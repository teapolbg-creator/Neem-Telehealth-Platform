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

  REVENUE_PHARMACY_BP: 'revenue.pharmacySharePctBp',
  REVENUE_NEEM_BP: 'revenue.neemSharePctBp',

  QUEUE_RESPONSE_WINDOW_SECONDS: 'queue.responseWindowSeconds',
  QUEUE_MAX_OFFER_ATTEMPTS: 'queue.maxOfferAttemptsBeforeAlert',
  QUEUE_DELAY_ALERT_SECONDS: 'queue.delayAlertSeconds',
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
    value: 4000,
    valueType: 'number',
    description: 'Consultation fee in minor units (pesewas). 4000 = GH₵ 40.00.',
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

  // --- Revenue ------------------------------------------------------------
  {
    key: K.REVENUE_PHARMACY_BP,
    value: 3000,
    valueType: 'number',
    description:
      'Pharmacy share of net consultation revenue, in basis points. 3000 = 30.00%. Doctors are NOT paid from this split (spec §39).',
    category: 'revenue',
    requiresConfirm: true,
  },
  {
    key: K.REVENUE_NEEM_BP,
    value: 7000,
    valueType: 'number',
    description: 'Neem share in basis points. Must complement the pharmacy share to 10000.',
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
    key: K.DOCTOR_MEMBERSHIP_FEE_MINOR,
    value: 50000,
    valueType: 'number',
    description:
      'Six-month doctor membership fee in minor units. Seeded placeholder — set before go-live.',
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
