import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../../db/prisma.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getLogger } from '../../lib/logger.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { cancelConsultation } from '../consultation/consultation.service.ts';

/**
 * Ends a consultation no doctor has taken within the wait limit (decision D50).
 *
 * Until this existed, a paid consultation with no eligible doctor waited
 * indefinitely: an admin delay alert after five minutes, and otherwise nothing.
 * A patient at the counter at night had no end to the wait but walking away.
 *
 * Measured from the queue entry's `enqueuedAt` — the first time the patient
 * joined the queue — not the consultation's `queuedAt`, which is reset every
 * time an offer lapses and is reassigned.
 *
 * Only WAITING_FOR_DOCTOR and REASSIGNING are ended. ASSIGNED is left alone: an
 * offer is in a doctor's hands for at most the response window, and pulling it
 * mid-offer would race their accept. It is caught on the next sweep once the
 * offer lapses.
 *
 * Cancelling a paid consultation raises the refund request (see
 * `cancelConsultation`), so the patient is never left paid and unserved with
 * nobody told. The refund itself is an administrator's decision.
 */
export async function cancelUnservedConsultations(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const maxWaitSeconds = await getIntSetting(SETTING_KEYS.QUEUE_MAX_WAIT_SECONDS, db);
  if (maxWaitSeconds <= 0) return 0;

  const cutoff = new Date(clock.now().getTime() - maxWaitSeconds * 1000);

  const overdue = await db.consultationQueueEntry.findMany({
    where: {
      enqueuedAt: { lt: cutoff },
      consultation: { state: { in: ['WAITING_FOR_DOCTOR', 'REASSIGNING'] } },
    },
    select: { id: true, consultation: { select: { publicId: true } } },
    orderBy: { enqueuedAt: 'asc' },
    take: 50,
  });

  let cancelled = 0;

  for (const entry of overdue) {
    try {
      await cancelConsultation(
        entry.consultation.publicId,
        'No doctor became available within the queue wait limit.',
        { actorType: 'SYSTEM' },
        db,
        clock,
      );
      await db.consultationQueueEntry.update({
        where: { id: entry.id },
        data: { state: 'ABANDONED', resolvedAt: clock.now() },
      });
      cancelled += 1;
    } catch (error) {
      getLogger().warn(
        { err: error, consultationPublicId: entry.consultation.publicId },
        'could not cancel a consultation past the queue wait limit',
      );
    }
  }

  return cancelled;
}
