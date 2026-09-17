import type { ProfessionalDiscipline } from '@neem/contracts';

/**
 * How a professional is identified on anything a patient can hold (v2).
 *
 * Every professional used to be a doctor, so a document said `MDC 12345` and
 * that was the whole of it. A dietitian and a personal trainer are not
 * registered with the Medical and Dental Council, and printing an MDC number
 * for one of them — or printing nothing where a reader expects a registration —
 * would misrepresent who signed the document.
 *
 * So the line is built from what the professional actually is. There is no
 * automated verification behind any of these numbers, for doctors either
 * (spec §22); what this renders is what a human administrator recorded.
 */

export interface CredentialSource {
  discipline?: ProfessionalDiscipline | null;
  mdcNumber?: string | null;
  credentialType?: string | null;
  credentialNumber?: string | null;
}

/** The fields every credential line needs, for a Prisma `select`. */
export const CREDENTIAL_SELECT = {
  discipline: true,
  mdcNumber: true,
  credentialType: true,
  credentialNumber: true,
} as const;

/**
 * The registration line, or null when there is nothing honest to print.
 *
 * Null rather than an empty string or a placeholder: a caller has to decide
 * what to do with a missing registration, and every one of them here omits
 * the line rather than inventing one.
 */
export function credentialLine(professional: CredentialSource): string | null {
  const discipline = professional.discipline ?? 'DOCTOR';

  if (discipline === 'DOCTOR') {
    return professional.mdcNumber ? `MDC ${professional.mdcNumber}` : null;
  }

  const parts = [professional.credentialType, professional.credentialNumber].filter(
    (part): part is string => Boolean(part && part.trim()),
  );

  return parts.length > 0 ? parts.join(' ') : null;
}

/** Name and registration, the shape every document and verification uses. */
export function signatory<T extends CredentialSource & { fullName: string }>(
  professional: T,
): { fullName: string; credential: string | null } {
  return { fullName: professional.fullName, credential: credentialLine(professional) };
}
