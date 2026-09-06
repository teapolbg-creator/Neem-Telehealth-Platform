import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArkeselNotificationProvider } from '../../src/adapters/notification/arkesel-notification.provider.ts';
import { PermanentDeliveryError } from '../../src/adapters/notification/notification.provider.ts';

/**
 * The Arkesel SMS adapter (spec §57, §58, decision D39).
 *
 * Unit tests against a stubbed `fetch`. What they assert is everything that is
 * Neem's decision: what goes over the wire, what counts as sent, and — the part
 * that carries the most weight here — which failures are worth retrying.
 *
 * Arkesel distinguishes its errors by status code, so this adapter does too,
 * and getting that boundary wrong is expensive in both directions. Retrying a
 * permanent failure fills the queue with messages that will never send and
 * buries the ones worth reading; giving up on a transient one loses a
 * patient's consultation reference, which is their only route back to their own
 * record (D24).
 */

const ACCEPTED = { status: 'success', data: { id: 'msg_9f8k2', credits_used: 1 } };

let fetchMock: ReturnType<typeof vi.fn>;

function respond(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function sentBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}'));
}

function sentHeaders(): Record<string, string> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

const MESSAGE = {
  to: '0244123456',
  body: 'Your Neem consultation is complete. Your reference is NEEM-A1B2-C3D4-E5F6. Keep it.',
  reference: 'notif_abc',
};

const send = () => new ArkeselNotificationProvider().send(MESSAGE);

beforeEach(() => {
  process.env.SMS_PROVIDER = 'arkesel';
  process.env.ARKESEL_API_KEY = 'test-api-key';
  process.env.ARKESEL_SENDER_ID = 'Neem';

  fetchMock = vi.fn().mockResolvedValue(respond(ACCEPTED));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ['SMS_PROVIDER', 'ARKESEL_API_KEY', 'ARKESEL_SENDER_ID']) {
    delete process.env[key];
  }
});

describe('what goes over the wire', () => {
  it('sends the key in Arkesel’s own header, not an Authorization one', async () => {
    await send();

    const [url] = fetchMock.mock.calls[0]!;

    expect(url).toBe('https://sms.arkesel.com/api/v2/sms/send');
    expect(sentHeaders()['api-key']).toBe('test-api-key');
    expect(sentHeaders().authorization).toBeUndefined();
    // Never in the URL: a query string reaches access and proxy logs.
    expect(String(url)).not.toContain('test-api-key');
  });

  it('sends the registered alphanumeric sender and a normalised recipient', async () => {
    await send();

    // Ghana's networks reject a numeric international sender outright.
    expect(sentBody().sender).toBe('Neem');
    expect(sentBody().recipients).toEqual(['233244123456']);
  });

  it('sends the rendered body unchanged', async () => {
    await send();

    // The template already ran; an adapter does no substitution of its own.
    expect(sentBody().message).toBe(MESSAGE.body);
  });
});

describe('what counts as sent', () => {
  it('reports ACCEPTED with the provider’s id', async () => {
    const result = await send();

    expect(result.status).toBe('ACCEPTED');
    expect(result.providerRef).toBe('msg_9f8k2');
  });

  it('reads the id when Arkesel answers with an array', async () => {
    // Their API has answered both ways across versions, and a message that was
    // sent must not be recorded as failed over the shape of the envelope.
    fetchMock.mockResolvedValueOnce(respond({ status: 'success', data: [{ id: 'msg_arr' }] }));

    const result = await send();

    expect(result.status).toBe('ACCEPTED');
    expect(result.providerRef).toBe('msg_arr');
  });

  it('does NOT treat a 200 without status=success as sent', async () => {
    fetchMock.mockResolvedValueOnce(respond({ status: 'error', message: 'Insufficient balance' }));

    const result = await send();

    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toMatch(/Insufficient balance/);
  });

  it('does NOT treat a success with no id as sent', async () => {
    /**
     * An answer with no handle is not evidence of a send. Recording it as SENT
     * would put a lie in the notification log, and a patient whose reference
     * never arrived would look exactly like one who received it.
     */
    fetchMock.mockResolvedValueOnce(respond({ status: 'success', data: {} }));

    const result = await send();

    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toMatch(/no message id/i);
  });
});

describe('which failures are worth retrying', () => {
  it('gives up on a rejected key, and names it', async () => {
    // One response, one call, both assertions on the same rejection —
    // `mockResolvedValueOnce` is spent by the first send, so a second
    // `expect(send())` would quietly assert against the default success.
    fetchMock.mockResolvedValueOnce(respond({ message: 'Invalid API key' }, 401));

    await expect(send()).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PermanentDeliveryError && /ARKESEL_API_KEY/.test(error.message),
    );
  });

  it('gives up on a 403 and names the sender registration', async () => {
    /**
     * 403 is overwhelmingly the sender ID rather than the key: Ghana's networks
     * block unregistered alphanumeric senders. An operator reading "permission
     * denied" would otherwise go looking at the API key, which is fine.
     */
    fetchMock.mockResolvedValueOnce(respond({ message: 'Forbidden' }, 403));

    await expect(send()).rejects.toThrow(/ARKESEL_SENDER_ID/);
  });

  it('gives up on a 422, because the same message will fail identically', async () => {
    fetchMock.mockResolvedValueOnce(respond({ message: 'Invalid recipient' }, 422));

    await expect(send()).rejects.toBeInstanceOf(PermanentDeliveryError);
  });

  it('retries a rate limit', async () => {
    // 429 is the clearest case for retrying: it means "not now", not "never".
    fetchMock.mockResolvedValueOnce(respond({ message: 'Too many requests' }, 429));

    const result = await send();

    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toMatch(/429/);
  });

  it('retries a server error', async () => {
    fetchMock.mockResolvedValueOnce(respond({ message: 'Server error' }, 500));

    const result = await send();
    expect(result.status).toBe('FAILED');
  });

  it('retries a timeout', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const result = await send();

    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toMatch(/did not respond in time/i);
  });

  it('refuses an unusable number without calling Arkesel at all', async () => {
    await expect(
      new ArkeselNotificationProvider().send({ ...MESSAGE, to: '+44 7700 900123' }),
    ).rejects.toBeInstanceOf(PermanentDeliveryError);

    // Not merely refused — never attempted. Sending a patient's reference to a
    // number we could not make sense of is the failure this prevents.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('what this adapter says it is', () => {
  it('is not a mock, and is an SMS provider', () => {
    const provider = new ArkeselNotificationProvider();

    expect(provider.isMock).toBe(false);
    expect(provider.channel).toBe('SMS');
    expect(provider.name).toBe('arkesel');
  });
});
