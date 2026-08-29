import type { DoctorStatus, PrismaClient } from '@prisma/client';
import type { DoctorRegistration } from '@neem/contracts';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { generatePublicId, hashPassword, encryptField, hashIp } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { revokeAllSessionsForUser } from '../auth/session.service.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import {
  canDoctorTransition,
  allowedDoctorTransitions,
  transitionRequiresReason,
} from '../../domain/account-state.ts';

/**
 * Doctor onboarding and lifecycle (spec §21, §22, §83).
 *
 * Three rules the specification is emphatic about, enforced here:
 *
 *  1. Doctors wait for MANUAL admin approval. Nothing self-serves to ACTIVE.
 *  2. Neem performs NO automated MDC verification. `mdcExpiresAt` drives a
 *     warning job; it is never treated as proof the licence is genuine.
 *  3. Minimum post-qualification experience is checked server-side against the
 *     configured setting, not against a constant in the form.
 */

export async function registerDoctor(
  input: DoctorRegistration,
  context: { ip?: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ publicId: string; status: DoctorStatus }> {
  const minYears = await getIntSetting(SETTING_KEYS.DOCTOR_MIN_YEARS_EXPERIENCE, db);

  if (input.yearsExperience < minYears) {
    throw errors.businessRule(
      `Neem requires a minimum of ${minYears} years of post-qualification clinical experience.`,
    );
  }

  const mdcExpiresAt = new Date(input.mdcExpiresAt);
  if (mdcExpiresAt <= clock.now()) {
    throw errors.businessRule(
      'That MDC licence expiry date is in the past. A valid licence is required to apply.',
    );
  }

  const languages = await db.language.findMany({
    where: { code: { in: input.languageCodes }, isActive: true },
  });

  if (languages.length !== input.languageCodes.length) {
    const known = new Set(languages.map((language) => language.code));
    const unknown = input.languageCodes.filter((code) => !known.has(code));
    throw errors.validation(
      unknown.map((code) => ({ field: 'languageCodes', issue: `"${code}" is not an available language` })),
    );
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const doctor = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          publicId: generatePublicId('usr'),
          email: input.email,
          passwordHash,
          role: 'DOCTOR',
          status: 'ACTIVE',
        },
      });

      return tx.doctor.create({
        data: {
          publicId: generatePublicId('doc'),
          userId: user.id,
          fullName: input.fullName,
          mdcNumber: input.mdcNumber,
          mdcIssuedAt: input.mdcIssuedAt ? new Date(input.mdcIssuedAt) : null,
          mdcExpiresAt,
          qualifiedAt: new Date(input.qualifiedAt),
          yearsExperience: input.yearsExperience,
          specialty: input.specialty ?? null,
          bio: input.bio ?? null,
          // Needed to bridge a Call Me consultation (spec §33). Encrypted, and
          // never read back to any client — only handed to the voice provider.
          phoneEnc: encryptField(input.phone),
          // Applications begin at PENDING. Only an admin decision moves them on.
          status: 'PENDING',
          languages: {
            create: input.languageCodes.map((code, index) => ({
              languageId: languages.find((language) => language.code === code)!.id,
              isPrimary: index === 0,
            })),
          },
          presence: { create: { currentLoad: 0, maxLoad: 1 } },
        },
      });
    });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.DOCTOR_REGISTERED,
        actorType: 'DOCTOR',
        actorId: doctor.id,
        entityType: 'doctor',
        entityId: doctor.id,
        ipHash: hashIp(context.ip),
        correlationId: context.correlationId,
        metadata: { languageCount: input.languageCodes.length, yearsExperience: input.yearsExperience },
      },
      db,
    );

    return { publicId: doctor.publicId, status: doctor.status };
  } catch (error) {
    if (isUniqueConstraintError(error, 'email')) {
      throw errors.conflict('An account already exists for that email address.');
    }
    if (isUniqueConstraintError(error, 'mdcNumber')) {
      throw errors.conflict('A doctor is already registered with that MDC number.');
    }
    throw error;
  }
}

export async function getDoctorByPublicId(publicId: string, db: Db = getPrisma()) {
  const doctor = await db.doctor.findUnique({
    where: { publicId },
    include: {
      user: { select: { publicId: true, email: true, status: true, lastLoginAt: true } },
      languages: { include: { language: true } },
      documents: { orderBy: { uploadedAt: 'desc' } },
      signatures: { where: { isActive: true }, select: { id: true, capturedAt: true } },
      subscriptions: { orderBy: { periodEnd: 'desc' }, take: 1 },
    },
  });

  if (!doctor) throw errors.notFound('Doctor not found.');
  return doctor;
}

/**
 * Changes a doctor's status through the state machine (spec §83).
 *
 * Two safeguards beyond the transition table:
 *  - A doctor cannot be activated without at least one verified credential
 *    document and a captured signature. Activation is the moment they become
 *    eligible to consult and to sign prescriptions.
 *  - Suspension ends their live sessions immediately.
 */
export async function changeDoctorStatus(
  publicId: string,
  next: DoctorStatus,
  context: { adminId: string; reason?: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ from: DoctorStatus; to: DoctorStatus }> {
  const doctor = await db.doctor.findUnique({
    where: { publicId },
    include: {
      documents: { select: { verifiedAt: true } },
      signatures: { where: { isActive: true }, select: { id: true } },
    },
  });
  if (!doctor) throw errors.notFound('Doctor not found.');

  const from = doctor.status;

  if (from === next) {
    throw errors.conflict(`This doctor is already ${next}.`);
  }
  if (!canDoctorTransition(from, next)) {
    throw errors.invalidStateTransition(from, next, 'doctor');
  }
  if (transitionRequiresReason(next) && !context.reason) {
    throw errors.businessRule(`A reason is required when moving a doctor to ${next}.`);
  }

  if (next === 'ACTIVE') {
    const verifiedDocuments = doctor.documents.filter((document) => document.verifiedAt !== null);

    if (verifiedDocuments.length === 0) {
      throw errors.businessRule(
        'This doctor has no verified credential documents. Verify their MDC licence and identification before activating them.',
      );
    }
    if (doctor.signatures.length === 0) {
      throw errors.businessRule(
        'This doctor has not captured a digital signature. They cannot sign prescriptions until they do.',
      );
    }
    if (doctor.mdcExpiresAt && doctor.mdcExpiresAt <= clock.now()) {
      throw errors.businessRule(
        'This doctor’s MDC licence has expired. A valid licence is required while active.',
      );
    }
  }

  const now = clock.now();

  await db.$transaction(async (tx) => {
    await tx.doctor.update({
      where: { id: doctor.id },
      data: {
        status: next,
        statusReason: context.reason ?? null,
        approvedAt: next === 'APPROVED' ? now : doctor.approvedAt,
        approvedByAdminId: next === 'APPROVED' ? context.adminId : doctor.approvedByAdminId,
      },
    });

    if (next === 'SUSPENDED' || next === 'REJECTED' || next === 'EXPIRED') {
      await revokeAllSessionsForUser(doctor.userId, `doctor_${next.toLowerCase()}`, tx, clock);

      // A doctor who is no longer active must not remain in the allocation
      // pool — presence is cleared in the same transaction as the status change.
      await tx.doctorPresence.updateMany({
        where: { doctorId: doctor.id },
        data: { onlineSince: null, lastHeartbeatAt: null, currentLoad: 0 },
      });
    }
  });

  await recordAudit(
    {
      action:
        next === 'SUSPENDED'
          ? AUDIT_ACTIONS.DOCTOR_SUSPENDED
          : next === 'REJECTED'
            ? AUDIT_ACTIONS.DOCTOR_REJECTED
            : next === 'APPROVED'
              ? AUDIT_ACTIONS.DOCTOR_APPROVED
              : AUDIT_ACTIONS.DOCTOR_STATUS_CHANGED,
      actorType: 'ADMIN',
      actorId: context.adminId,
      entityType: 'doctor',
      entityId: doctor.id,
      correlationId: context.correlationId,
      metadata: { from, to: next, reason: context.reason },
    },
    db,
  );

  return { from, to: next };
}

export function doctorTransitionOptions(from: DoctorStatus): readonly DoctorStatus[] {
  return allowedDoctorTransitions(from);
}

/**
 * Captures the doctor's drawn signature (spec §23).
 *
 * Stored encrypted and bound to the authenticated doctor. Re-capturing
 * deactivates the previous signature rather than overwriting it, so a
 * prescription signed earlier still references the signature actually used.
 */
export async function captureSignature(
  doctorId: string,
  signatureDataUrl: string,
  context: { ip?: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ capturedAt: Date }> {
  const capturedAt = clock.now();

  await db.$transaction(async (tx) => {
    await tx.doctorSignature.updateMany({
      where: { doctorId, isActive: true },
      data: { isActive: false },
    });
    await tx.doctorSignature.create({
      data: {
        doctorId,
        signatureDataEnc: encryptField(signatureDataUrl),
        capturedAt,
        capturedIpHash: hashIp(context.ip),
        isActive: true,
      },
    });
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.DOCTOR_SIGNATURE_CAPTURED,
      actorType: 'DOCTOR',
      actorId: doctorId,
      entityType: 'doctor',
      entityId: doctorId,
      ipHash: hashIp(context.ip),
      correlationId: context.correlationId,
    },
    db,
  );

  return { capturedAt };
}

export interface DoctorListFilters {
  status?: DoctorStatus;
  awaitingReview?: boolean;
  search?: string;
  limit: number;
  cursor?: string;
}

export async function listDoctors(filters: DoctorListFilters, db: Db = getPrisma()) {
  const rows = await db.doctor.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.awaitingReview ? { status: { in: ['PENDING', 'UNDER_REVIEW'] } } : {}),
      ...(filters.search
        ? {
            OR: [
              { fullName: { contains: filters.search } },
              { mdcNumber: { contains: filters.search } },
              { specialty: { contains: filters.search } },
            ],
          }
        : {}),
      ...(filters.cursor ? { publicId: { gt: filters.cursor } } : {}),
    },
    include: {
      languages: { include: { language: { select: { code: true, label: true } } } },
      documents: { select: { verifiedAt: true } },
      signatures: { where: { isActive: true }, select: { id: true } },
      subscriptions: { orderBy: { periodEnd: 'desc' }, take: 1 },
    },
    orderBy: { publicId: 'asc' },
    take: filters.limit + 1,
  });

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  return {
    items: page.map((doctor) => ({
      publicId: doctor.publicId,
      fullName: doctor.fullName,
      mdcNumber: doctor.mdcNumber,
      mdcExpiresAt: doctor.mdcExpiresAt?.toISOString() ?? null,
      specialty: doctor.specialty,
      yearsExperience: doctor.yearsExperience,
      status: doctor.status,
      statusReason: doctor.statusReason,
      languages: doctor.languages.map((entry) => ({
        code: entry.language.code,
        label: entry.language.label,
        isPrimary: entry.isPrimary,
      })),
      employmentType: doctor.employmentType,
      contractedHoursPerWeek: doctor.contractedHoursPerWeek,
      hasSignature: doctor.signatures.length > 0,
      documentCount: doctor.documents.length,
      verifiedDocumentCount: doctor.documents.filter((document) => document.verifiedAt !== null).length,
      subscriptionStatus: doctor.subscriptions[0]?.status ?? null,
      subscriptionEndsAt: doctor.subscriptions[0]?.periodEnd.toISOString() ?? null,
      createdAt: doctor.createdAt.toISOString(),
      approvedAt: doctor.approvedAt?.toISOString() ?? null,
      isDemo: doctor.isDemo,
    })),
    nextCursor: hasMore ? page.at(-1)?.publicId : undefined,
    hasMore,
  };
}

/**
 * Sets compensation parameters (spec §26).
 *
 * The system stores what an admin configures and can calculate payroll from
 * it. It does NOT derive a part-time formula — that decision has not been made
 * — and it never transfers a salary payment.
 */
export async function setDoctorCompensation(
  publicId: string,
  input: {
    employmentType?: 'FULL_TIME' | 'PART_TIME' | 'CONTRACT';
    contractedHoursPerWeek?: number;
    hourlyRateMinor?: number;
    monthlySalaryMinor?: number;
  },
  context: { adminId: string; correlationId?: string },
  db: Db = getPrisma(),
): Promise<void> {
  const doctor = await db.doctor.findUnique({ where: { publicId }, select: { id: true } });
  if (!doctor) throw errors.notFound('Doctor not found.');

  const maxHours = await getIntSetting(SETTING_KEYS.DOCTOR_MAX_HOURS_PER_WEEK, db);
  if (input.contractedHoursPerWeek !== undefined && input.contractedHoursPerWeek > maxHours) {
    throw errors.businessRule(
      `Contracted hours cannot exceed the ${maxHours}-hour weekly limit.`,
    );
  }

  await db.doctor.update({
    where: { id: doctor.id },
    data: {
      employmentType: input.employmentType,
      contractedHoursPerWeek: input.contractedHoursPerWeek,
      hourlyRateMinor: input.hourlyRateMinor,
      monthlySalaryMinor: input.monthlySalaryMinor,
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.DOCTOR_COMPENSATION_CHANGED,
      actorType: 'ADMIN',
      actorId: context.adminId,
      entityType: 'doctor',
      entityId: doctor.id,
      correlationId: context.correlationId,
      metadata: {
        employmentType: input.employmentType,
        contractedHoursPerWeek: input.contractedHoursPerWeek,
      },
    },
    db,
  );
}
