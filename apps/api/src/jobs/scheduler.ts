import { getLogger } from '../lib/logger.ts';
import { getEnv } from '../config/env.ts';
import { expirePendingPayments } from '../modules/payment/payment.service.ts';
import { expireStaleTokens } from '../modules/consultation/access-token.service.ts';
import { purgeExpiredSessions } from '../modules/auth/session.service.ts';
import {
  enforceResponseWindow,
  processWaitingQueue,
} from '../modules/queue/allocation.service.ts';
import { reapStalePresence } from '../modules/queue/presence.service.ts';
import { recomputeQualityScores } from '../modules/quality/quality.service.ts';
import { runSubscriptionExpirySweep } from '../modules/subscription/subscription.service.ts';
import { reconcilePayments } from '../modules/payment/reconciliation.service.ts';
import { emitTimerWarnings } from '../modules/media/media.service.ts';
import { purgeExpiredClinicalRecords } from '../modules/retention/clinical-record.service.ts';

/**
 * Scheduled work (docs/architecture.md §6).
 *
 * A plain interval scheduler in the API process. That is right for a
 * five-pharmacy pilot; the interface is small enough that moving these to a
 * dedicated worker later changes only where they are started.
 *
 * Each job is wrapped so that a failure is logged and the schedule continues —
 * one bad sweep must not stop every subsequent one. Overlapping runs are
 * prevented per job, because a slow purge should not stack up behind itself.
 */

interface JobDefinition {
  name: string;
  intervalMs: number;
  run: () => Promise<number | void>;
  /** Logged when the job did something, so quiet jobs stay quiet. */
  describe?: (result: number) => string;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const JOBS: JobDefinition[] = [
  {
    name: 'expire-pending-payments',
    // The payment window is 5 minutes; sweeping every 30s keeps the pharmacy's
    // countdown honest without hammering the database (spec §35).
    intervalMs: 30 * SECOND,
    run: expirePendingPayments,
    describe: (count) => `expired ${count} consultation(s) whose payment window closed`,
  },
  {
    name: 'expire-consultation-tokens',
    intervalMs: MINUTE,
    run: expireStaleTokens,
    describe: (count) => `revoked ${count} unused access token(s)`,
  },
  {
    // The 90-second response window, enforced server-side. Swept every 5s so a
    // lapsed offer is reassigned promptly rather than leaving a patient
    // waiting on a doctor who is not coming (spec §30).
    name: 'enforce-response-window',
    intervalMs: 5 * SECOND,
    run: async () => (await enforceResponseWindow()).missed,
    describe: (count) => `reassigned ${count} consultation(s) after a missed response`,
  },
  {
    // Picks up consultations that had no eligible doctor when they were
    // enqueued and have been waiting for one to come online.
    name: 'process-waiting-queue',
    intervalMs: 10 * SECOND,
    run: processWaitingQueue,
    describe: (count) => `offered ${count} waiting consultation(s)`,
  },
  {
    // Timer warnings only. This job emits events; it does NOT end a
    // consultation, and there is deliberately no job that does — only the
    // doctor completes a consultation (spec §15, §16).
    name: 'emit-timer-warnings',
    intervalMs: 10 * SECOND,
    run: emitTimerWarnings,
    describe: (count) => `sent a timer notice for ${count} live consultation(s)`,
  },
  {
    name: 'reap-stale-presence',
    intervalMs: 60 * SECOND,
    run: reapStalePresence,
    describe: (count) => `marked ${count} doctor(s) offline after a stale heartbeat`,
  },
  {
    name: 'recompute-quality-scores',
    intervalMs: 60 * MINUTE,
    run: async () => (await recomputeQualityScores()).scored,
    describe: (count) => `recomputed ${count} doctor quality score(s)`,
  },
  {
    // Lawful destruction of clinical records whose retention period has
    // elapsed (decision D23). Hourly is ample for a boundary measured in
    // years, and keeps the sweep small.
    name: 'purge-expired-clinical-records',
    intervalMs: 60 * MINUTE,
    run: purgeExpiredClinicalRecords,
    describe: (count) => `destroyed ${count} clinical record(s) past their retention period`,
  },
  {
    name: 'purge-expired-sessions',
    intervalMs: 15 * MINUTE,
    run: purgeExpiredSessions,
    describe: (count) => `removed ${count} expired session(s)`,
  },
  {
    /**
     * Membership expiry → suspension (spec §27).
     *
     * The sweep has existed since Phase 2 and was never scheduled, so a
     * doctor whose six-month membership lapsed stayed ACTIVE indefinitely and
     * kept receiving consultations. Hourly rather than daily because the
     * boundary is a moment, not a day, and a doctor suspended an hour late is
     * a doctor who took an hour of consultations they were not entitled to.
     */
    name: 'sweep-subscription-expiry',
    intervalMs: 60 * MINUTE,
    run: async () => (await runSubscriptionExpirySweep()).suspended,
    describe: (count) => `suspended ${count} doctor(s) whose membership lapsed`,
  },
  {
    /**
     * Payment reconciliation (docs/payment-flow.md §10).
     *
     * Finds payments where Neem and the provider disagree — most often a
     * webhook that never arrived, leaving a patient who paid with a
     * consultation that never activated. Records the drift; corrects nothing.
     */
    name: 'reconcile-payments',
    intervalMs: 60 * MINUTE,
    run: async () => (await reconcilePayments()).findings.length,
    describe: (count) => `found ${count} payment discrepancie(s) needing review`,
  },
];

const running = new Set<string>();
const timers: NodeJS.Timeout[] = [];

async function runJob(job: JobDefinition): Promise<void> {
  if (running.has(job.name)) {
    getLogger().debug({ job: job.name }, 'skipping run — previous one still in progress');
    return;
  }

  running.add(job.name);
  const startedAt = Date.now();

  try {
    const result = await job.run();

    if (typeof result === 'number' && result > 0) {
      getLogger().info(
        { job: job.name, durationMs: Date.now() - startedAt },
        job.describe?.(result) ?? `${job.name} affected ${result} record(s)`,
      );
    }
  } catch (error) {
    // Logged, never rethrown: an unhandled rejection here would take the
    // process down and stop every other job with it.
    getLogger().error({ err: error, job: job.name }, `scheduled job ${job.name} failed`);
  } finally {
    running.delete(job.name);
  }
}

export function startScheduler(): void {
  // Tests drive the jobs directly; background timers would make them
  // non-deterministic and leak between cases.
  if (getEnv().NODE_ENV === 'test') return;

  for (const job of JOBS) {
    const timer = setInterval(() => void runJob(job), job.intervalMs);
    // Do not hold the process open on account of a timer.
    timer.unref();
    timers.push(timer);
  }

  getLogger().info({ jobs: JOBS.map((job) => job.name) }, 'scheduled jobs started');
}

export function stopScheduler(): void {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
}

/** Exposed so tests and an admin health screen can run a sweep on demand. */
export async function runJobNow(name: string): Promise<void> {
  const job = JOBS.find((candidate) => candidate.name === name);
  if (!job) throw new Error(`Unknown job: ${name}`);
  await runJob(job);
}
