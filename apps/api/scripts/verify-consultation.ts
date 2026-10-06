/**
 * Check, one assertion at a time, what actually became of one consultation.
 *
 * Read-only. Written because "the preview now lists nothing" is not evidence
 * that the right things happened — an empty list is equally consistent with a
 * query that stopped matching for some unrelated reason. Each outcome is
 * therefore asserted positively and reported PASS or FAIL on its own.
 *
 *   npm run verify:consultation -- --env .env.production.local --reference NEEM-...
 *
 * Prints no patient details, no clinical content and no credentials.
 */
import process from 'node:process';
import { PrismaClient } from '@prisma/client';
import { config as loadDotenv } from 'dotenv';
import {
  acceptsCallJoin,
  isTerminal,
  patientSessionIsUsable,
  type ConsultationState,
} from '../src/domain/consultation-state.ts';

const args = process.argv.slice(2);

function flagValue(flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  return !value || value.startsWith('--') ? undefined : value;
}

const ENV_FILE = flagValue('--env');
const REFERENCE = flagValue('--reference');

if (ENV_FILE) {
  const loaded = loadDotenv({ path: ENV_FILE, override: true });
  if (loaded.error) {
    console.error(`Could not read ${ENV_FILE}: ${loaded.error.message}`);
    process.exit(1);
  }
}

if (!process.env.DATABASE_URL || !REFERENCE) {
  console.error('Usage: --env <file> --reference <NEEM-...>');
  process.exit(1);
}

const prisma = new PrismaClient();
const results: Array<{ ok: boolean; what: string; detail: string }> = [];

function check(ok: boolean, what: string, detail: string) {
  results.push({ ok, what, detail });
}

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  console.log(`\nReading   ${url.hostname}/${url.pathname.replace(/^\//, '')}`);
  console.log('Mode      READ-ONLY — no record is modified\n');

  const consultation = await prisma.consultation.findUnique({
    where: { publicId: REFERENCE },
    select: {
      id: true,
      publicId: true,
      state: true,
      startedAt: true,
      interruptedAt: true,
      rejoinableUntil: true,
      clinicalSealedAt: true,
    },
  });

  if (!consultation) {
    console.log(`No consultation ${REFERENCE} on this database.`);
    process.exitCode = 1;
    return;
  }

  const state = consultation.state as ConsultationState;

  // ---- 1. it ended, and ended as the right thing --------------------------
  check(
    state === 'ABANDONED',
    'consultation is ABANDONED',
    `state=${state}` +
      (state === 'EXPIRED'
        ? ' (EXPIRED means the system found no evidence a professional attended)'
        : ''),
  );
  check(isTerminal(state), 'state is terminal', `isTerminal(${state})=${isTerminal(state)}`);

  // ---- 2. the room is shut ------------------------------------------------
  const sessions = await prisma.mediaSession.findMany({
    where: { consultationId: consultation.id },
    select: { endedAt: true, endReason: true, provider: true },
    orderBy: { startedAt: 'asc' },
  });
  const open = sessions.filter((session) => session.endedAt === null);

  check(
    open.length === 0,
    'no media room left open',
    `${sessions.length} session(s), ${open.length} still open` +
      (sessions.length > 0
        ? `; last ended ${sessions.at(-1)!.endedAt?.toISOString() ?? 'never'} (${sessions.at(-1)!.endReason ?? 'no reason'})`
        : ''),
  );

  // ---- 3. nobody can get back in ------------------------------------------
  /*
   * The deployed guards, applied to the real state. Pure functions, so this
   * asks the same question `joinMediaSession` asks without calling it — a
   * verification script has no business exercising a write path against
   * production to find out.
   */
  check(
    !acceptsCallJoin(state),
    'rejoining the call is refused',
    `acceptsCallJoin(${state})=${acceptsCallJoin(state)}`,
  );
  check(
    !patientSessionIsUsable(state),
    'the patient session can no longer act',
    `patientSessionIsUsable(${state})=${patientSessionIsUsable(state)}`,
  );

  // ---- 4. exactly one refund, for the right amount ------------------------
  const refunds = await prisma.refund.findMany({
    where: { consultationId: consultation.id },
    select: { state: true, amountMinor: true, currency: true, reason: true },
  });

  check(refunds.length === 1, 'exactly one refund request', `${refunds.length} refund row(s)`);

  if (refunds.length === 1) {
    const refund = refunds[0]!;
    check(
      refund.amountMinor === 100 && refund.currency === 'GHS',
      'refund is for GHS 1.00',
      `${refund.amountMinor} minor ${refund.currency}`,
    );
    check(
      refund.state === 'REQUESTED',
      'refund awaits a human decision',
      `state=${refund.state} — no money has moved`,
    );
  }

  // ---- 5. the record survives ---------------------------------------------
  const events = await prisma.consultationStateEvent.count({
    where: { consultationId: consultation.id },
  });
  check(events > 0, 'state history preserved', `${events} transition(s) on record`);

  // ---- report -------------------------------------------------------------
  let failed = 0;
  for (const result of results) {
    if (!result.ok) failed += 1;
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.what.padEnd(38)} ${result.detail}`);
  }

  console.log(
    `\n${failed === 0 ? 'All checks passed.' : `${failed} check(s) FAILED.`}  ` +
      `interrupted=${consultation.interruptedAt?.toISOString() ?? '-'} ` +
      `sealed=${consultation.clinicalSealedAt?.toISOString() ?? '-'}\n`,
  );

  if (failed > 0) process.exitCode = 1;
}

await main();
await prisma.$disconnect();
