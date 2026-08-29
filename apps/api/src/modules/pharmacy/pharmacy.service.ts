import type { PharmacyStatus, PrismaClient } from '@prisma/client';
import type { PharmacyRegistration } from '@neem/contracts';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { generatePublicId, hashPassword, encryptField } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { revokeAllSessionsForUser } from '../auth/session.service.ts';
import {
  canPharmacyTransition,
  allowedPharmacyTransitions,
  transitionRequiresReason,
} from '../../domain/account-state.ts';

/**
 * Pharmacy onboarding and lifecycle (spec §20, §84).
 *
 * Registration creates the pharmacy and its single login account in one
 * transaction — a pharmacy row without an account, or the reverse, would be an
 * orphan an admin could not act on.
 *
 * Pharmacy Council registration is verified MANUALLY by an admin. The system
 * performs no automated lookup and must not imply that it does.
 */

export async function registerPharmacy(
  input: PharmacyRegistration,
  context: { ip?: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
): Promise<{ publicId: string; status: PharmacyStatus }> {
  const passwordHash = await hashPassword(input.password);

  try {
    const pharmacy = await db.$transaction(async (tx) => {
      const created = await tx.pharmacy.create({
        data: {
          publicId: generatePublicId('phm'),
          name: input.name,
          councilRegistrationNo: input.councilRegistrationNo,
          ownerName: input.ownerName,
          responsiblePharmacistName: input.responsiblePharmacistName,
          responsiblePharmacistLicenceNo: input.responsiblePharmacistLicenceNo ?? null,
          addressLine1: input.addressLine1,
          addressLine2: input.addressLine2 ?? null,
          city: input.city,
          region: input.region,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          phone: input.phone,
          email: input.email,
          // Applications start at PENDING and reach ACTIVE only through an
          // admin decision. There is no self-service path to ACTIVE.
          status: 'PENDING',
          hours: {
            create: input.openingHours.map((entry) => ({
              dayOfWeek: entry.dayOfWeek,
              opensAt: entry.opensAt,
              closesAt: entry.closesAt,
            })),
          },
          capabilities: {
            create: [
              ...input.tests.map((code) => ({ kind: 'TEST' as const, code, label: code })),
              ...input.equipment.map((code) => ({ kind: 'EQUIPMENT' as const, code, label: code })),
              ...input.services.map((code) => ({ kind: 'SERVICE' as const, code, label: code })),
            ],
          },
        },
      });

      const user = await tx.user.create({
        data: {
          publicId: generatePublicId('usr'),
          email: input.email,
          passwordHash,
          role: 'PHARMACY',
          status: 'ACTIVE',
        },
      });

      await tx.pharmacyUser.create({ data: { pharmacyId: created.id, userId: user.id } });

      return created;
    });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.PHARMACY_REGISTERED,
        actorType: 'PHARMACY',
        actorId: pharmacy.id,
        entityType: 'pharmacy',
        entityId: pharmacy.id,
        correlationId: context.correlationId,
        metadata: { city: pharmacy.city, region: pharmacy.region },
      },
      db,
    );

    return { publicId: pharmacy.publicId, status: pharmacy.status };
  } catch (error) {
    if (isUniqueConstraintError(error, 'email')) {
      throw errors.conflict('An account already exists for that email address.');
    }
    if (isUniqueConstraintError(error, 'councilRegistrationNo')) {
      throw errors.conflict('A pharmacy is already registered with that Pharmacy Council number.');
    }
    throw error;
  }
}

export async function getPharmacyByPublicId(publicId: string, db: Db = getPrisma()) {
  const pharmacy = await db.pharmacy.findUnique({
    where: { publicId },
    include: {
      hours: { orderBy: { dayOfWeek: 'asc' } },
      capabilities: true,
      documents: { orderBy: { uploadedAt: 'desc' } },
      users: { select: { user: { select: { publicId: true, email: true, status: true } } } },
    },
  });

  if (!pharmacy) throw errors.notFound('Pharmacy not found.');
  return pharmacy;
}

/**
 * Changes a pharmacy's status through the state machine (spec §84).
 *
 * Suspension immediately ends every live session for that pharmacy's account —
 * a suspended pharmacy must not be able to keep working until its cookie
 * expires (decision D4).
 */
export async function changePharmacyStatus(
  publicId: string,
  next: PharmacyStatus,
  context: { adminId: string; reason?: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ from: PharmacyStatus; to: PharmacyStatus }> {
  const pharmacy = await db.pharmacy.findUnique({
    where: { publicId },
    include: { users: { select: { userId: true } } },
  });
  if (!pharmacy) throw errors.notFound('Pharmacy not found.');

  const from = pharmacy.status;

  if (from === next) {
    throw errors.conflict(`This pharmacy is already ${next}.`);
  }
  if (!canPharmacyTransition(from, next)) {
    throw errors.invalidStateTransition(from, next, 'pharmacy');
  }
  if (transitionRequiresReason(next) && !context.reason) {
    throw errors.businessRule(`A reason is required when moving a pharmacy to ${next}.`);
  }

  const now = clock.now();

  await db.$transaction(async (tx) => {
    await tx.pharmacy.update({
      where: { id: pharmacy.id },
      data: {
        status: next,
        statusReason: context.reason ?? null,
        approvedAt: next === 'APPROVED' ? now : pharmacy.approvedAt,
        approvedByAdminId: next === 'APPROVED' ? context.adminId : pharmacy.approvedByAdminId,
      },
    });

    if (next === 'SUSPENDED' || next === 'REJECTED') {
      for (const membership of pharmacy.users) {
        await revokeAllSessionsForUser(membership.userId, `pharmacy_${next.toLowerCase()}`, tx, clock);
      }
    }
  });

  await recordAudit(
    {
      action:
        next === 'SUSPENDED'
          ? AUDIT_ACTIONS.PHARMACY_SUSPENDED
          : next === 'APPROVED'
            ? AUDIT_ACTIONS.PHARMACY_APPROVED
            : AUDIT_ACTIONS.PHARMACY_STATUS_CHANGED,
      actorType: 'ADMIN',
      actorId: context.adminId,
      entityType: 'pharmacy',
      entityId: pharmacy.id,
      correlationId: context.correlationId,
      metadata: { from, to: next, reason: context.reason },
    },
    db,
  );

  return { from, to: next };
}

export function pharmacyTransitionOptions(from: PharmacyStatus): readonly PharmacyStatus[] {
  return allowedPharmacyTransitions(from);
}

export interface PharmacyListFilters {
  status?: PharmacyStatus;
  awaitingReview?: boolean;
  search?: string;
  limit: number;
  cursor?: string;
}

export async function listPharmacies(filters: PharmacyListFilters, db: Db = getPrisma()) {
  const rows = await db.pharmacy.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.awaitingReview ? { status: { in: ['PENDING', 'UNDER_REVIEW'] } } : {}),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search } },
              { city: { contains: filters.search } },
              { councilRegistrationNo: { contains: filters.search } },
            ],
          }
        : {}),
      ...(filters.cursor ? { publicId: { gt: filters.cursor } } : {}),
    },
    include: { documents: { select: { verifiedAt: true } } },
    orderBy: { publicId: 'asc' },
    take: filters.limit + 1,
  });

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  return {
    items: page.map((pharmacy) => ({
      publicId: pharmacy.publicId,
      name: pharmacy.name,
      councilRegistrationNo: pharmacy.councilRegistrationNo,
      city: pharmacy.city,
      region: pharmacy.region,
      status: pharmacy.status,
      statusReason: pharmacy.statusReason,
      createdAt: pharmacy.createdAt.toISOString(),
      approvedAt: pharmacy.approvedAt?.toISOString() ?? null,
      documentCount: pharmacy.documents.length,
      verifiedDocumentCount: pharmacy.documents.filter((doc) => doc.verifiedAt !== null).length,
      isDemo: pharmacy.isDemo,
    })),
    nextCursor: hasMore ? page.at(-1)?.publicId : undefined,
    hasMore,
  };
}

/** Payout details are encrypted at rest and never returned in full. */
export async function updatePayoutDetails(
  pharmacyId: string,
  input: { method: string; accountName: string; accountNumber: string; bankOrNetwork: string },
  db: Db = getPrisma(),
): Promise<void> {
  await db.pharmacyPayoutDetail.upsert({
    where: { pharmacyId },
    update: {
      method: input.method,
      accountNameEnc: encryptField(input.accountName),
      accountNumberEnc: encryptField(input.accountNumber),
      bankOrNetwork: input.bankOrNetwork,
    },
    create: {
      pharmacyId,
      method: input.method,
      accountNameEnc: encryptField(input.accountName),
      accountNumberEnc: encryptField(input.accountNumber),
      bankOrNetwork: input.bankOrNetwork,
    },
  });
}
