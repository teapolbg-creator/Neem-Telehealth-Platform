import '../src/config/load-dotenv.ts';
import { PrismaClient } from '@prisma/client';
import { getEnv } from '../src/config/env.ts';
import { transition } from '../src/modules/consultation/consultation.service.ts';

/**
 * Closes demo consultations left stranded in the queue.
 *
 * Five days of end-to-end runs left 133 consultations sitting in
 * `WAITING_FOR_DOCTOR` and `REASSIGNING`. Nothing is wrong with the product
 * for holding them — spec §37 is explicit that a paid consultation is never
 * silently discarded, and scenario 3 asserts exactly that. But a doctor
 * **cannot decline an offer** (spec §30), so any doctor coming online is
 * immediately committed to one of them, which makes the queue impossible to
 * exercise through the UI: Scenario 1 completed a stranger's consultation and
 * then waited forever for its own patient.
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
 * Refuses to touch a row that is not demo data, and refuses to run in
 * production at all.
 */

const REASON = 'Stale demo queue closed in Phase 10 — never reached a doctor';

async function main(): Promise<void> {
  const env = getEnv();

  if (env.NODE_ENV === 'production') {
    console.error('Refusing to close consultations in production.');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    const stranded = await prisma.consultation.findMany({
      where: { state: { in: ['WAITING_FOR_DOCTOR', 'REASSIGNING'] } },
      select: { id: true, publicId: true, state: true, isDemo: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const real = stranded.filter((row) => !row.isDemo);
    if (real.length > 0) {
      console.error(
        `Refusing: ${real.length} of these are not demo rows.\n` +
          real.map((row) => `  ${row.publicId} (${row.state})`).join('\n'),
      );
      process.exit(1);
    }

    if (stranded.length === 0) {
      console.log('Nothing stranded in the queue.');
      return;
    }

    console.log(`closing ${stranded.length} stranded demo consultation(s)\n`);

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
      where: { state: { in: ['WAITING_FOR_DOCTOR', 'REASSIGNING'] } },
    });

    console.log(`closed:    ${closed}`);
    if (failures.length > 0) {
      console.log(`refused:   ${failures.length}`);
      for (const failure of failures) console.log(`  ${failure}`);
    }
    console.log(`remaining in the queue: ${remaining}`);

    if (remaining > 0 && failures.length === 0) {
      console.log(
        '\nSome arrived while this ran — a live queue is allowed to have work in it.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
