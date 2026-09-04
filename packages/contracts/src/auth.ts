import { z } from 'zod';
import { USER_ROLES } from './enums.ts';

/**
 * Authentication contracts. Shared by the API (validation) and the web app
 * (form resolvers), so the two cannot drift — docs/api.md §2.
 */

/**
 * Password policy. Length is the dominant factor in real-world resistance, so
 * a 12-character minimum is preferred over character-class rules that mostly
 * push users toward predictable substitutions.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

export const emailSchema = z.string().trim().toLowerCase().email().max(255);

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** A 2FA challenge is issued instead of a session when the account requires TOTP. */
export const loginResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('AUTHENTICATED'),
    user: z.object({
      publicId: z.string(),
      email: z.string(),
      role: z.enum(USER_ROLES),
      displayName: z.string(),
      mustEnrollTwoFactor: z.boolean(),
    }),
  }),
  z.object({
    status: z.literal('TWO_FACTOR_REQUIRED'),
    challengeId: z.string(),
    /** True when the admin has not yet enrolled and must do so before proceeding. */
    enrollmentRequired: z.boolean(),
  }),
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{6}$/, 'Enter the 6-digit code');

export const twoFactorVerifyRequestSchema = z.object({
  challengeId: z.string().min(1).max(128),
  code: z.string().trim().min(6).max(20),
});
export type TwoFactorVerifyRequest = z.infer<typeof twoFactorVerifyRequestSchema>;

export const twoFactorEnrollConfirmSchema = z.object({
  challengeId: z.string().min(1).max(128),
  code: totpCodeSchema,
});

export const passwordResetRequestSchema = z.object({ email: emailSchema });

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});

export const sessionUserSchema = z.object({
  publicId: z.string(),
  email: z.string(),
  role: z.enum(USER_ROLES),
  displayName: z.string(),
  twoFactorEnabled: z.boolean(),
  mustEnrollTwoFactor: z.boolean(),
  /** Resolved permission strings — the UI hides what it must, the API enforces it. */
  permissions: z.array(z.string()),
  /** Present for DOCTOR and PHARMACY principals. */
  organisation: z.object({ publicId: z.string(), name: z.string(), status: z.string() }).nullable(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;
