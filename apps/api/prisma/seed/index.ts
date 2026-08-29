import '../../src/config/load-dotenv.ts';
import { PrismaClient } from '@prisma/client';
import { getEnv } from '../../src/config/env.ts';
import { seedReferenceData } from './reference-data.ts';
import { seedDemoData } from './demo-data.ts';

/**
 * Seed entry point.
 *
 * Reference data always runs — the system cannot function without languages,
 * shifts, complaint categories and system settings.
 *
 * Demo data runs only when SEED_DEMO_DATA=true, and is refused outright in
 * production. Two independent guards enforce this: the config loader rejects
 * SEED_DEMO_DATA=true when NODE_ENV=production, and the check below refuses
 * regardless of the flag (spec §76).
 */
async function main(): Promise<void> {
  const env = getEnv();
  const prisma = new PrismaClient();

  try {
    console.log('Seeding reference data…');
    await seedReferenceData(prisma);
    console.log('  ✓ system settings, languages, shifts, complaint categories');

    if (env.NODE_ENV === 'production') {
      console.log('\nProduction environment — demo data skipped.');
      return;
    }

    if (!env.SEED_DEMO_DATA) {
      console.log('\nSEED_DEMO_DATA=false — demo data skipped.');
      return;
    }

    console.log('\nSeeding demo data (all rows flagged isDemo=true)…');
    const result = await seedDemoData(prisma, {
      adminEmail: env.DEMO_ADMIN_EMAIL,
      adminPassword: env.DEMO_ADMIN_PASSWORD,
    });

    console.log('  ✓ pharmacies, doctors, accounts\n');
    console.log('  DEMO ACCOUNTS');
    console.log('  ' + '─'.repeat(94));
    for (const account of result.accounts) {
      console.log(
        `  ${account.role.padEnd(9)} ${account.email.padEnd(30)} ${account.password.padEnd(20)} ${account.note}`,
      );
    }
    console.log('  ' + '─'.repeat(94));
    console.log('\n  These are demonstration credentials. They must never exist in production.\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('\nSeed failed:\n', error);
  process.exit(1);
});
