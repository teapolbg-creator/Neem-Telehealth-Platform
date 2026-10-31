import { z } from 'zod';
import { emailSchema } from './auth.ts';
import { ghanaPhoneSchema } from './onboarding.ts';

/**
 * Health facilities and the administrative geography they sit in (CHPS, slice 1a).
 *
 * See docs/v2-chps-plan.md. A facility is registered by a Neem administrator;
 * unlike a pharmacy there is no self-service application, because a CHPS
 * compound joins Neem through an agreement with the district, not by signing
 * up on a website.
 */

/**
 * What kind of facility it is.
 *
 * Only a CHPS compound has Neem accounts. The other kinds exist so a referral
 * (Phase 2) can name a real destination from the same registry instead of a
 * free-text hospital name.
 */
export const FACILITY_TYPES = [
  'CHPS',
  'HEALTH_CENTRE',
  'DISTRICT_HOSPITAL',
  'REGIONAL_HOSPITAL',
  'TEACHING_HOSPITAL',
  'OTHER',
] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];

export const FACILITY_TYPE_LABELS: Record<FacilityType, string> = {
  CHPS: 'CHPS compound',
  HEALTH_CENTRE: 'Health centre',
  DISTRICT_HOSPITAL: 'District hospital',
  REGIONAL_HOSPITAL: 'Regional hospital',
  TEACHING_HOSPITAL: 'Teaching hospital',
  OTHER: 'Other facility',
};

/**
 * Whether the facility takes part in Neem today.
 *
 * Two values, not a pharmacy-style verification machine: there is nothing
 * for the facility to submit, so there is no review to be in. A facility
 * starts INACTIVE and an administrator switches it on once its station is in
 * place.
 */
export const FACILITY_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type FacilityStatus = (typeof FACILITY_STATUSES)[number];

/** The consultation station's state, as last reported by a person (not a device). */
export const FACILITY_EQUIPMENT_STATUSES = ['NOT_INSTALLED', 'OPERATIONAL', 'FAULTY'] as const;
export type FacilityEquipmentStatus = (typeof FACILITY_EQUIPMENT_STATUSES)[number];

/**
 * The facility's internet connection, as last reported by a person.
 *
 * UNKNOWN until somebody says otherwise. Nothing measures this yet — station
 * heartbeats arrive with slice 1d — so the screens must call it "reported",
 * not "live".
 */
export const FACILITY_CONNECTIVITY_STATUSES = [
  'UNKNOWN',
  'GOOD',
  'INTERMITTENT',
  'POOR',
  'NONE',
] as const;
export type FacilityConnectivityStatus = (typeof FACILITY_CONNECTIVITY_STATUSES)[number];

const nameSchema = z.string().trim().min(2, 'Enter at least two characters').max(160);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullish();

/**
 * Facility codes are whatever the operator's source uses — a GHS facility
 * code where one exists. Upper-cased so that "chps-001" and "CHPS-001" are the
 * same facility.
 */
const facilityCodeSchema = z
  .string()
  .trim()
  .min(2, 'Enter the facility code')
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/, 'Use letters, numbers, and - _ . / only')
  .transform((value) => value.toUpperCase());

export const districtCreateSchema = z.object({
  regionId: z.string().uuid(),
  name: nameSchema,
});

export const subDistrictCreateSchema = z.object({
  districtId: z.string().uuid(),
  name: nameSchema,
});

const facilityFields = z.object({
  name: z.string().trim().min(2, 'Enter the facility name').max(200),
  code: facilityCodeSchema,
  type: z.enum(FACILITY_TYPES),
  districtId: z.string().uuid('Choose a district'),
  subDistrictId: z.string().uuid().nullish(),
  community: z.string().trim().min(2, 'Enter the community or town').max(160),
  addressLine: optionalText(200),
  /** A GhanaPostGPS digital address, which is how many places are actually found. */
  ghanaPostGps: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}-?\d{3,4}-?\d{3,4}$/, 'Use the GhanaPostGPS form, for example AK-039-5028')
    .or(z.literal(''))
    .transform((value) => (value === '' ? null : value))
    .nullish(),
  latitude: z.number().min(4).max(12).nullish(),
  longitude: z.number().min(-4).max(2).nullish(),
  contactName: optionalText(160),
  contactPhone: ghanaPhoneSchema.or(z.literal('').transform(() => null)).nullish(),
  contactEmail: emailSchema.or(z.literal('').transform(() => null)).nullish(),
});

export const facilityCreateSchema = facilityFields;
export type FacilityCreate = z.infer<typeof facilityCreateSchema>;

/**
 * Everything is optional on an update, and status, equipment and
 * connectivity can be changed only here — never on create, so that a new
 * facility always starts inactive and unknown rather than as whatever the
 * form happened to default to.
 */
export const facilityUpdateSchema = facilityFields.partial().extend({
  status: z.enum(FACILITY_STATUSES).optional(),
  statusReason: optionalText(500),
  equipmentStatus: z.enum(FACILITY_EQUIPMENT_STATUSES).optional(),
  connectivityStatus: z.enum(FACILITY_CONNECTIVITY_STATUSES).optional(),
});
export type FacilityUpdate = z.infer<typeof facilityUpdateSchema>;

/** A CHO or other authorised member of a facility's staff. */
export const facilityStaffCreateSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter their full name').max(160),
  email: emailSchema,
  title: optionalText(120),
  phone: ghanaPhoneSchema.or(z.literal('').transform(() => null)).nullish(),
  /** May manage the facility's own details and staff once that exists (Phase 3). */
  isFacilityAdmin: z.boolean().default(false),
});
export type FacilityStaffCreate = z.infer<typeof facilityStaffCreateSchema>;

export const facilityStaffStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

export interface GeographySubDistrict {
  id: string;
  name: string;
}

export interface GeographyDistrict {
  id: string;
  name: string;
  subDistricts: GeographySubDistrict[];
}

export interface GeographyRegion {
  id: string;
  name: string;
  districts: GeographyDistrict[];
}

export interface FacilityLocation {
  region: { id: string; name: string };
  district: { id: string; name: string };
  subDistrict: { id: string; name: string } | null;
  community: string;
}

export interface FacilitySummary {
  publicId: string;
  code: string;
  name: string;
  type: FacilityType;
  status: FacilityStatus;
  equipmentStatus: FacilityEquipmentStatus;
  connectivityStatus: FacilityConnectivityStatus;
  location: FacilityLocation;
  staffCount: number;
  isDemo: boolean;
  createdAt: string;
}

export interface FacilityStaffMember {
  userPublicId: string;
  fullName: string;
  email: string;
  title: string | null;
  phone: string | null;
  isFacilityAdmin: boolean;
  status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  /** False until they have used their set-up link and chosen a password. */
  hasSetPassword: boolean;
  lastLoginAt: string | null;
}

export interface FacilityDetail extends FacilitySummary {
  addressLine: string | null;
  ghanaPostGps: string | null;
  latitude: number | null;
  longitude: number | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  statusReason: string | null;
  connectivityReportedAt: string | null;
  staff: FacilityStaffMember[];
}

/**
 * What creating a staff account returns.
 *
 * `setupPath` is a one-time credential, shown to the administrator once so it
 * can be handed over in person: a CHO in a rural compound may not read email
 * on the day their account is made. `emailed` says whether it was also sent.
 */
export interface FacilityStaffSetup {
  member: FacilityStaffMember;
  setupPath: string;
  setupExpiresAt: string;
  emailed: boolean;
}
