/**
 * Verifies the SMTP credentials by connecting, authenticating, and sending one
 * real email.
 *
 *   npm run smtp:check -- --to you@example.com
 *
 * **This sends a real message.** To an address you name on the command line —
 * never to a doctor, a pharmacy, or anything from the database. The address is
 * required rather than defaulted so that running this by accident cannot email
 * somebody.
 *
 * It exists because the configuration loader checks that `SMTP_HOST` is *set*,
 * not that it exists. A value can be present, well-formed, and completely
 * wrong: the first host configured here was `privateemail._domainkey`, which
 * is the name of a DKIM **DNS record**, not a mail server. Nothing in the API
 * would have complained until a doctor failed to receive a consultation offer.
 *
 * Two steps, because they fail for different reasons and the difference is the
 * whole value of the script. `verify()` opens the connection and authenticates
 * — that catches a wrong host, a blocked port, a bad password. Sending catches
 * what only the relay knows: a refused sender, an unverified domain, a
 * rejected recipient.
 *
 * The password is read from `.env` and never printed.
 */
import { pathToFileURL } from 'node:url';
import nodemailer from 'nodemailer';
import { loadDotEnv } from './load-env.mjs';

/**
 * Turns a transport error into the thing that is actually wrong.
 *
 * Matches the message as well as `code`, because nodemailer wraps socket
 * failures: a host that does not resolve arrives as `code: 'ESOCKET'` with
 * "getaddrinfo ENOTFOUND …" in the text, not as `code: 'ENOTFOUND'`. Reading
 * only the code meant the one diagnostic this script was written for — the
 * DKIM record pasted into SMTP_HOST — printed the raw error instead of the
 * explanation. Found by running it against that exact mistake.
 */
function explain(error, host, port) {
  const code = error?.code ?? '';
  const message = String(error?.message ?? error);
  const mentions = (...needles) =>
    needles.some((needle) => code === needle || message.includes(needle));

  if (mentions('ENOTFOUND', 'EAI_AGAIN')) {
    const hint = host.includes('_domainkey')
      ? '\n    That host contains "_domainkey", which is part of a DKIM DNS record name\n' +
        '    rather than a mail server. DKIM belongs in your DNS records; SMTP_HOST\n' +
        '    wants the relay itself — for Namecheap Private Email, mail.privateemail.com.'
      : '\n    Check SMTP_HOST for a typo, and that it is the relay hostname rather\n' +
        '    than your mail domain.';
    return `The host ${host} does not resolve.${hint}`;
  }

  if (mentions('ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET')) {
    return (
      `Nothing accepted a connection on ${host}:${port}.\n` +
      '    Usually the wrong port, or a network blocking outbound mail. 465 is\n' +
      '    implicit TLS and 587 is STARTTLS; the adapter picks by port number, so\n' +
      '    the two are not interchangeable.'
    );
  }

  if (mentions('EAUTH') || /invalid login|authentication failed|535/i.test(message)) {
    return (
      'The relay refused the credentials.\n' +
      '    SMTP_USER is normally the full mailbox address, not a short name, and\n' +
      '    some providers require an app password rather than the account one.'
    );
  }

  if (/self.signed|certificate|SSL|TLS/i.test(message)) {
    return (
      `TLS failed against ${host}:${port}.\n` +
      '    Often a port mismatch: 465 expects TLS from the first byte, 587 expects\n' +
      '    a plaintext greeting and then STARTTLS.'
    );
  }

  return message;
}

async function main() {
  loadDotEnv();

  const argv = process.argv.slice(2);
  const toIndex = argv.indexOf('--to');
  const to = toIndex === -1 ? undefined : argv[toIndex + 1];

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  const from = process.env.SMTP_FROM;

  const missing = [
    ['SMTP_HOST', host],
    ['SMTP_FROM', from],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    console.error(
      `Not set in .env: ${missing.join(', ')}\n\n` +
        'SMTP_HOST is the relay hostname and SMTP_FROM is the address messages\n' +
        'are sent from, which must be one the relay is willing to send as.',
    );
    process.exit(1);
  }

  if (!to) {
    console.error(
      'Which address should the test message go to?\n\n' +
        '  npm run smtp:check -- --to you@example.com\n\n' +
        'Required rather than defaulted: this sends a real email, and running it\n' +
        'by accident should not be able to mail anybody.',
    );
    process.exit(1);
  }

  /*
   * Mirrors `smtp-notification.provider.ts` exactly — same secure rule, same
   * conditional auth. A check that connects differently from the application
   * can pass while the application fails, which is worse than no check.
   */
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });

  console.log(`Connecting to ${host}:${port} (${port === 465 ? 'implicit TLS' : 'STARTTLS'})…`);
  if (!user) {
    console.log('  No SMTP_USER, so connecting without authentication.');
  }

  try {
    await transporter.verify();
    console.log('  ✓ connected and authenticated\n');
  } catch (error) {
    console.error(`  ✗ ${explain(error, host, port)}\n`);
    process.exit(1);
  }

  console.log(`Sending one message to ${to}…`);

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject: 'Neem SMTP check',
      text:
        'This is a test message from the Neem SMTP check.\n\n' +
        'If you received it, the relay accepts the configured credentials and\n' +
        'will send as the configured address.\n',
    });

    console.log(`  ✓ accepted, message id ${info.messageId}`);
    if (info.rejected?.length) {
      console.log(`  ✗ but the relay rejected: ${info.rejected.join(', ')}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`  ✗ ${explain(error, host, port)}\n`);
    process.exit(1);
  }

  console.log('');
  console.log('ACCEPTED IS NOT DELIVERED. The relay has taken the message; whether it');
  console.log('reaches an inbox rather than a spam folder depends on SPF and DKIM for');
  console.log('the sending domain. Check the inbox, and check the spam folder — a');
  console.log('doctor has ninety seconds to answer a consultation offer, which is not');
  console.log('long enough to go looking for it.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('\nThe check failed:\n', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
