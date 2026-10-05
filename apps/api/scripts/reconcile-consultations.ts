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

import process from "node:process";
import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const JSON_OUT = args.includes("--json");
const REFERENCE = args[args.indexOf("--reference") + 1];

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
    unservedDeadlineAt: present.has("unservedDeadlineAt"),
    firstStartedAt: present.has("firstStartedAt"),
    rejoinableUntil: present.has("rejoinableUntil"),
    interruptedAt: present.has("interruptedAt"),
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
  "ACTIVATED",
  "WAITING_FOR_PATIENT",
  "PATIENT_JOINED",
  "WAITING_FOR_DOCTOR",
  "ASSIGNED",
  "REASSIGNING",
  "DOCTOR_ACCEPTED",
  "IN_PROGRESS",
  "INTERRUPTED",
  "COMPLETING",
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
  const [joined, notes, prescriptions, referrals, summaries] = await Promise.all([
    prisma.callAttendanceEvent.count({
      where: { consultationId, participant: "DOCTOR", event: "JOINED" },
    }),
    prisma.consultationClinicalNotes.count({ where: { consultationId } }),
    prisma.prescription.count({ where: { consultationId } }),
    prisma.referral.count({ where: { consultationId } }),
    prisma.consultationSummary.count({ where: { consultationId } }),
  ]);

  const signals = { joined, notes, prescriptions, referrals, summaries };
  const total = joined + notes + prescriptions + referrals + summaries;

  return {
    signals,
    attended: total > 0,
    // "No evidence" is not "no care". It is the absence of a record, which is
    // why these go to a person rather than to a sweep.
    verdict: total > 0 ? "ATTENDED" : "NO_EVIDENCE_OF_ATTENDANCE",
  };
}

async function classify(consultation: any) {
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

  if (paid && !queue && ["ACTIVATED", "WAITING_FOR_PATIENT"].includes(consultation.state)) {
    problems.push("PAID_BUT_NEVER_QUEUED");
  }
  if (
    queue &&
    ["WAITING", "OFFERING"].includes(queue.state) &&
    !OPEN_STATES.includes(consultation.state)
  ) {
    problems.push("STALE_QUEUE_ENTRY");
  }
  if (paid && COLUMNS.unservedDeadlineAt && !consultation.unservedDeadlineAt) {
    // Everything paid for before D61 existed. They have no deadline, so no
    // sweep can see them; this is the list that needs a decision.
    problems.push("NO_DEADLINE_RECORDED");
  }
  if (deadline && deadline < now) problems.push("PAST_DEADLINE");
  if (consultation.state === "IN_PROGRESS" && !attendance.attended) {
    problems.push("IN_PROGRESS_WITHOUT_ATTENDANCE");
  }

  return {
    reference: consultation.publicId,
    state: consultation.state,
    channel: consultation.pharmacyId ? "COUNTER" : "DIRECT",
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
        ? "NONE"
        : attendance.attended
          ? "REVIEW_BY_HAND"
          : problems.includes("PAST_DEADLINE")
            ? "EXPIRE_AND_REQUEST_REFUND"
            : problems.includes("PAID_BUT_NEVER_QUEUED")
              ? "ADMIT_TO_QUEUE"
              : "REVIEW_BY_HAND",
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
        "",
        `This database predates the consultation-lifetime fix: ${missing.join(", ")} absent.`,
        "Everything below is still accurate. The deadline columns read as empty, which is",
        "itself the finding: nothing here has a deadline, so nothing can expire on its own.",
        "",
      ].join("\n"),
    );
  }

  const where = REFERENCE ? { publicId: REFERENCE } : { state: { in: OPEN_STATES } };

  const consultations = await prisma.consultation.findMany({
    where,
    orderBy: { createdAt: "asc" },
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
        where: { status: "SUCCESS" },
        select: { amountMinor: true, currency: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      refunds: { select: { state: true, reason: true }, orderBy: { createdAt: "desc" }, take: 1 },
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

function report(rows: any[], flagged: any[]) {
  console.log(`\nScanned ${rows.length} open consultation(s). ${flagged.length} need attention.\n`);

  const buckets = new Map();
  for (const row of flagged) {
    for (const problem of row.problems) {
      buckets.set(problem, (buckets.get(problem) ?? 0) + 1);
    }
  }
  for (const [problem, count] of [...buckets].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${problem}`);
  }

  console.log("");
  for (const row of flagged) {
    console.log(
      `${row.reference}  ${row.state}  ${row.channel}${row.scheduled ? "  SCHEDULED" : ""}`,
    );
    console.log(`    problems    ${row.problems.join(", ")}`);
    console.log(`    proposal    ${row.proposal}`);
    console.log(
      `    attendance  ${row.attendance.verdict}  ${JSON.stringify(row.attendance.signals)}`,
    );
    console.log(
      `    paid        ${row.paid ? `yes (${row.amountMinor} minor)` : "no"}   refund: ${row.refundState ?? "none"}`,
    );
    console.log(`    queue       ${row.queueState ?? "none"}`);
    console.log(
      `    timeline    activated=${iso(row.activatedAt)} queued=${iso(row.queuedAt)} started=${iso(row.firstStartedAt)} interrupted=${iso(row.interruptedAt)}`,
    );
    console.log(
      `    deadlines   unserved=${iso(row.unservedDeadlineAt)} recovery=${iso(row.rejoinableUntil)}`,
    );
    console.log("");
  }

  const byHand = flagged.filter((row) => row.proposal === "REVIEW_BY_HAND");
  if (byHand.length > 0) {
    console.log(
      `${byHand.length} record(s) will NOT be touched by --apply: a professional attended, or the evidence is mixed. Decide these individually.\n`,
    );
  }
}

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : "-";
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
async function repair(flagged: any[]) {
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

  const safe = flagged.filter((row) => row.proposal === "EXPIRE_AND_REQUEST_REFUND");
  console.log(`\n--apply: repairing ${safe.length} unambiguous record(s).\n`);

  const { expireUnservedConsultations } =
    await import("../src/modules/consultation/unserved.service.ts");

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
