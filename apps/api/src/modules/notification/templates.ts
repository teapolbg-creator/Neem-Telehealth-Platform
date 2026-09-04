/**
 * The notification catalogue (spec §58, §60).
 *
 * Every notification Neem sends is declared here with the variables it may
 * use. That list is the enforcement point for the rule that matters most in
 * this module: **no notification payload contains clinical content.**
 *
 * A template can only interpolate the variables named in `variables`, and the
 * renderer refuses any it was not given. So a template cannot quietly grow a
 * `{{diagnosis}}` — there is nothing to fill it from, and the render fails
 * loudly rather than sending a blank or, worse, the literal placeholder.
 *
 * What a notification may say is deliberately thin: something has happened,
 * and here is where to look. The detail lives behind an authenticated screen.
 */

export type TemplateChannel = 'IN_APP' | 'BROWSER' | 'SMS' | 'EMAIL' | 'WHATSAPP';

export interface TemplateDefinition {
  code: string;
  /** Channels this notification is sent on, in order of preference. */
  channels: TemplateChannel[];
  locale: string;
  subject?: string;
  body: string;
  /**
   * Every variable the body may use.
   *
   * Names only — never a value, and never anything clinical. Adding one is a
   * deliberate act, which is the point.
   */
  variables: string[];
  description: string;
}

export const NOTIFICATION_TEMPLATES: TemplateDefinition[] = [
  // --- Doctor ---------------------------------------------------------------
  {
    code: 'doctor.consultation.offered',
    channels: ['IN_APP', 'BROWSER', 'SMS'],
    locale: 'en',
    subject: 'A consultation is waiting',
    body: 'A patient is waiting at {{pharmacyName}}. You have {{seconds}} seconds to accept. Open Neem to respond.',
    variables: ['pharmacyName', 'seconds'],
    description: 'A consultation has been offered and the response window is running (spec §30).',
  },
  {
    code: 'doctor.consultation.missed',
    channels: ['IN_APP', 'EMAIL'],
    locale: 'en',
    subject: 'You missed a consultation offer',
    body: 'An offer at {{pharmacyName}} was not answered in time and has gone to another doctor.',
    variables: ['pharmacyName'],
    description: 'The 90-second window lapsed without a response.',
  },
  {
    code: 'doctor.substitution.requested',
    channels: ['IN_APP', 'BROWSER', 'SMS'],
    locale: 'en',
    subject: 'A pharmacy is waiting on your decision',
    body: '{{pharmacyName}} has proposed a substitution on a prescription you issued. It cannot be dispensed until you decide.',
    variables: ['pharmacyName'],
    description: 'A substitution is blocking a prescription (spec §47).',
  },
  {
    code: 'doctor.shift.assigned',
    channels: ['IN_APP', 'EMAIL'],
    locale: 'en',
    subject: 'A shift has been assigned to you',
    body: 'You have been assigned the {{shiftLabel}} shift on {{serviceDate}}. Please confirm it in Neem.',
    variables: ['shiftLabel', 'serviceDate'],
    description: 'An admin assigned a shift that needs confirming (spec §25).',
  },
  {
    code: 'doctor.membership.expiring',
    channels: ['IN_APP', 'EMAIL', 'SMS'],
    locale: 'en',
    subject: 'Your Neem membership is ending',
    body: 'Your membership ends on {{periodEnd}}. Renew it in Neem to keep receiving consultations.',
    variables: ['periodEnd'],
    description: 'Advance warning before expiry suspends the account (spec §27).',
  },
  {
    code: 'doctor.membership.suspended',
    channels: ['IN_APP', 'EMAIL', 'SMS'],
    locale: 'en',
    subject: 'Your Neem account is suspended',
    body: 'Your membership expired and your account is suspended. Renew it in Neem to be reinstated.',
    variables: [],
    description: 'Membership lapsed past its grace period (spec §27).',
  },
  {
    code: 'doctor.licence.expiring',
    channels: ['IN_APP', 'EMAIL'],
    locale: 'en',
    subject: 'Your MDC licence is approaching expiry',
    body: 'Neem has your MDC licence expiring on {{expiresAt}}. Send an updated licence before then.',
    variables: ['expiresAt'],
    description: 'A licence nearing expiry (spec §22).',
  },
  {
    code: 'doctor.account.approved',
    channels: ['IN_APP', 'EMAIL'],
    locale: 'en',
    subject: 'Your Neem application has been approved',
    body: 'Your application has been approved. Sign in to Neem to complete your setup.',
    variables: [],
    description: 'An admin approved the application (spec §21).',
  },

  // --- Pharmacy -------------------------------------------------------------
  {
    code: 'pharmacy.consultation.doctor-assigned',
    channels: ['IN_APP', 'BROWSER'],
    locale: 'en',
    subject: 'A doctor has accepted',
    body: 'A doctor has accepted consultation {{consultationReference}}.',
    variables: ['consultationReference'],
    description: 'A waiting consultation has been picked up (spec §31).',
  },
  {
    code: 'pharmacy.prescription.issued',
    channels: ['IN_APP', 'BROWSER'],
    locale: 'en',
    subject: 'A prescription is ready',
    body: 'A prescription has been issued for consultation {{consultationReference}} and is ready to dispense.',
    variables: ['consultationReference'],
    description: 'A prescription reached the counter (spec §45).',
  },
  {
    code: 'pharmacy.prescription.revoked',
    channels: ['IN_APP', 'BROWSER', 'SMS'],
    locale: 'en',
    subject: 'A prescription has been withdrawn',
    body: 'The doctor has revoked the prescription for consultation {{consultationReference}}. Do not dispense it.',
    variables: ['consultationReference'],
    description: 'A revocation the counter must see before dispensing (spec §46).',
  },
  {
    code: 'pharmacy.substitution.decided',
    channels: ['IN_APP', 'BROWSER'],
    locale: 'en',
    subject: 'The doctor has answered your substitution',
    body: 'The doctor has {{decision}} your substitution on consultation {{consultationReference}}.',
    variables: ['decision', 'consultationReference'],
    description: 'A substitution decision releasing a held prescription (spec §47).',
  },
  {
    code: 'pharmacy.consultation.no-doctor',
    channels: ['IN_APP', 'BROWSER'],
    locale: 'en',
    subject: 'No doctor is available yet',
    body: 'Consultation {{consultationReference}} is still waiting. Neem is looking for a doctor who speaks the patient’s language.',
    variables: ['consultationReference'],
    description: 'The queue is starved and the counter should know (spec §29).',
  },
  {
    code: 'pharmacy.refund.decided',
    channels: ['IN_APP', 'EMAIL'],
    locale: 'en',
    subject: 'A refund request has been decided',
    body: 'Neem has {{decision}} the refund request for consultation {{consultationReference}}.',
    variables: ['decision', 'consultationReference'],
    description: 'An administrator decided a refund (spec §41).',
  },
  {
    code: 'pharmacy.account.approved',
    channels: ['IN_APP', 'EMAIL'],
    locale: 'en',
    subject: 'Your pharmacy has been approved',
    body: 'Your pharmacy has been approved on Neem. You can now start consultations.',
    variables: [],
    description: 'An admin approved the pharmacy (spec §20).',
  },

  // --- Patient --------------------------------------------------------------
  {
    code: 'patient.consultation.ready',
    channels: ['SMS'],
    locale: 'en',
    subject: undefined,
    body: 'Your Neem consultation is ready. Open the link the pharmacy gave you to join.',
    variables: [],
    description: 'A doctor is ready (spec §31).',
  },
  {
    code: 'patient.consultation.complete',
    channels: ['SMS'],
    locale: 'en',
    subject: undefined,
    /**
     * The reference and nothing else.
     *
     * This is the only route back to their own record (D24), and an SMS is
     * where a patient will still have it next month. It says nothing about
     * what happened — an SMS is readable by anyone holding the phone.
     */
    body: 'Your Neem consultation is complete. Your reference is {{consultationReference}}. Keep it.',
    variables: ['consultationReference'],
    description: 'Gives the patient their consultation reference (D24).',
  },

  // --- Admin ----------------------------------------------------------------
  {
    code: 'admin.queue.no-language-match',
    channels: ['IN_APP', 'EMAIL'],
    locale: 'en',
    subject: 'A consultation has no language match',
    body: 'Consultation {{consultationReference}} has waited {{minutes}} minutes with no doctor available who speaks {{language}}.',
    variables: ['consultationReference', 'minutes', 'language'],
    description: 'The queue cannot route for language (spec §29).',
  },
  {
    code: 'admin.payment.anomaly',
    channels: ['IN_APP', 'EMAIL'],
    locale: 'en',
    subject: 'A payment needs review',
    body: 'A payment discrepancy was recorded: {{kind}}. Check the reconciliation report.',
    variables: ['kind'],
    description: 'Reconciliation or settlement found drift (docs/payment-flow.md §10).',
  },
  {
    code: 'admin.refund.requested',
    channels: ['IN_APP', 'EMAIL'],
    locale: 'en',
    subject: 'A refund has been requested',
    body: 'A refund of {{amount}} has been requested for consultation {{consultationReference}}.',
    variables: ['amount', 'consultationReference'],
    description: 'Someone is waiting on a refund decision (spec §41).',
  },
  {
    code: 'admin.retention.overdue',
    channels: ['IN_APP', 'EMAIL'],
    locale: 'en',
    subject: 'Clinical record destruction is overdue',
    body: '{{count}} clinical record(s) are past their scheduled destruction date and have not been destroyed.',
    variables: ['count'],
    description: 'A retention obligation is not being met (decision D23).',
  },
];

/**
 * Words a template body may never contain.
 *
 * A blunt instrument, and deliberately so. The real guarantee is that a
 * template can only use the variables it declares, but an author can still
 * write clinical wording as *literal text* — "your malaria test was positive"
 * needs no variable at all. This catches that at the point a template is
 * written or edited, rather than after it has been sent.
 */
const FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  // Word stems, which legitimately match longer forms: diagnosis, diagnosed.
  { label: 'diagnos', pattern: /diagnos/i },
  { label: 'symptom', pattern: /symptom/i },
  { label: 'pregnan', pattern: /pregnan/i },
  { label: 'medication', pattern: /medication/i },
  { label: 'prescribed', pattern: /prescribed/i },
  { label: 'treatment', pattern: /treatment/i },
  { label: 'malaria', pattern: /malaria/i },
  /**
   * Whole words only.
   *
   * These are short enough to appear inside ordinary ones — "mg" sits in
   * "amgen", "dose" in "doses of goodwill" — and a check that fired on every
   * substring would be ignored within a week, which is worse than not having
   * it.
   */
  { label: 'dose', pattern: /\bdoses?\b/i },
  { label: 'mg', pattern: /\b\d*\s*mg\b/i },
  { label: 'blood', pattern: /\bblood\b/i },
  { label: 'positive', pattern: /\bpositive\b/i },
  { label: 'negative', pattern: /\bnegative\b/i },
  { label: 'test result', pattern: /\btest results?\b/i },
];

export interface TemplateProblem {
  code: string;
  problem: string;
}

/**
 * Checks a body against the two rules.
 *
 * Used by the seed and by the admin template editor, so a template that would
 * carry clinical content cannot be saved — not merely cannot be sent.
 */
export function validateTemplateBody(body: string, allowedVariables: string[]): TemplateProblem[] {
  const problems: TemplateProblem[] = [];

  const used = [...body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]!);
  for (const variable of used) {
    if (!allowedVariables.includes(variable)) {
      problems.push({
        code: 'unknown-variable',
        problem: `{{${variable}}} is not a variable this notification provides.`,
      });
    }
  }

  for (const { label, pattern } of FORBIDDEN_PATTERNS) {
    if (pattern.test(body)) {
      problems.push({
        code: 'clinical-content',
        problem: `"${label}" reads as clinical content, which a notification must never carry (spec §60).`,
      });
    }
  }

  return problems;
}

/**
 * Templates the catalogue declares but nothing in the application sends.
 *
 * Found in Phase 11: 17 of the 21 templates below had no producer. Every one
 * was complete — subject, body, channels, variables, and an admin screen to
 * reword them on — and nothing anywhere called `notify()` with the code. An
 * administrator could word a message with care and it would never reach
 * anyone, and the product said nothing about it.
 *
 * This set is exported for two consumers, which is the point of it existing
 * here rather than in either of them:
 *
 *  - `GET /admin/notification-templates` marks these rows, so the screen tells
 *    the truth about what editing them achieves today;
 *  - `tests/integration/notification-producers.test.ts` checks it against the
 *    actual source, so it cannot quietly go stale in either direction.
 *
 * It is a debt register. Wiring a producer means deleting the entry, and the
 * test fails until it is deleted.
 */
export const TEMPLATES_WITHOUT_PRODUCER: ReadonlySet<string> = new Set([
  'doctor.consultation.missed',
  'doctor.shift.assigned',
  'doctor.membership.expiring',
  'doctor.membership.suspended',
  'doctor.licence.expiring',
  'doctor.account.approved',
  'pharmacy.consultation.doctor-assigned',
  'pharmacy.prescription.revoked',
  'pharmacy.substitution.decided',
  'pharmacy.consultation.no-doctor',
  'pharmacy.refund.decided',
  'pharmacy.account.approved',
  'patient.consultation.ready',
  'admin.queue.no-language-match',
  'admin.payment.anomaly',
  'admin.refund.requested',
  'admin.retention.overdue',
]);
