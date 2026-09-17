import type { PrismaClient } from '@prisma/client';
import {
  getPrisma,
  isUniqueConstraintError,
  withWriteConflictRetry,
  type Db,
} from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { addSeconds, systemClock, type Clock } from '../../lib/clock.ts';
import { getLogger } from '../../lib/logger.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { getIntSetting, getNumberSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { transition } from '../consultation/consultation.service.ts';
import { emitToConsultation, emitToDoctor, emitToAdmins } from '../realtime/realtime.service.ts';
import { notify } from '../notification/notification.service.ts';
import {
  isLanguageStarved,
  rankDoctors,
  type DoctorCandidate,
  type QueueWeights,
  type RankingResult,
} from '../../domain/queue-scoring.ts';
import { originName } from '../../domain/consultation-origin.ts';
import type { ProfessionalDiscipline } from '@neem/contracts';

/**
 * The allocation engine (spec §28, §29, §30).
 *
 * Consultations are offered to one doctor at a time, chosen by score. The
 * doctor has a configurable window — 90 seconds by default — to accept.
 *
 * **There is no decline.** Doctors cannot reject an assigned consultation
 * (spec §30, answers doc Q19). Not answering is not a decline either: it
 * records a missed response against their quality data and moves the
 * consultation on. No route in this module or its routes file accepts a
 * rejection.
 */

export async function loadQueueWeights(db: Db = getPrisma()): Promise<QueueWeights> {
  const [language, availability, workload, responseTime, recentCount, quality] = await Promise.all([
    getNumberSetting(SETTING_KEYS.QUEUE_WEIGHT_LANGUAGE, db),
    getNumberSetting(SETTING_KEYS.QUEUE_WEIGHT_AVAILABILITY, db),
    getNumberSetting(SETTING_KEYS.QUEUE_WEIGHT_WORKLOAD, db),
    getNumberSetting(SETTING_KEYS.QUEUE_WEIGHT_RESPONSE_TIME, db),
    getNumberSetting(SETTING_KEYS.QUEUE_WEIGHT_RECENT_COUNT, db),
    getNumberSetting(SETTING_KEYS.QUEUE_WEIGHT_QUALITY, db),
  ]);

  return { language, availability, workload, responseTime, recentCount, quality };
}

/**
 * Which professionals are in the running at all (v2).
 *
 * Discipline is not an eligibility score, it is a different profession: a
 * patient who booked a dietitian must never be offered a doctor, however well
 * that doctor ranks. So it narrows the pool rather than joining the ranking.
 *
 * The roster — `ProfessionalService`, who is signed up to deliver what —
 * applies to a clinic's services and not to general practice. Joining the
 * weight-loss clinic is an act somebody performs; being a doctor who takes
 * general consultations is the default, and requiring a roster row for that
 * would empty the pool for every professional already on the platform.
 */
export interface CandidatePool {
  discipline?: ProfessionalDiscipline;
  /**
   * A service whose clinic somebody has to have joined (v2).
   *
   * Set for a clinic consultation and left alone for general practice, so a
   * patient who booked the weight-loss clinic reaches a professional who
   * actually works in it rather than anyone of the right discipline.
   */
  rosteredFor?: string;
  /**
   * The professional a patient booked by name, for an appointment (v2).
   *
   * Two things follow from it. The pool is that one person — nobody else may
   * take a consultation somebody paid to have with them. And they count as on
   * duty for it, because the appointment IS their commitment to that minute;
   * the shift rota is how the queue finds somebody who made no such promise,
   * and asking for both would let a consultation booked a week ago go to
   * nobody.
   *
   * Everything else still applies. A professional who is suspended, whose
   * licence has lapsed, who is not online or who is at capacity is not offered
   * it — the consultation waits, and the wait limit protects the patient (D50).
   */
  appointmentWith?: string;
}

/**
 * Gathers the pool for one consultation.
 *
 * Reads presence, shifts, subscriptions and performance in one pass. The pure
 * ranker then decides — this function makes no eligibility judgements of its
 * own, so there is exactly one place the rules live.
 */
export async function collectCandidates(
  consultationId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
  pool: CandidatePool = {},
): Promise<DoctorCandidate[]> {
  const now = clock.now();
  const heartbeatCutoff = new Date(now.getTime() - 90_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const serviceDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const [doctors, offered] = await Promise.all([
    db.doctor.findMany({
      where: {
        status: { in: ['ACTIVE', 'SUSPENDED', 'APPROVED'] },
        /*
         * Always narrowed, never left open. A consultation with no service is
         * one the counter created, and the counter sells a doctor — which is
         * also what every professional on the platform before v2 is.
         */
        discipline: pool.discipline ?? 'DOCTOR',
        ...(pool.appointmentWith ? { id: pool.appointmentWith } : {}),
        ...(pool.rosteredFor
          ? { services: { some: { serviceId: pool.rosteredFor, isActive: true } } }
          : {}),
      },
      include: {
        languages: { include: { language: { select: { code: true } } } },
        presence: true,
        subscriptions: { orderBy: { periodEnd: 'desc' }, take: 1 },
        shiftAssignments: {
          where: { serviceDate, status: 'CONFIRMED' },
          include: { shiftDefinition: true },
        },
        qualityScores: { orderBy: { computedAt: 'desc' }, take: 1 },
        assignments: {
          where: { offeredAt: { gte: dayAgo } },
          select: { offeredAt: true, acceptedAt: true, result: true },
        },
        consultations: {
          where: { completedAt: { gte: dayAgo } },
          select: { id: true },
        },
      },
    }),
    db.consultationAssignment.findMany({
      where: { consultationId },
      select: { doctorId: true },
    }),
  ]);

  const alreadyOffered = new Set(offered.map((entry) => entry.doctorId));

  return doctors.map((doctor) => {
    const accepted = doctor.assignments.filter((assignment) => assignment.acceptedAt !== null);
    const latencies = accepted
      .map((a) => (a.acceptedAt!.getTime() - a.offeredAt.getTime()) / 1000)
      .sort((a, b) => a - b);

    const medianResponseSeconds =
      latencies.length === 0 ? null : (latencies[Math.floor(latencies.length / 2)] ?? null);

    const subscription = doctor.subscriptions[0];
    const lastOffer = doctor.assignments
      .map((assignment) => assignment.offeredAt)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    // A doctor is "on shift" when they hold a CONFIRMED assignment covering
    // now. Assigned-but-unconfirmed does not count: the doctor has not agreed.
    const onShift =
      pool.appointmentWith === doctor.id ||
      doctor.shiftAssignments.some((assignment) =>
        shiftCoversNow(assignment.shiftDefinition.startsAt, assignment.shiftDefinition.endsAt, now),
      );

    return {
      doctorId: doctor.id,
      languageCodes: doctor.languages.map((entry) => entry.language.code),
      primaryLanguageCode: doctor.languages.find((entry) => entry.isPrimary)?.language.code ?? null,
      status: doctor.status,
      subscriptionUsable:
        !subscription || subscription.status === 'ACTIVE' || subscription.status === 'GRACE',
      licenceValid: !doctor.mdcExpiresAt || doctor.mdcExpiresAt > now,
      onShift,
      present: Boolean(
        doctor.presence?.lastHeartbeatAt && doctor.presence.lastHeartbeatAt >= heartbeatCutoff,
      ),
      currentLoad: doctor.presence?.currentLoad ?? 0,
      maxLoad: doctor.presence?.maxLoad ?? 1,
      servedThisShift: accepted.length,
      completedLast24h: doctor.consultations.length,
      medianResponseSeconds,
      qualityScore: doctor.qualityScores[0] ? Number(doctor.qualityScores[0].score) : null,
      lastOfferedAt: lastOffer ?? null,
      alreadyOffered: alreadyOffered.has(doctor.id),
    } satisfies DoctorCandidate;
  });
}

/**
 * The service somebody must be rostered for, or nothing (v2).
 *
 * General practice is the default and needs no roster; a clinic is something
 * a professional joins, and only its members are offered its patients.
 */
export function clinicRoster(
  service: { id: string; clinic: string } | null | undefined,
): string | undefined {
  if (!service || service.clinic === 'GENERAL') return undefined;
  return service.id;
}

function shiftCoversNow(startsAt: string, endsAt: string, now: Date): boolean {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [startHour = 0, startMinute = 0] = startsAt.split(':').map(Number);
  const [endHour = 0, endMinute = 0] = endsAt.split(':').map(Number);

  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;

  // A shift that crosses midnight covers two ranges of the clock.
  return end > start ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export interface OfferResult {
  offered: boolean;
  doctorId?: string;
  respondByAt?: Date;
  attemptNumber?: number;
  reason?: 'NO_ELIGIBLE_DOCTOR' | 'NOT_WAITING' | 'ALREADY_ASSIGNED';
  languageStarved?: boolean;
}

/**
 * Offers a waiting consultation to the best-scoring eligible doctor.
 *
 * When nobody is eligible the consultation STAYS in the queue — it is never
 * failed or discarded — and an admin alert is raised if the cause is language
 * (spec §29, §37).
 */
export async function offerNextDoctor(
  consultationId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<OfferResult> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    include: {
      language: true,
      queueEntry: true,
      pharmacy: { select: { name: true } },
      service: { select: { id: true, discipline: true, clinic: true } },
      appointment: { select: { doctorId: true, state: true } },
    },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');

  if (consultation.state !== 'WAITING_FOR_DOCTOR' && consultation.state !== 'REASSIGNING') {
    return { offered: false, reason: 'NOT_WAITING' };
  }
  if (!consultation.language) {
    return { offered: false, reason: 'NOT_WAITING' };
  }

  const [weights, windowSeconds, maxAttempts] = await Promise.all([
    loadQueueWeights(db),
    getIntSetting(SETTING_KEYS.QUEUE_RESPONSE_WINDOW_SECONDS, db),
    getIntSetting(SETTING_KEYS.QUEUE_MAX_OFFER_ATTEMPTS, db),
  ]);

  const candidates = await collectCandidates(consultationId, db, clock, {
    discipline: consultation.service?.discipline,
    rosteredFor: clinicRoster(consultation.service),
    // The patient chose this person and paid for them; nobody else may take it.
    appointmentWith: consultation.appointment?.doctorId,
  });
  const ranking = rankDoctors(candidates, consultation.language.code, weights, clock.now());

  if (ranking.ranked.length === 0) {
    await handleNoEligibleDoctor(consultation, ranking, db, clock);
    return {
      offered: false,
      reason: 'NO_ELIGIBLE_DOCTOR',
      languageStarved: isLanguageStarved(ranking.excluded),
    };
  }

  const best = ranking.ranked[0]!;
  const now = clock.now();
  const respondByAt = addSeconds(now, windowSeconds);
  const attemptNumber = (consultation.queueEntry?.offerAttempts ?? 0) + 1;

  try {
    /**
     * Retried on a write conflict: the ten-second queue sweep and an
     * administrator's manual reallocation can be offering the same
     * consultation at the same moment, and InnoDB breaks that tie by rolling
     * one of them back. Without the retry the offer was lost and the patient
     * waited on — see `withWriteConflictRetry`.
     */
    await withWriteConflictRetry(() =>
      db.$transaction(async (tx) => {
        await tx.consultationAssignment.create({
          data: {
            consultationId,
            doctorId: best.doctorId,
            offeredAt: now,
            respondByAt,
            result: 'PENDING',
            score: best.score,
            // Stored so an allocation can be explained after the fact — which
            // is what makes fairness auditable rather than asserted (spec §28).
            scoreBreakdown: best.breakdown as never,
            attemptNumber,
          },
        });

        await tx.consultationQueueEntry.update({
          where: { consultationId },
          data: { state: 'OFFERING', offerAttempts: attemptNumber },
        });

        await tx.consultation.update({
          where: { id: consultationId },
          data: { doctorId: best.doctorId },
        });

        await transition(
          consultationId,
          'ASSIGNED',
          { actorType: 'SYSTEM', reason: `offered_to_doctor_attempt_${attemptNumber}` },
          tx,
          clock,
        );
      }),
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { offered: false, reason: 'ALREADY_ASSIGNED' };
    }
    throw error;
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.DOCTOR_ASSIGNED,
      actorType: 'SYSTEM',
      entityType: 'consultation',
      entityId: consultationId,
      metadata: {
        doctorId: best.doctorId,
        score: best.score,
        attemptNumber,
        eligibleCount: ranking.ranked.length,
      },
    },
    db,
  );

  // The doctor is told there is an offer and how long they have; the patient
  // is told only that a doctor is being contacted.
  emitToDoctor(best.doctorId, 'queue.offer', {
    consultationPublicId: consultation.publicId,
    respondByAt: respondByAt.toISOString(),
    windowSeconds,
  });

  /**
   * Also on SMS.
   *
   * The socket reaches a doctor watching the screen. This one reaches the
   * doctor who stepped away, and the 90-second window is short enough that
   * the difference decides whether the patient is seen.
   *
   * Not awaited: an unreachable gateway must not hold up an allocation.
   */
  void notify({
    templateCode: 'doctor.consultation.offered',
    recipient: { type: 'DOCTOR', doctorId: best.doctorId },
    variables: { pharmacyName: originName(consultation.pharmacy), seconds: windowSeconds },
  });
  emitToConsultation(consultation.publicId, 'consultation.state_changed', { state: 'ASSIGNED' });

  if (attemptNumber >= maxAttempts) {
    emitToAdmins('admin.alert', {
      kind: 'REPEATED_NO_RESPONSE',
      consultationPublicId: consultation.publicId,
      attempts: attemptNumber,
    });
  }

  return { offered: true, doctorId: best.doctorId, respondByAt, attemptNumber };
}

/**
 * Handles a queue with nobody eligible.
 *
 * The consultation stays WAITING. An admin alert fires when the cause is a
 * language gap, because that is the case an administrator can actually act on
 * — by finding a doctor who speaks it (spec §29, answers doc Q9: "A + C").
 */
async function handleNoEligibleDoctor(
  consultation: {
    id: string;
    publicId: string;
    pharmacyId: string | null;
    language: { code: string; label: string } | null;
  },
  ranking: RankingResult,
  db: PrismaClient,
  clock: Clock,
): Promise<void> {
  const entry = await db.consultationQueueEntry.findUnique({
    where: { consultationId: consultation.id },
  });
  if (!entry) return;

  await db.consultationQueueEntry.update({
    where: { consultationId: consultation.id },
    data: { state: 'WAITING' },
  });

  const starved = isLanguageStarved(ranking.excluded);
  const now = clock.now();

  // Alert once per condition, not on every sweep — a five-second poll would
  // otherwise bury an admin in duplicates of the same problem.
  if (starved && !entry.noMatchAlertedAt) {
    await db.consultationQueueEntry.update({
      where: { consultationId: consultation.id },
      data: { noMatchAlertedAt: now },
    });

    emitToAdmins('admin.alert', {
      kind: 'NO_LANGUAGE_MATCH',
      consultationPublicId: consultation.publicId,
      languageCode: consultation.language?.code,
      languageLabel: consultation.language?.label,
    });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.QUEUE_NO_LANGUAGE_MATCH,
        actorType: 'SYSTEM',
        entityType: 'consultation',
        entityId: consultation.id,
        outcome: 'FAILURE',
        metadata: { languageCode: consultation.language?.code },
      },
      db,
    );

    /**
     * The socket alert above reaches an administrator who is signed in and
     * looking. These reach the ones who are not, and the pharmacy holding the
     * patient who is still standing at the counter — who could otherwise only
     * find out by watching the screen.
     *
     * Guarded by the same `noMatchAlertedAt` flag as the socket alert, so a
     * five-second sweep does not send this repeatedly.
     */
    const waitedMinutes = Math.max(
      1,
      Math.round((now.getTime() - entry.enqueuedAt.getTime()) / 60_000),
    );

    void notify({
      templateCode: 'admin.queue.no-language-match',
      recipient: { type: 'ADMIN' },
      variables: {
        consultationReference: consultation.publicId,
        minutes: waitedMinutes,
        language: consultation.language?.label ?? 'the requested language',
      },
    });

    // A patient-direct consultation has no counter waiting on it (v2).
    if (consultation.pharmacyId) {
      void notify({
        templateCode: 'pharmacy.consultation.no-doctor',
        recipient: { type: 'PHARMACY', pharmacyId: consultation.pharmacyId },
        variables: { consultationReference: consultation.publicId },
      });
    }
  }

  const delaySeconds = await getIntSetting(SETTING_KEYS.QUEUE_DELAY_ALERT_SECONDS, db);
  const waitedSeconds = (now.getTime() - entry.enqueuedAt.getTime()) / 1000;

  if (waitedSeconds >= delaySeconds && !entry.delayAlertedAt) {
    await db.consultationQueueEntry.update({
      where: { consultationId: consultation.id },
      data: { delayAlertedAt: now },
    });

    emitToAdmins('admin.alert', {
      kind: 'QUEUE_DELAY',
      consultationPublicId: consultation.publicId,
      waitedSeconds: Math.round(waitedSeconds),
    });
  }
}

/**
 * A doctor accepting an offer.
 *
 * Guarded so a doctor cannot accept an offer that was not theirs, that has
 * already lapsed, or that another doctor has taken.
 */
export async function acceptOffer(
  consultationPublicId: string,
  doctorId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ accepted: boolean; reason?: string }> {
  const consultation = await db.consultation.findUnique({
    where: { publicId: consultationPublicId },
    include: {
      assignments: {
        where: { doctorId, result: 'PENDING' },
        orderBy: { offeredAt: 'desc' },
        take: 1,
      },
    },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');

  const assignment = consultation.assignments[0];
  if (!assignment) {
    throw errors.notFound('You do not have an open offer for this consultation.');
  }

  const now = clock.now();
  if (assignment.respondByAt <= now) {
    return { accepted: false, reason: 'The response window for this consultation has passed.' };
  }
  if (consultation.state !== 'ASSIGNED') {
    return { accepted: false, reason: `This consultation is ${consultation.state}.` };
  }

  await db.$transaction(async (tx) => {
    // Guard against a race with the timeout sweep: only claim it if still PENDING.
    const claimed = await tx.consultationAssignment.updateMany({
      where: { id: assignment.id, result: 'PENDING' },
      data: { result: 'ACCEPTED', acceptedAt: now },
    });
    if (claimed.count === 0) {
      throw errors.conflict('That offer is no longer open.');
    }

    await tx.consultationQueueEntry.update({
      where: { consultationId: consultation.id },
      data: { state: 'ASSIGNED', resolvedAt: now },
    });

    await tx.doctorPresence.updateMany({
      where: { doctorId },
      data: { currentLoad: { increment: 1 } },
    });

    await tx.doctorPerformanceEvent.create({
      data: {
        doctorId,
        type: 'COMPLETED',
        consultationId: consultation.id,
        numericValue: (now.getTime() - assignment.offeredAt.getTime()) / 1000,
        occurredAt: now,
      },
    });

    await transition(
      consultation.id,
      'DOCTOR_ACCEPTED',
      { actorType: 'DOCTOR', actorId: doctorId, reason: 'offer_accepted' },
      tx,
      clock,
    );
  });

  emitToConsultation(consultation.publicId, 'consultation.state_changed', {
    state: 'DOCTOR_ACCEPTED',
  });

  /**
   * The counter is told a doctor has picked the consultation up, and the
   * patient is told they can join.
   *
   * The patient's waiting-room screen polls and will show this anyway — but
   * only to someone watching it. A patient who put the phone down to wait, at
   * a counter, needs the SMS.
   */
  if (consultation.pharmacyId) {
    void notify({
      templateCode: 'pharmacy.consultation.doctor-assigned',
      recipient: { type: 'PHARMACY', pharmacyId: consultation.pharmacyId },
      variables: { consultationReference: consultation.publicId },
    });
  }

  void notify({
    templateCode: 'patient.consultation.ready',
    recipient: { type: 'PATIENT', consultationId: consultation.id },
  });

  return { accepted: true };
}

export interface TimeoutSweepResult {
  missed: number;
  reoffered: number;
}

/**
 * Enforces the response window (spec §30).
 *
 * Runs server-side on a timer. The doctor's countdown is presentation only —
 * a client that never ticks, or one deliberately paused, changes nothing.
 */
export async function enforceResponseWindow(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<TimeoutSweepResult> {
  const now = clock.now();

  const lapsed = await db.consultationAssignment.findMany({
    where: { result: 'PENDING', respondByAt: { lt: now } },
    include: {
      consultation: {
        select: {
          id: true,
          publicId: true,
          state: true,
          pharmacy: { select: { name: true } },
        },
      },
    },
  });

  let missed = 0;
  let reoffered = 0;

  for (const assignment of lapsed) {
    try {
      await db.$transaction(async (tx) => {
        const claimed = await tx.consultationAssignment.updateMany({
          where: { id: assignment.id, result: 'PENDING' },
          data: { result: 'MISSED', missedAt: now },
        });
        // The doctor accepted in the same instant; leave their acceptance alone.
        if (claimed.count === 0) return;

        // Recorded against the doctor's quality data (spec §30).
        await tx.doctorPerformanceEvent.create({
          data: {
            doctorId: assignment.doctorId,
            type: 'MISSED_RESPONSE',
            consultationId: assignment.consultationId,
            occurredAt: now,
          },
        });

        if (assignment.consultation.state === 'ASSIGNED') {
          await tx.consultation.update({
            where: { id: assignment.consultationId },
            data: { doctorId: null },
          });
          await transition(
            assignment.consultationId,
            'REASSIGNING',
            { actorType: 'SYSTEM', reason: 'doctor_missed_response_window' },
            tx,
            clock,
          );
        }
      });

      missed += 1;

      await recordAudit(
        {
          action: AUDIT_ACTIONS.DOCTOR_MISSED_RESPONSE,
          actorType: 'SYSTEM',
          entityType: 'consultation',
          entityId: assignment.consultationId,
          outcome: 'FAILURE',
          metadata: { doctorId: assignment.doctorId, attemptNumber: assignment.attemptNumber },
        },
        db,
      );

      emitToDoctor(assignment.doctorId, 'queue.offer_expired', {
        consultationPublicId: assignment.consultation.publicId,
      });

      /**
       * Told that it lapsed, and that it has gone elsewhere.
       *
       * A missed response is recorded against the doctor's quality data, so
       * the one person who should certainly know it happened is the doctor it
       * was recorded against. The message names the pharmacy and nothing about
       * the patient.
       */
      void notify({
        templateCode: 'doctor.consultation.missed',
        recipient: { type: 'DOCTOR', doctorId: assignment.doctorId },
        variables: { pharmacyName: originName(assignment.consultation.pharmacy) },
      });

      // Straight back into allocation; the patient is never left stranded.
      const result = await offerNextDoctor(assignment.consultationId, db, clock);
      if (result.offered) reoffered += 1;
    } catch (error) {
      getLogger().error(
        { err: error, assignmentId: assignment.id },
        'failed to process a lapsed consultation offer',
      );
    }
  }

  return { missed, reoffered };
}

/**
 * Sweeps waiting consultations that have no live offer.
 *
 * Covers the case where nothing was eligible at enqueue time and a doctor has
 * since come online — without this, such a consultation would wait for an
 * event that never comes.
 */
export async function processWaitingQueue(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const waiting = await db.consultationQueueEntry.findMany({
    where: { state: { in: ['WAITING'] } },
    include: { consultation: { select: { id: true, state: true } } },
    orderBy: { enqueuedAt: 'asc' },
    take: 50,
  });

  let offered = 0;

  for (const entry of waiting) {
    if (
      entry.consultation.state !== 'WAITING_FOR_DOCTOR' &&
      entry.consultation.state !== 'REASSIGNING'
    ) {
      continue;
    }

    try {
      const result = await offerNextDoctor(entry.consultationId, db, clock);
      if (result.offered) offered += 1;
    } catch (error) {
      getLogger().error(
        { err: error, consultationId: entry.consultationId },
        'failed to offer a waiting consultation',
      );
    }
  }

  return offered;
}
