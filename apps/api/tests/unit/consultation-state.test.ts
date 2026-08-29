import { describe, expect, it } from 'vitest';
import { CONSULTATION_STATES } from '@neem/contracts';
import {
  acceptsPatientArrival,
  allowedTransitions,
  assertTransition,
  canPharmacyCancel,
  canTransition,
  InvalidConsultationTransition,
  isAwaitingPayment,
  isPaid,
  isTerminal,
  patientSessionIsUsable,
} from '../../src/domain/consultation-state.ts';

/**
 * Consultation state machine (spec §81).
 *
 * The refusals matter more than the permissions, so the full cross-product is
 * asserted: any pair not in the table must be rejected.
 */

const ALLOWED = new Set([
  'PENDING_PAYMENT>PAYMENT_PROCESSING', 'PENDING_PAYMENT>EXPIRED', 'PENDING_PAYMENT>CANCELLED',
  'PAYMENT_PROCESSING>PAID', 'PAYMENT_PROCESSING>PAYMENT_FAILED', 'PAYMENT_PROCESSING>EXPIRED',
  'PAYMENT_FAILED>PAYMENT_PROCESSING', 'PAYMENT_FAILED>EXPIRED', 'PAYMENT_FAILED>CANCELLED',
  'PAID>ACTIVATED',
  'ACTIVATED>WAITING_FOR_PATIENT', 'ACTIVATED>CANCELLED', 'ACTIVATED>EXPIRED',
  'ACTIVATED>REFUND_REQUESTED',
  'WAITING_FOR_PATIENT>PATIENT_JOINED', 'WAITING_FOR_PATIENT>EXPIRED',
  'WAITING_FOR_PATIENT>CANCELLED', 'WAITING_FOR_PATIENT>REFUND_REQUESTED',
  'PATIENT_JOINED>WAITING_FOR_DOCTOR', 'PATIENT_JOINED>CANCELLED',
  'PATIENT_JOINED>REFUND_REQUESTED', 'PATIENT_JOINED>ABANDONED',
  'WAITING_FOR_DOCTOR>ASSIGNED', 'WAITING_FOR_DOCTOR>CANCELLED',
  'WAITING_FOR_DOCTOR>REFUND_REQUESTED', 'WAITING_FOR_DOCTOR>ABANDONED',
  'ASSIGNED>DOCTOR_ACCEPTED', 'ASSIGNED>REASSIGNING', 'ASSIGNED>CANCELLED',
  'REASSIGNING>ASSIGNED', 'REASSIGNING>WAITING_FOR_DOCTOR', 'REASSIGNING>CANCELLED',
  'DOCTOR_ACCEPTED>IN_PROGRESS', 'DOCTOR_ACCEPTED>REASSIGNING', 'DOCTOR_ACCEPTED>ABANDONED',
  'IN_PROGRESS>COMPLETING', 'IN_PROGRESS>ABANDONED',
  'COMPLETING>COMPLETED',
  'REFUND_REQUESTED>REFUNDED', 'REFUND_REQUESTED>ACTIVATED',
  'REFUND_REQUESTED>WAITING_FOR_PATIENT',
  'REFUND_REQUESTED>PATIENT_JOINED', 'REFUND_REQUESTED>WAITING_FOR_DOCTOR',
  'REFUND_REQUESTED>COMPLETED',
]);

describe('consultation transitions', () => {
  it('permits exactly the documented edges and nothing else', () => {
    for (const from of CONSULTATION_STATES) {
      for (const to of CONSULTATION_STATES) {
        expect(canTransition(from, to), `${from} → ${to}`).toBe(ALLOWED.has(`${from}>${to}`));
      }
    }
  });

  it('never allows a state to transition to itself', () => {
    for (const state of CONSULTATION_STATES) {
      expect(canTransition(state, state)).toBe(false);
    }
  });

  it('lets nothing out of a terminal state', () => {
    for (const state of ['COMPLETED', 'EXPIRED', 'CANCELLED', 'ABANDONED', 'REFUNDED'] as const) {
      expect(isTerminal(state)).toBe(true);
      expect(allowedTransitions(state)).toHaveLength(0);
    }
  });

  it('reaches PAID only from PAYMENT_PROCESSING (spec §34)', () => {
    // The single most important refusal in the engine: nothing else may mark a
    // consultation paid, so no client-supplied claim can activate one.
    const routes = CONSULTATION_STATES.filter((from) => canTransition(from, 'PAID'));
    expect(routes).toEqual(['PAYMENT_PROCESSING']);
  });

  it('reaches ACTIVATED only from PAID', () => {
    const routes = CONSULTATION_STATES.filter((from) => canTransition(from, 'ACTIVATED'));
    // REFUND_REQUESTED can return here when an admin rejects the request.
    expect(routes.sort()).toEqual(['PAID', 'REFUND_REQUESTED']);
  });

  it('reaches COMPLETED only through COMPLETING, so the purge cannot be skipped', () => {
    // COMPLETING is where permanent records are written and temporary clinical
    // data is deleted (spec §16). A direct jump would bypass both.
    const routes = CONSULTATION_STATES.filter((from) => canTransition(from, 'COMPLETED'));
    expect(routes.sort()).toEqual(['COMPLETING', 'REFUND_REQUESTED']);
  });

  it('never lets an unpaid consultation reach the queue', () => {
    expect(canTransition('PENDING_PAYMENT', 'WAITING_FOR_DOCTOR')).toBe(false);
    expect(canTransition('PAYMENT_FAILED', 'WAITING_FOR_PATIENT')).toBe(false);
    expect(canTransition('PAYMENT_PROCESSING', 'PATIENT_JOINED')).toBe(false);
  });

  it('throws a typed error for an illegal transition', () => {
    expect(() => assertTransition('COMPLETED', 'IN_PROGRESS')).toThrow(InvalidConsultationTransition);
    expect(() => assertTransition('PAID', 'ACTIVATED')).not.toThrow();
  });
});

describe('payment window', () => {
  it('covers only the pre-payment states', () => {
    const awaiting = CONSULTATION_STATES.filter(isAwaitingPayment);
    expect(awaiting.sort()).toEqual(['PAYMENT_FAILED', 'PAYMENT_PROCESSING', 'PENDING_PAYMENT']);
  });

  it('never touches a paid consultation, so a slow webhook cannot expire one', () => {
    for (const state of CONSULTATION_STATES) {
      if (isPaid(state)) expect(isAwaitingPayment(state)).toBe(false);
    }
  });
});

describe('paid states', () => {
  it('treats everything from PAID onward as paid for', () => {
    expect(isPaid('PAID')).toBe(true);
    expect(isPaid('ACTIVATED')).toBe(true);
    expect(isPaid('IN_PROGRESS')).toBe(true);
    expect(isPaid('COMPLETED')).toBe(true);
  });

  it('does not treat pre-payment or failed states as paid', () => {
    expect(isPaid('PENDING_PAYMENT')).toBe(false);
    expect(isPaid('PAYMENT_PROCESSING')).toBe(false);
    expect(isPaid('PAYMENT_FAILED')).toBe(false);
    expect(isPaid('EXPIRED')).toBe(false);
  });
});

describe('patient access', () => {
  it('accepts a QR exchange only while the consultation awaits the patient', () => {
    const accepting = CONSULTATION_STATES.filter(acceptsPatientArrival);
    expect(accepting.sort()).toEqual(['ACTIVATED', 'WAITING_FOR_PATIENT']);
  });

  it('refuses a QR exchange once the patient has already joined', () => {
    // This is what stops a second person using a scanned code after the fact.
    expect(acceptsPatientArrival('PATIENT_JOINED')).toBe(false);
    expect(acceptsPatientArrival('IN_PROGRESS')).toBe(false);
    expect(acceptsPatientArrival('COMPLETED')).toBe(false);
  });

  it('keeps the patient session usable through the consultation but not after', () => {
    expect(patientSessionIsUsable('WAITING_FOR_DOCTOR')).toBe(true);
    expect(patientSessionIsUsable('IN_PROGRESS')).toBe(true);
    expect(patientSessionIsUsable('COMPLETED')).toBe(false);
    expect(patientSessionIsUsable('CANCELLED')).toBe(false);
    expect(patientSessionIsUsable('EXPIRED')).toBe(false);
  });
});

describe('pharmacy cancellation', () => {
  it('is refused once a doctor is engaged with the patient', () => {
    expect(canPharmacyCancel('DOCTOR_ACCEPTED')).toBe(false);
    expect(canPharmacyCancel('IN_PROGRESS')).toBe(false);
    expect(canPharmacyCancel('COMPLETING')).toBe(false);
  });

  it('is allowed while the consultation is still waiting', () => {
    expect(canPharmacyCancel('PENDING_PAYMENT')).toBe(true);
    expect(canPharmacyCancel('WAITING_FOR_PATIENT')).toBe(true);
    expect(canPharmacyCancel('WAITING_FOR_DOCTOR')).toBe(true);
  });

  it('is refused for anything already finished', () => {
    for (const state of CONSULTATION_STATES.filter(isTerminal)) {
      expect(canPharmacyCancel(state)).toBe(false);
    }
  });
});
