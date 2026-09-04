import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../../src/db/prisma.ts';
import { hashPassword, generatePublicId } from '../../src/lib/crypto.ts';
import { seedReferenceData } from '../../prisma/seed/reference-data.ts';

/**
 * Integration-test database helpers.
 *
 * These tests run against a real MySQL database rather than mocks, because a
 * large part of what they verify lives in the database itself: unique
 * constraints, foreign keys, transactional atomicity, and cascade behaviour.
 * A mocked Prisma client would happily accept a duplicate webhook.
 */

let cachedTableNames: string[] | undefined;

async function tableNames(prisma: PrismaClient): Promise<string[]> {
  if (cachedTableNames) return cachedTableNames;

  const rows = await prisma.$queryRaw<Array<{ TABLE_NAME: string }>>`
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_TYPE = 'BASE TABLE'
      AND TABLE_NAME <> '_prisma_migrations'
  `;

  cachedTableNames = rows.map((row) => row.TABLE_NAME);
  return cachedTableNames;
}

/**
 * Empties every table, then restores reference data.
 *
 * TRUNCATE rather than DELETE so auto-increment and row state are genuinely
 * reset; foreign key checks are suspended for the duration because the tables
 * reference each other in both directions.
 */
export async function resetDatabase(): Promise<void> {
  const prisma = getPrisma();
  const tables = await tableNames(prisma as PrismaClient);

  // Batched into a single transaction: ~58 individual round trips to MySQL
  // dominated the runtime of every test otherwise.
  await prisma.$transaction([
    prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0'),
    ...tables.map((table) => prisma.$executeRawUnsafe(`TRUNCATE TABLE \`${table}\``)),
    prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1'),
  ]);

  // Settings, languages, shifts and complaint categories are required for the
  // system to function at all, so they are part of a clean state.
  await seedReferenceData(prisma as PrismaClient);
}

export interface TestUserOptions {
  email: string;
  password: string;
  role: 'ADMIN' | 'DOCTOR' | 'PHARMACY';
  status?: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
  /** When set, the account already has TOTP enrolled with this secret. */
  twoFactorSecretEnc?: string;
  twoFactorEnabled?: boolean;
}

export async function createTestUser(options: TestUserOptions) {
  const prisma = getPrisma();

  return prisma.user.create({
    data: {
      publicId: generatePublicId('usr'),
      email: options.email,
      passwordHash: await hashPassword(options.password),
      role: options.role,
      status: options.status ?? 'ACTIVE',
      twoFactorSecretEnc: options.twoFactorSecretEnc ?? null,
      twoFactorEnabledAt: options.twoFactorEnabled ? new Date() : null,
      isDemo: true,
    },
  });
}

export async function createTestPharmacy(
  name = 'Test Pharmacy',
  status: 'ACTIVE' | 'PENDING' = 'ACTIVE',
) {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8);

  return prisma.pharmacy.create({
    data: {
      publicId: generatePublicId('phm'),
      name,
      councilRegistrationNo: `PCG-TEST-${suffix}`,
      ownerName: 'Test Owner',
      responsiblePharmacistName: 'Test Pharmacist',
      addressLine1: '1 Test Street',
      city: 'Accra',
      region: 'Greater Accra',
      phone: '+233240000000',
      email: `${suffix}@pharmacy.test`,
      status,
      isDemo: true,
    },
  });
}

export async function createTestDoctor(
  fullName = 'Dr. Test',
  status: 'ACTIVE' | 'PENDING' = 'ACTIVE',
) {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8);

  const user = await createTestUser({
    email: `${suffix}@doctor.test`,
    password: 'TestPassword123!',
    role: 'DOCTOR',
  });

  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: user.id,
      fullName,
      mdcNumber: `MDC-TEST-${suffix}`,
      status,
      isDemo: true,
    },
  });

  return { user, doctor };
}
