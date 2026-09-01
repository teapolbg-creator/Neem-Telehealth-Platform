import type { ConsultationState, PrismaClient } from '@prisma/client';
import type { ActorType } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { generateConsultationReference } from '../../lib/crypto.ts';
import { addSeconds, systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { getIntSetting, getSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { applyDiscount, computeDiscount } from '../../lib/money.ts';
import {
  assertTransition,
  canPharmacyCancel,
  InvalidConsultationTransition,
  isPaid,
  isTerminal,
} from '../../domain/consultation-state.ts';
import { pharmacyCanInitiateConsultations } from '../../domain/account-state.ts';
import { releaseCapacity } from '../queue/presence.service.ts';
import { sealClinicalRecord } from '../retention/clinical-record.service.ts';

/**
 * Consultation lifecycle (spec §10, §16, §81).
 *
 * Every state change goes through `transition()`, which enforces the state
 * machine and writes an immutable event. Nothing in this codebase assigns
 * `consultation.state` directly.
 */

export interface TransitionContext {
  actorType: ActorType;
  actorId?: string | null;
  reason?: string;
  correlationId?: string;
}

/**
 * Moves a consultation to a new state, refusing anything the state machine
 * disallows and recording both outcomes.
 *
 * Takes a transaction client when the caller has one, so a state change and
 * the work that justifies it commit together — a consultation must never be
 * PAID without its payment row, nor COMPLETED without its purge.
 */
export async function transition(
  consultationId: string,
  to: ConsultationState,
  context: TransitionContext,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<ConsultationState> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    select: { id: true, state: true, doctorId: true },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');

  const from = consultation.state;

  try {
    assertTransition(from, to);
  } catch (error) {
    if (error instanceof InvalidConsultationTransition) {
      // Rejected attempts are recorded too: a repeated illegal transition is a
      // bug worth seeing in the audit trail, not a silent 409.
      await db.consultationStateEvent.create({
        data: {
          consultationId,
          fromState: from,
          toState: to,
          actorType: context.actorType,
          actorId: context.actorId ?? null,
          reason: context.reason ?? null,
          accepted: false,
        },
      });
      throw errors.invalidStateTransition(from, to, 'consultation');
    }
    throw error;
  }

  const now = clock.now();

  // Timestamps that belong to specific transitions, set here so no caller can
  // forget one and leave the permanent record incomplete.
  const timestamps: Record<string, Date> = {};
  if (to === 'ACTIVATED') timestamps.activatedAt = now;
  if (to === 'PATIENT_JOINED') timestamps.patientJoinedAt = now;
  if (to === 'WAITING_FOR_DOCTOR') timestamps.queuedAt = now;
  if (to === 'ASSIGNED') timestamps.assignedAt = now;
  if (to === 'IN_PROGRESS') timestamps.startedAt = now;
  if (to === 'COMPLETED') timestamps.completedAt = now;

  await db.consultation.update({
    where: { id: consultationId },
    data: { state: to, ...timestamps },
  });

  await db.consultationStateEvent.create({
    data: {
      consultationId,
      fromState: from,
      toState: to,
      actorType: context.actorType,
      actorId: context.actorId ?? null,
      reason: context.reason ?? null,
      accepted: true,
      occurredAt: now,
    },
  });

  /**
   * Give the doctor their capacity back once the consultation is over.
   *
   * Acceptance increments `currentLoad`; without this, it is never decremented
   * and every doctor is permanently at capacity after their first
   * consultation, so the queue quietly stops routing to anyone. Done here
   * rather than at each terminal call site precisely so no future path can
   * forget it.
   *
   * `GREATEST(currentLoad - 1, 0)` inside `releaseCapacity` makes a repeat
   * harmless, so a retried transition cannot drive the count negative.
   */
  if (consultation.doctorId && !isTerminal(from) && isTerminal(to)) {
    await releaseCapacity(consultation.doctorId, db);
  }

  /**
   * Seal the clinical record and schedule its destruction (decision D23).
   *
   * Here, for the same reason capacity is released here: a consultation can
   * reach a terminal state down several paths — completion, cancellation,
   * expiry, abandonment, refund — and every one of them must seal. Doing it at
   * each call site means the next path added forgets, and a record left
   * unsealed is one a doctor can still read.
   *
   * Idempotent, so a record already sealed keeps its original destruction
   * date. Re-sealing would quietly extend how long patient data is held.
   */
  if (!isTerminal(from) && isTerminal(to)) {
    await sealClinicalRecord(consultationId, db, clock);
  }

  return to;
}

export interface CreateConsultationInput {
  pharmacyId: string;
  promotionCode?: string;
}

/**
 * Creates a consultation in PENDING_PAYMENT.
 *
 * Price comes from settings, never a literal (spec §38). The payment deadline
 * is stamped here so the expiry sweep has something to act on even if payment
 * is never initiated (spec §35).
 */
export async function createConsultation(
  input: CreateConsultationInput,
  context: { actorId: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
) {
  const pharmacy = await db.pharmacy.findUnique({
    where: { id: input.pharmacyId },
    select: { id: true, status: true, name: true, isDemo: true },
  });
  if (!pharmacy) throw errors.notFound('Pharmacy not found.');

  // Spec §84 — only ACTIVE pharmacies may initiate consultations.
  if (!pharmacyCanInitiateConsultations(pharmacy.status)) {
    throw errors.businessRule(
      `This pharmacy is ${pharmacy.status} and cannot start consultations. Contact Neem administration.`,
    );
  }

  const priceMinor = await getIntSetting(SETTING_KEYS.CONSULTATION_PRICE_MINOR, db);
  const currency = String(await getSetting(SETTING_KEYS.CONSULTATION_CURRENCY, db));
  const windowSeconds = await getIntSetting(SETTING_KEYS.PAYMENT_WINDOW_SECONDS, db);

  const promotion = input.promotionCode
    ? await resolvePromotion(input.promotionCode, pharmacy.id, priceMinor, db, clock)
    : null;

  const discountMinor = promotion ? promotion.discountMinor : 0;
  const netMinor = applyDiscount(priceMinor, discountMinor);

  const consultation = await db.$transaction(async (tx) => {
    const created = await tx.consultation.create({
      data: {
        // Human-transcribable, because under D24 this is the patient's only
        // route back to their own record (see generateConsultationReference).
        publicId: generateConsultationReference(),
        pharmacyId: pharmacy.id,
        state: 'PENDING_PAYMENT',
        priceMinor,
        discountMinor,
        netMinor,
        currency,
        promotionId: promotion?.id ?? null,
        paymentDeadlineAt: addSeconds(clock.now(), windowSeconds),
        isDemo: pharmacy.isDemo,
      },
    });

    await tx.consultationStateEvent.create({
      data: {
        consultationId: created.id,
        fromState: null,
        toState: 'PENDING_PAYMENT',
        actorType: 'PHARMACY',
        actorId: context.actorId,
        accepted: true,
      },
    });

    if (promotion) {
      await tx.promotionRedemption.create({
        data: { promotionId: promotion.id, consultationId: created.id, discountMinor },
      });
      await tx.promotion.update({
        where: { id: promotion.id },
        data: { usedCount: { increment: 1 } },
      });
    }

    return created;
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CONSULTATION_CREATED,
      actorType: 'PHARMACY',
      actorId: context.actorId,
      entityType: 'consultation',
      entityId: consultation.id,
      correlationId: context.correlationId,
      metadata: { pharmacyId: pharmacy.id, priceMinor, discountMinor, netMinor },
    },
    db,
  );

  return consultation;
}

/**
 * Validates a promotional code and computes its discount (spec §42).
 *
 * Every rule is checked server-side; a client cannot supply a discount amount.
 */
async function resolvePromotion(
  code: string,
  pharmacyId: string,
  priceMinor: number,
  db: Db,
  clock: Clock,
): Promise<{ id: string; discountMinor: number } | null> {
  const promotion = await db.promotion.findUnique({ where: { code } });

  if (!promotion || !promotion.isActive) {
    throw errors.businessRule('That promotional code is not valid.');
  }

  const now = clock.now();
  if (promotion.startsAt > now || promotion.endsAt < now) {
    throw errors.businessRule('That promotional code is not currently active.');
  }
  if (promotion.maxUses !== null && promotion.usedCount >= promotion.maxUses) {
    throw errors.businessRule('That promotional code has reached its usage limit.');
  }
  if (promotion.pharmacyId && promotion.pharmacyId !== pharmacyId) {
    throw errors.businessRule('That promotional code is not available at this pharmacy.');
  }
  if (priceMinor < promotion.minAmountMinor) {
    throw errors.businessRule('That promotional code does not apply to this consultation.');
  }

  const discountMinor = computeDiscount(
    priceMinor,
    promotion.type === 'PERCENT'
      ? { type: 'PERCENT', valueBp: promotion.valueBp ?? 0 }
      : { type: 'FIXED', valueMinor: promotion.valueMinor ?? 0 },
  );

  return { id: promotion.id, discountMinor };
}

export async function getConsultationByPublicId(publicId: string, db: Db = getPrisma()) {
  const consultation = await db.consultation.findUnique({
    where: { publicId },
    include: {
      pharmacy: { select: { id: true, publicId: true, name: true } },
      doctor: { select: { publicId: true, fullName: true, specialty: true } },
      language: { select: { code: true, label: true } },
      patientSession: true,
      payments: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  if (!consultation) throw errors.notFound('Consultation not found.');
  return consultation;
}

/**
 * Cancels a consultation.
 *
 * A paid consultation is never silently discarded (spec §37): cancelling one
 * records that a refund is owed, which the admin then decides on. The refund
 * itself arrives with the financial engine in Phase 7.
 */
export async function cancelConsultation(
  publicId: string,
  reason: string,
  context: TransitionContext & { pharmacyId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ state: ConsultationState; refundOwed: boolean }> {
  const consultation = await db.consultation.findUnique({
    where: { publicId },
    select: { id: true, state: true, pharmacyId: true },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');

  if (context.pharmacyId && consultation.pharmacyId !== context.pharmacyId) {
    throw errors.notFound('Consultation not found.');
  }
  if (!canPharmacyCancel(consultation.state)) {
    throw errors.businessRule(
      `A consultation in ${consultation.state} cannot be cancelled. A doctor is already engaged with this patient.`,
    );
  }

  const refundOwed = isPaid(consultation.state);

  await db.$transaction(async (tx) => {
    await transition(consultation.id, 'CANCELLED', { ...context, reason }, tx, clock);
    await tx.consultationAccessToken.updateMany({
      where: { consultationId: consultation.id, revokedAt: null },
      data: { revokedAt: clock.now(), revokedReason: 'consultation_cancelled' },
    });
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CONSULTATION_STATE_CHANGED,
      actorType: context.actorType,
      actorId: context.actorId,
      entityType: 'consultation',
      entityId: consultation.id,
      correlationId: context.correlationId,
      metadata: { to: 'CANCELLED', refundOwed, reason },
    },
    db,
  );

  return { state: 'CANCELLED', refundOwed };
}

export interface ConsultationListFilters {
  pharmacyId?: string;
  doctorId?: string;
  states?: ConsultationState[];
  activeOnly?: boolean;
  limit: number;
  cursor?: string;
}

/**
 * Lists consultations.
 *
 * Returns operational fields only. Historical consultation access is
 * operational history, never medical history (spec §13) — there is no include
 * here for notes, vitals or tests, and after completion those rows no longer
 * exist anyway.
 */
export async function listConsultations(filters: ConsultationListFilters, db: Db = getPrisma()) {
  const ACTIVE_STATES: ConsultationState[] = [
    'PENDING_PAYMENT',
    'PAYMENT_PROCESSING',
    'PAYMENT_FAILED',
    'PAID',
    'ACTIVATED',
    'WAITING_FOR_PATIENT',
    'PATIENT_JOINED',
    'WAITING_FOR_DOCTOR',
    'ASSIGNED',
    'REASSIGNING',
    'DOCTOR_ACCEPTED',
    'IN_PROGRESS',
    'COMPLETING',
  ];

  const rows = await db.consultation.findMany({
    where: {
      ...(filters.pharmacyId ? { pharmacyId: filters.pharmacyId } : {}),
      ...(filters.doctorId ? { doctorId: filters.doctorId } : {}),
      ...(filters.states ? { state: { in: filters.states } } : {}),
      ...(filters.activeOnly ? { state: { in: ACTIVE_STATES } } : {}),
    },
    include: {
      doctor: { select: { publicId: true, fullName: true } },
      language: { select: { code: true, label: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: filters.limit + 1,
    ...(filters.cursor ? { cursor: { publicId: filters.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  return { items: page, nextCursor: hasMore ? page.at(-1)?.publicId : undefined, hasMore };
}
