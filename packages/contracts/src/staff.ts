import { z } from 'zod';
import { emailSchema } from './auth.ts';
import { GEO_SCOPE_LEVELS, type GeoScopeLevel } from './enums.ts';
import type { FacilitySummary } from './facility.ts';
import { ghanaPhoneSchema } from './onboarding.ts';

/**
 * Neem's own staff accounts: operations administrators and district health
 * officers, created by the super administrator (CHPS slice 3a, D84).
 *
 * Super administrators are not created here. There are very few, each holds
 * every power including this one, and they are made with the server-side
 * script, so a stolen super-admin session cannot mint another.
 */

/** What the super administrator may create on screen. */
export const STAFF_ACCOUNT_ROLES = ['OPS_ADMIN', 'DISTRICT'] as const;
export type StaffAccountRole = (typeof STAFF_ACCOUNT_ROLES)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullish();

const nameSchema = z.string().trim().min(2, 'Enter their full name').max(160);

/**
 * The area a district officer's account covers. The level names the narrowest
 * column that must be set; the server also checks the district belongs to the
 * region and the sub-district to the district.
 */
export const geoScopeSchema = z
  .object({
    level: z.enum(GEO_SCOPE_LEVELS),
    regionId: z.string().min(1, 'Choose a region'),
    districtId: z.string().min(1).nullish(),
    subDistrictId: z.string().min(1).nullish(),
  })
  .superRefine((scope, ctx) => {
    if (scope.level !== 'REGION' && !scope.districtId) {
      ctx.addIssue({ code: 'custom', path: ['districtId'], message: 'Choose a district' });
    }
    if (scope.level === 'SUB_DISTRICT' && !scope.subDistrictId) {
      ctx.addIssue({ code: 'custom', path: ['subDistrictId'], message: 'Choose a sub-district' });
    }
  })
  .transform((scope) => ({
    level: scope.level,
    regionId: scope.regionId,
    districtId: scope.level === 'REGION' ? null : (scope.districtId ?? null),
    subDistrictId: scope.level === 'SUB_DISTRICT' ? (scope.subDistrictId ?? null) : null,
  }));
export type GeoScopeInput = z.infer<typeof geoScopeSchema>;

export const staffAccountCreateSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('OPS_ADMIN'),
    fullName: nameSchema,
    email: emailSchema,
    title: optionalText(120),
  }),
  z.object({
    role: z.literal('DISTRICT'),
    fullName: nameSchema,
    email: emailSchema,
    title: optionalText(120),
    phone: ghanaPhoneSchema.or(z.literal('').transform(() => null)).nullish(),
    scope: geoScopeSchema,
  }),
]);
export type StaffAccountCreate = z.infer<typeof staffAccountCreateSchema>;

export const staffAccountStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

export interface GeoScopeView {
  level: GeoScopeLevel;
  region: { id: string; name: string };
  district: { id: string; name: string } | null;
  subDistrict: { id: string; name: string } | null;
  /** In words, narrowest first: "Ho West, Volta". */
  label: string;
}

export interface StaffAccount {
  userPublicId: string;
  role: 'ADMIN' | StaffAccountRole;
  fullName: string;
  email: string;
  title: string | null;
  phone: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  /** False until they have used their set-up link and chosen a password. */
  hasSetPassword: boolean;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  /** A district officer's area; null for administrators. */
  scope: GeoScopeView | null;
  /** The super administrator looking at the list. Nobody suspends themselves. */
  isSelf: boolean;
}

/** As for a CHPS staff account: the link is shown once, to hand over. */
export interface StaffAccountSetup {
  account: StaffAccount;
  setupPath: string;
  setupExpiresAt: string;
  emailed: boolean;
}

/** What a district officer sees on arrival (D84). */
export interface DistrictOverview {
  officer: { fullName: string; title: string | null };
  scope: GeoScopeView;
  /** The CHPS compounds in the area, active or not. */
  facilities: FacilitySummary[];
}
