import type { PrismaClient } from '@prisma/client';
import { notifyOnce } from '../notification/notification.service.ts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { decryptField, encryptField, encryptNullable } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { getLogger } from '../../lib/logger.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';

/**
 * The clinical record — sealing, reading, and destruction (decision D23).
 *
 * **This is the only module permitted to touch clinical tables.** A test greps
 * the rest of `src/` for direct access to `consultationClinicalNotes`,
 * `consultationVitals` and `consultationTest`, because a guard that any module
 * can route around is not a guard.
 *
 * The rule it enforces, in one sentence: while a consultation is live its
 * treating doctor may read the record; once sealed, nobody may, until it is
 * destroyed at expiry.
 *
 * Ghanaian record-keeping law does not permit deleting these notes when the
 * consultation ends (see `docs/data-retention.md`). Neem therefore keeps them
 * — encrypted, unreadable, and on a timer — rather than either destroying
 * evidence a patient may need or building the medical history spec §13
 * forbids.
 */

export interface VitalsReadings {
  bpSystolic?: number | null;
  bpDiastolic?: number | null;
  pulseBpm?: number | null;
  temperatureC?: number | null;
  weightKg?: number | null;
  spo2Percent?: number | null;
}

export interface ClinicalRecord {
  notes: string | null;
  diagnosis: string | null;
  treatment: string | null;
  vitals: (VitalsReadings & { recordedAt: string }) | null;
  tests: Array<{ code: string; label: string; result: string; recordedAt: string }>;
}

/**
 * Thrown when something asks for a record that has been sealed.
 *
 * Deliberately its own type rather than a generic 403: a caller reaching this
 * is a caller that should not have asked, and it should be obvious in a stack
 * trace which rule stopped it.
 */
export class ClinicalRecordSealed extends Error {
  constructor(readonly consultationId: string) {
    super(
      'This clinical record is sealed. It is retained under a legal record-keeping ' +
        'obligation and cannot be read through the product (decision D23).',
    );
    this.name = 'ClinicalRecordSealed';
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function recordVitals(
  consultationId: string,
  readings: VitalsReadings,
  recordedByUserId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  await assertUnsealed(consultationId, db);

  await db.consultationVitals.create({
    data: {
      consultationId,
      readingsEnc: encryptField(JSON.stringify(readings)),
      recordedByUserId,
      recordedAt: clock.now(),
    },
  });
}

export async function recordTest(
  consultationId: string,
  test: { code: string; label: string; result: string },
  recordedByUserId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  await assertUnsealed(consultationId, db);

  await db.consultationTest.create({
    data: {
      consultationId,
      testCode: test.code,
      testLabel: test.label,
      resultEnc: encryptField(test.result),
      recordedByUserId,
      recordedAt: clock.now(),
    },
  });
}

export interface ClinicalNotesInput {
  notes?: string | null;
  diagnosis?: string | null;
  treatment?: string | null;
}

/**
 * Saves the doctor's working notes.
 *
 * Lives here rather than in the clinical workspace module for the same reason
 * every other clinical read and write does: this is the only module allowed to
 * touch these tables, and a test enforces it. Writing them from the workspace
 * would have been the first bypass of the sealing rule.
 */
export async function saveClinicalNotes(
  consultationId: string,
  input: ClinicalNotesInput,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  await assertUnsealed(consultationId, db);

  await db.consultationClinicalNotes.upsert({
    where: { consultationId },
    create: {
      consultationId,
      notesEnc: encryptNullable(input.notes),
      diagnosisEnc: encryptNullable(input.diagnosis),
      treatmentEnc: encryptNullable(input.treatment),
    },
    update: {
      notesEnc: encryptNullable(input.notes),
      diagnosisEnc: encryptNullable(input.diagnosis),
      treatmentEnc: encryptNullable(input.treatment),
      updatedAt: clock.now(),
    },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Reads the clinical record for a live consultation.
 *
 * Refuses once sealed. There is deliberately no parameter that overrides this
 * — break-glass access will be a separate, audited, two-person path, and it is
 * not built while counsel's answer on G7c is outstanding.
 */
export async function readClinicalRecord(
  consultationId: string,
  db: Db = getPrisma(),
): Promise<ClinicalRecord> {
  await assertUnsealed(consultationId, db);

  const [notes, vitals, tests] = await Promise.all([
    db.consultationClinicalNotes.findUnique({ where: { consultationId } }),
    db.consultationVitals.findFirst({
      where: { consultationId },
      orderBy: { recordedAt: 'desc' },
    }),
    db.consultationTest.findMany({
      where: { consultationId },
      orderBy: { recordedAt: 'desc' },
    }),
  ]);

  return {
    notes: notes?.notesEnc ? decryptField(notes.notesEnc) : null,
    diagnosis: notes?.diagnosisEnc ? decryptField(notes.diagnosisEnc) : null,
    treatment: notes?.treatmentEnc ? decryptField(notes.treatmentEnc) : null,
    vitals: vitals
      ? {
          ...(JSON.parse(decryptField(vitals.readingsEnc)) as VitalsReadings),
          recordedAt: vitals.recordedAt.toISOString(),
        }
      : null,
    tests: tests.map((test) => ({
      code: test.testCode,
      label: test.testLabel,
      result: decryptField(test.resultEnc),
      recordedAt: test.recordedAt.toISOString(),
    })),
  };
}

/** Whether a record is sealed, without reading any of its contents. */
export async function isSealed(consultationId: string, db: Db = getPrisma()): Promise<boolean> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    select: { clinicalSealedAt: true },
  });

  return consultation?.clinicalSealedAt !== null && consultation?.clinicalSealedAt !== undefined;
}

async function assertUnsealed(consultationId: string, db: Db): Promise<void> {
  if (await isSealed(consultationId, db)) {
    throw new ClinicalRecordSealed(consultationId);
  }
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

/**
 * Seals the record and schedules its destruction.
 *
 * Called from `transition()` on the first terminal transition, so that no
 * completion path — present or future — can forget it. Idempotent: a record
 * already sealed keeps its original seal time and its original destruction
 * date, because re-sealing would silently extend how long patient data is
 * held.
 *
 * Takes a transaction client when the caller has one, so that sealing and the
 * state change commit together.
 */
export async function sealClinicalRecord(
  consultationId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ sealedAt: Date; destroyAt: Date } | null> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    select: { id: true, clinicalSealedAt: true },
  });
  if (!consultation) return null;

  if (consultation.clinicalSealedAt) {
    const existing = await db.retentionJob.findFirst({
      where: { consultationId, status: 'SCHEDULED' },
      select: { scheduledFor: true },
    });
    return existing
      ? { sealedAt: consultation.clinicalSealedAt, destroyAt: existing.scheduledFor }
      : null;
  }

  const years = await getIntSetting(SETTING_KEYS.RETENTION_CLINICAL_RECORD_YEARS, db);
  const sealedAt = clock.now();

  const destroyAt = new Date(sealedAt);
  destroyAt.setUTCFullYear(destroyAt.getUTCFullYear() + years);

  await db.consultation.update({
    where: { id: consultationId },
    data: { clinicalSealedAt: sealedAt },
  });

  await db.retentionJob.create({
    data: { consultationId, scheduledFor: destroyAt, status: 'SCHEDULED' },
  });

  /**
   * The access token is a credential, not a record. It goes now — nothing
   * about record-keeping requires keeping a key, and leaving it alive would
   * let a stale QR code reopen a finished consultation.
   */
  await db.consultationAccessToken.deleteMany({ where: { consultationId } });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CLINICAL_RECORD_SEALED,
      actorType: 'SYSTEM',
      entityType: 'consultation',
      entityId: consultationId,
      // Dates only. Never a word of what the record contains (spec §61).
      metadata: { retentionYears: years, destroyAt: destroyAt.toISOString() },
    },
    db,
  );

  return { sealedAt, destroyAt };
}

// ---------------------------------------------------------------------------
// Destruction
// ---------------------------------------------------------------------------

/**
 * Destroys sealed records whose retention period has elapsed.
 *
 * A real `DELETE`, never a flag (spec §62). What survives is the operational
 * consultation row, any prescription or referral, and the retention job itself
 * recording that destruction happened and what it removed — so the fact of
 * lawful destruction is provable after the data is gone.
 */
export async function purgeExpiredClinicalRecords(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const now = clock.now();

  const due = await db.retentionJob.findMany({
    where: { status: 'SCHEDULED', scheduledFor: { lte: now } },
    select: { id: true, consultationId: true },
    take: 200,
  });

  let destroyed = 0;

  for (const job of due) {
    try {
      await db.$transaction(async (tx) => {
        await tx.retentionJob.update({
          where: { id: job.id },
          data: { status: 'RUNNING', startedAt: clock.now() },
        });

        const rowsPurged = {
          clinicalNotes: (
            await tx.consultationClinicalNotes.deleteMany({
              where: { consultationId: job.consultationId },
            })
          ).count,
          vitals: (
            await tx.consultationVitals.deleteMany({
              where: { consultationId: job.consultationId },
            })
          ).count,
          tests: (
            await tx.consultationTest.deleteMany({ where: { consultationId: job.consultationId } })
          ).count,
          patientSession: (
            await tx.patientSession.deleteMany({ where: { consultationId: job.consultationId } })
          ).count,
        };

        await tx.retentionJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            completedAt: clock.now(),
            verifiedAt: clock.now(),
            rowsPurged,
          },
        });

        await recordAudit(
          {
            action: AUDIT_ACTIONS.CLINICAL_RECORD_DESTROYED,
            actorType: 'SYSTEM',
            entityType: 'consultation',
            entityId: job.consultationId,
            // Counts only — the contents are the thing being destroyed.
            metadata: rowsPurged,
          },
          tx,
        );
      });

      destroyed += 1;
    } catch (error) {
      // Recorded and skipped rather than thrown: one stuck record must not
      // stop every other lawful destruction that is due.
      getLogger().error(
        { err: error, retentionJobId: job.id },
        'clinical record destruction failed',
      );

      await db.retentionJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message.slice(0, 500) : 'unknown',
        },
      });
    }
  }

  /**
   * A destruction that has fallen overdue is escalated, not merely countable.
   *
   * `overdueDestructions` has existed since Phase 5.5 and nothing called it
   * outside a health check. Holding clinical data past its retention period is
   * a compliance failure, and a destruction job that has been quietly failing
   * is precisely the thing nobody notices — the failure mode is silence, so
   * the remedy has to be a message.
   *
   * Deduped over a day: this runs hourly and an overdue record stays overdue
   * until somebody acts.
   */
  const overdue = await overdueDestructions(db, clock);
  if (overdue > 0) {
    void notifyOnce(
      {
        templateCode: 'admin.retention.overdue',
        recipient: { type: 'ADMIN' },
        variables: { count: overdue },
      },
      { withinDays: 1 },
      db,
      clock,
    );
  }

  return destroyed;
}

/**
 * Sealed records that are overdue for destruction.
 *
 * Surfaced to an administrator rather than left silent: data held past its
 * retention period is a compliance failure, and a job that has been quietly
 * failing is exactly what nobody notices.
 */
export async function overdueDestructions(
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  return db.retentionJob.count({
    where: {
      status: { in: ['SCHEDULED', 'RUNNING', 'FAILED'] },
      scheduledFor: { lt: new Date(clock.now().getTime() - 24 * 60 * 60 * 1000) },
    },
  });
}
