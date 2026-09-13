import '../src/config/load-dotenv.ts';
import { PrismaClient } from '@prisma/client';
import { collectCandidates } from '../src/modules/queue/allocation.service.ts';
import { checkEligibility } from '../src/domain/queue-scoring.ts';

/**
 * Why the queue is not offering a doctor anything.
 *
 *   npm run doctor:check -- --email doctor@example.com [--language en]
 *
 * A consultation with nobody eligible **stays in the queue** — it is never
 * failed, never discarded, and an admin alert fires only when the cause is
 * specifically language. Every other reason produces silence. So a dry run
 * where everything looks configured and nothing happens is the expected
 * symptom of eight different problems, and this exists to say which.
 *
 * **It reuses the real rules rather than restating them.** `collectCandidates`
 * builds the candidate exactly as the allocator does, and `checkEligibility`
 * is the same function the allocator calls — so this cannot drift into
 * agreeing with a system that would refuse, or refusing where the system would
 * agree. Restating the eight gates here would have been easier to read and
 * worth nothing: a check that computes differently from the thing it checks
 * can pass while the real path fails.
 *
 * Read-only. It creates nothing and changes nothing.
 */

/** A consultation id that matches no row, so `alreadyOffered` is empty. */
const NO_CONSULTATION = '00000000-0000-0000-0000-000000000000';

/** What to do about each way the allocator can refuse. */
const REMEDIES: Record<string, string> = {
  ALREADY_OFFERED:
    'This doctor was already offered this consultation and did not take it. Not a fault.',
  NOT_ACTIVE:
    'An admin must approve the doctor. APPROVED is not enough — the status must be ACTIVE.',
  SUBSCRIPTION_LAPSED:
    'A subscription row exists and is neither ACTIVE nor GRACE. Renew it, or delete the row: a doctor with no subscription at all passes this gate.',
  LICENCE_EXPIRED: 'mdcExpiresAt is in the past. Set a future date, or clear it.',
  OFF_SHIFT:
    'No CONFIRMED shift covering the current time. Assigning a shift is not enough — the doctor has to confirm it. Shift hours are UTC.',
  NOT_PRESENT:
    'No heartbeat in the last 90 seconds. The doctor must have the queue screen open right now; this is the one that most often looks like a broken system.',
  LANGUAGE_MISMATCH:
    'The doctor does not consult in this language. Language is a rule, never a score — no amount of availability compensates.',
  AT_CAPACITY:
    'Already at maxLoad. Finish or reassign the current consultation, or raise the doctor’s capacity.',
};

function arg(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const email = arg('--email');
  const language = arg('--language') ?? 'en';

  if (!email) {
    console.error(
      'Usage:\n' +
        '  npm run doctor:check -- --email doctor@example.com [--language en]\n\n' +
        'The language matters: it is checked against the consultation the patient\n' +
        'chose, so a doctor can be perfectly available and still not be offered one.',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    const doctor = await prisma.doctor.findFirst({
      where: { user: { email: email.toLowerCase() } },
      select: {
        id: true,
        publicId: true,
        fullName: true,
        status: true,
        mdcExpiresAt: true,
        signatures: { select: { id: true }, take: 1 },
      },
    });

    if (!doctor) {
      console.error(`No doctor account for ${email}.`);
      process.exit(1);
    }

    // The allocator's own candidate construction, not a copy of it.
    const candidates = await collectCandidates(NO_CONSULTATION, prisma);
    const candidate = candidates.find((entry) => entry.doctorId === doctor.id);

    console.log(`${doctor.fullName}  (${doctor.publicId})`);
    console.log(`  status ${doctor.status}\n`);

    if (!candidate) {
      /*
       * The candidate query fetches ACTIVE, SUSPENDED and APPROVED. A doctor
       * outside those never reaches the eligibility check at all, so this is a
       * different failure from being excluded by a gate and is reported as one.
       */
      console.log('  ✗ not in the candidate pool at all');
      console.log(`    Status is ${doctor.status}; the allocator only looks at ACTIVE,`);
      console.log('    SUSPENDED and APPROVED doctors, and only ACTIVE ones are eligible.');
      process.exit(1);
    }

    // Each gate's input, from the same candidate the allocator would score.
    const gates: Array<[string, boolean, string]> = [
      ['not already offered', !candidate.alreadyOffered, 'ALREADY_OFFERED'],
      ['status is ACTIVE', candidate.status === 'ACTIVE', 'NOT_ACTIVE'],
      ['subscription usable', candidate.subscriptionUsable, 'SUBSCRIPTION_LAPSED'],
      ['licence valid', candidate.licenceValid, 'LICENCE_EXPIRED'],
      ['on a confirmed shift', candidate.onShift, 'OFF_SHIFT'],
      ['present (heartbeat < 90s)', candidate.present, 'NOT_PRESENT'],
      [`speaks "${language}"`, candidate.languageCodes.includes(language), 'LANGUAGE_MISMATCH'],
      [
        `has capacity (${candidate.currentLoad}/${candidate.maxLoad})`,
        candidate.currentLoad < candidate.maxLoad,
        'AT_CAPACITY',
      ],
    ];

    for (const [label, ok] of gates) {
      console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    }

    console.log(`\n  languages: ${candidate.languageCodes.join(', ') || '(none)'}`);

    /*
     * The verdict comes from the allocator's own function, not from the ticks
     * above. If the two ever disagree, the ticks are the ones that are wrong.
     */
    const verdict = checkEligibility(candidate, language);

    console.log('');
    if (verdict.eligible) {
      console.log(`This doctor would be offered an "${language}" consultation now.`);
    } else {
      console.log(`Would NOT be offered: ${verdict.reason}`);
      console.log(`  ${REMEDIES[verdict.reason!] ?? ''}`);
      console.log('');
      console.log('The gates are checked in order and this is the first that failed;');
      console.log('fixing it may reveal another. The ticks above show all of them.');
    }

    /*
     * Not an eligibility gate, and the reason it is here anyway: a doctor with
     * no signature is offered consultations, conducts them, and is refused at
     * the moment they try to issue a prescription — with a patient in front of
     * them. Cheaper to find now.
     */
    if (doctor.signatures.length === 0) {
      console.log('');
      console.log('  ! no signature on file. This does not stop a consultation, but a');
      console.log('    prescription cannot be issued without one. Capture it before the');
      console.log('    doctor is in front of a patient, not during.');
    }

    process.exit(verdict.eligible ? 0 : 1);
  } finally {
    await prisma.$disconnect();
  }
}

await main();
