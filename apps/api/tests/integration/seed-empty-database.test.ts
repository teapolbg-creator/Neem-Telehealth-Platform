import { afterAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { getBooleanSetting } from '../../src/modules/settings/settings.service.ts';
import { SETTING_KEYS } from '../../src/modules/settings/settings.defaults.ts';
import { seedDemoData } from '../../prisma/seed/demo-data.ts';
import { resetDatabase, setDoctorOnDutyRequired } from '../helpers/database.ts';

/**
 * A new install has to be able to seed (D97).
 *
 * The demo history drives the real services, so a rule added to a service later
 * can stop the seed, and nothing else in the suite runs it. Only a new database
 * shows the fault: on an old one the history is already there and is left alone.
 */

afterAll(async () => {
  await disconnectPrisma();
});

describe('seeding an empty database', () => {
  it(
    'completes, and leaves the rules and the queue as they should be',
    { timeout: 180_000 },
    async () => {
      await resetDatabase();
      // As on a new install. The suite turns it off, and it is what stopped the seed.
      await setDoctorOnDutyRequired(true);
      const prisma = getPrisma() as PrismaClient;

      const result = await seedDemoData(prisma, {
        adminEmail: 'admin@neem.demo',
        adminPassword: 'NeemDemoAdmin!2026',
      });

      expect(result.history?.created).toBeGreaterThan(0);

      // Lifted for the history, which predates the rota, and put back afterwards.
      expect(await getBooleanSetting(SETTING_KEYS.REQUIRE_DOCTOR_ON_DUTY, prisma)).toBe(true);

      // A demo doctor can write a prescription (D60).
      expect(
        await prisma.doctor.count({
          where: {
            isDemo: true,
            status: 'ACTIVE',
            OR: [{ qualification: null }, { practiceAddress: null }],
          },
        }),
      ).toBe(0);

      // Consultations long finished are not sitting on the admin queue.
      expect(
        await prisma.consultationQueueEntry.count({
          where: {
            state: { in: ['WAITING', 'OFFERING'] },
            consultation: { state: { notIn: ['WAITING_FOR_DOCTOR', 'ASSIGNED', 'REASSIGNING'] } },
          },
        }),
      ).toBe(0);
    },
  );
});
