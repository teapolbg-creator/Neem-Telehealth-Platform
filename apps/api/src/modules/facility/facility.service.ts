import type { Prisma, PrismaClient } from '@prisma/client';
import { addHours } from 'date-fns';
import type {
  FacilityConnectivityStatus,
  FacilityCreate,
  FacilityDetail,
  FacilityStaffCreate,
  FacilityStaffMember,
  FacilityStaffSetup,
  FacilityStatus,
  FacilitySummary,
  FacilityType,
  FacilityUpdate,
  GeographyRegion,
} from '@neem/contracts';
import { getEnv } from '../../config/env.ts';
import { getNotificationProvider } from '../../adapters/notification/index.ts';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { generatePublicId, generateToken, hashPassword, hashToken } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { revokeAllSessionsForUser } from '../auth/session.service.ts';

/**
 * Health facilities, their place in Ghana's administrative geography, and
 * their staff accounts (CHPS slice 1a, D73).
 *
 * Everything here is done by a Neem administrator. A facility does not apply
 * to join the way a pharmacy does, and a CHO does not register themselves:
 * the administrator creates the account and hands over a one-time set-up link,
 * so no password ever passes through anybody but its owner.
 */

/**
 * How long a set-up link lasts. Longer than a password reset's hour, because
 * it may be handed over on paper at a district meeting and used days later on
 * the facility's own device.
 */
export const STAFF_SETUP_LINK_HOURS = 72;

interface AdminContext {
  adminUserId: string;
  correlationId?: string;
}

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

export async function getGeography(db: Db = getPrisma()): Promise<GeographyRegion[]> {
  const regions = await db.region.findMany({
    orderBy: { name: 'asc' },
    include: {
      districts: {
        orderBy: { name: 'asc' },
        include: { subDistricts: { orderBy: { name: 'asc' } } },
      },
    },
  });

  return regions.map((region) => ({
    id: region.id,
    name: region.name,
    districts: region.districts.map((district) => ({
      id: district.id,
      name: district.name,
      subDistricts: district.subDistricts.map((sub) => ({ id: sub.id, name: sub.name })),
    })),
  }));
}

export async function createDistrict(
  input: { regionId: string; name: string },
  context: AdminContext,
  db: Db = getPrisma(),
): Promise<{ id: string; name: string }> {
  const region = await db.region.findUnique({ where: { id: input.regionId } });
  if (!region) throw errors.notFound('Region not found.');

  try {
    const district = await db.district.create({
      data: { regionId: region.id, name: input.name },
    });
    await recordAudit(
      {
        action: AUDIT_ACTIONS.GEOGRAPHY_CHANGED,
        actorType: 'ADMIN',
        actorId: context.adminUserId,
        entityType: 'district',
        entityId: district.id,
        correlationId: context.correlationId,
        metadata: { region: region.name, district: district.name },
      },
      db,
    );
    return { id: district.id, name: district.name };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw errors.conflict(`${region.name} already has a district called ${input.name}.`);
    }
    throw error;
  }
}

export async function createSubDistrict(
  input: { districtId: string; name: string },
  context: AdminContext,
  db: Db = getPrisma(),
): Promise<{ id: string; name: string }> {
  const district = await db.district.findUnique({ where: { id: input.districtId } });
  if (!district) throw errors.notFound('District not found.');

  try {
    const sub = await db.subDistrict.create({
      data: { districtId: district.id, name: input.name },
    });
    await recordAudit(
      {
        action: AUDIT_ACTIONS.GEOGRAPHY_CHANGED,
        actorType: 'ADMIN',
        actorId: context.adminUserId,
        entityType: 'sub_district',
        entityId: sub.id,
        correlationId: context.correlationId,
        metadata: { district: district.name, subDistrict: sub.name },
      },
      db,
    );
    return { id: sub.id, name: sub.name };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw errors.conflict(`${district.name} already has a sub-district called ${input.name}.`);
    }
    throw error;
  }
}

/**
 * A sub-district must belong to the facility's district. Checked here rather
 * than by a composite foreign key, because the mistake it catches is an
 * administrator picking from a stale list — which deserves a sentence, not a
 * constraint violation.
 */
async function assertLocation(
  districtId: string,
  subDistrictId: string | null | undefined,
  db: Db,
): Promise<void> {
  const district = await db.district.findUnique({ where: { id: districtId } });
  if (!district) {
    throw errors.validation(
      [{ field: 'districtId', issue: 'Choose a district from the list.' }],
      'Choose a district from the list.',
    );
  }

  if (subDistrictId) {
    const sub = await db.subDistrict.findUnique({ where: { id: subDistrictId } });
    if (!sub || sub.districtId !== districtId) {
      throw errors.validation(
        [{ field: 'subDistrictId', issue: 'That sub-district is not in the chosen district.' }],
        'That sub-district is not in the chosen district.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Facilities
// ---------------------------------------------------------------------------

const facilityInclude = {
  district: { include: { region: true } },
  subDistrict: true,
  _count: { select: { staff: true } },
} satisfies Prisma.FacilityInclude;

type FacilityRow = Prisma.FacilityGetPayload<{ include: typeof facilityInclude }>;

function toSummary(row: FacilityRow): FacilitySummary {
  return {
    publicId: row.publicId,
    code: row.code,
    name: row.name,
    type: row.type,
    status: row.status,
    equipmentStatus: row.equipmentStatus,
    connectivityStatus: row.connectivityStatus,
    location: {
      region: { id: row.district.region.id, name: row.district.region.name },
      district: { id: row.district.id, name: row.district.name },
      subDistrict: row.subDistrict ? { id: row.subDistrict.id, name: row.subDistrict.name } : null,
      community: row.community,
    },
    staffCount: row._count.staff,
    isDemo: row.isDemo,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface FacilityListFilters {
  status?: FacilityStatus;
  type?: FacilityType;
  regionId?: string;
  districtId?: string;
  search?: string;
  limit: number;
  cursor?: string;
}

export async function listFacilities(filters: FacilityListFilters, db: Db = getPrisma()) {
  const rows = await db.facility.findMany({
    where: {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.districtId ? { districtId: filters.districtId } : {}),
      ...(filters.regionId ? { district: { regionId: filters.regionId } } : {}),
      ...(filters.search
        ? {
            // Case-insensitive for the reason given in listPharmacies (D43).
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' } },
              { code: { contains: filters.search, mode: 'insensitive' } },
              { community: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(filters.cursor ? { publicId: { gt: filters.cursor } } : {}),
    },
    include: facilityInclude,
    orderBy: { publicId: 'asc' },
    take: filters.limit + 1,
  });

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  return {
    items: page.map(toSummary),
    nextCursor: hasMore ? page[page.length - 1]!.publicId : null,
    hasMore,
  };
}

export async function createFacility(
  input: FacilityCreate,
  context: AdminContext,
  db: Db = getPrisma(),
): Promise<FacilitySummary> {
  await assertLocation(input.districtId, input.subDistrictId, db);

  try {
    const row = await db.facility.create({
      data: {
        publicId: generatePublicId('fac'),
        code: input.code,
        name: input.name,
        type: input.type,
        districtId: input.districtId,
        subDistrictId: input.subDistrictId ?? null,
        community: input.community,
        addressLine: input.addressLine ?? null,
        ghanaPostGps: input.ghanaPostGps ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        contactName: input.contactName ?? null,
        contactPhone: input.contactPhone ?? null,
        contactEmail: input.contactEmail ?? null,
        // Status, equipment and connectivity take their defaults — INACTIVE,
        // NOT_INSTALLED, UNKNOWN — and are changed only by an update.
        createdByUserId: context.adminUserId,
      },
      include: facilityInclude,
    });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.FACILITY_CREATED,
        actorType: 'ADMIN',
        actorId: context.adminUserId,
        entityType: 'facility',
        entityId: row.id,
        correlationId: context.correlationId,
        metadata: { code: row.code, type: row.type, district: row.district.name },
      },
      db,
    );

    return toSummary(row);
  } catch (error) {
    if (isUniqueConstraintError(error, 'code')) {
      throw errors.conflict(`A facility with the code ${input.code} is already registered.`);
    }
    throw error;
  }
}

async function findFacility(publicId: string, db: Db) {
  const row = await db.facility.findUnique({ where: { publicId }, include: facilityInclude });
  if (!row) throw errors.notFound('Facility not found.');
  return row;
}

async function staffFor(facilityId: string, db: Db): Promise<FacilityStaffMember[]> {
  const members = await db.facilityUser.findMany({
    where: { facilityId },
    orderBy: { createdAt: 'asc' },
    include: {
      user: {
        select: {
          publicId: true,
          email: true,
          status: true,
          lastLoginAt: true,
          // A staff account is created with a password nobody knows, so the
          // only way to have one is to have used a set-up or reset link.
          passwordResetTokens: { where: { usedAt: { not: null } }, select: { id: true }, take: 1 },
        },
      },
    },
  });

  return members.map(toStaffMember);
}

function toStaffMember(member: {
  fullName: string;
  title: string | null;
  phone: string | null;
  isFacilityAdmin: boolean;
  user: {
    publicId: string;
    email: string;
    status: FacilityStaffMember['status'];
    lastLoginAt: Date | null;
    passwordResetTokens: { id: string }[];
  };
}): FacilityStaffMember {
  return {
    userPublicId: member.user.publicId,
    fullName: member.fullName,
    email: member.user.email,
    title: member.title,
    phone: member.phone,
    isFacilityAdmin: member.isFacilityAdmin,
    status: member.user.status,
    hasSetPassword: member.user.passwordResetTokens.length > 0,
    lastLoginAt: member.user.lastLoginAt?.toISOString() ?? null,
  };
}

export async function getFacilityDetail(
  publicId: string,
  db: Db = getPrisma(),
): Promise<FacilityDetail> {
  const row = await findFacility(publicId, db);
  return toDetail(row, await staffFor(row.id, db));
}

/** The signed-in staff member's own facility. */
export async function getOwnFacility(
  facilityId: string,
  db: Db = getPrisma(),
): Promise<FacilityDetail> {
  const row = await db.facility.findUnique({ where: { id: facilityId }, include: facilityInclude });
  if (!row) throw errors.notFound('Facility not found.');
  return toDetail(row, await staffFor(row.id, db));
}

function toDetail(row: FacilityRow, staff: FacilityStaffMember[]): FacilityDetail {
  return {
    ...toSummary(row),
    addressLine: row.addressLine,
    ghanaPostGps: row.ghanaPostGps,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    contactEmail: row.contactEmail,
    statusReason: row.statusReason,
    connectivityReportedAt: row.connectivityReportedAt?.toISOString() ?? null,
    staff,
  };
}

export async function updateFacility(
  publicId: string,
  input: FacilityUpdate,
  context: AdminContext,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<FacilityDetail> {
  const existing = await findFacility(publicId, db);

  const districtId = input.districtId ?? existing.districtId;
  /*
   * Moving a facility to another district takes it out of its sub-district
   * unless a new one is given: the old one belongs to the old district.
   */
  const subDistrictId =
    input.subDistrictId !== undefined
      ? input.subDistrictId
      : districtId === existing.districtId
        ? existing.subDistrictId
        : null;
  await assertLocation(districtId, subDistrictId, db);

  // Staff accounts exist only at a CHPS compound (createStaffAccount), so one
  // that has staff cannot become a facility that may not.
  if (
    input.type &&
    input.type !== 'CHPS' &&
    existing.type === 'CHPS' &&
    existing._count.staff > 0
  ) {
    throw errors.businessRule(
      'This CHPS compound has staff accounts, so it cannot be changed to another type.',
    );
  }

  const deactivating = input.status === 'INACTIVE' && existing.status === 'ACTIVE';
  if (deactivating && !input.statusReason) {
    throw errors.businessRule('Say why the facility is being deactivated.');
  }

  const changes: Prisma.FacilityUncheckedUpdateInput = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
    districtId,
    subDistrictId: subDistrictId ?? null,
    ...(input.community !== undefined ? { community: input.community } : {}),
    ...(input.addressLine !== undefined ? { addressLine: input.addressLine } : {}),
    ...(input.ghanaPostGps !== undefined ? { ghanaPostGps: input.ghanaPostGps } : {}),
    ...(input.latitude !== undefined ? { latitude: input.latitude } : {}),
    ...(input.longitude !== undefined ? { longitude: input.longitude } : {}),
    ...(input.contactName !== undefined ? { contactName: input.contactName } : {}),
    ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}),
    ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail } : {}),
    ...(input.equipmentStatus !== undefined ? { equipmentStatus: input.equipmentStatus } : {}),
    ...(input.connectivityStatus !== undefined
      ? {
          connectivityStatus: input.connectivityStatus,
          connectivityReportedAt: clock.now(),
        }
      : {}),
    ...(input.status !== undefined
      ? {
          status: input.status,
          // A reason belongs to the status it explains; reactivating clears it.
          statusReason: input.status === 'INACTIVE' ? (input.statusReason ?? null) : null,
        }
      : {}),
  };

  try {
    await db.facility.update({ where: { id: existing.id }, data: changes });
  } catch (error) {
    if (isUniqueConstraintError(error, 'code')) {
      throw errors.conflict(`A facility with the code ${input.code} is already registered.`);
    }
    throw error;
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.FACILITY_UPDATED,
      actorType: 'ADMIN',
      actorId: context.adminUserId,
      entityType: 'facility',
      entityId: existing.id,
      correlationId: context.correlationId,
      metadata: {
        fields: Object.keys(input),
        ...(input.status !== undefined
          ? { statusFrom: existing.status, statusTo: input.status }
          : {}),
        ...(input.connectivityStatus !== undefined
          ? { connectivity: input.connectivityStatus satisfies FacilityConnectivityStatus }
          : {}),
      },
    },
    db,
  );

  return getFacilityDetail(publicId, db);
}

// ---------------------------------------------------------------------------
// Staff accounts
// ---------------------------------------------------------------------------

/**
 * Issues a one-time link with which a staff member chooses their password.
 *
 * It is a password-reset token, redeemed on the existing reset page, because
 * that page already does exactly this — sets a password, burns the token, ends
 * every other session — and a second implementation of a credential flow is a
 * second place for it to be wrong. Any unused earlier link dies first, so only
 * the newest one handed over works.
 */
async function issueSetupLink(
  user: { id: string; email: string },
  facilityName: string,
  db: Db,
  clock: Clock,
): Promise<{ setupPath: string; setupExpiresAt: Date; emailed: boolean }> {
  const now = clock.now();
  await db.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: now } },
    data: { expiresAt: now },
  });

  const token = generateToken();
  const setupExpiresAt = addHours(now, STAFF_SETUP_LINK_HOURS);
  await db.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashToken(token), expiresAt: setupExpiresAt },
  });

  const setupPath = `/auth/reset?token=${token}`;

  /*
   * Emailed only where email is really delivered (as the reset route
   * decides). Elsewhere the administrator hands the link over, and the
   * screen says so rather than claiming a message went out.
   */
  const emailed = getEnv().EMAIL_PROVIDER === 'smtp';
  if (emailed) {
    void getNotificationProvider('EMAIL')
      .send({
        to: user.email,
        subject: 'Set up your Neem account',
        body:
          `A Neem account has been created for you at ${facilityName}.\n\n` +
          `Choose your password here:\n${getEnv().WEB_ORIGIN}${setupPath}\n\n` +
          `The link can be used once and expires in ${STAFF_SETUP_LINK_HOURS} hours. ` +
          `If you were not expecting this, ignore it and tell your district office.`,
        reference: `staffsetup_${token.slice(0, 8)}`,
      })
      .catch(() => {
        // The administrator still holds the link; a failed email loses nothing.
      });
  }

  return { setupPath, setupExpiresAt, emailed };
}

async function findStaffMember(facilityId: string, userPublicId: string, db: Db) {
  const member = await db.facilityUser.findFirst({
    where: { facilityId, user: { publicId: userPublicId } },
    include: { user: true },
  });
  if (!member) throw errors.notFound('Staff member not found.');
  return member;
}

async function staffMemberView(userId: string, db: Db): Promise<FacilityStaffMember> {
  const member = await db.facilityUser.findUniqueOrThrow({
    where: { userId },
    include: {
      user: {
        select: {
          publicId: true,
          email: true,
          status: true,
          lastLoginAt: true,
          passwordResetTokens: { where: { usedAt: { not: null } }, select: { id: true }, take: 1 },
        },
      },
    },
  });
  return toStaffMember(member);
}

export async function createStaffAccount(
  facilityPublicId: string,
  input: FacilityStaffCreate,
  context: AdminContext,
  // The full client, not a transaction: this opens one so the user and its
  // membership are created together or not at all.
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<FacilityStaffSetup> {
  const facility = await findFacility(facilityPublicId, db);

  if (facility.type !== 'CHPS') {
    throw errors.businessRule(
      'Only a CHPS compound has Neem staff accounts. Other facilities are referral destinations.',
    );
  }

  // A password nobody knows, so the account cannot be used until its owner
  // sets one through the link.
  const passwordHash = await hashPassword(generateToken(32));

  let userId: string;
  try {
    userId = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          publicId: generatePublicId('usr'),
          email: input.email,
          passwordHash,
          role: 'FACILITY',
          status: 'ACTIVE',
        },
      });
      await tx.facilityUser.create({
        data: {
          facilityId: facility.id,
          userId: user.id,
          fullName: input.fullName,
          title: input.title ?? null,
          phone: input.phone ?? null,
          isFacilityAdmin: input.isFacilityAdmin,
        },
      });
      return user.id;
    });
  } catch (error) {
    if (isUniqueConstraintError(error, 'email')) {
      throw errors.conflict('An account already exists for that email address.');
    }
    throw error;
  }

  const setup = await issueSetupLink({ id: userId, email: input.email }, facility.name, db, clock);

  await recordAudit(
    {
      action: AUDIT_ACTIONS.FACILITY_STAFF_CREATED,
      actorType: 'ADMIN',
      actorId: context.adminUserId,
      entityType: 'user',
      entityId: userId,
      correlationId: context.correlationId,
      metadata: {
        facility: facility.code,
        isFacilityAdmin: input.isFacilityAdmin,
        setupEmailed: setup.emailed,
      },
    },
    db,
  );

  return {
    member: await staffMemberView(userId, db),
    setupPath: setup.setupPath,
    setupExpiresAt: setup.setupExpiresAt.toISOString(),
    emailed: setup.emailed,
  };
}

/**
 * Suspends or restores a staff account. Suspension ends every live session at
 * once (D4): a CHO who has left must not keep a working tab.
 */
export async function setStaffStatus(
  facilityPublicId: string,
  userPublicId: string,
  status: 'ACTIVE' | 'SUSPENDED',
  context: AdminContext,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<FacilityStaffMember> {
  const facility = await findFacility(facilityPublicId, db);
  const member = await findStaffMember(facility.id, userPublicId, db);

  if (member.user.status === 'DISABLED') {
    throw errors.businessRule('This account is disabled and cannot be changed here.');
  }
  if (member.user.status === status) {
    throw errors.conflict(`This account is already ${status.toLowerCase()}.`);
  }

  await db.user.update({ where: { id: member.userId }, data: { status } });
  if (status === 'SUSPENDED') {
    await revokeAllSessionsForUser(member.userId, 'facility_staff_suspended', db, clock);
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.FACILITY_STAFF_STATUS_CHANGED,
      actorType: 'ADMIN',
      actorId: context.adminUserId,
      entityType: 'user',
      entityId: member.userId,
      correlationId: context.correlationId,
      metadata: { facility: facility.code, from: member.user.status, to: status },
    },
    db,
  );

  return staffMemberView(member.userId, db);
}

/**
 * A fresh set-up link, for a link that was lost or expired — or for a CHO who
 * forgot their password and has no email they can read. Using it replaces the
 * password, exactly as a reset does.
 */
export async function reissueSetupLink(
  facilityPublicId: string,
  userPublicId: string,
  context: AdminContext,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<FacilityStaffSetup> {
  const facility = await findFacility(facilityPublicId, db);
  const member = await findStaffMember(facility.id, userPublicId, db);

  if (member.user.status !== 'ACTIVE') {
    throw errors.businessRule('Restore this account before issuing it a new set-up link.');
  }

  const setup = await issueSetupLink(member.user, facility.name, db, clock);

  await recordAudit(
    {
      action: AUDIT_ACTIONS.FACILITY_STAFF_SETUP_ISSUED,
      actorType: 'ADMIN',
      actorId: context.adminUserId,
      entityType: 'user',
      entityId: member.userId,
      correlationId: context.correlationId,
      metadata: { facility: facility.code, setupEmailed: setup.emailed },
    },
    db,
  );

  return {
    member: await staffMemberView(member.userId, db),
    setupPath: setup.setupPath,
    setupExpiresAt: setup.setupExpiresAt.toISOString(),
    emailed: setup.emailed,
  };
}
