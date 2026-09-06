/**
 * Verifies the Whereby credential and the room lifecycle, against the real API.
 *
 *   npm run whereby:check
 *
 * The adapter's unit tests stub `fetch`, which proves what Neem asks for but
 * not that Whereby agrees. This closes that gap: it creates a real room, prints
 * the URL so you can open it in two browsers and confirm media actually flows,
 * then deletes the room.
 *
 * It reads `WHEREBY_API_KEY` from `.env` and never prints it — not on success,
 * not in an error. A key pasted into a terminal transcript is a key that has
 * leaked.
 *
 * Nothing here touches the database, and no consultation is involved. It is
 * safe to run at any time.
 */
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from './load-env.mjs';

const BASE_URL = 'https://api.whereby.dev/v1';

async function main() {
  loadDotEnv();

  const key = process.env.WHEREBY_API_KEY;
  if (!key) {
    console.error(
      'WHEREBY_API_KEY is not set.\n\n' +
        'Get one from the Whereby dashboard under Configure -> API keys, and put\n' +
        'it in .env as WHEREBY_API_KEY=... . Never commit it.',
    );
    process.exit(1);
  }

  const endDate = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  console.log('Creating a room…');

  const created = await fetch(`${BASE_URL}/meetings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      endDate,
      roomMode: 'normal',
      roomNamePrefix: 'neem-check-',
      fields: ['hostRoomUrl'],
      // No `recording` key — the same omission the adapter makes. See the note
      // at the top of `whereby-media.provider.ts`.
    }),
  });

  const body = await created.json().catch(() => undefined);

  if (!created.ok) {
    console.error(
      `\nWhereby refused the request (HTTP ${created.status}).\n` +
        `${body?.message ?? body?.error ?? 'No message given.'}\n\n` +
        (created.status === 401
          ? 'A 401 means the key is wrong, revoked, or from a different account.'
          : ''),
    );
    process.exit(1);
  }

  console.log('  ✓ the key works, and a room was created\n');
  console.log(`  meetingId : ${body.meetingId}`);
  console.log(`  patient   : ${body.roomUrl}?displayName=Patient&minimal=on`);
  console.log(
    `  doctor    : ${body.hostRoomUrl ? `${body.hostRoomUrl}&displayName=Doctor&minimal=on` : '(none — "fields" was refused)'}`,
  );
  console.log(
    '\n  Open both in separate browsers to confirm media flows. The doctor URL\n' +
      '  carries a host key: treat it as a credential, not a link to share.',
  );

  console.log('\nDeleting the room…');

  const deleted = await fetch(`${BASE_URL}/meetings/${encodeURIComponent(body.meetingId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${key}` },
  });

  if (!deleted.ok && deleted.status !== 404) {
    console.error(
      `  ! Whereby returned ${deleted.status} on delete. The room above is still\n` +
        '    reachable until an hour after its end date. Delete it from the dashboard.',
    );
    process.exit(1);
  }

  console.log('  ✓ deleted — the URLs above are now dead\n');
  console.log(
    'Set VIDEO_PROVIDER=whereby in .env to use it for consultations.\n' +
      'Check that recording is OFF in the Whereby dashboard first: this adapter\n' +
      'never asks for it, but the account setting is outside its reach.',
  );
}

// `pathToFileURL` rather than string-building: on Windows a raw path never
// matches `import.meta.url`, and the script silently does nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('\nThe check failed:\n', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
