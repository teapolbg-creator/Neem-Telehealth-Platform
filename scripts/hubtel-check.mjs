/**
 * Verifies the Hubtel credentials and sender ID by sending one real SMS.
 *
 *   npm run hubtel:check -- --to 0244123456
 *
 * **This sends a real message and costs real money.** One message, to a number
 * you name on the command line — never to a patient, never to anything from
 * the database. The number is required rather than defaulted precisely so that
 * running this by accident cannot text somebody.
 *
 * It exists because the adapter's unit tests stub `fetch`: they prove what Neem
 * asks Hubtel for, not that Hubtel agrees. Two things in particular can only be
 * learned from a real send:
 *
 *  - whether `HUBTEL_SENDER_ID` has actually been registered with the networks.
 *    An unregistered alphanumeric sender is accepted by the API and then
 *    dropped by the network, so the only way to know is for a handset to ring.
 *  - what Hubtel's per-message status codes actually are. The adapter treats a
 *    2xx carrying a message id as accepted and does not branch on a code it
 *    guessed; this prints whatever comes back, so the mapping can be tightened
 *    against something observed.
 *
 * Credentials are read from `.env` and never printed.
 */
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from './load-env.mjs';

const ENDPOINT = 'https://smsc.hubtel.com/v1/messages/send';

/**
 * The same normalisation the adapter uses.
 *
 * Duplicated because the operational scripts are plain `.mjs` and deliberately
 * do not import the application TypeScript. A duplicate that drifts is worse
 * than no duplicate, so `hubtel-adapter.test.ts` compares the two functions
 * case by case.
 */
export function toGhanaMsisdn(raw) {
  const digits = String(raw).replace(/[\s()+-]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;
  if (/^233\d{9}$/.test(digits)) return digits;
  if (/^[1-9]\d{8}$/.test(digits)) return `233${digits}`;
  return null;
}

async function main() {
  loadDotEnv();

  const argv = process.argv.slice(2);
  const toIndex = argv.indexOf('--to');
  const rawTo = toIndex === -1 ? undefined : argv[toIndex + 1];

  const clientId = process.env.HUBTEL_CLIENT_ID;
  const clientSecret = process.env.HUBTEL_CLIENT_SECRET;
  const senderId = process.env.HUBTEL_SENDER_ID;

  const missing = [
    ['HUBTEL_CLIENT_ID', clientId],
    ['HUBTEL_CLIENT_SECRET', clientSecret],
    ['HUBTEL_SENDER_ID', senderId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    console.error(
      `Not set in .env: ${missing.join(', ')}\n\n` +
        'The client id and secret come from the Hubtel dashboard under API keys.\n' +
        'The sender ID is the name recipients see, and it must be REGISTERED with\n' +
        'the networks or messages are accepted and then silently dropped.',
    );
    process.exit(1);
  }

  if (!rawTo) {
    console.error(
      'Which number should the test message go to?\n\n' +
        '  npm run hubtel:check -- --to 0244123456\n\n' +
        'Required rather than defaulted: this sends a real SMS, and running it\n' +
        'by accident should not be able to text anybody.',
    );
    process.exit(1);
  }

  const to = toGhanaMsisdn(rawTo);
  if (!to) {
    console.error(
      `"${rawTo}" is not a Ghanaian number this can make sense of.\n` +
        'Expected something like 0244123456, 233244123456 or +233 24 412 3456.',
    );
    process.exit(1);
  }

  console.log(`Sending one message to ${to} as "${senderId}"…\n`);

  const authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  const reference = `check_${Date.now()}`;

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({
      From: senderId,
      To: to,
      Content: 'Neem test message. If you received this, the SMS provider is configured correctly.',
      RegisteredDelivery: true,
      ClientReference: reference,
    }),
  });

  const body = await response.json().catch(() => undefined);

  console.log(`  HTTP ${response.status}`);
  console.log(`  body: ${JSON.stringify(body, null, 2)}\n`);

  if (response.status === 401 || response.status === 403) {
    console.error(
      'Hubtel rejected the request.\n\n' +
        'A 401 usually means the client id or secret is wrong. A 403 more often\n' +
        'means the sender ID is not registered, or the account has no SMS credit.',
    );
    process.exit(1);
  }

  if (!response.ok) {
    console.error('Hubtel refused the message. The body above is its reason.');
    process.exit(1);
  }

  const messageId = body?.MessageId ?? body?.messageId;
  if (!messageId) {
    console.error(
      'Hubtel answered 200 but gave no message id, so the adapter would treat\n' +
        'this as NOT sent. That is deliberate — an empty answer from a gateway\n' +
        'is not a send — but it means something is wrong with the request.',
    );
    process.exit(1);
  }

  console.log(`  ✓ accepted, message id ${messageId}\n`);
  console.log('ACCEPTED IS NOT DELIVERED. Hubtel has taken the message; the networks');
  console.log('decide the rest. Check the handset.\n');
  console.log('If nothing arrives, the usual cause is an unregistered sender ID:');
  console.log('the API accepts it and the network drops it, silently, every time.');
  console.log(`\nOur reference for this send was ${reference}.`);
}

// `pathToFileURL` rather than string-building: on Windows a raw path never
// matches `import.meta.url`, and the script silently does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('\nThe check failed:\n', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
