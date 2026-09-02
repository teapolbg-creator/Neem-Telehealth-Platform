import { TERMINAL_CONSULTATION_STATES, type ConsultationState } from '@neem/contracts';

/**
 * Consultation state machine (spec §81).
 *
 * The authority is docs/consultation-flow.md §3. Pure and exhaustive, so every
 * transition that must be REFUSED is as cheap to test as the ones allowed.
 *
 * Two rules deserve stating out loud, because they are the ones a well-meaning
 * refactor would break:
 *
 *  1. Nothing reaches PAID except from PAYMENT_PROCESSING, and the service that
 *     performs that transition accepts only a server-side verification result.
 *     A client saying "payment succeeded" can never move a consultation here
 *     (spec §34).
 *  2. The 5-minute timer has no transition of its own. Expiry of the
 *     *consultation clock* never ends a consultation — only the doctor does
 *     (spec §15). `EXPIRED` here means the *payment or access window* lapsed
 *     before the consultation ever began.
 */

const TRANSITIONS: Record<ConsultationState, readonly ConsultationState[]> = {
  PENDING_PAYMENT: ['PAYMENT_PROCESSING', 'EXPIRED', 'CANCELLED'],
  PAYMENT_PROCESSING: ['PAID', 'PAYMENT_FAILED', 'EXPIRED'],
  PAYMENT_FAILED: ['PAYMENT_PROCESSING', 'EXPIRED', 'CANCELLED'],
  PAID: ['ACTIVATED'],
  // A consultation can sit in ACTIVATED while the pharmacy prints the code and
  // the patient walks away, so it must be cancellable and expirable from here.
  // Omitting these left a paid consultation with no exit but the patient
  // scanning — which is precisely the "paid consultation silently stranded"
  // outcome spec §37 forbids.
  ACTIVATED: ['WAITING_FOR_PATIENT', 'CANCELLED', 'EXPIRED', 'REFUND_REQUESTED'],
  WAITING_FOR_PATIENT: ['PATIENT_JOINED', 'EXPIRED', 'CANCELLED', 'REFUND_REQUESTED'],
  PATIENT_JOINED: ['WAITING_FOR_DOCTOR', 'CANCELLED', 'REFUND_REQUESTED', 'ABANDONED'],
  WAITING_FOR_DOCTOR: ['ASSIGNED', 'CANCELLED', 'REFUND_REQUESTED', 'ABANDONED'],
  ASSIGNED: ['DOCTOR_ACCEPTED', 'REASSIGNING', 'CANCELLED'],
  REASSIGNING: ['ASSIGNED', 'WAITING_FOR_DOCTOR', 'CANCELLED'],
  DOCTOR_ACCEPTED: ['IN_PROGRESS', 'REASSIGNING', 'ABANDONED'],
  IN_PROGRESS: ['COMPLETING', 'ABANDONED'],
  COMPLETING: ['COMPLETED'],
  // A refund decision returns the consultation to a settled state; the refund
  // module records which state it came from so a rejection can restore it.
  REFUND_REQUESTED: [
    'REFUNDED',
    'ACTIVATED',
    'WAITING_FOR_PATIENT',
    'PATIENT_JOINED',
    'WAITING_FOR_DOCTOR',
    'COMPLETED',
    // A rejected request must be able to put the consultation back exactly
    // where it was, including the terminal states a request may now come from.
    'EXPIRED',
    'CANCELLED',
    'ABANDONED',
  ],

  /**
   * Terminal, with one deliberate exception.
   *
   * `EXPIRED`, `CANCELLED` and `ABANDONED` are all reachable *after* payment:
   * a consultation reaches ACTIVATED only once money has been taken, and can
   * then expire unscanned, be cancelled by the pharmacy, or be abandoned by
   * the patient. Those are precisely the cases where someone paid and received
   * nothing, and until this was added there was no path by which the money
   * could go back — the refund routes could not even record a request.
   *
   * `COMPLETED` is deliberately NOT among them. A consultation that happened
   * was delivered; a patient unhappy with it has a complaint (spec §51), which
   * an administrator reviews, and not an automatic claim on the fee. Drawing
   * the line here keeps "did you receive the service" separate from "was the
   * service good", which are different questions with different remedies.
   */
  COMPLETED: [],
  EXPIRED: ['REFUND_REQUESTED'],
  CANCELLED: ['REFUND_REQUESTED'],
  ABANDONED: ['REFUND_REQUESTED'],
  REFUNDED: [],
};

export function canTransition(from: ConsultationState, to: ConsultationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: ConsultationState): readonly ConsultationState[] {
  return TRANSITIONS[from];
}

const TERMINAL: ReadonlySet<ConsultationState> = new Set(TERMINAL_CONSULTATION_STATES);

export function isTerminal(state: ConsultationState): boolean {
  return TERMINAL.has(state);
}

/**
 * States in which the consultation has been paid for.
 *
 * Used to decide whether cancelling owes the patient a refund, and to stop a
 * paid consultation being silently discarded (spec §37).
 */
const PAID_STATES: ReadonlySet<ConsultationState> = new Set([
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
  'COMPLETED',
  'REFUND_REQUESTED',
]);

export function isPaid(state: ConsultationState): boolean {
  return PAID_STATES.has(state);
}

/** The patient's QR token may be exchanged only while the consultation waits for them. */
export function acceptsPatientArrival(state: ConsultationState): boolean {
  return state === 'ACTIVATED' || state === 'WAITING_FOR_PATIENT';
}

/** States in which a patient session should still be able to act. */
const PATIENT_ACTIVE: ReadonlySet<ConsultationState> = new Set([
  'WAITING_FOR_PATIENT',
  'PATIENT_JOINED',
  'WAITING_FOR_DOCTOR',
  'ASSIGNED',
  'REASSIGNING',
  'DOCTOR_ACCEPTED',
  'IN_PROGRESS',
]);

export function patientSessionIsUsable(state: ConsultationState): boolean {
  return PATIENT_ACTIVE.has(state);
}

/**
 * States in which a patient session may still be READ.
 *
 * Deliberately wider than the set in which it may act. Resolving only on
 * `PATIENT_ACTIVE` meant the session died the instant the doctor completed,
 * and the patient's phone — polling every five seconds — got a 401 instead of
 * the completion screen. That screen carries the consultation reference, which
 * decision D24 makes the patient's only route back to their own record, and it
 * is where they are asked for feedback. Both were unreachable.
 *
 * Reading is all this widening grants. Every route that changes something
 * calls `assertPatientCanAct`, so a completed consultation cannot have its
 * language or mode altered through a session that is still readable.
 */
const PATIENT_READABLE: ReadonlySet<ConsultationState> = new Set<ConsultationState>([
  ...PATIENT_ACTIVE,
  'COMPLETING',
  ...TERMINAL_CONSULTATION_STATES,
  'REFUND_REQUESTED',
]);

export function patientSessionIsReadable(state: ConsultationState): boolean {
  return PATIENT_READABLE.has(state);
}

/** States from which the pharmacy may still cancel. */
export function canPharmacyCancel(state: ConsultationState): boolean {
  return (
    !isTerminal(state) &&
    state !== 'IN_PROGRESS' &&
    state !== 'COMPLETING' &&
    state !== 'DOCTOR_ACCEPTED'
  );
}

/**
 * Whether the payment window applies.
 *
 * Only these states are swept by `expire-pending-payments`; anything paid is
 * out of its reach, so a slow webhook can never expire a consultation that was
 * in fact paid for.
 */
export function isAwaitingPayment(state: ConsultationState): boolean {
  return (
    state === 'PENDING_PAYMENT' || state === 'PAYMENT_PROCESSING' || state === 'PAYMENT_FAILED'
  );
}

export class InvalidConsultationTransition extends Error {
  constructor(
    readonly from: ConsultationState,
    readonly to: ConsultationState,
  ) {
    super(`A consultation cannot move from ${from} to ${to}.`);
    this.name = 'InvalidConsultationTransition';
  }
}

export function assertTransition(from: ConsultationState, to: ConsultationState): void {
  if (!canTransition(from, to)) {
    throw new InvalidConsultationTransition(from, to);
  }
}
