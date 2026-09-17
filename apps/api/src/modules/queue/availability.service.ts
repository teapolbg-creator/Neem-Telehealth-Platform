import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getBooleanSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { checkStandingEligibility } from '../../domain/queue-scoring.ts';
import { collectCandidates, type CandidatePool } from './allocation.service.ts';
import type { ProfessionalDiscipline } from '@neem/contracts';

/**
 * Whether a consultation may be started at all (decision D50).
 *
 * The first live consultation was paid for at 04:00 and waited in the queue
 * for a doctor who was not on shift. Nothing had stopped the pharmacy taking
 * the money. This is that stop.
 *
 * It reuses the allocator's own candidate construction and its own standing
 * gates, rather than restating them, so "on duty" here and "eligible" in the
 * queue cannot drift apart.
 */

/** A consultation id that matches no row, so no doctor counts as already offered. */
const NO_CONSULTATION = '00000000-0000-0000-0000-000000000000';

/**
 * At least one doctor who is ACTIVE, paid up, licensed and on a confirmed
 * shift covering now. Presence and capacity are deliberately not required:
 * the queue waits for those, and the wait limit covers the patient.
 */
export async function isAnyDoctorOnDuty(
  db: Db = getPrisma(),
  clock: Clock = systemClock,
  pool: CandidatePool = {},
): Promise<boolean> {
  const candidates = await collectCandidates(NO_CONSULTATION, db, clock, pool);
  return candidates.some((candidate) => checkStandingEligibility(candidate).eligible);
}

/**
 * Refuses when no doctor is on duty and `consultation.requireDoctorOnDuty` is
 * on. A hard block rather than a warning: a counter under pressure clicks
 * through warnings, and the cost falls on a patient who has already paid.
 */
export async function assertDoctorOnDuty(
  db: Db = getPrisma(),
  clock: Clock = systemClock,
  pool: CandidatePool = {},
): Promise<void> {
  if (!(await getBooleanSetting(SETTING_KEYS.REQUIRE_DOCTOR_ON_DUTY, db))) return;
  if (await isAnyDoctorOnDuty(db, clock, pool)) return;

  /*
   * Named, because "no doctor is on duty" is wrong and confusing when the
   * patient asked for a dietitian and there are doctors working (v2).
   */
  const profession = PROFESSION_LABEL[pool.discipline ?? 'DOCTOR'];

  throw errors.businessRule(
    `No ${profession} is on duty right now, so a consultation cannot be started. Please try again during clinic hours.`,
  );
}

const PROFESSION_LABEL: Record<ProfessionalDiscipline, string> = {
  DOCTOR: 'doctor',
  DIETITIAN: 'dietitian',
  TRAINER: 'trainer',
};
