import { SETTING_KEYS } from '../../src/modules/settings/settings.defaults.ts';
import { invalidateSettingsCache } from '../../src/modules/settings/settings.service.ts';
import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../../src/db/prisma.ts';
import { hashPassword, generatePublicId } from '../../src/lib/crypto.ts';
import { seedReferenceData } from '../../prisma/seed/reference-data.ts';

/**
 * Integration-test database helpers.
 *
 * These tests run against a real PostgreSQL database rather than mocks,
 * because a large part of what they verify lives in the database itself:
 * unique constraints, foreign keys, transactional atomicity, and cascade
 * behaviour. A mocked Prisma client would happily accept a duplicate webhook.
 */

let cachedTableNames: string[] | undefined;

async function tableNames(prisma: PrismaClient): Promise<string[]> {
  if (cachedTableNames) return cachedTableNames;

  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_type = 'BASE TABLE'
      AND table_name <> '_prisma_migrations'
  `;

  cachedTableNames = rows.map((row) => row.table_name);
  return cachedTableNames;
}

/**
 * Empties every table, then restores reference data.
 *
 * One `TRUNCATE` naming every table at once, with `CASCADE`.
 *
 * Postgres has no equivalent of MySQL's `SET FOREIGN_KEY_CHECKS = 0`, which is
 * how this used to get around tables referencing each other in both
 * directions — and it does not need one: truncating them together in a single
 * statement means no intermediate state ever violates a constraint. `CASCADE`
 * covers anything reachable that the list somehow missed.
 *
 * `RESTART IDENTITY` resets sequences, which is what the MySQL version was
 * after when it chose TRUNCATE over DELETE.
 *
 * Still one round trip, for the same reason as before: ~60 individual
 * statements dominated the runtime of every test.
 */
export async function resetDatabase(): Promise<void> {
  const prisma = getPrisma();
  const tables = await tableNames(prisma as PrismaClient);

  if (tables.length === 0) {
    throw new Error(
      'No tables found to reset. The test database is probably unmigrated — run npm run db:migrate:test.',
    );
  }

  // Quoted, because every table name in this schema is lower_snake_case but
  // the identifiers come from the database rather than from source.
  const list = tables.map((table) => `"${table}"`).join(', ');

  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);

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
      /*
       * Lower-cased, because that is what the application stores.
       *
       * `emailSchema` in the contracts package lower-cases on the way in, so
       * every address that reaches this table through a real request is
       * already lower-case, and sign-in looks one up by the same rule. These
       * factories write straight to Prisma and skipped that step, producing
       * rows no API call could have created.
       *
       * MySQL hid it: its default collation matched regardless of case, so a
       * mixed-case row and a lower-cased lookup found each other. PostgreSQL
       * does not, and 181 tests failed on "That email or password is not
       * correct" — for accounts that had just been created. The fixture was
       * wrong the whole time; only the database was covering for it.
       */
      email: options.email.toLowerCase(),
      passwordHash: await hashPassword(options.password),
      role: options.role,
      status: options.status ?? 'ACTIVE',
      twoFactorSecretEnc: options.twoFactorSecretEnc ?? null,
      twoFactorEnabledAt: options.twoFactorEnabled ? new Date() : null,
      isDemo: true,
    },
  });
}

/*
 * Test identifiers are lower-cased at the point they are generated.
 *
 * `generatePublicId` is deliberately mixed-case — it makes a short opaque id
 * out of a wide alphabet — and these suffixes end up inside email addresses.
 * The application lower-cases every address it accepts (`emailSchema`), so a
 * mixed-case row is one no real request could have produced, and sign-in then
 * looks for the lower-cased form and does not find it.
 *
 * MySQL's default collation matched the two anyway, which is why this was
 * invisible for the life of the project. PostgreSQL compares case-sensitively
 * (decision D43) and 181 tests failed with "That email or password is not
 * correct" for accounts created moments earlier. The fixtures were wrong all
 * along; the database was covering for them.
 */
export async function createTestPharmacy(
  name = 'Test Pharmacy',
  status: 'ACTIVE' | 'PENDING' = 'ACTIVE',
) {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8).toLowerCase();

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
      email: `${suffix.toLowerCase()}@pharmacy.test`,
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
  const suffix = generatePublicId('x').slice(-8).toLowerCase();

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

/**
 * Turns the SMS channel on or off for one test.
 *
 * SMS is off by default for the pilot (decision D46), which means a test that
 * exercises SMS has to ask for it. That is not a workaround — it is the
 * dependency becoming visible. Before this setting existed those tests passed
 * because a default happened to suit them, and a test whose subject is "an SMS
 * is sent" should say so rather than inherit it.
 *
 * Called from `beforeEach` in the files that cover the SMS capability we are
 * deliberately keeping rather than deleting, so it stays proven while switched
 * off in production.
 */
export async function setSmsEnabled(enabled: boolean): Promise<void> {
  const prisma = getPrisma();

  await prisma.systemSetting.upsert({
    where: { key: SETTING_KEYS.NOTIFICATIONS_SMS_ENABLED },
    create: {
      key: SETTING_KEYS.NOTIFICATIONS_SMS_ENABLED,
      value: enabled,
      valueType: 'boolean',
      description: 'Whether notifications are sent by SMS.',
      category: 'notifications',
    },
    update: { value: enabled },
  });

  // The settings cache holds values for 30s, which is longer than a test.
  invalidateSettingsCache(SETTING_KEYS.NOTIFICATIONS_SMS_ENABLED);
}
