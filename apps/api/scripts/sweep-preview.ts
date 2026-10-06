/**
 * What the lifecycle sweeps would do, without doing any of it (D63).
 *
 * Read-only. It runs the same questions the three sweeps ask — stale in
 * progress, unserved deadline, recovery window — and prints the records each
 * would act on and what would happen to them. Nothing is written, no refund is
 * requested, and the sweep functions themselves are never called.
 *
 *   npm run sweep:preview -- --env .env.production.local
 *
 * The point is to answer "what will this deploy touch?" before it touches
 * anything, on a database whose records belong to real people.
 */
import process from 'node:process';
import { PrismaClient } from '@prisma/client';
import { config as loadDotenv } from 'dotenv';

const args = process.argv.slice(2);

function flagValue(flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  return !value || value.startsWith('--') ? undefined : value;
}

const ENV_FILE = flagValue('--env');
if (ENV_FILE) {
  const loaded = loadDotenv({ path: ENV_FILE, override: true });
  if (loaded.error) {
    console.error(`Could not read ${ENV_FILE}: ${loaded.error.message}`);
    process.exit(1);
  }
}

if (!process.env.DATABASE_URL) {
  console.error('No DATABASE_URL. Pass --env <file> or export it.');
  process.exit(1);
}

/** Host and database only: no user, no password, no query string. */
function target(): string {
  try {
    const url = new URL(process.env.DATABASE_URL!);
    return `${url.hostname}/${url.pathname.replace(/^\//, '')}`;
  } catch {
    return 'an unparseable DATABASE_URL';
  }
}

const prisma = new PrismaClient();

/** The thresholds the sweeps will actually use, read from this database. */
async function thresholds() {
  const rows = await prisma.systemSetting.findMany({
    where: {
      key: {
        in: [
          'consultation.staleInProgressMinutes',
          'consultation.recoveryWindowMinutes',
          'consultation.unservedDeadlineHours',
        ],
      },
    },
    select: { key: true, value: true },
  });

  const read = (key: string, fallback: number) => {
    const row = rows.find((candidate) => candidate.key === key);
    const parsed = Number(row?.value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    staleMinutes: read('consultation.staleInProgressMinutes', 120),
    recoveryMinutes: read('consultation.recoveryWindowMinutes', 15),
    deadlineHours: read('consultation.unservedDeadlineHours', 24),
    // Absent means this database has not been seeded with them yet, which is
    // itself worth saying: the defaults in code are what would apply.
    seeded: rows.length,
  };
}

async function main() {
  const limits = await thresholds();
  const now = new Date();

  console.log(`\nReading   ${target()}`);
  console.log('Mode      PREVIEW — nothing is written, no refund is requested\n');
  console.log(
    `Thresholds  stale=${limits.staleMinutes}m  recovery=${limits.recoveryMinutes}m  deadline=${limits.deadlineHours}h  (${limits.seeded}/3 present in this database)\n`,
  );

  // ---- 1. interrupt-stale-consultations ----------------------------------
  const cutoff = new Date(now.getTime() - limits.staleMinutes * 60_000);
  const live = await prisma.consultation.findMany({
    where: { state: 'IN_PROGRESS', startedAt: { not: null } },
    select: { id: true, publicId: true, startedAt: true },
  });

  const stale: Array<{ reference: string; quietFor: string }> = [];
  const activeLeftAlone: Array<{ reference: string; quietFor: string }> = [];

  for (const consultation of live) {
    const latest = await prisma.callAttendanceEvent.findFirst({
      // A professional's activity only: a patient alone in a room is not a
      // consultation happening, and must not hold one open.
      where: { consultationId: consultation.id, participant: 'DOCTOR' },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });
    const activity = latest?.occurredAt ?? consultation.startedAt;
    if (!activity) continue;

    const quietFor = `${Math.floor((now.getTime() - activity.getTime()) / 60_000)}m`;
    if (activity <= cutoff) stale.push({ reference: consultation.publicId, quietFor });
    else activeLeftAlone.push({ reference: consultation.publicId, quietFor });
  }

  console.log('interrupt-stale-consultations');
  console.log(`  would mark INTERRUPTED: ${stale.length}`);
  for (const row of stale) console.log(`    ${row.reference}  quiet for ${row.quietFor}`);
  console.log(`  left alone (still active): ${activeLeftAlone.length}`);
  for (const row of activeLeftAlone) console.log(`    ${row.reference}  quiet for ${row.quietFor}`);

  // ---- 2. expire-unserved-consultations ----------------------------------
  const overdue = await prisma.consultation.findMany({
    where: {
      unservedDeadlineAt: { lt: now },
      state: {
        in: [
          'ACTIVATED',
          'WAITING_FOR_PATIENT',
          'PATIENT_JOINED',
          'WAITING_FOR_DOCTOR',
          'ASSIGNED',
          'REASSIGNING',
          'DOCTOR_ACCEPTED',
          'IN_PROGRESS',
          'INTERRUPTED',
        ],
      },
    },
    select: { publicId: true, state: true },
  });

  console.log(`\nexpire-unserved-consultations`);
  console.log(`  would end: ${overdue.length}`);
  for (const row of overdue) console.log(`    ${row.publicId}  ${row.state}`);

  // ---- 3. expire-recovery-windows ----------------------------------------
  const lapsed = await prisma.consultation.findMany({
    where: { state: 'INTERRUPTED', rejoinableUntil: { lt: now } },
    select: { publicId: true },
  });

  console.log(`\nexpire-recovery-windows`);
  console.log(`  would end: ${lapsed.length}`);
  for (const row of lapsed) console.log(`    ${row.publicId}`);

  // ---- knock-on effects --------------------------------------------------
  const touched = [...stale.map((row) => row.reference), ...overdue.map((row) => row.publicId)];

  if (touched.length > 0) {
    const openRooms = await prisma.mediaSession.count({
      where: { consultation: { publicId: { in: touched } }, endedAt: null },
    });
    const existingRefunds = await prisma.refund.count({
      where: { consultation: { publicId: { in: touched } } },
    });

    console.log(`\nknock-on, once those records reach a terminal state`);
    console.log(`  media rooms that would be torn down: ${openRooms}`);
    console.log(`  refund requests that already exist:  ${existingRefunds}`);
    console.log(
      `  refund requests that would be raised: up to ${touched.length - existingRefunds} (one per record, never two)`,
    );
  }

  console.log('');
  await prisma.$disconnect();
}

await main();
