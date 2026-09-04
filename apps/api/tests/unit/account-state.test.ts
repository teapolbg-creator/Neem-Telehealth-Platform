import { describe, expect, it } from 'vitest';
import { DOCTOR_STATUSES, PHARMACY_STATUSES } from '@neem/contracts';
import {
  canDoctorTransition,
  canPharmacyTransition,
  doctorCanReceiveConsultations,
  doctorIsAwaitingReview,
  pharmacyCanInitiateConsultations,
  pharmacyIsAwaitingReview,
  transitionRequiresReason,
} from '../../src/domain/account-state.ts';

/**
 * Doctor and pharmacy state machines (spec §83, §84).
 *
 * The transitions that must be REFUSED matter more than the ones that are
 * allowed, so those are tested exhaustively: any status pair not in the
 * transition table is rejected.
 */

describe('doctor state machine', () => {
  it('walks the intended approval path', () => {
    expect(canDoctorTransition('PENDING', 'UNDER_REVIEW')).toBe(true);
    expect(canDoctorTransition('UNDER_REVIEW', 'APPROVED')).toBe(true);
    expect(canDoctorTransition('APPROVED', 'ACTIVE')).toBe(true);
  });

  it('never lets an unapproved doctor reach ACTIVE', () => {
    // The single most important refusal: an unverified clinician must not be
    // able to become eligible for consultations.
    expect(canDoctorTransition('PENDING', 'ACTIVE')).toBe(false);
    expect(canDoctorTransition('UNDER_REVIEW', 'ACTIVE')).toBe(false);
    expect(canDoctorTransition('REJECTED', 'ACTIVE')).toBe(false);
    expect(canDoctorTransition('EXPIRED', 'ACTIVE')).toBe(false);
  });

  it('requires re-review after expiry, because a licence must stay valid', () => {
    expect(canDoctorTransition('EXPIRED', 'UNDER_REVIEW')).toBe(true);
    expect(canDoctorTransition('EXPIRED', 'APPROVED')).toBe(false);
  });

  it('lets an admin lift a suspension, but not skip review after rejection', () => {
    expect(canDoctorTransition('SUSPENDED', 'ACTIVE')).toBe(true);
    expect(canDoctorTransition('REJECTED', 'UNDER_REVIEW')).toBe(true);
    expect(canDoctorTransition('REJECTED', 'APPROVED')).toBe(false);
  });

  it('refuses every transition not in the table', () => {
    const allowed = new Set([
      'PENDING>UNDER_REVIEW',
      'PENDING>REJECTED',
      'UNDER_REVIEW>APPROVED',
      'UNDER_REVIEW>REJECTED',
      'UNDER_REVIEW>PENDING',
      'APPROVED>ACTIVE',
      'APPROVED>SUSPENDED',
      'APPROVED>REJECTED',
      'ACTIVE>SUSPENDED',
      'ACTIVE>EXPIRED',
      'SUSPENDED>ACTIVE',
      'SUSPENDED>EXPIRED',
      'SUSPENDED>REJECTED',
      'EXPIRED>UNDER_REVIEW',
      'EXPIRED>SUSPENDED',
      'REJECTED>UNDER_REVIEW',
    ]);

    for (const from of DOCTOR_STATUSES) {
      for (const to of DOCTOR_STATUSES) {
        expect(canDoctorTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it('treats no status as self-transitioning', () => {
    for (const status of DOCTOR_STATUSES) {
      expect(canDoctorTransition(status, status)).toBe(false);
    }
  });

  it('permits consultations only when ACTIVE', () => {
    for (const status of DOCTOR_STATUSES) {
      expect(doctorCanReceiveConsultations(status)).toBe(status === 'ACTIVE');
    }
  });

  it('identifies applications awaiting review', () => {
    expect(doctorIsAwaitingReview('PENDING')).toBe(true);
    expect(doctorIsAwaitingReview('UNDER_REVIEW')).toBe(true);
    expect(doctorIsAwaitingReview('ACTIVE')).toBe(false);
  });
});

describe('pharmacy state machine', () => {
  it('walks the intended approval path', () => {
    expect(canPharmacyTransition('PENDING', 'UNDER_REVIEW')).toBe(true);
    expect(canPharmacyTransition('UNDER_REVIEW', 'APPROVED')).toBe(true);
    expect(canPharmacyTransition('APPROVED', 'ACTIVE')).toBe(true);
  });

  it('never lets an unapproved pharmacy reach ACTIVE', () => {
    expect(canPharmacyTransition('PENDING', 'ACTIVE')).toBe(false);
    expect(canPharmacyTransition('UNDER_REVIEW', 'ACTIVE')).toBe(false);
    expect(canPharmacyTransition('REJECTED', 'ACTIVE')).toBe(false);
  });

  it('refuses every transition not in the table', () => {
    const allowed = new Set([
      'PENDING>UNDER_REVIEW',
      'PENDING>REJECTED',
      'UNDER_REVIEW>APPROVED',
      'UNDER_REVIEW>REJECTED',
      'UNDER_REVIEW>PENDING',
      'APPROVED>ACTIVE',
      'APPROVED>SUSPENDED',
      'APPROVED>REJECTED',
      'ACTIVE>SUSPENDED',
      'SUSPENDED>ACTIVE',
      'SUSPENDED>REJECTED',
      'REJECTED>UNDER_REVIEW',
    ]);

    for (const from of PHARMACY_STATUSES) {
      for (const to of PHARMACY_STATUSES) {
        expect(canPharmacyTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it('permits initiating consultations only when ACTIVE', () => {
    for (const status of PHARMACY_STATUSES) {
      expect(pharmacyCanInitiateConsultations(status)).toBe(status === 'ACTIVE');
    }
  });

  it('identifies applications awaiting review', () => {
    expect(pharmacyIsAwaitingReview('PENDING')).toBe(true);
    expect(pharmacyIsAwaitingReview('ACTIVE')).toBe(false);
  });
});

describe('adverse actions require a recorded reason', () => {
  it('requires one for suspension, rejection and expiry', () => {
    expect(transitionRequiresReason('SUSPENDED')).toBe(true);
    expect(transitionRequiresReason('REJECTED')).toBe(true);
    expect(transitionRequiresReason('EXPIRED')).toBe(true);
  });

  it('does not require one for ordinary progression', () => {
    expect(transitionRequiresReason('APPROVED')).toBe(false);
    expect(transitionRequiresReason('ACTIVE')).toBe(false);
    expect(transitionRequiresReason('UNDER_REVIEW')).toBe(false);
  });
});
