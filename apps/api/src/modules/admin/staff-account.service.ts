import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  GeoScopeInput,
  GeoScopeView,
  StaffAccount,
  StaffAccountCreate,
  StaffAccountSetup,
} from '@neem/contracts';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { generatePublicId, generateToken, hashPassword } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { revokeAllSessionsForUser } from '../auth/session.service.ts';
import { issueSetupLink } from '../auth/setup-link.service.ts';

/**
 * Operations administrators and district health officers (CHPS slice 3a, D84).
 *
 * Created, suspended and restored by the super administrator. Super
 * administrators are listed but not changed here: they are made with the
 * server-side script, and one cannot suspend another from a browser.
 */

interface SuperAdminContext {
  adminUserId: string;
  correlationId?: string;
}

const STAFF_ROLES = ['ADMIN', 'OPS_ADMIN', 'DISTRICT'] as const;

const scopeInclude = {
  region: { select: { id: true, name: true } },
  district: { select: { id: true, name: true } },
  subDistrict: { select: { id: true, name: true } },
} satisfies Prisma.DistrictOfficerInclude;

const accountInclude = {
  admin: { select: { fullName: true, title: true } },
  districtOfficer: { include: scopeInclude },
  passwordResetTokens: { where: { usedAt: { not: null } }, select: { id: true }, take: 1 },
} satisfies Prisma.UserInclude;

type AccountRow = Prisma.UserGetPayload<{ include: typeof accountInclude }>;
type ScopeRow = Prisma.DistrictOfficerGetPayload<{ include: typeof scopeInclude }>;

export function toScopeView(row: ScopeRow): GeoScopeView {
  const label = [row.subDistrict?.name, row.district?.name, row.region.name]
    .filter(Boolean)
    .join(', ');
  return {
    level: row.scopeLevel,
    region: row.region,
    district: row.district,
    subDistrict: row.subDistrict,
    label,
  };
}

function toAccount(row: AccountRow, viewerUserId: string): StaffAccount {
  return {
    userPublicId: row.publicId,
    role: row.role as StaffAccount['role'],
    fullName: row.admin?.fullName ?? row.districtOfficer?.fullName ?? row.email,
    email: row.email,
    title: row.admin?.title ?? row.districtOfficer?.title ?? null,
    phone: row.districtOfficer?.phone ?? null,
    status: row.status,
    // A super administrator made by the script chose their password there.
    hasSetPassword: row.role === 'ADMIN' || row.passwordResetTokens.length > 0,
    twoFactorEnabled: row.twoFactorEnabledAt !== null,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    scope: row.districtOfficer ? toScopeView(row.districtOfficer) : null,
    isSelf: row.id === viewerUserId,
  };
}

export async function listStaffAccounts(
  viewerUserId: string,
  db: Db = getPrisma(),
): Promise<StaffAccount[]> {
  const rows = await db.user.findMany({
    where: { role: { in: [...STAFF_ROLES] } },
    include: accountInclude,
    orderBy: [{ role: 'asc' }, { email: 'asc' }],
  });
  return rows.map((row) => toAccount(row, viewerUserId));
}

/** The district must be in the region, and the sub-district in the district. */
async function assertScope(scope: GeoScopeInput, db: Db): Promise<void> {
  const region = await db.region.findUnique({ where: { id: scope.regionId } });
  if (!region)
    throw errors.validation([{ field: 'scope.regionId', issue: 'That region does not exist.' }]);
  if (scope.districtId) {
    const district = await db.district.findUnique({ where: { id: scope.districtId } });
    if (!district || district.regionId !== scope.regionId) {
      throw errors.validation([
        { field: 'scope.districtId', issue: 'That district is not in the chosen region.' },
      ]);
    }
  }
  if (scope.subDistrictId) {
    const subDistrict = await db.subDistrict.findUnique({ where: { id: scope.subDistrictId } });
    if (!subDistrict || subDistrict.districtId !== scope.districtId) {
      throw errors.validation([
        { field: 'scope.subDistrictId', issue: 'That sub-district is not in the chosen district.' },
      ]);
    }
  }
}

async function findEditable(userPublicId: string, viewerUserId: string, db: Db) {
  const user = await db.user.findFirst({
    where: { publicId: userPublicId, role: { in: [...STAFF_ROLES] } },
  });
  if (!user) throw errors.notFound('Account not found.');
  if (user.id === viewerUserId) {
    throw errors.businessRule('You cannot change your own account here.');
  }
  if (user.role === 'ADMIN') {
    throw errors.businessRule(
      'Super administrator accounts are managed on the server, not from this screen.',
    );
  }
  return user;
}

async function accountView(userId: string, viewerUserId: string, db: Db) {
  const row = await db.user.findUniqueOrThrow({ where: { id: userId }, include: accountInclude });
  return toAccount(row, viewerUserId);
}

function setupWording(role: string) {
  return role === 'OPS_ADMIN'
    ? { createdFor: 'as a Neem operations administrator', whoToTell: 'Neem' }
    : { createdFor: 'to view your district’s CHPS facilities', whoToTell: 'Neem' };
}

export async function createStaffAccount(
  input: StaffAccountCreate,
  context: SuperAdminContext,
  // The full client, not a transaction: this opens one so the user and its
  // profile are created together or not at all.
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<StaffAccountSetup> {
  if (input.role === 'DISTRICT') await assertScope(input.scope, db);

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
          role: input.role,
          status: 'ACTIVE',
        },
      });
      if (input.role === 'OPS_ADMIN') {
        await tx.admin.create({
          data: { userId: user.id, fullName: input.fullName, title: input.title ?? null },
        });
      } else {
        await tx.districtOfficer.create({
          data: {
            userId: user.id,
            fullName: input.fullName,
            title: input.title ?? null,
            phone: input.phone ?? null,
            scopeLevel: input.scope.level,
            regionId: input.scope.regionId,
            districtId: input.scope.districtId,
            subDistrictId: input.scope.subDistrictId,
            createdByUserId: context.adminUserId,
          },
        });
      }
      return user.id;
    });
  } catch (error) {
    if (isUniqueConstraintError(error, 'email')) {
      throw errors.conflict('An account already exists for that email address.');
    }
    throw error;
  }

  const setup = await issueSetupLink(
    { id: userId, email: input.email },
    setupWording(input.role),
    db,
    clock,
  );

  await recordAudit(
    {
      action: AUDIT_ACTIONS.STAFF_ACCOUNT_CREATED,
      actorType: 'ADMIN',
      actorId: context.adminUserId,
      entityType: 'user',
      entityId: userId,
      correlationId: context.correlationId,
      metadata: {
        role: input.role,
        ...(input.role === 'DISTRICT' ? { scopeLevel: input.scope.level } : {}),
        setupEmailed: setup.emailed,
      },
    },
    db,
  );

  return {
    account: await accountView(userId, context.adminUserId, db),
    setupPath: setup.setupPath,
    setupExpiresAt: setup.setupExpiresAt.toISOString(),
    emailed: setup.emailed,
  };
}

/** Suspension ends every live session at once (D4), as for CHPS staff. */
export async function setStaffAccountStatus(
  userPublicId: string,
  status: 'ACTIVE' | 'SUSPENDED',
  context: SuperAdminContext,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<StaffAccount> {
  const user = await findEditable(userPublicId, context.adminUserId, db);

  if (user.status === 'DISABLED') {
    throw errors.businessRule('This account is disabled and cannot be changed here.');
  }
  if (user.status === status) {
    throw errors.conflict(`This account is already ${status.toLowerCase()}.`);
  }

  await db.user.update({ where: { id: user.id }, data: { status } });
  if (status === 'SUSPENDED') {
    await revokeAllSessionsForUser(user.id, 'staff_account_suspended', db, clock);
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.STAFF_ACCOUNT_STATUS_CHANGED,
      actorType: 'ADMIN',
      actorId: context.adminUserId,
      entityType: 'user',
      entityId: user.id,
      correlationId: context.correlationId,
      metadata: { role: user.role, from: user.status, to: status },
    },
    db,
  );

  return accountView(user.id, context.adminUserId, db);
}

/** For a lost or expired link, or a forgotten password. Using it replaces the password. */
export async function reissueStaffSetupLink(
  userPublicId: string,
  context: SuperAdminContext,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<StaffAccountSetup> {
  const user = await findEditable(userPublicId, context.adminUserId, db);
  if (user.status !== 'ACTIVE') {
    throw errors.businessRule('Restore this account before issuing it a new set-up link.');
  }

  const setup = await issueSetupLink(user, setupWording(user.role), db, clock);

  await recordAudit(
    {
      action: AUDIT_ACTIONS.STAFF_ACCOUNT_SETUP_ISSUED,
      actorType: 'ADMIN',
      actorId: context.adminUserId,
      entityType: 'user',
      entityId: user.id,
      correlationId: context.correlationId,
      metadata: { role: user.role, setupEmailed: setup.emailed },
    },
    db,
  );

  return {
    account: await accountView(user.id, context.adminUserId, db),
    setupPath: setup.setupPath,
    setupExpiresAt: setup.setupExpiresAt.toISOString(),
    emailed: setup.emailed,
  };
}
