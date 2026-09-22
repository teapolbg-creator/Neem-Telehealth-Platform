import { describe, expect, it } from 'vitest';
import { documentTypesFor, PROFESSIONAL_DOCUMENTS } from '@neem/contracts';

/**
 * What each kind of professional uploads (v2). The upload route refuses any
 * type not on this list, so these are the rules a trainer's file is held to.
 */
describe('documents asked of each profession', () => {
  it('asks a dietitian for only a CV, an AHPC licence and a government ID', () => {
    expect(PROFESSIONAL_DOCUMENTS.DIETITIAN.required).toEqual([
      'CV',
      'AHPC_LICENCE',
      'GOVERNMENT_ID',
    ]);
    expect(documentTypesFor('DIETITIAN')).toEqual(['CV', 'AHPC_LICENCE', 'GOVERNMENT_ID']);
  });

  it('asks a trainer for only a CV, a government ID and a portfolio', () => {
    expect(PROFESSIONAL_DOCUMENTS.TRAINER.required).toEqual(['CV', 'GOVERNMENT_ID', 'PORTFOLIO']);
    expect(documentTypesFor('TRAINER')).toEqual(['CV', 'GOVERNMENT_ID', 'PORTFOLIO']);
  });

  it('never lets a dietitian or trainer file an MDC licence', () => {
    expect(documentTypesFor('DIETITIAN')).not.toContain('MDC_LICENCE');
    expect(documentTypesFor('TRAINER')).not.toContain('MDC_LICENCE');
  });

  it('leaves a doctor asked for what they always were', () => {
    expect(PROFESSIONAL_DOCUMENTS.DOCTOR.required).toEqual([
      'MDC_LICENCE',
      'GOVERNMENT_ID',
      'PRACTICE_EVIDENCE',
    ]);
    expect(documentTypesFor('DOCTOR')).toContain('EMPLOYMENT_VERIFICATION');
    expect(documentTypesFor('DOCTOR')).not.toContain('PORTFOLIO');
  });
});
