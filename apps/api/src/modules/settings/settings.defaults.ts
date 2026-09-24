/**
 * System settings catalogue.
 *
 * Every business rule that an operator might reasonably want to change lives
 * here and is stored in the `system_settings` table — never as a literal in
 * source code (spec §38, §39, §56).
 *
 * `requiresConfirm: true` marks a setting whose change the admin UI must
 * confirm with an explicit impact description, and which is written to
 * `system_setting_history` and the audit log (spec §96).
 */

export const SETTING_KEYS = {
  CONSULTATION_PRICE_MINOR: 'consultation.priceMinor',
  CONSULTATION_CURRENCY: 'consultation.currency',
  CONSULTATION_DURATION_SECONDS: 'consultation.durationSeconds',
  CONSULTATION_WARNING_SECONDS: 'consultation.warningSeconds',
  PAYMENT_WINDOW_SECONDS: 'consultation.paymentWindowSeconds',
  QR_TOKEN_TTL_SECONDS: 'consultation.qrTokenTtlSeconds',
  REQUIRE_DOCTOR_ON_DUTY: 'consultation.requireDoctorOnDuty',

  CHANNELS_DIRECT_ENABLED: 'channels.directEnabled',

  PATIENT_CODE_TTL_SECONDS: 'patient.accountCodeTtlSeconds',
  PATIENT_CODE_MAX_ATTEMPTS: 'patient.accountCodeMaxAttempts',
  PATIENT_SESSION_HOURS: 'patient.accountSessionHours',

  REVENUE_PHARMACY_BP: 'revenue.pharmacySharePctBp',
  REVENUE_NEEM_BP: 'revenue.neemSharePctBp',
  REVENUE_PROFESSIONAL_EARNINGS_ENABLED: 'revenue.professionalEarningsEnabled',
  REVENUE_PROFESSIONAL_BP: 'revenue.professionalSharePctBp',
  REVENUE_COUNTER_SHARE_FROM: 'revenue.counterShareFrom',
  DOCTOR_MEMBERSHIP_REQUIRED: 'doctor.membershipRequired',

  QUEUE_RESPONSE_WINDOW_SECONDS: 'queue.responseWindowSeconds',
  QUEUE_MAX_OFFER_ATTEMPTS: 'queue.maxOfferAttemptsBeforeAlert',
  QUEUE_DELAY_ALERT_SECONDS: 'queue.delayAlertSeconds',
  QUEUE_MAX_WAIT_SECONDS: 'queue.maxWaitSeconds',
  QUEUE_WEIGHT_LANGUAGE: 'queue.weights.language',
  QUEUE_WEIGHT_AVAILABILITY: 'queue.weights.availability',
  QUEUE_WEIGHT_WORKLOAD: 'queue.weights.workload',
  QUEUE_WEIGHT_RESPONSE_TIME: 'queue.weights.responseTime',
  QUEUE_WEIGHT_RECENT_COUNT: 'queue.weights.recentCount',
  QUEUE_WEIGHT_QUALITY: 'queue.weights.quality',

  QUALITY_WEIGHT_RATING: 'quality.weights.rating',
  QUALITY_WEIGHT_COMPLAINTS: 'quality.weights.complaints',
  QUALITY_WEIGHT_RESPONSE_TIME: 'quality.weights.responseTime',
  QUALITY_WEIGHT_MISSED: 'quality.weights.missedResponses',
  QUALITY_WEIGHT_COMPLETION: 'quality.weights.completionRate',
  QUALITY_WEIGHT_AUDIT: 'quality.weights.auditOutcomes',
  QUALITY_WEIGHT_RX_ISSUES: 'quality.weights.prescriptionIssues',

  DOCTOR_MAX_HOURS_PER_WEEK: 'doctor.maxServiceHoursPerWeek',
  DOCTOR_FULL_TIME_MONTHLY_MINOR: 'doctor.fullTimeMonthlySalaryMinor',
  DOCTOR_MEMBERSHIP_FEE_MINOR: 'doctor.membershipFeeMinor',
  DOCTOR_MEMBERSHIP_MONTHS: 'doctor.membershipPeriodMonths',
  DOCTOR_MEMBERSHIP_GRACE_DAYS: 'doctor.membershipGraceDays',
  DOCTOR_MEMBERSHIP_WARNING_DAYS: 'doctor.membershipExpiryWarningDays',
  DOCTOR_MIN_YEARS_EXPERIENCE: 'doctor.minYearsExperience',
  DOCTOR_LICENCE_WARNING_DAYS: 'doctor.licenceExpiryWarningDays',
  DOCTOR_MAX_CONCURRENT: 'doctor.maxConcurrentConsultations',

  MEDIA_MAX_CONCURRENT_CALLS: 'media.maxConcurrentBridgedCalls',

  NOTIFICATIONS_SMS_ENABLED: 'notifications.smsEnabled',

  RETENTION_BACKUP_WINDOW_DAYS: 'retention.backupWindowDays',
  RETENTION_CLINICAL_RECORD_YEARS: 'retention.clinicalRecordYears',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export interface SettingDefinition {
  key: SettingKey;
  value: unknown;
  valueType: 'number' | 'string' | 'boolean' | 'json';
  description: string;
  category: string;
  requiresConfirm?: boolean;
}

const K = SETTING_KEYS;

export const DEFAULT_SETTINGS: SettingDefinition[] = [
  // --- Consultation -------------------------------------------------------
  {
    key: K.CONSULTATION_PRICE_MINOR,
    // Seeded, not fixed. The business documents never settle on a figure and
    // the specification forbids hard-coding one (spec §38).
    // GHS 50, matching a general consultation booked directly (operator's
    // decision, 2026-09-18). Seeded for new environments only: a live
    // environment keeps the price its administrator set until they change it.
    value: 5000,
    valueType: 'number',
    description: 'Counter consultation fee in minor units (pesewas). 5000 = GH₵ 50.00.',
    category: 'consultation',
    requiresConfirm: true,
  },
  {
    key: K.CONSULTATION_CURRENCY,
    value: 'GHS',
    valueType: 'string',
    description: 'ISO 4217 currency for consultation pricing.',
    category: 'consultation',
    requiresConfirm: true,
  },
  {
    key: K.CONSULTATION_DURATION_SECONDS,
    value: 300,
    valueType: 'number',
    description:
      'Default consultation length (5 minutes). The timer NEVER terminates a consultation — only the doctor completes it (spec §15).',
    category: 'consultation',
  },
  {
    key: K.CONSULTATION_WARNING_SECONDS,
    value: 60,
    valueType: 'number',
    description: 'Seconds remaining at which the doctor and patient see a time warning.',
    category: 'consultation',
  },
  {
    key: K.PAYMENT_WINDOW_SECONDS,
    value: 300,
    valueType: 'number',
    description:
      'How long a pending payment stays valid before the consultation expires (spec §35).',
    category: 'consultation',
  },
  {
    key: K.QR_TOKEN_TTL_SECONDS,
    value: 1800,
    valueType: 'number',
    description: 'Lifetime of a one-time consultation QR token before it expires unused.',
    category: 'consultation',
  },
  {
    key: K.REQUIRE_DOCTOR_ON_DUTY,
    value: true,
    valueType: 'boolean',
    description:
      'Refuse to start, or take payment for, a consultation when no doctor is on duty — active, licensed, paid up and on a confirmed shift covering now (D50).',
    category: 'consultation',
    requiresConfirm: true,
  },
  {
    key: K.CHANNELS_DIRECT_ENABLED,
    value: false,
    valueType: 'boolean',
    /*
     * Off until the patient-direct service is finished and authorised.
     *
     * While it is off, the public service list is empty and says so, so a
     * half-built journey cannot be reached by guessing a URL. The pharmacy
     * counter does not read this setting at all.
     */
    description:
      'Whether patients can book consultations themselves, without a pharmacy (v2). Off until the journey is complete and authorised.',
    category: 'consultation',
    requiresConfirm: true,
  },
  {
    key: K.PATIENT_CODE_TTL_SECONDS,
    value: 600,
    valueType: 'number',
    description: 'How long a patient sign-in code stays valid (v2).',
    category: 'patient',
  },
  {
    key: K.PATIENT_CODE_MAX_ATTEMPTS,
    value: 5,
    valueType: 'number',
    description: 'Wrong guesses allowed against one patient sign-in code before it is dead (v2).',
    category: 'patient',
  },
  {
    key: K.PATIENT_SESSION_HOURS,
    value: 168,
    valueType: 'number',
    description:
      'How long a patient stays signed in to their account, in hours (v2). Their documents are reachable for this long without a new code.',
    category: 'patient',
  },

  // --- Revenue ------------------------------------------------------------
  {
    key: K.REVENUE_PHARMACY_BP,
    // 20%, of what the patient paid (operator's decision, 2026-09-18).
    value: 2000,
    valueType: 'number',
    description:
      "Pharmacy share of a counter consultation, of what the patient paid, in basis points. 2000 = 20.00%. The doctor's share comes out of the remainder, after the provider fee.",
    category: 'revenue',
    requiresConfirm: true,
  },
  {
    key: K.REVENUE_NEEM_BP,
    value: 8000,
    valueType: 'number',
    description: 'Neem share in basis points. Must complement the pharmacy share to 10000.',
    category: 'revenue',
    requiresConfirm: true,
  },
  {
    key: K.REVENUE_PROFESSIONAL_EARNINGS_ENABLED,
    value: false,
    valueType: 'boolean',
    /*
     * Off, and it stays off until somebody has decided what a professional is
     * paid (v2).
     *
     * The share below has no honest default — a number invented here would be
     * a number somebody is paid — so this switch is what stops the machinery
     * running on a guess. While it is off no earning is recorded at all, and
     * turning it on with the share still at zero is refused.
     */
    description:
      'Whether a share of each patient-direct consultation is recorded as earned by the professional (v2). Off until the split is agreed.',
    category: 'revenue',
    requiresConfirm: true,
  },
  {
    key: K.REVENUE_PROFESSIONAL_BP,
    value: 5000,
    valueType: 'number',
    /*
     * 50%, confirmed by the operator on 2026-09-17, of what is left after the
     * provider's fee. The switch above is still off: agreeing a rate and
     * running the machinery in production are two decisions, and this is only
     * the first.
     */
    description:
      "The professional's share of a patient-direct consultation after provider fees, in basis points. 5000 = 50.00% (v2).",
    category: 'revenue',
    requiresConfirm: true,
  },

  // --- Queue --------------------------------------------------------------
  {
    key: K.QUEUE_RESPONSE_WINDOW_SECONDS,
    value: 90,
    valueType: 'number',
    description:
      'Seconds a doctor has to accept an assigned consultation before it is reassigned and a missed response is recorded (spec §30).',
    category: 'queue',
  },
  {
    key: K.QUEUE_MAX_OFFER_ATTEMPTS,
    value: 3,
    valueType: 'number',
    description: 'Offer attempts on one consultation before an admin alert is raised.',
    category: 'queue',
  },
  {
    key: K.QUEUE_DELAY_ALERT_SECONDS,
    value: 300,
    valueType: 'number',
    description: 'Queue wait after which an admin delay alert is raised.',
    category: 'queue',
  },
  {
    key: K.QUEUE_MAX_WAIT_SECONDS,
    value: 1200,
    valueType: 'number',
    description:
      'Queue wait after which a consultation no doctor has taken is cancelled and a refund request raised for an administrator. 0 turns the limit off (D50).',
    category: 'queue',
  },
  // Weights sum to 1.0. Language is ALSO a hard eligibility gate — a doctor who
  // does not speak the selected language is never assigned at any score (spec §29).
  {
    key: K.QUEUE_WEIGHT_LANGUAGE,
    value: 0.3,
    valueType: 'number',
    description: 'Queue weight: language proficiency.',
    category: 'queue',
    requiresConfirm: true,
  },
  {
    key: K.QUEUE_WEIGHT_AVAILABILITY,
    value: 0.2,
    valueType: 'number',
    description: 'Queue weight: availability headroom.',
    category: 'queue',
    requiresConfirm: true,
  },
  {
    key: K.QUEUE_WEIGHT_WORKLOAD,
    value: 0.2,
    valueType: 'number',
    description: 'Queue weight: workload balance across the shift.',
    category: 'queue',
    requiresConfirm: true,
  },
  {
    key: K.QUEUE_WEIGHT_RESPONSE_TIME,
    value: 0.15,
    valueType: 'number',
    description: 'Queue weight: median offer-to-accept latency.',
    category: 'queue',
    requiresConfirm: true,
  },
  {
    key: K.QUEUE_WEIGHT_RECENT_COUNT,
    value: 0.1,
    valueType: 'number',
    description: 'Queue weight: consultations completed in the trailing 24 hours.',
    category: 'queue',
    requiresConfirm: true,
  },
  {
    key: K.QUEUE_WEIGHT_QUALITY,
    value: 0.05,
    valueType: 'number',
    description: 'Queue weight: internal quality score.',
    category: 'queue',
    requiresConfirm: true,
  },

  // --- Quality score (never visible to doctors — spec §52) ----------------
  {
    key: K.QUALITY_WEIGHT_RATING,
    value: 0.3,
    valueType: 'number',
    description: 'Quality weight: mean patient rating.',
    category: 'quality',
    requiresConfirm: true,
  },
  {
    key: K.QUALITY_WEIGHT_COMPLAINTS,
    value: 0.2,
    valueType: 'number',
    description: 'Quality weight: complaint rate (negative).',
    category: 'quality',
    requiresConfirm: true,
  },
  {
    key: K.QUALITY_WEIGHT_RESPONSE_TIME,
    value: 0.15,
    valueType: 'number',
    description: 'Quality weight: median response time.',
    category: 'quality',
    requiresConfirm: true,
  },
  {
    key: K.QUALITY_WEIGHT_MISSED,
    value: 0.15,
    valueType: 'number',
    description: 'Quality weight: missed-response rate (negative).',
    category: 'quality',
    requiresConfirm: true,
  },
  {
    key: K.QUALITY_WEIGHT_COMPLETION,
    value: 0.1,
    valueType: 'number',
    description: 'Quality weight: consultation completion rate.',
    category: 'quality',
    requiresConfirm: true,
  },
  {
    key: K.QUALITY_WEIGHT_AUDIT,
    value: 0.05,
    valueType: 'number',
    description: 'Quality weight: clinical and administrative audit outcomes.',
    category: 'quality',
    requiresConfirm: true,
  },
  {
    key: K.QUALITY_WEIGHT_RX_ISSUES,
    value: 0.05,
    valueType: 'number',
    description: 'Quality weight: prescription issues (negative).',
    category: 'quality',
    requiresConfirm: true,
  },

  // --- Doctors ------------------------------------------------------------
  {
    key: K.DOCTOR_MAX_HOURS_PER_WEEK,
    value: 40,
    valueType: 'number',
    description:
      'Maximum service hours per doctor per week. Enforced inside the shift-assignment transaction, not merely displayed (spec §25).',
    category: 'workforce',
    requiresConfirm: true,
  },
  {
    key: K.DOCTOR_FULL_TIME_MONTHLY_MINOR,
    value: 800000,
    valueType: 'number',
    description:
      'Monthly pay for a doctor working a full contracted week, in minor units. ' +
      '800000 = GH₵ 8,000.00. Part-time pay is this figure scaled by contracted ' +
      'hours over a full week (decision D28). Neem computes compensation and never ' +
      'transfers it (spec §26).',
    category: 'workforce',
    requiresConfirm: true,
  },
  {
    key: K.REVENUE_COUNTER_SHARE_FROM,
    /*
     * When counter doctors stop being paid a salary and start earning a share
     * (operator's decision, 2026-09-18). The first of a month, always: the
     * salary is a monthly figure, and a cut-over in the middle of one would pay
     * the second half of it twice.
     */
    value: '2026-10-01',
    valueType: 'string',
    description:
      'The first day counter consultations earn the doctor a share instead of salary (YYYY-MM-01). Payroll shows no salary from this month.',
    category: 'revenue',
    requiresConfirm: true,
  },
  {
    key: K.DOCTOR_MEMBERSHIP_REQUIRED,
    /*
     * Reinstated at GH₵5 per renewal (operator's decision, 2026-09-24), after
     * being dropped in D53. It is a commitment to the platform rather than
     * revenue, and it applies to every professional, not only doctors.
     *
     * A live deployment keeps whatever an administrator set, so switching this
     * back on is a deliberate act there, not something a deploy does.
     */
    value: true,
    valueType: 'boolean',
    description: 'Whether a professional must hold a paid membership to receive consultations.',
    category: 'workforce',
    requiresConfirm: true,
  },
  {
    key: K.DOCTOR_MEMBERSHIP_FEE_MINOR,
    // GHS 5.00 every six months, for every professional (operator's decision,
    // 2026-09-24). Reinstated after being dropped in D53, at a fee that is a
    // commitment to the platform rather than a source of revenue.
    value: 500,
    valueType: 'number',
    description:
      'Membership fee per renewal in minor units, for every professional. 500 = GH₵ 5.00.',
    category: 'workforce',
    requiresConfirm: true,
  },
  {
    key: K.DOCTOR_MEMBERSHIP_MONTHS,
    value: 6,
    valueType: 'number',
    description: 'Doctor membership period in months.',
    category: 'workforce',
  },
  {
    key: K.DOCTOR_MEMBERSHIP_GRACE_DAYS,
    value: 7,
    valueType: 'number',
    description: 'Grace period after membership expiry before Active → Suspended (spec §27).',
    category: 'workforce',
  },
  {
    key: K.DOCTOR_MEMBERSHIP_WARNING_DAYS,
    value: 14,
    valueType: 'number',
    description:
      'Days before a membership ends at which the doctor is warned (spec §27). The warning ' +
      'is sent once per window, not once per sweep. Setting this at or below the grace ' +
      'period means the first a doctor hears of it is the suspension.',
    category: 'workforce',
  },
  {
    key: K.DOCTOR_MIN_YEARS_EXPERIENCE,
    value: 3,
    valueType: 'number',
    description: 'Minimum post-qualification clinical experience in years (spec §21).',
    category: 'workforce',
  },
  {
    key: K.DOCTOR_LICENCE_WARNING_DAYS,
    value: 60,
    valueType: 'number',
    description: 'Days before MDC licence expiry at which the system flags the doctor (spec §22).',
    category: 'workforce',
  },
  {
    key: K.DOCTOR_MAX_CONCURRENT,
    value: 1,
    valueType: 'number',
    description: 'Maximum concurrent consultations per doctor.',
    category: 'workforce',
  },

  // --- Media --------------------------------------------------------------
  {
    key: K.MEDIA_MAX_CONCURRENT_CALLS,
    value: 1,
    valueType: 'number',
    /*
     * How many Call Me bridges may be live at once.
     *
     * This is a **subscription limit, not a technical one**. The pilot buys a
     * single simultaneous call for its first month; the provider can serve ten
     * today and more later. Placing an eleventh call would not fail politely
     * at the provider — it would fail at a pharmacy counter with a patient
     * waiting — so the system counts its own live calls and refuses before
     * dialling.
     *
     * It lives here rather than in code because month two changes it by buying
     * more capacity, and nobody should need a deploy to follow a commercial
     * decision.
     */
    description:
      'How many Call Me voice bridges may run at once. Match this to the number of simultaneous calls the voice provider subscription allows.',
    category: 'media',
    requiresConfirm: true,
  },

  // --- Notifications ------------------------------------------------------
  {
    key: K.NOTIFICATIONS_SMS_ENABLED,
    value: false,
    valueType: 'boolean',
    /*
     * Whether notifications go out by SMS at all.
     *
     * **Off for the pilot MVP.** The SMS provider, its adapter, its templates
     * and its tests all remain — nothing here deletes a capability. What is
     * switched off is the channel, and the switch is a setting rather than a
     * deploy because turning SMS back on is a decision the pilot expects to
     * make mid-flight, once the sender ID is registered and delivery has been
     * seen to work on a real handset.
     *
     * While it is off, a template that would have sent an SMS sends an email
     * instead, to recipients who have an email address. Doctors and pharmacies
     * do; **patients do not, and there is no field for one** — Neem keeps no
     * patient profile (spec §8.1), so the two patient templates are recorded
     * as suppressed rather than delivered. That is acceptable now and was not
     * before: the consultation reference (D24) reaches the patient on their
     * own screen and is printed on every document they can now download, so
     * the SMS is no longer the only copy of anything.
     */
    description:
      'Whether notifications are sent by SMS. Off for the pilot: messages that would have gone by SMS go by email instead, where the recipient has an email address. Turn on once the SMS sender ID is registered and delivery is confirmed.',
    category: 'notifications',
    requiresConfirm: true,
  },

  // --- Retention ----------------------------------------------------------
  {
    key: K.RETENTION_CLINICAL_RECORD_YEARS,
    value: 3,
    valueType: 'number',
    description:
      'Years a sealed clinical record is retained before destruction (decision D23). ' +
      'Ghanaian record-keeping law does not permit deleting notes at completion; three ' +
      'years matches the civil window for a negligence claim. Raising this holds patient ' +
      'data longer; lowering it may destroy evidence a claim needs. Confirm with counsel ' +
      'before changing (G7a).',
    category: 'retention',
    requiresConfirm: true,
  },
  {
    key: K.RETENTION_BACKUP_WINDOW_DAYS,
    value: 30,
    valueType: 'number',
    description:
      'Days that database backups retain data, including rows already purged from primary tables. Stated openly rather than concealed (docs/data-retention.md §5). Subject to legal review.',
    category: 'retention',
    requiresConfirm: true,
  },
];

/**
 * Invariant checked at seed time and whenever an admin changes a revenue
 * setting: the two shares must complement to exactly 100%.
 */
export function assertRevenueSharesComplement(pharmacyBp: number, neemBp: number): void {
  if (pharmacyBp + neemBp !== 10_000) {
    throw new Error(
      `Revenue shares must sum to 10000 basis points; received ${pharmacyBp} + ${neemBp} = ${pharmacyBp + neemBp}`,
    );
  }
}

/** Queue and quality weights are normalised, so each group must sum to 1.0. */
export function assertWeightsSumToOne(weights: number[], group: string): void {
  const total = weights.reduce((sum, w) => sum + w, 0);
  // Floating-point tolerance — these are configuration values, not money.
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`${group} weights must sum to 1.0; received ${total}`);
  }
}
