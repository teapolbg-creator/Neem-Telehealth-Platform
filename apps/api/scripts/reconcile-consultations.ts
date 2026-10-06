#!/usr/bin/env node
/**
 * What is stuck, and what it would take to unstick it (D61).
 *
 * Read-only by default and **read-only is the default for a reason**: these are
 * paid consultations belonging to real people, the evidence that care was or
 * was not delivered is circumstantial, and closing one wrongly either takes
 * money for nothing or refuses a refund that is owed. Nothing here writes
 * unless `--apply` is passed, and even then it refuses the ambiguous cases.
 *
 *   npm run reconcile:consultations --              # report
 *   npm run reconcile:consultations -- --json       # report, machine readable
 *   npm run reconcile:consultations -- --apply      # repair the safe cases
 *   npm run reconcile:consultations -- --reference NEEM-XXXX   # trace one
 *
 * It needs DATABASE_URL in the environment. It never prints a patient's name,
 * phone number, address or any clinical content — only references, states,
 * timestamps and counts.
 */

import process from 'node:process';
import { PrismaClient } from '@prisma/client';
import { config as loadDotenv } from 'dotenv';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const JSON_OUT = args.includes('--json');
/**
 * The value after a flag, or undefined when the flag is absent.
 *
 * Written out because the obvious one-liner is wrong in a way that hides
 * itself: `args[args.indexOf(flag) + 1]` returns `args[0]` when the flag is
 * missing, because `indexOf` gives -1. With no arguments at all that is
 * `undefined` and looks correct, which is exactly how it survived — the first
 * run that passed any other flag silently scoped the entire report to a
 * consultation named "--env" and reported nothing wrong.
 */
function flagValue(flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;

  const value = args[at + 1];
  // A flag with nothing after it, or followed by another flag, has no value.
  if (!value || value.startsWith('--')) return undefined;

  return value;
}

const REFERENCE = flagValue('--reference');
const ENV_FILE = flagValue('--env');

/**
 * Which database, named explicitly or not at all.
 *
 * Deliberately NOT falling back to the repository's `.env`. That file points at
 * the local development database, and a reconciliation tool that quietly picks
 * up whichever connection happens to be lying around is one mistyped command
 * away from reporting on the wrong system — or, with `--apply`, repairing it.
 *
 * So the production run names its file: `--env .env.production.local`. Nothing
 * is loaded without that flag, and `DATABASE_URL` already exported in the shell
 * still works for anyone who prefers it.
 */
if (ENV_FILE) {
  const loaded = loadDotenv({ path: ENV_FILE, override: true });
  if (loaded.error) {
    console.error(`Could not read ${ENV_FILE}: ${loaded.error.message}`);
    process.exit(1);
  }
}

if (!process.env.DATABASE_URL) {
  console.error(
    [
      'No DATABASE_URL.',
      '',
      'Either export it, or name a file:',
      '  npm run reconcile:consultations -- --env .env.production.local',
    ].join('\n'),
  );
  process.exit(1);
}

/**
 * Which database this is about to read, with nothing secret in it.
 *
 * Printed before anything else because the one mistake that matters here is
 * pointing the tool at the wrong system and believing the output. Host and
 * database name only: the user, the password and any query parameters are
 * dropped rather than masked, so there is no version of this line that could
 * leak a credential into a terminal, a screenshot or a pasted report.
 */
function describeTarget(): string {
  try {
    const url = new URL(process.env.DATABASE_URL!);
    return `${url.hostname}/${url.pathname.replace(/^\//, '')}`;
  } catch {
    return 'an unparseable DATABASE_URL';
  }
}

console.log(
  [
    '',
    `Reading   ${describeTarget()}`,
    APPLY
      ? 'Mode      APPLY — this will write to the database'
      : 'Mode      READ-ONLY — no record is modified',
    '',
  ].join('\n'),
);

const prisma = new PrismaClient();

/**
 * Which of the lifetime columns this database actually has.
 *
 * Asked rather than assumed, because this tool exists to inspect a database
 * older than the code that reads it.
 */
async function lifetimeColumns() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'consultations'
        AND column_name IN ('unservedDeadlineAt', 'firstStartedAt', 'rejoinableUntil', 'interruptedAt')`,
  );
  const present = new Set((rows as Array<{ column_name: string }>).map((row) => row.column_name));
  return {
    unservedDeadlineAt: present.has('unservedDeadlineAt'),
    firstStartedAt: present.has('firstStartedAt'),
    rejoinableUntil: present.has('rejoinableUntil'),
    interruptedAt: present.has('interruptedAt'),
  };
}

let COLUMNS = {
  unservedDeadlineAt: true,
  firstStartedAt: true,
  rejoinableUntil: true,
  interruptedAt: true,
};

/** States a consultation can sit in while somebody is still owed something. */
const OPEN_STATES = [
  'ACTIVATED',
  'WAITING_FOR_PATIENT',
  'PATIENT_JOINED',
  'WAITING_FOR_DOCTOR',
  'ASSIGNED',
  'REASSIGNING',
  'DOCTOR_ACCEPTED',
  'IN_PROGRESS',
  'INTERRUPTED',
  'COMPLETING',
];

/**
 * Did a professional ever actually attend?
 *
 * Several signals, never one. A missing `startedAt` does not mean nobody came,
 * and a present one does not mean they did — a patient's own rejoin used to set
 * it. Anything found here means care may have been delivered, which is enough
 * to keep the record away from any automatic decision.
 */
async function attendanceFor(consultationId: string) {
  const [joined, notes, prescriptions, referrals, summaries, doctorStarted] = await Promise.all([
    prisma.callAttendanceEvent.count({
      where: { consultationId, participant: 'DOCTOR', event: 'JOINED' },
    }),
    prisma.consultationClinicalNotes.count({ where: { consultationId } }),
    prisma.prescription.count({ where: { consultationId } }),
    prisma.referral.count({ where: { consultationId } }),
    prisma.consultationSummary.count({ where: { consultationId } }),
    // The state history: a DOCTOR moving a consultation into IN_PROGRESS is
    // written only by a professional joining the room, and unlike attendance
    // events it exists on every consultation ever recorded.
    prisma.consultationStateEvent.count({
      where: { consultationId, toState: 'IN_PROGRESS', actorType: 'DOCTOR', accepted: true },
    }),
  ]);

  const signals = { joined, notes, prescriptions, referrals, summaries, doctorStarted };

  /*
   * Joining is not delivering, and the report must not blur them.
   *
   * A professional entering the room is a fact about a connection. Care being
   * delivered is a fact about what the patient got, and the only durable trace
   * of it is something a professional wrote: a note, a prescription, a
   * referral, a summary. A doctor who joined, found the patient gone and
   * closed the tab leaves the first and not the second.
   *
   * The money question turns on exactly that difference, so there are three
   * answers rather than two, and the middle one is the honest place for a
   * consultation this system cannot speak for.
   */
  const delivered = notes + prescriptions + referrals + summaries;
  const connected = joined + doctorStarted;

  const verdict = delivered > 0 ? 'CARE_DELIVERED' : connected > 0 ? 'JOINED_ONLY' : 'NO_EVIDENCE';

  return {
    signals,
    // Anything a person must weigh rather than a sweep decide.
    attended: connected > 0 || delivered > 0,
    delivered: delivered > 0,
    verdict,
  };
}

/**
 * A consultation row as this script reads it.
 *
 * The lifetime fields are optional because the database may predate them: the
 * select above asks only for the columns that exist, and this type says so
 * rather than pretending every deployment has them.
 */
interface ConsultationRow {
  id: string;
  publicId: string;
  state: string;
  pharmacyId: string | null;
  createdAt: Date;
  activatedAt: Date | null;
  queuedAt: Date | null;
  assignedAt: Date | null;
  startedAt: Date | null;
  unservedDeadlineAt?: Date | null;
  firstStartedAt?: Date | null;
  rejoinableUntil?: Date | null;
  interruptedAt?: Date | null;
  appointment: { startsAt: Date; state: string } | null;
  queueEntry: { state: string; enqueuedAt: Date } | null;
  payments: Array<{ amountMinor: number; currency: string; createdAt: Date }>;
  refunds: Array<{ state: string; reason: string }>;
}

/** One line of the report: what is wrong, and what a repair would do. */
interface Finding {
  reference: string;
  state: string;
  channel: string;
  scheduled: boolean;
  problems: string[];
  proposal: string;
  attendance: {
    verdict: string;
    attended: boolean;
    delivered: boolean;
    signals: Record<string, number>;
  };
  paid: boolean;
  amountMinor: number | null;
  queueState: string | null;
  refundState: string | null;
  activatedAt: Date | null;
  queuedAt: Date | null;
  firstStartedAt: Date | null;
  interruptedAt: Date | null;
  rejoinableUntil: Date | null;
  unservedDeadlineAt: Date | null;
  appointmentStartsAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  assignedAt: Date | null;
}

async function classify(consultation: ConsultationRow): Promise<Finding> {
  const attendance = await attendanceFor(consultation.id);
  const paid = consultation.payments.length > 0;
  const refund = consultation.refunds[0] ?? null;
  const queue = consultation.queueEntry;

  const now = new Date();
  const deadlines = [
    consultation.rejoinableUntil ?? null,
    consultation.unservedDeadlineAt ?? null,
  ].filter(Boolean);
  const deadline = deadlines.length
    ? new Date(Math.min(...deadlines.map((d) => new Date(d).getTime())))
    : null;

  const problems = [];

  if (paid && !queue && ['ACTIVATED', 'WAITING_FOR_PATIENT'].includes(consultation.state)) {
    problems.push('PAID_BUT_NEVER_QUEUED');
  }
  if (
    queue &&
    ['WAITING', 'OFFERING'].includes(queue.state) &&
    !OPEN_STATES.includes(consultation.state)
  ) {
    problems.push('STALE_QUEUE_ENTRY');
  }
  if (paid && COLUMNS.unservedDeadlineAt && !consultation.unservedDeadlineAt) {
    // Everything paid for before D61 existed. They have no deadline, so no
    // sweep can see them; this is the list that needs a decision.
    problems.push('NO_DEADLINE_RECORDED');
  }
  if (deadline && deadline < now) problems.push('PAST_DEADLINE');
  if (consultation.state === 'IN_PROGRESS' && !attendance.attended) {
    problems.push('IN_PROGRESS_WITHOUT_ATTENDANCE');
  }

  return {
    reference: consultation.publicId,
    state: consultation.state,
    channel: consultation.pharmacyId ? 'COUNTER' : 'DIRECT',
    scheduled: Boolean(consultation.appointment),
    appointmentStartsAt: consultation.appointment?.startsAt ?? null,
    createdAt: consultation.createdAt,
    activatedAt: consultation.activatedAt,
    queuedAt: consultation.queuedAt,
    assignedAt: consultation.assignedAt,
    firstStartedAt: consultation.firstStartedAt ?? null,
    startedAt: consultation.startedAt,
    interruptedAt: consultation.interruptedAt ?? null,
    rejoinableUntil: consultation.rejoinableUntil ?? null,
    unservedDeadlineAt: consultation.unservedDeadlineAt ?? null,
    paid,
    amountMinor: consultation.payments[0]?.amountMinor ?? null,
    queueState: queue?.state ?? null,
    refundState: refund?.state ?? null,
    attendance,
    problems,
    /*
     * What a repair would do — and "nothing" wherever the evidence is mixed.
     * A consultation a professional attended is never closed by this script:
     * whether care was delivered is a judgement, and the whole point of the
     * report is to put it in front of somebody who can make it.
     */
    proposal:
      problems.length === 0
        ? 'NONE'
        : attendance.attended
          ? 'REVIEW_BY_HAND'
          : problems.includes('PAST_DEADLINE')
            ? 'EXPIRE_AND_REQUEST_REFUND'
            : problems.includes('PAID_BUT_NEVER_QUEUED')
              ? 'ADMIT_TO_QUEUE'
              : 'REVIEW_BY_HAND',
  };
}

async function main() {
  COLUMNS = await lifetimeColumns();

  const missing = Object.entries(COLUMNS)
    .filter(([, present]) => !present)
    .map(([name]) => name);

  if (missing.length > 0) {
    console.log(
      [
        '',
        `This database predates the consultation-lifetime fix: ${missing.join(', ')} absent.`,
        'Everything below is still accurate. The deadline columns read as empty, which is',
        'itself the finding: nothing here has a deadline, so nothing can expire on its own.',
        '',
      ].join('\n'),
    );
  }

  const where = REFERENCE ? { publicId: REFERENCE } : { state: { in: OPEN_STATES } };

  const consultations = await prisma.consultation.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: {
      id: true,
      publicId: true,
      state: true,
      pharmacyId: true,
      createdAt: true,
      activatedAt: true,
      queuedAt: true,
      assignedAt: true,
      startedAt: true,
      /*
       * Only the columns this database actually has.
       *
       * The point of this tool is to inspect a database that is OLDER than the
       * code: production has the problem and the fix that adds these columns
       * has not been deployed there. Naming an absent column fails the whole
       * query, which would make the report useless at exactly the moment it is
       * needed. Absent columns read as null below, which is the right answer —
       * nothing there has a deadline, and that absence is itself the finding.
       */
      ...(COLUMNS.unservedDeadlineAt ? { unservedDeadlineAt: true } : {}),
      ...(COLUMNS.firstStartedAt ? { firstStartedAt: true } : {}),
      ...(COLUMNS.rejoinableUntil ? { rejoinableUntil: true } : {}),
      ...(COLUMNS.interruptedAt ? { interruptedAt: true } : {}),
      appointment: { select: { startsAt: true, state: true } },
      queueEntry: { select: { state: true, enqueuedAt: true } },
      payments: {
        where: { status: 'SUCCESS' },
        select: { amountMinor: true, currency: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      refunds: { select: { state: true, reason: true }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  const rows = [];
  for (const consultation of consultations) rows.push(await classify(consultation));

  const flagged = rows.filter((row) => row.problems.length > 0);

  if (JSON_OUT) {
    console.log(JSON.stringify({ scanned: rows.length, flagged }, null, 2));
  } else {
    report(rows, flagged);
  }

  if (APPLY) await repair(flagged);
}

function report(rows: Finding[], flagged: Finding[]) {
  console.log(`\nScanned ${rows.length} open consultation(s). ${flagged.length} need attention.\n`);

  const problemCounts = new Map<string, number>();
  for (const row of flagged) {
    for (const problem of row.problems) {
      problemCounts.set(problem, (problemCounts.get(problem) ?? 0) + 1);
    }
  }
  for (const [problem, count] of [...problemCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${problem}`);
  }

  /*
   * The three buckets, because they are three different decisions: one is a
   * refund somebody confirms, one is a judgement, and one is a consultation
   * that may have been worth what was paid for it.
   */
  const buckets = {
    CARE_DELIVERED: flagged.filter((row) => row.attendance.verdict === 'CARE_DELIVERED'),
    JOINED_ONLY: flagged.filter((row) => row.attendance.verdict === 'JOINED_ONLY'),
    NO_EVIDENCE: flagged.filter((row) => row.attendance.verdict === 'NO_EVIDENCE'),
  };

  console.log('');
  console.log('By what the record can show:');
  console.log(
    `  ${String(buckets.CARE_DELIVERED.length).padStart(4)}  CARE_DELIVERED   a professional wrote something: notes, a prescription, a referral or a summary`,
  );
  console.log(
    `  ${String(buckets.JOINED_ONLY.length).padStart(4)}  JOINED_ONLY      a professional was in the room; nothing records what the patient got`,
  );
  console.log(
    `  ${String(buckets.NO_EVIDENCE.length).padStart(4)}  NO_EVIDENCE      no sign a professional ever arrived`,
  );
  console.log('');

  for (const row of flagged) {
    console.log(
      `${row.reference}  ${row.state}  ${row.channel}${row.scheduled ? '  SCHEDULED' : ''}`,
    );
    console.log(`    problems    ${row.problems.join(', ')}`);
    console.log(`    proposal    ${row.proposal}`);
    console.log(
      `    attendance  ${row.attendance.verdict}  ${JSON.stringify(row.attendance.signals)}`,
    );
    console.log(
      `    paid        ${row.paid ? `yes (${row.amountMinor} minor)` : 'no'}   refund: ${row.refundState ?? 'none'}`,
    );
    console.log(`    queue       ${row.queueState ?? 'none'}`);
    console.log(
      `    timeline    activated=${iso(row.activatedAt)} queued=${iso(row.queuedAt)} started=${iso(row.firstStartedAt)} interrupted=${iso(row.interruptedAt)}`,
    );
    console.log(
      `    deadlines   unserved=${iso(row.unservedDeadlineAt)} recovery=${iso(row.rejoinableUntil)}`,
    );
    console.log('');
  }

  const byHand = flagged.filter((row) => row.proposal === 'REVIEW_BY_HAND');
  if (byHand.length > 0) {
    console.log(
      `${byHand.length} record(s) will NOT be touched by --apply: a professional attended, or the evidence is mixed. Decide these individually.\n`,
    );
  }
}

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : '-';
}

/**
 * The repair, which does as little as it can get away with.
 *
 * Only the unambiguous cases: a paid consultation nobody ever attended, past
 * its deadline, gets expired with a refund requested for an administrator. It
 * does not move money, it does not close anything a professional attended, and
 * it is safe to run twice because every step re-reads the record and the state
 * machine refuses a second terminal transition.
 */
async function repair(flagged: Finding[]) {
  if (!COLUMNS.unservedDeadlineAt) {
    console.log(
      [
        '',
        '--apply refused: this database has no unservedDeadlineAt column, so there is no',
        'supported way to expire anything here. Deploy the lifetime migration first, then',
        'run the report again before applying anything.',
        '',
      ].join('\n'),
    );
    return;
  }

  const safe = flagged.filter((row) => row.proposal === 'EXPIRE_AND_REQUEST_REFUND');
  console.log(`\n--apply: repairing ${safe.length} unambiguous record(s).\n`);

  const { expireUnservedConsultations } =
    await import('../src/modules/consultation/unserved.service.ts');

  // Give anything past its deadline a deadline the sweep can see, then let the
  // ordinary sweep do the work — the same code path production runs, rather
  // than a second implementation that could disagree with it.
  for (const row of safe) {
    const consultation = await prisma.consultation.findUnique({
      where: { publicId: row.reference },
      select: { id: true, unservedDeadlineAt: true },
    });
    if (!consultation) continue;
    if (consultation.unservedDeadlineAt) continue;

    await prisma.consultation.update({
      where: { id: consultation.id },
      data: { unservedDeadlineAt: new Date(Date.now() - 1000) },
    });
    console.log(`  ${row.reference}: deadline recorded`);
  }

  // The script's own connection, so the sweep does not build one from an app
  // config this tool has no business needing.
  const result = await expireUnservedConsultations(prisma);
  console.log(`\n  expired: ${result.expired}   needing review: ${result.needingReview}\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
