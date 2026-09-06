import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubtelNotificationProvider } from '../../src/adapters/notification/hubtel-notification.provider.ts';
import { toGhanaMsisdn } from '../../src/adapters/notification/ghana-msisdn.ts';
import { PermanentDeliveryError } from '../../src/adapters/notification/notification.provider.ts';

/**
 * The Hubtel SMS adapter (spec §57, §58, decision D37).
 *
 * Unit tests against a stubbed `fetch`. Hubtel's API is not exercised here —
 * that needs real credentials and a message that costs money — so what these
 * assert is everything that is Neem's decision: what goes over the wire, what
 * is treated as sent, and what is refused outright.
 *
 * The number tests carry the most weight. A patient's consultation reference
 * is their only route back to their own record (D24), so a number normalised
 * wrongly does not merely fail to arrive — it arrives at a stranger's handset,
 * carrying a reference to someone else's consultation.
 */

const ACCEPTED = { MessageId: 'msg_123', Status: 0, Rate: 1 };

let fetchMock: ReturnType<typeof vi.fn>;

function respond(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function sentBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}'));
}

function sentHeaders(call = 0): Record<string, string> {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
}

const MESSAGE = {
  to: '0244123456',
  body: 'Your Neem consultation is complete. Your reference is NEEM-A1B2-C3D4-E5F6. Keep it.',
  reference: 'notif_abc',
};

beforeEach(() => {
  process.env.SMS_PROVIDER = 'hubtel';
  process.env.HUBTEL_CLIENT_ID = 'test-client-id';
  process.env.HUBTEL_CLIENT_SECRET = 'test-client-secret';
  process.env.HUBTEL_SENDER_ID = 'Neem';

  fetchMock = vi.fn().mockResolvedValue(respond(ACCEPTED));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of [
    'SMS_PROVIDER',
    'HUBTEL_CLIENT_ID',
    'HUBTEL_CLIENT_SECRET',
    'HUBTEL_SENDER_ID',
  ]) {
    delete process.env[key];
  }
});

describe('turning a Ghanaian number into what Hubtel expects', () => {
  it('converts the way a number is actually written in Ghana', () => {
    expect(toGhanaMsisdn('0244123456')).toBe('233244123456');
  });

  it('accepts one that is already international, however it is punctuated', () => {
    expect(toGhanaMsisdn('233244123456')).toBe('233244123456');
    expect(toGhanaMsisdn('+233 24 412 3456')).toBe('233244123456');
    expect(toGhanaMsisdn('+233-244-123-456')).toBe('233244123456');
  });

  it('accepts one stored without its trunk zero', () => {
    expect(toGhanaMsisdn('244123456')).toBe('233244123456');
  });

  it('refuses anything it would have to guess at', () => {
    // Each of these could be "fixed" by a rule that also mangles a real
    // number. Refusing is the only safe answer: the message carries a
    // reference to one person's consultation.
    for (const bad of [
      '',
      '   ',
      '024412345', // nine digits with a trunk zero — one short
      '02441234567', // one too many
      '4412 3456', // no network code
      '00233244123456', // international prefix, not a plus
      '+44 7700 900123', // a UK number
      'not-a-number',
      '0244123abc',
    ]) {
      expect(toGhanaMsisdn(bad), `should refuse ${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe('what goes over the wire', () => {
  it('authenticates in the header, never in the query string', async () => {
    await new HubtelNotificationProvider().send(MESSAGE);

    const [url] = fetchMock.mock.calls[0]!;
    const expected = Buffer.from('test-client-id:test-client-secret').toString('base64');

    expect(sentHeaders().authorization).toBe(`Basic ${expected}`);

    /**
     * Hubtel's own examples put the credentials in the query string. A query
     * string reaches access logs, proxy logs and error reports; these are
     * account credentials.
     */
    expect(String(url)).not.toContain('clientsecret');
    expect(String(url)).not.toContain('test-client-secret');
  });

  it('sends the registered alphanumeric sender, not a number', async () => {
    await new HubtelNotificationProvider().send(MESSAGE);

    // Ghana's networks reject a numeric international sender outright.
    expect(sentBody().From).toBe('Neem');
  });

  it('sends the normalised number and the body it was given, unchanged', async () => {
    await new HubtelNotificationProvider().send(MESSAGE);

    expect(sentBody().To).toBe('233244123456');
    // The adapter does no substitution of its own — the template already ran.
    expect(sentBody().Content).toBe(MESSAGE.body);
  });

  it('carries our notification id so a delivery report can be tied back', async () => {
    await new HubtelNotificationProvider().send(MESSAGE);

    expect(sentBody().ClientReference).toBe('notif_abc');
    expect(sentBody().RegisteredDelivery).toBe(true);
  });
});

describe('what counts as sent', () => {
  it('reports ACCEPTED with the provider’s handle', async () => {
    const result = await new HubtelNotificationProvider().send(MESSAGE);

    expect(result.status).toBe('ACCEPTED');
    expect(result.providerRef).toBe('msg_123');
  });

  it('reads a lower-cased message id too', async () => {
    // Hubtel's surfaces are not consistent about casing, and a message that
    // was sent must not be recorded as failed over a capital letter.
    fetchMock.mockResolvedValueOnce(respond({ messageId: 'msg_456', status: 0 }));

    const result = await new HubtelNotificationProvider().send(MESSAGE);

    expect(result.status).toBe('ACCEPTED');
    expect(result.providerRef).toBe('msg_456');
  });

  it('does NOT treat a 200 with no message id as sent', async () => {
    fetchMock.mockResolvedValueOnce(respond({ Message: 'Something happened' }));

    /**
     * An empty answer from a gateway is not a send. Recording it as SENT would
     * put a lie in the notification log, and the patient whose reference never
     * arrived would look like one who received it.
     */
    const result = await new HubtelNotificationProvider().send(MESSAGE);

    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toMatch(/no message id/i);
  });
});

describe('what is worth retrying and what is not', () => {
  it('treats a timeout as retryable', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    const result = await new HubtelNotificationProvider().send(MESSAGE);

    // FAILED rather than thrown: the retry job exists for exactly this.
    expect(result.status).toBe('FAILED');
    expect(result.failureReason).toMatch(/did not respond in time/i);
  });

  it('treats an unreachable gateway as retryable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await new HubtelNotificationProvider().send(MESSAGE);
    expect(result.status).toBe('FAILED');
  });

  it('treats a 500 as retryable', async () => {
    fetchMock.mockResolvedValueOnce(respond({ Message: 'Server error' }, 500));

    const result = await new HubtelNotificationProvider().send(MESSAGE);
    expect(result.status).toBe('FAILED');
  });

  it('refuses to retry rejected credentials or an unregistered sender', async () => {
    fetchMock.mockResolvedValueOnce(respond({ Message: 'Unauthorized' }, 401));

    /**
     * Configuration does not improve by being retried every minute, and a
     * queue full of them buries the failures worth reading. The message names
     * the three settings that could be at fault.
     */
    await expect(new HubtelNotificationProvider().send(MESSAGE)).rejects.toBeInstanceOf(
      PermanentDeliveryError,
    );
  });

  it('names the sender registration, because that is the likely cause', async () => {
    fetchMock.mockResolvedValueOnce(respond({ Message: 'Forbidden' }, 403));

    await expect(new HubtelNotificationProvider().send(MESSAGE)).rejects.toThrow(
      /HUBTEL_SENDER_ID is registered/,
    );
  });

  it('refuses an unusable number without calling Hubtel at all', async () => {
    await expect(
      new HubtelNotificationProvider().send({ ...MESSAGE, to: '+44 7700 900123' }),
    ).rejects.toBeInstanceOf(PermanentDeliveryError);

    // Not merely refused — never attempted. Sending a patient's reference to a
    // number we could not make sense of is the failure this prevents.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an empty destination', async () => {
    await expect(
      new HubtelNotificationProvider().send({ ...MESSAGE, to: '   ' }),
    ).rejects.toBeInstanceOf(PermanentDeliveryError);
  });
});

describe('what this adapter says it is', () => {
  it('is not a mock, and is an SMS provider', () => {
    const provider = new HubtelNotificationProvider();

    // `isMock` drives the demo banner and the production guard. Getting it
    // wrong would either warn about a real send or, far worse, let a mock into
    // production (spec §93).
    expect(provider.isMock).toBe(false);
    expect(provider.channel).toBe('SMS');
    expect(provider.name).toBe('hubtel');
  });
});
