import type { PrismaClient } from '@prisma/client';
import { NOTIFICATION_TEMPLATES } from '../../src/modules/notification/templates.ts';
import {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  assertRevenueSharesComplement,
  assertWeightsSumToOne,
} from '../../src/modules/settings/settings.defaults.ts';

/**
 * Reference data — required for the system to function at all, in every
 * environment including production. Distinct from demo data, which is
 * fictional and must never reach production (spec §76).
 *
 * Idempotent: safe to run repeatedly. Existing settings are left untouched so
 * a re-seed never silently reverts an admin's configuration.
 */

/**
 * All six languages from the business document are seeded; only English, Twi
 * and Ga are active for the MVP. Admin activates the rest without a migration
 * (decision D9).
 */
const LANGUAGES = [
  { code: 'en', label: 'English', subtitle: 'Default', isActive: true, sortOrder: 1 },
  { code: 'tw', label: 'Twi', subtitle: 'Akan', isActive: true, sortOrder: 2 },
  { code: 'ga', label: 'Ga', subtitle: 'Greater Accra', isActive: true, sortOrder: 3 },
  { code: 'ee', label: 'Ewe', subtitle: 'Volta', isActive: false, sortOrder: 4 },
  { code: 'dag', label: 'Dagbani', subtitle: 'Northern', isActive: false, sortOrder: 5 },
  { code: 'ha', label: 'Hausa', subtitle: 'Northern', isActive: false, sortOrder: 6 },
];

/**
 * Night shift is seeded inactive — the business document lists 8pm–8am as a
 * future expansion, not part of the pilot (spec §25).
 */
const SHIFTS = [
  {
    code: 'MORNING',
    label: 'Morning (8:00 AM – 2:00 PM)',
    startsAt: '08:00',
    endsAt: '14:00',
    crossesMidnight: false,
    isActive: true,
  },
  {
    code: 'AFTERNOON',
    label: 'Afternoon (2:00 PM – 8:00 PM)',
    startsAt: '14:00',
    endsAt: '20:00',
    crossesMidnight: false,
    isActive: true,
  },
  {
    code: 'NIGHT',
    label: 'Night (8:00 PM – 8:00 AM)',
    startsAt: '20:00',
    endsAt: '08:00',
    crossesMidnight: true,
    isActive: false,
  },
];

const COMPLAINT_CATEGORIES = [
  { code: 'CLINICAL_CONCERN', label: 'Clinical concern', sortOrder: 1 },
  { code: 'DOCTOR_CONDUCT', label: 'Doctor conduct', sortOrder: 2 },
  { code: 'WAIT_TIME', label: 'Waiting time', sortOrder: 3 },
  { code: 'CONNECTION_QUALITY', label: 'Audio or video quality', sortOrder: 4 },
  { code: 'PAYMENT_ISSUE', label: 'Payment issue', sortOrder: 5 },
  { code: 'PRESCRIPTION_ISSUE', label: 'Prescription issue', sortOrder: 6 },
  { code: 'PHARMACY_SERVICE', label: 'Pharmacy service', sortOrder: 7 },
  { code: 'PRIVACY_CONCERN', label: 'Privacy concern', sortOrder: 8 },
  { code: 'OTHER', label: 'Other', sortOrder: 9 },
];

/**
 * Point-of-care capabilities a pharmacy may declare. Drives which tests the
 * pharmacy consultation screen offers (spec §50).
 */
export const POINT_OF_CARE_TESTS = [
  { code: 'MALARIA_RDT', label: 'Malaria RDT' },
  { code: 'RBS', label: 'Random blood sugar' },
  { code: 'URINE_DIPSTICK', label: 'Urine dipstick' },
  { code: 'PREGNANCY', label: 'Pregnancy test' },
];

export const VITAL_EQUIPMENT = [
  { code: 'BP_MONITOR', label: 'Blood pressure monitor' },
  { code: 'THERMOMETER', label: 'Thermometer' },
  { code: 'PULSE_OXIMETER', label: 'Pulse oximeter' },
  { code: 'WEIGHING_SCALE', label: 'Weighing scale' },
];

export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  // Validate the defaults before writing them, so a bad edit to the catalogue
  // fails at seed time rather than becoming a live misconfiguration.
  const pharmacyBp = Number(
    DEFAULT_SETTINGS.find((s) => s.key === SETTING_KEYS.REVENUE_PHARMACY_BP)?.value,
  );
  const neemBp = Number(
    DEFAULT_SETTINGS.find((s) => s.key === SETTING_KEYS.REVENUE_NEEM_BP)?.value,
  );
  assertRevenueSharesComplement(pharmacyBp, neemBp);

  assertWeightsSumToOne(
    DEFAULT_SETTINGS.filter((s) => s.key.startsWith('queue.weights.')).map((s) => Number(s.value)),
    'Queue',
  );
  assertWeightsSumToOne(
    DEFAULT_SETTINGS.filter((s) => s.key.startsWith('quality.weights.')).map((s) =>
      Number(s.value),
    ),
    'Quality',
  );

  for (const setting of DEFAULT_SETTINGS) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      // Never overwrite a value an admin has already tuned.
      update: { description: setting.description, category: setting.category },
      create: {
        key: setting.key,
        value: setting.value as never,
        valueType: setting.valueType,
        description: setting.description,
        category: setting.category,
        requiresConfirm: setting.requiresConfirm ?? false,
      },
    });
  }

  for (const language of LANGUAGES) {
    await prisma.language.upsert({
      where: { code: language.code },
      update: { label: language.label, subtitle: language.subtitle, sortOrder: language.sortOrder },
      create: language,
    });
  }

  for (const shift of SHIFTS) {
    await prisma.shiftDefinition.upsert({
      where: { code: shift.code },
      update: { label: shift.label },
      create: shift,
    });
  }

  /**
   * Notification templates.
   *
   * The catalogue in `modules/notification/templates.ts` is the source of
   * truth for which notifications exist and what variables each may use.
   * These rows are the *editable wording*, seeded from it so an administrator
   * has something to edit rather than an empty screen.
   *
   * Upserted on `update: {}` — an admin's edit is never overwritten by a
   * later seed run, which would silently undo their work.
   */
  for (const template of NOTIFICATION_TEMPLATES) {
    for (const channel of template.channels) {
      await prisma.notificationTemplate.upsert({
        where: {
          code_channel_locale: {
            code: template.code,
            channel,
            locale: template.locale,
          },
        },
        update: {},
        create: {
          code: template.code,
          channel,
          locale: template.locale,
          subject: template.subject ?? null,
          body: template.body,
          isActive: true,
        },
      });
    }
  }

  for (const category of COMPLAINT_CATEGORIES) {
    await prisma.complaintCategory.upsert({
      where: { code: category.code },
      update: { label: category.label, sortOrder: category.sortOrder },
      create: category,
    });
  }
}
