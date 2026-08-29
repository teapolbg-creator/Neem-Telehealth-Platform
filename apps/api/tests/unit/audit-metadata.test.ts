import { describe, expect, it } from 'vitest';
import { sanitiseAuditMetadata } from '../../src/modules/audit/audit.service.ts';

/**
 * Spec §61: "Audit logs must not become a backdoor medical-history database."
 *
 * The audit log is permanent and append-only, so anything that leaks into it
 * survives the consultation purge. These tests are the enforcement of that
 * rule, not a description of it.
 */
describe('audit metadata sanitiser', () => {
  it('drops clinical content', () => {
    const result = sanitiseAuditMetadata({
      consultationId: 'cons_abc123',
      diagnosis: 'Suspected uncomplicated malaria',
      notes: 'Patient reports fever for three days',
      treatment: 'Artemether-Lumefantrine',
      symptoms: 'fever, chills',
    });

    expect(result).toBeDefined();
    expect(result).not.toHaveProperty('diagnosis');
    expect(result).not.toHaveProperty('notes');
    expect(result).not.toHaveProperty('treatment');
    expect(result).not.toHaveProperty('symptoms');
    expect(result?.consultationId).toBe('cons_abc123');
  });

  it('drops patient identifiers', () => {
    const result = sanitiseAuditMetadata({
      patientName: 'Efua Mensah',
      fullName: 'Efua Mensah',
      phone: '0240000000',
      paymentPhone: '0550000000',
      age: 34,
    });

    expect(result).not.toHaveProperty('patientName');
    expect(result).not.toHaveProperty('fullName');
    expect(result).not.toHaveProperty('phone');
    expect(result).not.toHaveProperty('paymentPhone');
    // Age alone is not identifying and is useful for operational analytics.
    expect(result?.age).toBe(34);
  });

  it('drops prescription content while keeping the identifier', () => {
    const result = sanitiseAuditMetadata({
      prescriptionId: 'rx_xyz789',
      medication: 'Amoxicillin 500mg',
      dose: '1 cap TID',
      instructions: 'After food',
      itemCount: 2,
    });

    expect(result?.prescriptionId).toBe('rx_xyz789');
    expect(result?.itemCount).toBe(2);
    expect(result).not.toHaveProperty('medication');
    expect(result).not.toHaveProperty('dose');
    expect(result).not.toHaveProperty('instructions');
  });

  it('drops credentials and tokens', () => {
    const result = sanitiseAuditMetadata({
      password: 'hunter2',
      token: 'abc',
      tokenHash: 'def',
      secret: 'ghi',
      signature: 'jkl',
      action: 'login',
    });

    for (const key of ['password', 'token', 'tokenHash', 'secret', 'signature']) {
      expect(result).not.toHaveProperty(key);
    }
    expect(result?.action).toBe('login');
  });

  it('is case-insensitive, so casing cannot smuggle content through', () => {
    const result = sanitiseAuditMetadata({ Diagnosis: 'x', PATIENTNAME: 'y', NoTeS: 'z' });
    expect(result).not.toHaveProperty('Diagnosis');
    expect(result).not.toHaveProperty('PATIENTNAME');
    expect(result).not.toHaveProperty('NoTeS');
  });

  it('drops nested objects, which is where free text hides', () => {
    const result = sanitiseAuditMetadata({
      consultationId: 'cons_1',
      payload: { diagnosis: 'malaria', patientName: 'Efua' },
    });

    expect(result).not.toHaveProperty('payload');
    expect(result?.consultationId).toBe('cons_1');
  });

  it('records which keys it dropped, so the omission is visible in review', () => {
    const result = sanitiseAuditMetadata({ consultationId: 'c1', diagnosis: 'x' });
    expect(result?._droppedKeys).toContain('diagnosis');
  });

  it('truncates long strings so free text cannot be smuggled in a safe key', () => {
    const result = sanitiseAuditMetadata({ reason: 'a'.repeat(5000) });
    expect((result?.reason as string).length).toBe(300);
  });

  it('keeps scalar arrays but strips object elements', () => {
    const result = sanitiseAuditMetadata({
      states: ['PAID', 'ACTIVATED'],
      mixed: ['ok', { diagnosis: 'x' }, 42],
    });

    expect(result?.states).toEqual(['PAID', 'ACTIVATED']);
    expect(result?.mixed).toEqual(['ok', 42]);
  });

  it('returns undefined rather than an empty object when everything is dropped', () => {
    expect(sanitiseAuditMetadata(undefined)).toBeUndefined();
    expect(sanitiseAuditMetadata({})).toBeUndefined();
  });
});
