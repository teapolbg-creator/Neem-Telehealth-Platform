import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  permissionsForRole,
  roleHasPermission,
} from '@neem/contracts';

/**
 * RBAC boundaries.
 *
 * Each assertion here corresponds to a rule in the specification that would be
 * a real safety or privacy failure if it regressed. They are cheap and they
 * guard exactly the things a future refactor is most likely to break.
 */
describe('role permissions', () => {
  describe('doctors', () => {
    it('cannot see patient feedback or ratings (spec §24, §51)', () => {
      expect(roleHasPermission('DOCTOR', PERMISSIONS.FEEDBACK_READ)).toBe(false);
    });

    it('cannot see their own quality score (spec §52)', () => {
      expect(roleHasPermission('DOCTOR', PERMISSIONS.QUALITY_READ)).toBe(false);
    });

    it('cannot create a consultation — consultations originate at a pharmacy', () => {
      expect(roleHasPermission('DOCTOR', PERMISSIONS.CONSULTATION_CREATE)).toBe(false);
    });

    it('cannot dispense — dispensing is the pharmacy\'s act (spec §46)', () => {
      expect(roleHasPermission('DOCTOR', PERMISSIONS.PRESCRIPTION_DISPENSE)).toBe(false);
    });

    it('cannot read the audit log or platform-wide finance', () => {
      expect(roleHasPermission('DOCTOR', PERMISSIONS.AUDIT_READ)).toBe(false);
      expect(roleHasPermission('DOCTOR', PERMISSIONS.FINANCE_READ_ALL)).toBe(false);
    });

    it('can prescribe, revoke, refer, and decide substitutions', () => {
      expect(roleHasPermission('DOCTOR', PERMISSIONS.PRESCRIPTION_CREATE)).toBe(true);
      expect(roleHasPermission('DOCTOR', PERMISSIONS.PRESCRIPTION_REVOKE)).toBe(true);
      expect(roleHasPermission('DOCTOR', PERMISSIONS.REFERRAL_CREATE)).toBe(true);
      expect(roleHasPermission('DOCTOR', PERMISSIONS.SUBSTITUTION_DECIDE)).toBe(true);
    });
  });

  describe('pharmacies', () => {
    it('cannot create or alter a prescription (spec §104)', () => {
      expect(roleHasPermission('PHARMACY', PERMISSIONS.PRESCRIPTION_CREATE)).toBe(false);
      expect(roleHasPermission('PHARMACY', PERMISSIONS.PRESCRIPTION_REVOKE)).toBe(false);
    });

    it('may propose a substitution but never decide one (spec §48)', () => {
      expect(roleHasPermission('PHARMACY', PERMISSIONS.SUBSTITUTION_PROPOSE)).toBe(true);
      expect(roleHasPermission('PHARMACY', PERMISSIONS.SUBSTITUTION_DECIDE)).toBe(false);
    });

    it('cannot write clinical notes — vitals and tests only (spec §18, §73)', () => {
      expect(roleHasPermission('PHARMACY', PERMISSIONS.CLINICAL_NOTES_WRITE)).toBe(false);
      expect(roleHasPermission('PHARMACY', PERMISSIONS.VITALS_WRITE)).toBe(true);
      expect(roleHasPermission('PHARMACY', PERMISSIONS.TESTS_WRITE)).toBe(true);
    });

    it('sees only its own share, never Neem gross revenue (spec §18)', () => {
      expect(roleHasPermission('PHARMACY', PERMISSIONS.FINANCE_READ_OWN)).toBe(true);
      expect(roleHasPermission('PHARMACY', PERMISSIONS.FINANCE_READ_ALL)).toBe(false);
    });

    it('cannot conduct or complete a consultation', () => {
      expect(roleHasPermission('PHARMACY', PERMISSIONS.CONSULTATION_CONDUCT)).toBe(false);
      expect(roleHasPermission('PHARMACY', PERMISSIONS.CONSULTATION_COMPLETE)).toBe(false);
    });

    it('cannot approve refunds or manage settings', () => {
      expect(roleHasPermission('PHARMACY', PERMISSIONS.REFUND_DECIDE)).toBe(false);
      expect(roleHasPermission('PHARMACY', PERMISSIONS.SETTINGS_MANAGE)).toBe(false);
    });
  });

  describe('administrators', () => {
    it('hold every defined permission', () => {
      const all = Object.values(PERMISSIONS);
      for (const permission of all) {
        expect(roleHasPermission('ADMIN', permission)).toBe(true);
      }
    });

    it('are the only role that can read the audit log', () => {
      const readers = (['ADMIN', 'DOCTOR', 'PHARMACY'] as const).filter((role) =>
        roleHasPermission(role, PERMISSIONS.AUDIT_READ),
      );
      expect(readers).toEqual(['ADMIN']);
    });

    it('are the only role that can decide refunds (spec §41)', () => {
      const deciders = (['ADMIN', 'DOCTOR', 'PHARMACY'] as const).filter((role) =>
        roleHasPermission(role, PERMISSIONS.REFUND_DECIDE),
      );
      expect(deciders).toEqual(['ADMIN']);
    });
  });

  it('returns a copy, so a caller cannot mutate the policy at runtime', () => {
    const list = permissionsForRole('DOCTOR');
    list.push(PERMISSIONS.AUDIT_READ);
    expect(roleHasPermission('DOCTOR', PERMISSIONS.AUDIT_READ)).toBe(false);
  });

  it('defines a policy for every role, with no empty set', () => {
    for (const role of ['ADMIN', 'DOCTOR', 'PHARMACY'] as const) {
      expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
    }
  });
});
