/**
 * Verifies the Whereby credential and the room lifecycle, against the real API.
 *
 *   npm run whereby:check
 *
 * The adapter's unit tests stub `fetch`, which proves what Neem asks for but
 * not that Whereby agrees. This closes that gap by creating a real room.
 *
 * Two modes, because the first version had a bug worth remembering. It created
 * a room, printed the URLs, told the reader to open them in two browsers — and
 * then deleted the room, before anyone could. The advice was impossible to
 * follow, and the result looked exactly like a broken integration: "Sorry, we
 * can't find that room".
 *
 *   npm run whereby:check           create, verify, delete. Answers "does the
 *                                   key work" and claims nothing about media.
 *   npm run whereby:check -- --keep create and LEAVE IT UP, so the URLs can
 *                                   actually be opened. Prints how to delete it.
 *   npm run whereby:check -- --delete <meetingId>    clean up afterwards.
 *
 * It reads `WHEREBY_API_KEY` from `.env` and never prints it — not on success,
 * not in an error. A key pasted into a terminal transcript is a key that has
 * leaked.
 *
 * Nothing here touches the database, and no consultation is involved. It is
 * safe to run at any time.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from './load-env.mjs';

const BASE_URL = 'https://api.whereby.dev/v1';

/**
 * The room URLs, written to a file as well as printed.
 *
 * A host room URL carries a JWT and runs to several hundred characters, which
 * wraps in a terminal and gets copied wrong — losing the `roomKey` produces a
 * URL that looks plausible and is not the doctor's. A file can be opened and
 * copied exactly.
 */
const URL_FILE = '.whereby-room.txt';

async function deleteMeeting(key, meetingId) {
  const response = await fetch(`${BASE_URL}/meetings/${encodeURIComponent(meetingId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${key}` },
  });
  return response.ok || response.status === 404;
}

async function main() {
  loadDotEnv();

  const argv = process.argv.slice(2);
  const keep = argv.includes('--keep');
  const deleteIndex = argv.indexOf('--delete');

  const key = process.env.WHEREBY_API_KEY;
  if (!key) {
    console.error(
      'WHEREBY_API_KEY is not set.\n\n' +
        'Get one from the Whereby dashboard under Configure -> API keys, and put\n' +
        'it in .env as WHEREBY_API_KEY=... . Never commit it.',
    );
    process.exit(1);
  }

  if (deleteIndex !== -1) {
    const meetingId = argv[deleteIndex + 1];
    if (!meetingId) {
      console.error('--delete needs a meeting id, e.g. --delete 139362950');
      process.exit(1);
    }

    const ok = await deleteMeeting(key, meetingId);
    console.log(ok ? `  ✓ meeting ${meetingId} is gone` : `  ! could not delete ${meetingId}`);
    process.exit(ok ? 0 : 1);
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

  const patientUrl = `${body.roomUrl}?displayName=Patient&minimal=on`;
  const doctorUrl = body.hostRoomUrl ? `${body.hostRoomUrl}&displayName=Doctor&minimal=on` : null;

  console.log('  ✓ the key works, and Whereby created a room\n');
  console.log(`  meetingId : ${body.meetingId}`);

  if (!keep) {
    /**
     * Deleted immediately, and the URLs are deliberately NOT offered.
     *
     * This mode answers one question — does the credential work — and must not
     * imply a second. Printing a URL beside a room about to be destroyed is how
     * the first version of this script sent someone to a "Sorry, we can't find
     * that room" page and left them thinking the integration was broken.
     */
    const ok = await deleteMeeting(key, body.meetingId);
    console.log(
      ok
        ? '  ✓ and deleted it again\n'
        : `  ! could not delete it — remove meeting ${body.meetingId} from the dashboard\n`,
    );

    console.log('The credential and the room lifecycle work. This says NOTHING about');
    console.log('whether audio and video flow — the room is already gone.\n');
    console.log('To test media, make one that stays up:\n');
    console.log('  npm run whereby:check -- --keep');
    process.exit(ok ? 0 : 1);
  }

  writeFileSync(
    URL_FILE,
    [
      `meetingId: ${body.meetingId}`,
      '',
      'PATIENT (open in one browser):',
      patientUrl,
      '',
      'DOCTOR (open in a different browser, or a private window):',
      doctorUrl ?? '(none — Whereby refused the hostRoomUrl field)',
      '',
      'Delete it when you are done:',
      `  npm run whereby:check -- --delete ${body.meetingId}`,
      '',
    ].join('\n'),
    'utf8',
  );

  console.log(`  ✓ left up. Both URLs are in ${URL_FILE}\n`);
  console.log('  PATIENT:');
  console.log(`  ${patientUrl}\n`);
  console.log('  DOCTOR:');
  console.log(`  ${doctorUrl ?? '(none — Whereby refused the hostRoomUrl field)'}\n`);
  console.log(
    `  The doctor URL is long and wraps in a terminal. Copy it from ${URL_FILE}\n` +
      '  rather than from here — losing the roomKey gives a URL that looks right\n' +
      '  and joins as a guest instead of the host.\n',
  );
  console.log('  Open both, in two different browsers. Two people who can see and hear');
  console.log('  each other is the only thing that proves media works.\n');
  console.log(`  Then delete it:  npm run whereby:check -- --delete ${body.meetingId}`);
  console.log(
    '\n  It also expires 30 minutes from now, plus Whereby’s own hour of grace —\n' +
      '  but a room left up is a room somebody can walk into.',
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
