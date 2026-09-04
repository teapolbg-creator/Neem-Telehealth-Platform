/**
 * Every notification template in the catalogue is either sent by something, or
 * listed below as knowingly unsent.
 *
 * Found in Phase 11: of 21 templates, 4 had a producer. The other 17 were
 * complete — subject, body, channels, variables, an admin screen to reword them
 * on — and nothing anywhere called `notify()` with their code. An administrator
 * could carefully word a message that would never reach anyone, and nothing in
 * the product said so.
 *
 * This is the same shape as the drift test over `docs/api.md` and the public
 * route list in `security.test.ts`: a claim the build re-checks rather than a
 * claim someone made once. The list below is a debt register, not permission.
 * Wiring a producer means deleting its entry, and adding a template without one
 * means writing an entry and a reason — which is a harder thing to do quietly
 * than leaving a gap.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOTIFICATION_TEMPLATES,
  TEMPLATES_WITHOUT_PRODUCER,
} from '../../src/modules/notification/templates.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/**
 * Why each unwired template matters, kept next to the assertions rather than
 * next to the data.
 *
 * The set itself lives in `templates.ts`, because the admin route needs it
 * too and two copies of a debt register is how a debt register starts lying.
 * What lives here is the consequence — stated as who is not told what, since
 * that is the question worth asking at review and it is not answerable from a
 * module name.
 */
const CONSEQUENCES: Record<string, string> = {
  'doctor.account.approved':
    'an approved doctor is never told; they discover it by signing in and looking',
  'pharmacy.account.approved':
    'the same, for a pharmacy that has been waiting on manual verification',
  'doctor.consultation.missed':
    'the 90-second window lapses and the doctor is not told it counted against them',
  'doctor.shift.assigned': 'a doctor learns of a new shift only by opening the app',
  'doctor.licence.expiring':
    'no advance warning; the doctor discovers the lapse when a prescription is refused mid-consultation',
  'doctor.membership.expiring': 'no warning before the subscription sweep suspends them',
  'doctor.membership.suspended': 'suspension arrives silently',
  'pharmacy.substitution.decided':
    'the doctor is told a substitution was proposed; the pharmacy is not told the answer, and dispensing stays blocked until it notices',
  'pharmacy.prescription.revoked':
    'refused server-side, so nobody is endangered — but the counter finds out by being refused',
  'pharmacy.consultation.doctor-assigned':
    'the counter cannot tell the patient a doctor has been found',
  'pharmacy.consultation.no-doctor':
    'admins get a socket alert; the pharmacy holding the waiting patient does not',
  'pharmacy.refund.decided': 'the pharmacy is not told the outcome of a refund on its consultation',
  'patient.consultation.ready':
    'the waiting-room screen polls, so a patient watching sees it; one who put the phone down does not',
  'admin.queue.no-language-match': 'a live socket alert only — nothing for an admin who is away',
  'admin.payment.anomaly': 'the same',
  'admin.refund.requested': 'the same',
  'admin.retention.overdue': 'a retention job that has not run is not escalated to anyone',
};

async function sourceText(): Promise<string> {
  const chunks: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts')) chunks.push(await readFile(full, 'utf8'));
    }
  }

  await walk(SRC);
  return chunks.join('\n');
}

/** Codes passed to `notify()` anywhere in the application. */
function producedCodes(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/templateCode:\s*'([a-z0-9.-]+)'/g)) {
    found.add(match[1]!);
  }
  return found;
}

describe('notification templates and their producers', () => {
  it('sends every template that is not on the unwired list', async () => {
    const produced = producedCodes(await sourceText());

    const silent = NOTIFICATION_TEMPLATES.map((template) => template.code)
      .filter((code) => !produced.has(code))
      .filter((code) => !TEMPLATES_WITHOUT_PRODUCER.has(code));

    expect(
      silent,
      'These templates have no producer and are not on the unwired list. Either ' +
        'call notify() with the code, or add an entry saying who is not told what.',
    ).toEqual([]);
  });

  it('has no stale entries on the unwired list', async () => {
    const produced = producedCodes(await sourceText());

    const nowWired = [...TEMPLATES_WITHOUT_PRODUCER].filter((code) => produced.has(code));

    expect(
      nowWired,
      'These are listed as unwired but something now sends them. Delete their ' +
        'entries — a debt register that overstates the debt stops being read.',
    ).toEqual([]);
  });

  it('says, for every unwired template, who is not told what', () => {
    const missing = [...TEMPLATES_WITHOUT_PRODUCER].filter((code) => !CONSEQUENCES[code]);

    expect(
      missing,
      'An entry on the debt register with no stated consequence. Write who ' +
        'does not learn what, or the register becomes a list nobody can triage.',
    ).toEqual([]);
  });
  it('lists only codes that exist in the catalogue', () => {
    const catalogue = new Set(NOTIFICATION_TEMPLATES.map((template) => template.code));
    const unknown = [...TEMPLATES_WITHOUT_PRODUCER].filter((code) => !catalogue.has(code));

    expect(unknown, 'The unwired list names templates the catalogue does not have.').toEqual([]);
  });

  it('records how much of the catalogue is actually connected', async () => {
    const produced = producedCodes(await sourceText());
    const codes = NOTIFICATION_TEMPLATES.map((template) => template.code);
    const wired = codes.filter((code) => produced.has(code));

    // Not an assertion about a good number — an assertion that the number is
    // known. It was 4 of 21 when this test was written: the doctor's offer,
    // the doctor's substitution request, the pharmacy's prescription-issued
    // notice, and the patient's completion message.
    expect(wired.length + TEMPLATES_WITHOUT_PRODUCER.size).toBe(codes.length);
  });
});
