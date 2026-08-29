import type { DoctorStatus, PharmacyStatus } from '@neem/contracts';

/**
 * Doctor and pharmacy lifecycle state machines (spec §83, §84).
 *
 * Pure functions with no I/O, so every transition — including the ones that
 * must be refused — is cheap to test exhaustively. Services call
 * `assertDoctorTransition` / `assertPharmacyTransition` inside the same
 * transaction that writes the new status; nothing assigns `status` directly.
 *
 * The rule that matters most: only ACTIVE doctors receive consultations, and
 * only ACTIVE pharmacies initiate them.
 */

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

/**
 * PENDING → UNDER_REVIEW → APPROVED → ACTIVE, with SUSPENDED / EXPIRED /
 * REJECTED as alternates.
 *
 * Deliberate choices:
 *  - REJECTED is not terminal. An applicant who fixes their paperwork returns
 *    to UNDER_REVIEW rather than having to create a second account, which
 *    would fragment their audit trail.
 *  - SUSPENDED can return to ACTIVE (admin lifts it) or to EXPIRED (a licence
 *    or membership lapses while suspended).
 *  - EXPIRED → UNDER_REVIEW, because renewal means re-verifying credentials
 *    (spec §22: a doctor must hold a valid MDC licence at all times).
 *  - Nothing reaches ACTIVE except through APPROVED. There is no path that
 *    lets an unverified doctor take a consultation.
 */
const DOCTOR_TRANSITIONS: Record<DoctorStatus, readonly DoctorStatus[]> = {
  PENDING: ['UNDER_REVIEW', 'REJECTED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED', 'PENDING'],
  APPROVED: ['ACTIVE', 'SUSPENDED', 'REJECTED'],
  ACTIVE: ['SUSPENDED', 'EXPIRED'],
  SUSPENDED: ['ACTIVE', 'EXPIRED', 'REJECTED'],
  EXPIRED: ['UNDER_REVIEW', 'SUSPENDED'],
  REJECTED: ['UNDER_REVIEW'],
};

export function canDoctorTransition(from: DoctorStatus, to: DoctorStatus): boolean {
  return DOCTOR_TRANSITIONS[from].includes(to);
}

export function allowedDoctorTransitions(from: DoctorStatus): readonly DoctorStatus[] {
  return DOCTOR_TRANSITIONS[from];
}

/** The single question the queue engine asks (spec §83). */
export function doctorCanReceiveConsultations(status: DoctorStatus): boolean {
  return status === 'ACTIVE';
}

/**
 * Statuses from which an admin may still act on an application. Used to build
 * the verification queue.
 */
export function doctorIsAwaitingReview(status: DoctorStatus): boolean {
  return status === 'PENDING' || status === 'UNDER_REVIEW';
}

// ---------------------------------------------------------------------------
// Pharmacy
// ---------------------------------------------------------------------------

/**
 * PENDING → UNDER_REVIEW → APPROVED → ACTIVE, with SUSPENDED / REJECTED.
 *
 * A pharmacy has no EXPIRED state: Pharmacy Council registration is verified
 * manually at onboarding and re-checked by an admin, rather than tracked as an
 * automatic expiry the way a doctor's MDC licence is (spec §20 vs §22).
 */
const PHARMACY_TRANSITIONS: Record<PharmacyStatus, readonly PharmacyStatus[]> = {
  PENDING: ['UNDER_REVIEW', 'REJECTED'],
  UNDER_REVIEW: ['APPROVED', 'REJECTED', 'PENDING'],
  APPROVED: ['ACTIVE', 'SUSPENDED', 'REJECTED'],
  ACTIVE: ['SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'REJECTED'],
  REJECTED: ['UNDER_REVIEW'],
};

export function canPharmacyTransition(from: PharmacyStatus, to: PharmacyStatus): boolean {
  return PHARMACY_TRANSITIONS[from].includes(to);
}

export function allowedPharmacyTransitions(from: PharmacyStatus): readonly PharmacyStatus[] {
  return PHARMACY_TRANSITIONS[from];
}

/** The single question consultation creation asks (spec §84). */
export function pharmacyCanInitiateConsultations(status: PharmacyStatus): boolean {
  return status === 'ACTIVE';
}

export function pharmacyIsAwaitingReview(status: PharmacyStatus): boolean {
  return status === 'PENDING' || status === 'UNDER_REVIEW';
}

// ---------------------------------------------------------------------------
// Transitions that require a recorded reason
// ---------------------------------------------------------------------------

/**
 * Suspension and rejection are adverse actions against a real business or
 * clinician. Requiring a reason means the audit trail can always answer "why",
 * which matters both for the affected party and for a regulator (spec §96).
 */
const REQUIRES_REASON = new Set(['SUSPENDED', 'REJECTED', 'EXPIRED']);

export function transitionRequiresReason(to: DoctorStatus | PharmacyStatus): boolean {
  return REQUIRES_REASON.has(to);
}
