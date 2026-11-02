import { z } from 'zod';
import { TRIAGE_CATEGORIES, type TriageCategory, type VitalSigns } from './patient.ts';

/**
 * Flags from a clinically approved triage protocol (slice 5c, brief §A3, D93).
 *
 * This code holds no clinical numbers. The rules are entered by the super
 * administrator from a document someone qualified has approved, and until then
 * there are none. A flag is a prompt to the CHO: it never sets a category, starts
 * an emergency or stops anything.
 */

export const PROTOCOL_READINGS = {
  bpSystolic: 'BP systolic',
  bpDiastolic: 'BP diastolic',
  temperatureC: 'Temperature',
  pulseBpm: 'Pulse',
  respiratoryRate: 'Respiratory rate',
  spo2Percent: 'Oxygen saturation',
  weightKg: 'Weight',
  heightCm: 'Height',
  glucoseMmolL: 'Blood glucose',
} as const;
export type ProtocolReading = keyof typeof PROTOCOL_READINGS;

export const PROTOCOL_COMPARISONS = ['BELOW', 'ABOVE'] as const;
export type ProtocolComparison = (typeof PROTOCOL_COMPARISONS)[number];

export const triageRuleCreateSchema = z.object({
  reading: z.enum(Object.keys(PROTOCOL_READINGS) as [ProtocolReading, ...ProtocolReading[]], {
    errorMap: () => ({ message: 'Choose a reading' }),
  }),
  comparison: z.enum(PROTOCOL_COMPARISONS),
  threshold: z.number().finite().min(0).max(1000),
  suggestedCategory: z.enum(TRIAGE_CATEGORIES).nullish(),
  message: z.string().trim().min(3, 'Say what the CHO should be told').max(300),
  source: z.string().trim().min(3, 'Name the approved document this comes from').max(200),
  approvedBy: z.string().trim().min(3, 'Name who approved entering this rule').max(160),
});
export type TriageRuleCreate = z.infer<typeof triageRuleCreateSchema>;

/** What the CHO's screen needs to raise a flag as they type. */
export interface TriageRule {
  id: string;
  reading: ProtocolReading;
  comparison: ProtocolComparison;
  threshold: number;
  suggestedCategory: TriageCategory | null;
  message: string;
  source: string;
}

export interface TriageRuleAdmin extends TriageRule {
  approvedBy: string;
  createdAt: string;
  retiredAt: string | null;
}

export interface ProtocolFlag {
  ruleId: string;
  message: string;
  source: string;
  suggestedCategory: TriageCategory | null;
}

/** Which rules these readings cross. A reading not taken crosses nothing. */
export function protocolFlags(rules: TriageRule[], vitals: VitalSigns): ProtocolFlag[] {
  return rules
    .filter((rule) => {
      const value = vitals[rule.reading];
      if (value === null || value === undefined) return false;
      return rule.comparison === 'BELOW' ? value < rule.threshold : value > rule.threshold;
    })
    .map((rule) => ({
      ruleId: rule.id,
      message: rule.message,
      source: rule.source,
      suggestedCategory: rule.suggestedCategory,
    }));
}
