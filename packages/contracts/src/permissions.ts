import type { UserRole } from './enums.ts';

/**
 * Role-based access control.
 *
 * These strings are the vocabulary; the API enforces them in middleware on
 * every protected route (docs/security.md §4). The web app uses the same list
 * only to decide what to render — it is never the enforcement point (spec §92).
 *
 * Beyond a permission check, resource routes additionally apply an ownership
 * predicate. Holding `prescription:read` does not let a pharmacy read another
 * pharmacy's prescription.
 */

export const PERMISSIONS = {
  // Consultations
  CONSULTATION_CREATE: 'consultation:create',
  CONSULTATION_READ: 'consultation:read',
  CONSULTATION_CANCEL: 'consultation:cancel',
  CONSULTATION_REASSIGN_REQUEST: 'consultation:reassign-request',
  CONSULTATION_ASSIGN: 'consultation:assign',
  CONSULTATION_CONDUCT: 'consultation:conduct',
  CONSULTATION_COMPLETE: 'consultation:complete',

  // Clinical
  VITALS_WRITE: 'vitals:write',
  TESTS_WRITE: 'tests:write',
  CLINICAL_NOTES_WRITE: 'clinical-notes:write',

  // Prescriptions
  PRESCRIPTION_CREATE: 'prescription:create',
  PRESCRIPTION_READ: 'prescription:read',
  PRESCRIPTION_REVOKE: 'prescription:revoke',
  PRESCRIPTION_DISPENSE: 'prescription:dispense',
  SUBSTITUTION_PROPOSE: 'substitution:propose',
  SUBSTITUTION_DECIDE: 'substitution:decide',

  // Referrals
  REFERRAL_CREATE: 'referral:create',
  REFERRAL_READ: 'referral:read',

  // Finance
  FINANCE_READ_OWN: 'finance:read-own',
  FINANCE_READ_ALL: 'finance:read-all',
  REFUND_REQUEST: 'refund:request',
  REFUND_DECIDE: 'refund:decide',
  PAYOUT_MANAGE: 'payout:manage',

  // Administration
  DOCTOR_MANAGE: 'doctor:manage',
  PHARMACY_MANAGE: 'pharmacy:manage',
  SHIFT_MANAGE: 'shift:manage',
  SUBSCRIPTION_MANAGE: 'subscription:manage',
  SETTINGS_MANAGE: 'settings:manage',
  PROMOTION_MANAGE: 'promotion:manage',
  NOTIFICATION_TEMPLATE_MANAGE: 'notification-template:manage',
  COMPLAINT_MANAGE: 'complaint:manage',
  QUALITY_READ: 'quality:read',
  FEEDBACK_READ: 'feedback:read',
  ANALYTICS_READ: 'analytics:read',
  AUDIT_READ: 'audit:read',
  SYSTEM_HEALTH_READ: 'system-health:read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const P = PERMISSIONS;

/**
 * Deliberate omissions, each traceable to the specification:
 *
 *  - DOCTOR has no FEEDBACK_READ and no QUALITY_READ. Doctors must not see
 *    their ratings or their quality score (spec §24, §52).
 *  - DOCTOR has no CONSULTATION_CREATE. Consultations originate at a pharmacy.
 *  - PHARMACY has no PRESCRIPTION_CREATE, PRESCRIPTION_REVOKE, or
 *    SUBSTITUTION_DECIDE. A pharmacy may propose, never alter (spec §48, §104).
 *  - PHARMACY has no FINANCE_READ_ALL. It sees its own share, never Neem's
 *    gross revenue (spec §18).
 *  - Nobody but ADMIN reads the audit log.
 */
export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  PHARMACY: [
    P.CONSULTATION_CREATE,
    P.CONSULTATION_READ,
    P.CONSULTATION_CANCEL,
    P.CONSULTATION_REASSIGN_REQUEST,
    P.VITALS_WRITE,
    P.TESTS_WRITE,
    P.PRESCRIPTION_READ,
    P.PRESCRIPTION_DISPENSE,
    P.SUBSTITUTION_PROPOSE,
    P.REFERRAL_READ,
    P.FINANCE_READ_OWN,
    /**
     * The pharmacy took the money and is who the patient comes back to. By the
     * time a refund is worth asking for the patient has often left, so the
     * counter must be able to ask on their behalf. Deciding remains an
     * administrator's alone (spec §41).
     */
    P.REFUND_REQUEST,
  ],

  DOCTOR: [
    P.CONSULTATION_READ,
    P.CONSULTATION_CONDUCT,
    P.CONSULTATION_COMPLETE,
    P.CLINICAL_NOTES_WRITE,
    P.PRESCRIPTION_CREATE,
    P.PRESCRIPTION_READ,
    P.PRESCRIPTION_REVOKE,
    P.SUBSTITUTION_DECIDE,
    P.REFERRAL_CREATE,
    P.REFERRAL_READ,
    P.FINANCE_READ_OWN,
  ],

  ADMIN: Object.values(P),
};

/** Patient sessions carry no permissions. Their routes are session-scoped. */
export function permissionsForRole(role: UserRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
