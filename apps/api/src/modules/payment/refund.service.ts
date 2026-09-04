import type { PrismaClient } from '@prisma/client';
import type { ConsultationState } from '@neem/contracts';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { generatePublicId } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { canTransition } from '../../domain/consultation-state.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { getPaymentProvider } from '../../adapters/payment/index.ts';
import { transition } from '../consultation/consultation.service.ts';
import { notify } from '../notification/notification.service.ts';
import { formatMoney, money } from '../../lib/money.ts';

/**
 * Refunds (spec §41, docs/payment-flow.md §7).
 *
 * The shape of this module follows one rule: **a refund is never automatic.**
 * A patient or a pharmacy asks; an administrator decides. Nothing here refunds
 * money because of a state machine or a timer.
 *
 * Two properties are enforced structurally rather than by convention:
 *
 *  - **One refund per payment.** The database holds a unique index on
 *    `providerRefundRef`, and this module refuses a second request while one
 *    is open. Both are needed: the first stops a duplicate provider refund,
 *    the second stops a duplicate request reaching the provider at all.
 *  - **Revenue is reversed, never deleted.** The allocation row stays and is
 *    stamped `reversedAt`, so the ledger remains additive and a refunded
 *    consultation can still be explained months later. Payout calculation
 *    excludes reversed allocations rather than the row disappearing beneath it.
 */

/** States a refund may still be decided from. */
const OPEN_STATES = ['REQUESTED', 'APPROVED', 'PROCESSING'] as const;

export interface RefundRequestInput {
  reason: string;
  requestedByType: 'PATIENT' | 'PHARMACY' | 'ADMIN';
  requestedByRef?: string;
  correlationId?: string;
}

/**
 * Records a refund request.
 *
 * The consultation moves to `REFUND_REQUESTED` where the state machine allows
 * it, which pauses a live consultation while the decision is pending. Where it
 * does not — a consultation that already expired or was abandoned — the
 * request is still recorded and the consultation is left where it is. Those
 * are the cases where someone paid and received nothing, and refusing to
 * record the request because the consultation had already ended would be
 * exactly backwards.
 */
export async function requestRefund(
  consultationId: string,
  input: RefundRequestInput,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ publicId: string; state: string; consultationState: ConsultationState }> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    include: {
      payments: { where: { status: 'SUCCESS' }, orderBy: { createdAt: 'desc' }, take: 1 },
      refunds: { where: { state: { in: [...OPEN_STATES, 'COMPLETED'] } }, take: 1 },
    },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');

  const payment = consultation.payments[0];
  if (!payment) {
    // Nothing was taken, so there is nothing to give back. Said plainly rather
    // than recorded as a refund of zero, which would clutter the admin queue
    // with requests that can never be actioned.
    throw errors.businessRule('No payment has been taken for this consultation.');
  }

  const existing = consultation.refunds[0];
  if (existing) {
    throw errors.conflict(
      existing.state === 'COMPLETED'
        ? 'This consultation has already been refunded.'
        : 'A refund request for this consultation is already being reviewed.',
    );
  }

  const refund = await db.refund.create({
    data: {
      publicId: generatePublicId('ref'),
      consultationId,
      paymentId: payment.id,
      requestedByType: input.requestedByType,
      requestedByRef: input.requestedByRef ?? null,
      reason: input.reason,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      state: 'REQUESTED',
    },
  });

  // Pausing a live consultation; leaving a finished one alone.
  let consultationState = consultation.state;
  if (canTransition(consultation.state, 'REFUND_REQUESTED')) {
    consultationState = await transition(
      consultationId,
      'REFUND_REQUESTED',
      {
        actorType: input.requestedByType,
        actorId: input.requestedByRef,
        reason: 'refund_requested',
      },
      db,
      clock,
    );
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.REFUND_REQUESTED,
      actorType: input.requestedByType,
      actorId: input.requestedByRef,
      entityType: 'refund',
      entityId: refund.id,
      correlationId: input.correlationId,
      // Amount and who asked. The reason is the requester's own words and is
      // held on the refund row, where an administrator reads it in context.
      metadata: { consultationId, amountMinor: refund.amountMinor, paymentId: payment.id },
    },
    db,
  );

  /**
   * Someone is now waiting on a decision only an administrator can make.
   *
   * The admin console raises a live socket alert, which reaches an
   * administrator who is signed in. This reaches the one who is not — and a
   * refund request that sits unread over a weekend is a patient waiting on
   * their money.
   *
   * The amount and the reference, never the requester's stated reason: that
   * is their own words, and it belongs on the refund row where an
   * administrator reads it in context, not in an email.
   */
  void notify({
    templateCode: 'admin.refund.requested',
    recipient: { type: 'ADMIN' },
    variables: {
      amount: formatMoney(money(refund.amountMinor, refund.currency)),
      consultationReference: consultation.publicId,
    },
    correlationId: input.correlationId,
  });

  return { publicId: refund.publicId, state: refund.state, consultationState };
}

/**
 * Tells the pharmacy how a refund on its consultation was decided.
 *
 * Both exits of `decideRefund` call this, so the approved and rejected paths
 * cannot drift apart in what the counter is told — which is the usual way one
 * of a pair of notifications goes missing.
 */
function notifyRefundDecision(
  refund: { consultation: { publicId: string; pharmacyId: string } },
  decision: 'approved' | 'rejected',
  correlationId?: string,
): void {
  void notify({
    templateCode: 'pharmacy.refund.decided',
    recipient: { type: 'PHARMACY', pharmacyId: refund.consultation.pharmacyId },
    variables: { decision, consultationReference: refund.consultation.publicId },
    correlationId,
  });
}

export interface RefundDecision {
  approve: boolean;
  note?: string;
  correlationId?: string;
}

/**
 * The administrator's decision (spec §41).
 *
 * A rejection restores the consultation to wherever it was before the request,
 * read from the state event log rather than stored twice — the log is already
 * the record of truth for state history, and a second copy could disagree with
 * it.
 *
 * An approval calls the provider first and only then writes. If the provider
 * refuses, nothing local has changed and the administrator can try again; the
 * alternative — marking it refunded and hoping — would put the ledger and the
 * money out of step, which is the one thing this module exists to prevent.
 */
export async function decideRefund(
  refundPublicId: string,
  adminId: string,
  decision: RefundDecision,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ state: string; consultationState: ConsultationState }> {
  const refund = await db.refund.findUnique({
    where: { publicId: refundPublicId },
    include: {
      payment: { select: { id: true, providerReference: true, amountMinor: true } },
      consultation: { select: { id: true, publicId: true, state: true, pharmacyId: true } },
    },
  });
  if (!refund) throw errors.notFound('Refund not found.');

  if (!(OPEN_STATES as readonly string[]).includes(refund.state)) {
    throw errors.conflict(`This refund is already ${refund.state.toLowerCase()}.`);
  }

  const now = clock.now();

  if (!decision.approve) {
    const restored = await restorePriorState(refund.consultationId, adminId, db, clock);

    await db.refund.update({
      where: { id: refund.id },
      data: {
        state: 'REJECTED',
        reviewedByAdminId: adminId,
        decidedAt: now,
        decisionNote: decision.note ?? null,
      },
    });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.REFUND_DECIDED,
        actorType: 'ADMIN',
        actorId: adminId,
        entityType: 'refund',
        entityId: refund.id,
        correlationId: decision.correlationId,
        metadata: { approved: false, amountMinor: refund.amountMinor },
      },
      db,
    );

    notifyRefundDecision(refund, 'rejected', decision.correlationId);

    return { state: 'REJECTED', consultationState: restored };
  }

  // Approved. The provider is asked before anything local is written.
  const result = await getPaymentProvider().refund({
    providerReference: refund.payment.providerReference,
    amountMinor: refund.amountMinor,
    reason: decision.note ?? refund.reason,
  });

  const consultationState = await db.$transaction(async (tx) => {
    try {
      await tx.refund.update({
        where: { id: refund.id },
        data: {
          state: result.status === 'COMPLETED' ? 'COMPLETED' : 'PROCESSING',
          reviewedByAdminId: adminId,
          decidedAt: now,
          decisionNote: decision.note ?? null,
          providerRefundRef: result.providerRefundReference,
          completedAt: result.status === 'COMPLETED' ? now : null,
        },
      });
    } catch (error) {
      // UNIQUE(providerRefundRef). The provider handed back a reference we
      // already hold, which means this refund has already been recorded.
      if (!isUniqueConstraintError(error)) throw error;
    }

    await reverseAllocation(refund.consultationId, now, tx);

    // The consultation ends as refunded wherever the machine allows it. A
    // consultation that had already expired or been abandoned stays as it was:
    // the refund is a fact about the money, not a second ending.
    if (canTransition(refund.consultation.state, 'REFUNDED')) {
      return transition(
        refund.consultationId,
        'REFUNDED',
        { actorType: 'ADMIN', actorId: adminId, reason: 'refund_approved' },
        tx,
        clock,
      );
    }
    return refund.consultation.state;
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.REFUND_DECIDED,
      actorType: 'ADMIN',
      actorId: adminId,
      entityType: 'refund',
      entityId: refund.id,
      correlationId: decision.correlationId,
      metadata: {
        approved: true,
        amountMinor: refund.amountMinor,
        providerStatus: result.status,
        mock: getPaymentProvider().isMock,
      },
    },
    db,
  );

  notifyRefundDecision(refund, 'approved', decision.correlationId);

  return { state: result.status === 'COMPLETED' ? 'COMPLETED' : 'PROCESSING', consultationState };
}

/**
 * Completes a refund the provider has finished settling.
 *
 * Paystack settles refunds asynchronously, so approval leaves the refund in
 * PROCESSING and this is what closes it — driven by the `refund.processed`
 * webhook, never by a timer or an optimistic assumption at approval time.
 */
export async function completeRefund(
  providerRefundRef: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<boolean> {
  const refund = await db.refund.findUnique({ where: { providerRefundRef } });
  if (!refund) return false;
  if (refund.state === 'COMPLETED') return true;

  await db.refund.update({
    where: { id: refund.id },
    data: { state: 'COMPLETED', completedAt: clock.now() },
  });

  // Reversal is idempotent, and repeated here because a refund can complete
  // without ever passing through this service's approval path in a replay.
  await reverseAllocation(refund.consultationId, clock.now(), db);

  return true;
}

/**
 * Stamps the revenue allocation as reversed.
 *
 * The row is kept. Deleting it would make the ledger non-additive and leave a
 * payout that had already been calculated from it unexplainable.
 */
async function reverseAllocation(consultationId: string, at: Date, db: Db): Promise<void> {
  await db.revenueAllocation.updateMany({
    where: { consultationId, reversedAt: null },
    data: { reversedAt: at },
  });
}

/**
 * Puts a consultation back where it was before the refund request.
 *
 * Read from the state event log: it already records `fromState` for every
 * transition, so storing the prior state on the refund row as well would be a
 * second copy of the same fact with its own way of being wrong.
 */
async function restorePriorState(
  consultationId: string,
  adminId: string,
  db: Db,
  clock: Clock,
): Promise<ConsultationState> {
  const current = await db.consultation.findUniqueOrThrow({
    where: { id: consultationId },
    select: { state: true },
  });
  if (current.state !== 'REFUND_REQUESTED') return current.state;

  const event = await db.consultationStateEvent.findFirst({
    where: { consultationId, toState: 'REFUND_REQUESTED', accepted: true },
    orderBy: { occurredAt: 'desc' },
    select: { fromState: true },
  });

  const prior = event?.fromState;
  if (!prior || !canTransition('REFUND_REQUESTED', prior)) {
    // Nothing to restore to. Left in REFUND_REQUESTED rather than guessed at:
    // a consultation parked in a visible, unusual state is a problem an
    // administrator can see, and a wrong guess is one nobody would.
    return 'REFUND_REQUESTED';
  }

  return transition(
    consultationId,
    prior,
    { actorType: 'ADMIN', actorId: adminId, reason: 'refund_rejected' },
    db,
    clock,
  );
}

export interface RefundListItem {
  publicId: string;
  state: string;
  reason: string;
  amountMinor: number;
  currency: string;
  requestedByType: string;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  consultationReference: string;
  consultationState: string;
  pharmacyName: string;
}

/** The administrator's queue. Open requests first, oldest first. */
export async function listRefunds(
  filter: { openOnly?: boolean; limit?: number },
  db: Db = getPrisma(),
): Promise<RefundListItem[]> {
  const refunds = await db.refund.findMany({
    where: filter.openOnly ? { state: { in: [...OPEN_STATES] } } : {},
    include: {
      consultation: {
        select: { publicId: true, state: true, pharmacy: { select: { name: true } } },
      },
    },
    orderBy: [{ state: 'asc' }, { createdAt: 'asc' }],
    take: filter.limit ?? 100,
  });

  return refunds.map((refund) => ({
    publicId: refund.publicId,
    state: refund.state,
    reason: refund.reason,
    amountMinor: refund.amountMinor,
    currency: refund.currency,
    requestedByType: refund.requestedByType,
    createdAt: refund.createdAt.toISOString(),
    decidedAt: refund.decidedAt?.toISOString() ?? null,
    decisionNote: refund.decisionNote,
    consultationReference: refund.consultation.publicId,
    consultationState: refund.consultation.state,
    pharmacyName: refund.consultation.pharmacy.name,
  }));
}
