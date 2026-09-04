import type { PrescriptionState } from '@prisma/client';

/**
 * The prescription state machine (spec §41–§48, §82).
 *
 * Pure, so the rules can be reasoned about and exhaustively tested without a
 * database. Three of them are safety rules rather than workflow rules, and are
 * called out where they are enforced:
 *
 *  1. **A dispensed prescription can never be revoked.** The medicine is with
 *     the patient. Revoking afterwards would produce a record claiming a
 *     prescription was withdrawn when it was in fact filled — worse than
 *     useless to anyone investigating later (spec §82).
 *  2. **A pharmacy never edits a doctor's prescription.** It may propose a
 *     substitution, which the doctor decides. There is no transition a
 *     pharmacy can drive that changes what was prescribed (spec §47).
 *  3. **Nothing returns to DRAFT.** Once signed and issued, the document
 *     exists; a correction is a revocation plus a new prescription, so the
 *     trail shows what actually happened.
 */

const TRANSITIONS: Record<PrescriptionState, readonly PrescriptionState[]> = {
  // The doctor is still composing. Nothing outside the consultation sees it.
  DRAFT: ['ISSUED'],

  // Signed and bound to the doctor's signature. Revocable, because the
  // pharmacy has not acted on it yet.
  ISSUED: ['ACTIVE', 'REVOKED'],

  // With the pharmacy and dispensable.
  ACTIVE: ['PENDING_SUBSTITUTION', 'DISPENSED', 'REVOKED'],

  // The pharmacy has proposed a swap and is waiting on the doctor. Still
  // revocable — a doctor who spots a problem while considering a substitution
  // must not have to approve or reject it first.
  PENDING_SUBSTITUTION: ['SUBSTITUTION_APPROVED', 'SUBSTITUTION_REJECTED', 'REVOKED'],

  // The doctor approved the swap. Another item may still need one, so a
  // further substitution round is permitted.
  SUBSTITUTION_APPROVED: ['DISPENSED', 'PENDING_SUBSTITUTION', 'REVOKED'],

  // The doctor refused the swap. The pharmacy dispenses what was prescribed,
  // or the prescription is revoked — it does not become undispensable.
  SUBSTITUTION_REJECTED: ['DISPENSED', 'PENDING_SUBSTITUTION', 'REVOKED'],

  // Terminal, and deliberately empty. See rule 1 above.
  DISPENSED: [],
  REVOKED: [],
};

export class InvalidPrescriptionTransition extends Error {
  constructor(
    readonly from: PrescriptionState,
    readonly to: PrescriptionState,
  ) {
    super(`A prescription cannot move from ${from} to ${to}.`);
    this.name = 'InvalidPrescriptionTransition';
  }
}

export function canTransition(from: PrescriptionState, to: PrescriptionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertPrescriptionTransition(from: PrescriptionState, to: PrescriptionState): void {
  if (!canTransition(from, to)) throw new InvalidPrescriptionTransition(from, to);
}

export function allowedTransitions(from: PrescriptionState): readonly PrescriptionState[] {
  return TRANSITIONS[from];
}

const TERMINAL: ReadonlySet<PrescriptionState> = new Set(['DISPENSED', 'REVOKED']);

export function isTerminal(state: PrescriptionState): boolean {
  return TERMINAL.has(state);
}

/**
 * Whether the issuing doctor may still revoke.
 *
 * The single most important predicate in this file. A prescription that has
 * been dispensed is in the patient's hands, and no revocation can call it
 * back (spec §46, §82).
 */
export function canRevoke(state: PrescriptionState): boolean {
  return !isTerminal(state) && state !== 'DRAFT';
}

/** Whether the pharmacy may dispense. */
export function canDispense(state: PrescriptionState): boolean {
  return (
    state === 'ACTIVE' || state === 'SUBSTITUTION_APPROVED' || state === 'SUBSTITUTION_REJECTED'
  );
}

/**
 * Whether the pharmacy may propose a substitution.
 *
 * Not while one is already pending — a second proposal on top of an
 * undecided one would leave the doctor answering a question that has moved.
 */
export function canProposeSubstitution(state: PrescriptionState): boolean {
  return (
    state === 'ACTIVE' || state === 'SUBSTITUTION_APPROVED' || state === 'SUBSTITUTION_REJECTED'
  );
}

/** Whether the prescription is visible to the pharmacy at all. */
export function isVisibleToPharmacy(state: PrescriptionState): boolean {
  return state !== 'DRAFT';
}
