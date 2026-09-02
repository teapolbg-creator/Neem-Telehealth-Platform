import { describe, expect, it } from 'vitest';
import type { PrescriptionState } from '@prisma/client';
import {
  allowedTransitions,
  assertPrescriptionTransition,
  canDispense,
  canProposeSubstitution,
  canRevoke,
  canTransition,
  InvalidPrescriptionTransition,
  isTerminal,
  isVisibleToPharmacy,
} from '../../src/domain/prescription-state.ts';

/**
 * The prescription state machine (spec §41–§48, §82).
 *
 * The safety rules get their own block at the bottom, because they are the
 * ones that would matter in an inquiry.
 */

const ALL_STATES: PrescriptionState[] = [
  'DRAFT',
  'ISSUED',
  'ACTIVE',
  'PENDING_SUBSTITUTION',
  'SUBSTITUTION_APPROVED',
  'SUBSTITUTION_REJECTED',
  'DISPENSED',
  'REVOKED',
];

describe('the transition table', () => {
  it('covers every state, so a new one cannot be added silently', () => {
    for (const state of ALL_STATES) {
      expect(() => allowedTransitions(state), state).not.toThrow();
    }
  });

  it('walks the ordinary path: draft, issued, active, dispensed', () => {
    expect(canTransition('DRAFT', 'ISSUED')).toBe(true);
    expect(canTransition('ISSUED', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'DISPENSED')).toBe(true);
  });

  it('walks the substitution path in both outcomes', () => {
    expect(canTransition('ACTIVE', 'PENDING_SUBSTITUTION')).toBe(true);
    expect(canTransition('PENDING_SUBSTITUTION', 'SUBSTITUTION_APPROVED')).toBe(true);
    expect(canTransition('PENDING_SUBSTITUTION', 'SUBSTITUTION_REJECTED')).toBe(true);

    // A rejected substitution still dispenses — the pharmacy fills what the
    // doctor actually prescribed.
    expect(canTransition('SUBSTITUTION_REJECTED', 'DISPENSED')).toBe(true);
    expect(canTransition('SUBSTITUTION_APPROVED', 'DISPENSED')).toBe(true);
  });

  it('allows a second substitution round, because a prescription has several items', () => {
    expect(canTransition('SUBSTITUTION_APPROVED', 'PENDING_SUBSTITUTION')).toBe(true);
    expect(canTransition('SUBSTITUTION_REJECTED', 'PENDING_SUBSTITUTION')).toBe(true);
  });

  it('refuses a second proposal while one is undecided', () => {
    // The doctor would be answering a question that has already moved.
    expect(canProposeSubstitution('PENDING_SUBSTITUTION')).toBe(false);
  });

  it('never returns to DRAFT from anywhere', () => {
    // A correction is a revocation plus a new prescription, so the trail shows
    // what actually happened.
    for (const state of ALL_STATES) {
      expect(canTransition(state, 'DRAFT'), state).toBe(false);
    }
  });

  it('throws with both states named, so a failure is diagnosable', () => {
    expect(() => assertPrescriptionTransition('DISPENSED', 'REVOKED')).toThrow(
      InvalidPrescriptionTransition,
    );
    expect(() => assertPrescriptionTransition('DISPENSED', 'REVOKED')).toThrow(
      /cannot move from DISPENSED to REVOKED/,
    );
  });
});

describe('the safety rules', () => {
  it('a dispensed prescription can never be revoked (spec §82)', () => {
    // The medicine is with the patient. Revoking would produce a record
    // claiming withdrawal when the prescription was in fact filled.
    expect(canTransition('DISPENSED', 'REVOKED')).toBe(false);
    expect(canRevoke('DISPENSED')).toBe(false);
  });

  it('a dispensed prescription can go nowhere at all', () => {
    expect(allowedTransitions('DISPENSED')).toEqual([]);

    for (const state of ALL_STATES) {
      expect(canTransition('DISPENSED', state), `DISPENSED → ${state}`).toBe(false);
    }
  });

  it('a revoked prescription can go nowhere either', () => {
    expect(allowedTransitions('REVOKED')).toEqual([]);

    for (const state of ALL_STATES) {
      expect(canTransition('REVOKED', state), `REVOKED → ${state}`).toBe(false);
    }
  });

  it('cannot be dispensed once revoked', () => {
    expect(canDispense('REVOKED')).toBe(false);
    expect(canTransition('REVOKED', 'DISPENSED')).toBe(false);
  });

  it('is revocable at every stage before dispensing, including mid-substitution', () => {
    // A doctor who spots a problem while a substitution sits undecided must
    // not have to approve or reject it first.
    for (const state of [
      'ISSUED',
      'ACTIVE',
      'PENDING_SUBSTITUTION',
      'SUBSTITUTION_APPROVED',
      'SUBSTITUTION_REJECTED',
    ] as PrescriptionState[]) {
      expect(canRevoke(state), state).toBe(true);
      expect(canTransition(state, 'REVOKED'), state).toBe(true);
    }
  });

  it('is not revocable while still a draft — there is nothing to revoke', () => {
    expect(canRevoke('DRAFT')).toBe(false);
  });

  it('hides a draft from the pharmacy', () => {
    expect(isVisibleToPharmacy('DRAFT')).toBe(false);

    for (const state of ALL_STATES.filter((s) => s !== 'DRAFT')) {
      expect(isVisibleToPharmacy(state), state).toBe(true);
    }
  });

  it('will not dispense anything the pharmacy has not been given', () => {
    expect(canDispense('DRAFT')).toBe(false);
    // Not until the pharmacy has acknowledged receipt.
    expect(canDispense('ISSUED')).toBe(false);
    // And never while a substitution is undecided.
    expect(canDispense('PENDING_SUBSTITUTION')).toBe(false);
  });
});

describe('terminality', () => {
  it.each([
    ['DISPENSED', true],
    ['REVOKED', true],
    ['DRAFT', false],
    ['ISSUED', false],
    ['ACTIVE', false],
    ['PENDING_SUBSTITUTION', false],
    ['SUBSTITUTION_APPROVED', false],
    ['SUBSTITUTION_REJECTED', false],
  ] as Array<[PrescriptionState, boolean]>)('%s terminal: %s', (state, expected) => {
    expect(isTerminal(state)).toBe(expected);
  });

  it('gives every terminal state an empty transition list, and no other state one', () => {
    for (const state of ALL_STATES) {
      expect(allowedTransitions(state).length === 0, state).toBe(isTerminal(state));
    }
  });
});
