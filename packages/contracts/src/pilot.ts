import { z } from 'zod';
import { emailSchema } from './auth.ts';
import { ghanaPhoneSchema } from './onboarding.ts';
import { PILOT_APPLICANT_ROLES, PILOT_APPLICATION_STATUSES } from './enums.ts';

/**
 * Pilot expressions of interest, submitted from the public marketing site.
 *
 * **This is a lead, not a registration.** Real onboarding lives in
 * `onboarding.ts` and requires an MDC number, a licence expiry date, a
 * qualification date, a password and languages before it will accept a doctor.
 * Asking a stranger for their council number and a password on a landing page,
 * before anyone has spoken to them, costs far more sign-ups than it saves.
 *
 * So this collects enough to have a conversation and no more. A row here grants
 * nothing: no account, no session, no capability. Somebody at Neem still has to
 * take the applicant through onboarding, and the wording on the form says so.
 *
 * Nothing clinical belongs here. This is contact information about a
 * professional, not a patient record, and the free-text field is the one place
 * someone might be tempted to paste something else — which is why it is capped
 * and why the API never treats it as anything but a note.
 */

// ---------------------------------------------------------------------------
// What the public form submits
// ---------------------------------------------------------------------------

export const pilotApplicationSchema = z
  .object({
    role: z.enum(PILOT_APPLICANT_ROLES),

    fullName: z.string().trim().min(2).max(160),
    phone: ghanaPhoneSchema,
    email: emailSchema,

    /** Doctors only. Required for a doctor by the refinement below. */
    specialty: z.string().trim().max(120).optional(),

    /** Practice, facility or pharmacy name. */
    organisation: z.string().trim().min(2).max(200),
    location: z.string().trim().min(2).max(160),

    /**
     * Free text, kept as a string.
     *
     * People write "8", "about 8" and "8 years" in this box. Coercing to a
     * number would reject two of those, and the value is only ever read by a
     * human deciding whether to call someone.
     */
    yearsOfPractice: z.string().trim().max(40).optional(),

    additionalInfo: z.string().trim().max(2000).optional(),

    /**
     * Must be true. Consent is the lawful basis for holding these details and
     * for calling this person, so a submission without it is not accepted at
     * all rather than stored with a false flag.
     */
    consent: z.literal(true),
  })
  .refine((value) => value.role !== 'DOCTOR' || Boolean(value.specialty?.length), {
    path: ['specialty'],
    message: 'Tell us your specialty, or enter “General practice”.',
  });

export type PilotApplication = z.infer<typeof pilotApplicationSchema>;

/** What the public endpoint returns. Deliberately thin — it is a public route. */
export const pilotApplicationResponseSchema = z.object({
  reference: z.string(),
  message: z.string(),
});
export type PilotApplicationResponse = z.infer<typeof pilotApplicationResponseSchema>;

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const pilotApplicationStatusUpdateSchema = z.object({
  status: z.enum(PILOT_APPLICATION_STATUSES),
  /** Why. Optional, but the reason is usually the useful part. */
  note: z.string().trim().max(500).optional(),
});
export type PilotApplicationStatusUpdate = z.infer<typeof pilotApplicationStatusUpdateSchema>;

export const pilotApplicationListFilterSchema = z.object({
  role: z.enum(PILOT_APPLICANT_ROLES).optional(),
  status: z.enum(PILOT_APPLICATION_STATUSES).optional(),
  search: z.string().trim().max(120).optional(),
});
export type PilotApplicationListFilter = z.infer<typeof pilotApplicationListFilterSchema>;
