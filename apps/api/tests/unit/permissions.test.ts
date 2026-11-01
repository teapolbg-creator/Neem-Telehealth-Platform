import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  PROFESSIONAL_DISCIPLINES,
  ROLE_PERMISSIONS,
  SUPER_ADMIN_ONLY,
  USER_ROLES,
  disciplineMayPrescribe,
  isAdminRole,
  permissionsForProfessional,
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

    it("cannot dispense — dispensing is the pharmacy's act (spec §46)", () => {
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

  describe('CHPS facility staff (D73)', () => {
    it('hold exactly what the slices so far have granted', () => {
      // Each slice adds exactly what it needs; this fails loudly if a
      // permission arrives without a test saying why. 1b: D75.
      expect(permissionsForRole('FACILITY')).toEqual([
        PERMISSIONS.PATIENT_REGISTER,
        PERMISSIONS.PATIENT_RECORD_READ,
        PERMISSIONS.TRIAGE_WRITE,
        PERMISSIONS.CHPS_CONSULTATION_REQUEST,
        PERMISSIONS.STATION_MANAGE,
        PERMISSIONS.CHPS_REFERRAL_MANAGE,
        PERMISSIONS.CHPS_FOLLOW_UP_MANAGE,
        PERMISSIONS.CHPS_REPORT_READ,
        PERMISSIONS.CHPS_PRESCRIPTION_DISPENSE,
      ]);
    });

    it('cannot manage facilities, prescribe or read anything clinical', () => {
      for (const permission of [
        PERMISSIONS.FACILITY_MANAGE,
        PERMISSIONS.PRESCRIPTION_CREATE,
        PERMISSIONS.CONSULTATION_READ,
        PERMISSIONS.AUDIT_READ,
      ]) {
        expect(roleHasPermission('FACILITY', permission)).toBe(false);
      }
    });
  });

  describe('operations administrators and district officers (D84)', () => {
    it('give operations everything except the super administrator’s list', () => {
      for (const permission of Object.values(PERMISSIONS)) {
        expect(roleHasPermission('OPS_ADMIN', permission)).toBe(
          !SUPER_ADMIN_ONLY.includes(permission),
        );
      }
      for (const permission of [
        PERMISSIONS.STAFF_ACCOUNT_MANAGE,
        PERMISSIONS.SETTINGS_MANAGE,
        PERMISSIONS.AUDIT_READ,
        PERMISSIONS.FINANCE_READ_ALL,
        PERMISSIONS.PAYOUT_MANAGE,
        PERMISSIONS.REFUND_DECIDE,
      ]) {
        expect(SUPER_ADMIN_ONLY).toContain(permission);
      }
      expect(roleHasPermission('OPS_ADMIN', PERMISSIONS.FACILITY_MANAGE)).toBe(true);
      expect(roleHasPermission('OPS_ADMIN', PERMISSIONS.CONSULTATION_ASSIGN)).toBe(true);
    });

    it('let a district officer read their area and nothing else', () => {
      expect(permissionsForRole('DISTRICT')).toEqual([PERMISSIONS.DISTRICT_REPORT_READ]);
    });

    it('treat both administrator roles as administrators, and nobody else', () => {
      expect(USER_ROLES.filter(isAdminRole)).toEqual(['ADMIN', 'OPS_ADMIN']);
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
      const readers = USER_ROLES.filter((role) => roleHasPermission(role, PERMISSIONS.AUDIT_READ));
      expect(readers).toEqual(['ADMIN']);
    });

    it('are the only role that can decide refunds (spec §41)', () => {
      const deciders = (['ADMIN', 'DOCTOR', 'PHARMACY', 'FACILITY'] as const).filter((role) =>
        roleHasPermission(role, PERMISSIONS.REFUND_DECIDE),
      );
      expect(deciders).toEqual(['ADMIN']);
    });
  });

  /**
   * Discipline (v2).
   *
   * A dietitian and a personal trainer hold the DOCTOR role, so the role alone
   * is not the answer to what they may do. These are the cases where getting
   * it wrong means a prescription in the name of somebody who cannot write one.
   */
  describe('disciplines', () => {
    const PRESCRIBING = [
      PERMISSIONS.PRESCRIPTION_CREATE,
      PERMISSIONS.PRESCRIPTION_REVOKE,
      PERMISSIONS.REFERRAL_CREATE,
      PERMISSIONS.SUBSTITUTION_DECIDE,
    ] as const;

    it.each(['DIETITIAN', 'TRAINER'] as const)('withholds prescribing from a %s', (discipline) => {
      const held = permissionsForProfessional('DOCTOR', discipline);

      for (const permission of PRESCRIBING) {
        expect(held).not.toContain(permission);
      }
      expect(disciplineMayPrescribe(discipline)).toBe(false);
    });

    it('leaves them everything a consultation itself needs', () => {
      const held = permissionsForProfessional('DOCTOR', 'DIETITIAN');

      expect(held).toContain(PERMISSIONS.CONSULTATION_CONDUCT);
      expect(held).toContain(PERMISSIONS.CONSULTATION_COMPLETE);
      expect(held).toContain(PERMISSIONS.CLINICAL_NOTES_WRITE);
    });

    it('gives a doctor exactly what the role gives', () => {
      expect(permissionsForProfessional('DOCTOR', 'DOCTOR')).toEqual(permissionsForRole('DOCTOR'));
    });

    /** Every professional who existed before v2 has no discipline recorded. */
    it('treats a missing discipline as a doctor', () => {
      expect(permissionsForProfessional('DOCTOR', null)).toEqual(permissionsForRole('DOCTOR'));
      expect(disciplineMayPrescribe(undefined)).toBe(true);
    });

    it('answers for every discipline there is', () => {
      for (const discipline of PROFESSIONAL_DISCIPLINES) {
        expect(permissionsForProfessional('DOCTOR', discipline).length).toBeGreaterThan(0);
      }
    });

    /** Discipline narrows a professional. It has no bearing on anyone else. */
    it('does not touch pharmacies or administrators', () => {
      expect(permissionsForProfessional('PHARMACY', null)).toEqual(permissionsForRole('PHARMACY'));
      expect(permissionsForProfessional('ADMIN', null)).toEqual(permissionsForRole('ADMIN'));
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
