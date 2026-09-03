import '../src/config/load-dotenv.ts';
import { PrismaClient } from '@prisma/client';
import { getEnv } from '../src/config/env.ts';
import { transition } from '../src/modules/consultation/consultation.service.ts';

/**
 * Closes demo consultations that cannot end on their own.
 *
 * Two piles, one cause — five days of abandoned end-to-end runs.
 *
 * **Stranded in the queue** (`WAITING_FOR_DOCTOR`, `REASSIGNING`). Nothing is
 * wrong with the product for holding these: spec §37 is explicit that a paid
 * consultation is never silently discarded, and scenario 3 asserts exactly
 * that. But a doctor **cannot decline an offer** (spec §30), so any doctor
 * coming online is immediately committed to one, which makes the queue
 * impossible to exercise through the UI — Scenario 1 completed a stranger's
 * consultation and then waited forever for its own patient.
 *
 * **Stuck mid-consultation** (`IN_PROGRESS`, `DOCTOR_ACCEPTED`). Only a doctor
 * completes a consultation (spec §15, §16) and there is deliberately no job
 * that does, so a demo run that stops halfway leaves one open forever, holding
 * its doctor at capacity and its clinical record unsealed. Closing them
 * releases the capacity and — because every terminal transition seals (D23) —
 * schedules the record for destruction, which is where it should have been all
 * along.
 *
 * Two things this deliberately does not do.
 *
 * **It does not delete anything.** 131 of the 133 carry a successful payment,
 * with revenue allocations and audit entries behind them. Deleting the
 * consultations would take the money records with them and leave the demo
 * analytics, payouts and reconciliation describing a world that never
 * existed.
 *
 * **It does not write states directly.** Every move goes through
 * `transition()`, so the state machine refuses anything illegal, the state
 * events are written, capacity held by a stranded assignment is released, and
 * the whole sweep appears in the audit log as what it was. `REASSIGNING` has
 * no legal edge to a terminal state, so those go through
 * `WAITING_FOR_DOCTOR` first — two real steps rather than one convenient
 * fiction.
 *
 * `ABANDONED` rather than `CANCELLED`: nobody cancelled these. The patient was
 * never reached and went home, which is what abandonment means.
 *
 * Refuses to touch a row that is not demo data, refuses anything touched in
 * the last few minutes so live work is never swept up, and refuses to run in
 * production at all.
 */

/**
 * States a consultation cannot leave without help.
 *
 * `PENDING_PAYMENT` and `ACTIVATED` are deliberately absent: those expire on
 * their own through `expire-pending-payments` and the token sweep, and a
 * script that closed them would be papering over a job that had stopped.
 */
const STUCK = ['WAITING_FOR_DOCTOR', 'REASSIGNING', 'DOCTOR_ACCEPTED', 'IN_PROGRESS'] as const;

/** Nothing touched this recently is stale, whatever state it is in. */
const IDLE_MINUTES = Number(process.env.STALE_IDLE_MINUTES ?? 15);

const REASON = 'Stale demo consultation closed in Phase 10 — it could not end on its own';

async function main(): Promise<void> {
  const env = getEnv();

  if (env.NODE_ENV === 'production') {
    console.error('Refusing to close consultations in production.');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    const idleBefore = new Date(Date.now() - IDLE_MINUTES * 60 * 1000);

    const candidates = await prisma.consultation.findMany({
      where: { state: { in: [...STUCK] } },
      select: {
        id: true,
        publicId: true,
        state: true,
        isDemo: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // A consultation someone is in the middle of is not stale, and sweeping it
    // would end a live call. The guard is on `updatedAt` rather than
    // `createdAt`: a long consultation is old and busy at the same time.
    const busy = candidates.filter((row) => row.updatedAt > idleBefore);
    const stranded = candidates.filter((row) => row.updatedAt <= idleBefore);

    const real = stranded.filter((row) => !row.isDemo);
    if (real.length > 0) {
      console.error(
        `Refusing: ${real.length} of these are not demo rows.\n` +
          real.map((row) => `  ${row.publicId} (${row.state})`).join('\n'),
      );
      process.exit(1);
    }

    if (busy.length > 0) {
      console.log(
        `leaving ${busy.length} alone — touched within the last ${IDLE_MINUTES} minutes`,
      );
    }

    if (stranded.length === 0) {
      console.log('Nothing stale to close.');
      return;
    }

    const byState = new Map<string, number>();
    for (const row of stranded) byState.set(row.state, (byState.get(row.state) ?? 0) + 1);

    console.log(`closing ${stranded.length} stale demo consultation(s)`);
    for (const [state, count] of byState) console.log(`  ${state.padEnd(20)} ${count}`);
    console.log('');

    let closed = 0;
    const failures: string[] = [];

    for (const row of stranded) {
      try {
        // REASSIGNING cannot reach a terminal state directly.
        if (row.state === 'REASSIGNING') {
          await transition(row.id, 'WAITING_FOR_DOCTOR', {
            actorType: 'SYSTEM',
            reason: REASON,
          });
        }

        await transition(row.id, 'ABANDONED', { actorType: 'SYSTEM', reason: REASON });
        closed += 1;
      } catch (error) {
        failures.push(`${row.publicId} (${row.state}): ${(error as Error).message}`);
      }
    }

    const remaining = await prisma.consultation.count({
      where: { state: { in: [...STUCK] } },
    });

    console.log(`closed:    ${closed}`);
    if (failures.length > 0) {
      console.log(`refused:   ${failures.length}`);
      for (const failure of failures) console.log(`  ${failure}`);
    }
    console.log(`still open: ${remaining}`);

    if (remaining > busy.length && failures.length === 0) {
      console.log('\nSome arrived while this ran — a live system is allowed to have work in it.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
