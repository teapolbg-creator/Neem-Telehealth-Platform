/**
 * Verifies the Arkesel credentials and sender ID by sending one real SMS.
 *
 *   npm run arkesel:check -- --to 0244123456
 *
 * **This sends a real message and costs real money.** One message, to a number
 * you name on the command line — never to a patient, never to anything from the
 * database. The number is required rather than defaulted so that running this
 * by accident cannot text somebody.
 *
 * It exists because the adapter's unit tests stub `fetch`: they prove what Neem
 * asks Arkesel for, not that Arkesel agrees. One thing in particular can only
 * be learned from a real send — whether `ARKESEL_SENDER_ID` is registered with
 * the networks. An unregistered alphanumeric sender is accepted by the API and
 * then dropped by the network, so the only way to know is for a handset to
 * buzz.
 *
 * The key is read from `.env` and never printed.
 */
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from './load-env.mjs';
import { toGhanaMsisdn } from './ghana-msisdn.mjs';

const ENDPOINT = 'https://sms.arkesel.com/api/v2/sms/send';

async function main() {
  loadDotEnv();

  const argv = process.argv.slice(2);
  const toIndex = argv.indexOf('--to');
  const rawTo = toIndex === -1 ? undefined : argv[toIndex + 1];

  const apiKey = process.env.ARKESEL_API_KEY;
  const senderId = process.env.ARKESEL_SENDER_ID;

  const missing = [
    ['ARKESEL_API_KEY', apiKey],
    ['ARKESEL_SENDER_ID', senderId],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    console.error(
      `Not set in .env: ${missing.join(', ')}\n\n` +
        'The key comes from the Arkesel dashboard under API keys. The sender ID is\n' +
        'the name recipients see, and it must be REGISTERED with the networks or\n' +
        'messages are accepted and then silently dropped.',
    );
    process.exit(1);
  }

  if (!rawTo) {
    console.error(
      'Which number should the test message go to?\n\n' +
        '  npm run arkesel:check -- --to 0244123456\n\n' +
        'Required rather than defaulted: this sends a real SMS, and running it by\n' +
        'accident should not be able to text anybody.',
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

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: senderId,
      message: 'Neem test message. If you received this, the SMS provider is configured correctly.',
      recipients: [to],
    }),
  });

  const body = await response.json().catch(() => undefined);

  console.log(`  HTTP ${response.status}`);
  console.log(`  body: ${JSON.stringify(body, null, 2)}\n`);

  if (response.status === 401) {
    console.error('Arkesel rejected the API key. Check ARKESEL_API_KEY.');
    process.exit(1);
  }
  if (response.status === 403) {
    console.error(
      'Arkesel refused the sender.\n\n' +
        'Almost always ARKESEL_SENDER_ID not being registered with the networks,\n' +
        'or an account with no SMS credit.',
    );
    process.exit(1);
  }
  if (!response.ok) {
    console.error('Arkesel refused the message. The body above is its reason.');
    process.exit(1);
  }

  const id = Array.isArray(body?.data) ? body.data[0]?.id : body?.data?.id;
  if ((body?.status ?? '').toLowerCase() !== 'success' || !id) {
    console.error(
      'Arkesel answered 200 but did not report a success with a message id, so\n' +
        'the adapter would treat this as NOT sent. That is deliberate — an\n' +
        'unevidenced answer from a gateway is not a send.',
    );
    process.exit(1);
  }

  console.log(`  ✓ accepted, message id ${id}\n`);
  console.log('ACCEPTED IS NOT DELIVERED. Arkesel has taken the message; the networks');
  console.log('decide the rest. Check the handset.\n');
  console.log('If nothing arrives, the usual cause is an unregistered sender ID:');
  console.log('the API accepts it and the network drops it, silently, every time.');
}

// `pathToFileURL` rather than string-building: on Windows a raw path never
// matches `import.meta.url`, and the script silently does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('\nThe check failed:\n', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
