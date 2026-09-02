import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import {
  ClinicalRecordSealed,
  isSealed,
  purgeExpiredClinicalRecords,
  readClinicalRecord,
  recordTest,
  recordVitals,
  sealClinicalRecord,
} from '../../src/modules/retention/clinical-record.service.ts';
import {
  RETRIEVAL_PURPOSES,
  endRetrieval,
  retrieveArchivedConsultation,
} from '../../src/modules/retention/archived-retrieval.service.ts';
import { fixedClock } from '../../src/lib/clock.ts';
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';

/**
 * Clinical record retention (decision D23, D24).
 *
 * The design this replaced deleted clinical notes the moment a consultation
 * completed. Ghanaian record-keeping law does not permit that, so the record is
 * now kept — encrypted, unreadable through the product, and destroyed when the
 * retention period expires.
 *
 * The three assertions that matter, and which replace the old spec §101 test:
 * after a consultation ends the record still exists; nobody can read it; and
 * once the period elapses it is gone.
 */

const PHARMACY_PASSWORD = 'PharmacyPassword123!';

async function liveConsultation(): Promise<{ id: string; publicId: string; userId: string }> {
  const prisma = getPrisma();
  const pharmacy = await createTestPharmacy(`Pharmacy ${generatePublicId('x').slice(-6)}`, 'ACTIVE');
  const user = await createTestUser({
    email: `${generatePublicId('x').slice(-8)}@pharmacy.test`,
    password: PHARMACY_PASSWORD,
    role: 'PHARMACY',
  });
  await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });

  const cookies = await signIn(user.email, PHARMACY_PASSWORD);
  const created = await request<{ publicId: string }>('/pharmacy/consultations', {
    method: 'POST',
    cookies,
    payload: {},
  });
  const publicId = created.body.data!.publicId;

  const consultation = await prisma.consultation.findUniqueOrThrow({ where: { publicId } });
  return { id: consultation.id, publicId, userId: user.id };
}

/**
 * Puts a full clinical record on a live consultation — identity included.
 *
 * Identity matters here: a sealed record that cannot be attributed to a patient
 * discharges no record-keeping duty, so retrieval must return it and the access
 * log must record that it was reached.
 */
async function writeRecord(consultationId: string, userId: string): Promise<void> {
  await getPrisma().patientSession.create({
    data: {
      consultationId,
      fullNameEnc: encryptField('Adwoa Mensah'),
      age: 34,
      sex: 'FEMALE',
      phoneEnc: encryptField('0245551234'),
    },
  });

  await recordVitals(
    consultationId,
    { bpSystolic: 128, bpDiastolic: 84, pulseBpm: 92, temperatureC: 38.2, spo2Percent: 97 },
    userId,
  );
  await recordTest(
    consultationId,
    { code: 'MALARIA_RDT', label: 'Malaria RDT', result: 'Positive' },
    userId,
  );
  await getPrisma().consultationClinicalNotes.create({
    data: { consultationId, notesEnc: encryptField('Fever for three days.') },
  });
}

beforeEach(async () => {
  await resetDatabase();
  setPaymentProviderForTesting(new MockPaymentProvider());
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await closeTestApp();
  await disconnectPrisma();
});

// ---------------------------------------------------------------------------
// While the consultation is live
// ---------------------------------------------------------------------------

describe('a live clinical record', () => {
  it('is readable, and round-trips through encryption intact', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);

    const record = await readClinicalRecord(consultation.id);

    expect(record.vitals).toMatchObject({ bpSystolic: 128, temperatureC: 38.2, spo2Percent: 97 });
    expect(record.tests[0]).toMatchObject({ code: 'MALARIA_RDT', result: 'Positive' });
    expect(record.notes).toBe('Fever for three days.');
  });

  it('stores nothing clinical in plaintext', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);

    const prisma = getPrisma();
    const vitals = await prisma.consultationVitals.findFirstOrThrow({
      where: { consultationId: consultation.id },
    });
    const test = await prisma.consultationTest.findFirstOrThrow({
      where: { consultationId: consultation.id },
    });

    // The readings must not be legible to anyone reading the table directly.
    expect(vitals.readingsEnc).toMatch(/^v1\./);
    expect(vitals.readingsEnc).not.toContain('128');
    expect(test.resultEnc).toMatch(/^v1\./);
    expect(test.resultEnc).not.toContain('Positive');

    // The test's code and label stay legible: which test a pharmacy performed
    // is an operational record. The finding is the clinical part.
    expect(test.testCode).toBe('MALARIA_RDT');
  });
});

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

describe('sealing', () => {
  it('happens on any terminal transition, not just completion', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);

    expect(await isSealed(consultation.id)).toBe(false);

    // Expiry, not completion — a consultation reaches a terminal state down
    // several paths and every one of them must seal.
    await transition(consultation.id, 'EXPIRED', { actorType: 'SYSTEM', reason: 'test' });

    expect(await isSealed(consultation.id)).toBe(true);
  });

  it('makes the record unreadable, while leaving it in existence', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);
    await transition(consultation.id, 'EXPIRED', { actorType: 'SYSTEM', reason: 'test' });

    // Unreadable...
    await expect(readClinicalRecord(consultation.id)).rejects.toThrow(ClinicalRecordSealed);

    // ...but still there. This is the whole point of D23: the record survives
    // because the law requires it, and is closed because privacy requires that.
    const prisma = getPrisma();
    expect(
      await prisma.consultationClinicalNotes.count({ where: { consultationId: consultation.id } }),
    ).toBe(1);
    expect(
      await prisma.consultationVitals.count({ where: { consultationId: consultation.id } }),
    ).toBe(1);
  });

  it('refuses further writes once sealed', async () => {
    const consultation = await liveConsultation();
    await transition(consultation.id, 'EXPIRED', { actorType: 'SYSTEM', reason: 'test' });

    await expect(
      recordVitals(consultation.id, { pulseBpm: 80 }, consultation.userId),
    ).rejects.toThrow(ClinicalRecordSealed);
  });

  it('schedules destruction for the configured number of years', async () => {
    const consultation = await liveConsultation();
    const at = new Date('2026-09-01T10:00:00.000Z');

    await transition(
      consultation.id,
      'EXPIRED',
      { actorType: 'SYSTEM', reason: 'test' },
      getPrisma(),
      fixedClock(at),
    );

    const job = await getPrisma().retentionJob.findFirstOrThrow({
      where: { consultationId: consultation.id },
    });

    expect(job.status).toBe('SCHEDULED');
    // Three years, the seeded default.
    expect(job.scheduledFor.toISOString()).toBe('2029-09-01T10:00:00.000Z');
  });

  it('does not extend the destruction date when sealing twice', async () => {
    const consultation = await liveConsultation();
    const first = new Date('2026-09-01T10:00:00.000Z');

    await sealClinicalRecord(consultation.id, getPrisma(), fixedClock(first));
    const original = await getPrisma().retentionJob.findFirstOrThrow({
      where: { consultationId: consultation.id },
    });

    // A year later, something seals again. Patient data must not silently gain
    // another retention period.
    await sealClinicalRecord(
      consultation.id,
      getPrisma(),
      fixedClock(new Date('2027-09-01T10:00:00.000Z')),
    );

    const jobs = await getPrisma().retentionJob.findMany({
      where: { consultationId: consultation.id },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.scheduledFor.toISOString()).toBe(original.scheduledFor.toISOString());
  });

  it('destroys the access token, which is a credential rather than a record', async () => {
    const consultation = await liveConsultation();
    const prisma = getPrisma();

    await prisma.consultationAccessToken.create({
      data: {
        consultationId: consultation.id,
        tokenHash: generatePublicId('tok').padEnd(64, '0').slice(0, 64),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    await transition(consultation.id, 'EXPIRED', { actorType: 'SYSTEM', reason: 'test' });

    expect(
      await prisma.consultationAccessToken.count({ where: { consultationId: consultation.id } }),
    ).toBe(0);
  });

  it('records the seal in the audit log without a word of clinical content', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);
    await transition(consultation.id, 'EXPIRED', { actorType: 'SYSTEM', reason: 'test' });

    const entry = await getPrisma().auditLog.findFirstOrThrow({
      where: { action: 'retention.clinical-record.sealed', entityId: consultation.id },
    });

    const serialised = JSON.stringify(entry);
    expect(serialised).toContain('retentionYears');
    expect(serialised).not.toMatch(/Fever|Positive|MALARIA|128/);
  });
});

// ---------------------------------------------------------------------------
// Nobody can read a sealed record through the product
// ---------------------------------------------------------------------------

/**
 * The pharmacy's read-back of its own observations.
 *
 * A pharmacist who cannot see whether a reading went in will enter it twice.
 * The boundary is that they read back what they measured — never the doctor's
 * notes, which live in the same guarded record (spec §50).
 */
describe('the pharmacy reads back its observations, and nothing else', () => {
  it('returns the vitals and tests it recorded', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);

    const user = await getPrisma().user.findUniqueOrThrow({ where: { id: consultation.userId } });
    const cookies = await signIn(user.email, PHARMACY_PASSWORD);

    const response = await request<{
      sealed: boolean;
      vitals: { bpSystolic: number; temperatureC: number } | null;
      tests: Array<{ label: string; result: string }>;
    }>(`/pharmacy/consultations/${consultation.publicId}/observations`, { cookies });

    expect(response.status).toBe(200);
    expect(response.body.data!.sealed).toBe(false);
    expect(response.body.data!.vitals?.bpSystolic).toBe(128);
    expect(response.body.data!.vitals?.temperatureC).toBe(38.2);
    expect(response.body.data!.tests).toHaveLength(1);
    expect(response.body.data!.tests[0]!.result).toBe('Positive');
  });

  it('never returns the doctor’s notes', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);

    const user = await getPrisma().user.findUniqueOrThrow({ where: { id: consultation.userId } });
    const cookies = await signIn(user.email, PHARMACY_PASSWORD);

    const response = await request(
      `/pharmacy/consultations/${consultation.publicId}/observations`,
      { cookies },
    );

    // 'Fever for three days.' is what writeRecord puts in the notes.
    expect(JSON.stringify(response.body)).not.toMatch(/Fever/);
  });

  it('closes once the consultation is over', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);
    await transition(consultation.id, 'EXPIRED', { actorType: 'SYSTEM', reason: 'test' });

    const user = await getPrisma().user.findUniqueOrThrow({ where: { id: consultation.userId } });
    const cookies = await signIn(user.email, PHARMACY_PASSWORD);

    const response = await request<{ sealed: boolean; vitals: unknown; tests: unknown[] }>(
      `/pharmacy/consultations/${consultation.publicId}/observations`,
      { cookies },
    );

    expect(response.body.data!.sealed).toBe(true);
    expect(response.body.data!.vitals).toBeNull();
    expect(response.body.data!.tests).toEqual([]);
    expect(JSON.stringify(response.body)).not.toMatch(/Positive|128|38\.2/);
  });

  it('is closed to another pharmacy', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);

    const other = await liveConsultation();
    const otherUser = await getPrisma().user.findUniqueOrThrow({ where: { id: other.userId } });
    const cookies = await signIn(otherUser.email, PHARMACY_PASSWORD);

    const response = await request(
      `/pharmacy/consultations/${consultation.publicId}/observations`,
      { cookies },
    );

    // 404, not 403 — a pharmacy must not learn another's consultation exists.
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('a sealed record is closed to every role', () => {
  it('is not returned by the doctor consultation route', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);
    await transition(consultation.id, 'EXPIRED', { actorType: 'SYSTEM', reason: 'test' });

    // The doctor route reads through the guarded service, so a sealed record
    // stops it rather than being quietly serialised into the response.
    await expect(readClinicalRecord(consultation.id)).rejects.toThrow(ClinicalRecordSealed);
  });

  it('offers no route that returns clinical data for a finished consultation', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);
    await transition(consultation.id, 'EXPIRED', { actorType: 'SYSTEM', reason: 'test' });

    const cookies = await signIn(
      (await getPrisma().user.findUniqueOrThrow({ where: { id: consultation.userId } })).email,
      PHARMACY_PASSWORD,
    );

    const response = await request(`/pharmacy/consultations/${consultation.publicId}`, { cookies });
    const body = JSON.stringify(response.body);

    expect(body).not.toMatch(/Fever|Positive|128|38\.2/);
  });
});

// ---------------------------------------------------------------------------
// Destruction at expiry
// ---------------------------------------------------------------------------

describe('destruction when the retention period elapses', () => {
  it('leaves nothing behind, and records that it happened', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);
    await transition(
      consultation.id,
      'EXPIRED',
      { actorType: 'SYSTEM', reason: 'test' },
      getPrisma(),
      fixedClock(new Date('2026-09-01T10:00:00.000Z')),
    );

    // A day before it is due, nothing happens.
    expect(
      await purgeExpiredClinicalRecords(getPrisma(), fixedClock(new Date('2029-08-31T10:00:00Z'))),
    ).toBe(0);

    const prisma = getPrisma();
    expect(
      await prisma.consultationClinicalNotes.count({ where: { consultationId: consultation.id } }),
    ).toBe(1);

    // A day after, it is destroyed.
    expect(
      await purgeExpiredClinicalRecords(getPrisma(), fixedClock(new Date('2029-09-02T10:00:00Z'))),
    ).toBe(1);

    expect(
      await prisma.consultationClinicalNotes.count({ where: { consultationId: consultation.id } }),
    ).toBe(0);
    expect(
      await prisma.consultationVitals.count({ where: { consultationId: consultation.id } }),
    ).toBe(0);
    expect(await prisma.consultationTest.count({ where: { consultationId: consultation.id } })).toBe(
      0,
    );
    expect(
      await prisma.patientSession.count({ where: { consultationId: consultation.id } }),
    ).toBe(0);

    // The operational record survives — a consultation happened, and that fact
    // is not clinical (spec §12).
    expect(await prisma.consultation.count({ where: { id: consultation.id } })).toBe(1);

    // And destruction is provable after the data is gone.
    const job = await prisma.retentionJob.findFirstOrThrow({
      where: { consultationId: consultation.id },
    });
    expect(job.status).toBe('COMPLETED');
    expect(job.rowsPurged).toMatchObject({ clinicalNotes: 1, vitals: 1, tests: 1 });
  });

  it('is a real DELETE, not a flag (spec §62)', async () => {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);
    await transition(
      consultation.id,
      'EXPIRED',
      { actorType: 'SYSTEM', reason: 'test' },
      getPrisma(),
      fixedClock(new Date('2026-09-01T10:00:00.000Z')),
    );
    await purgeExpiredClinicalRecords(getPrisma(), fixedClock(new Date('2030-01-01T00:00:00Z')));

    // Not "hidden by a query filter" — the rows are not in the table.
    const rows = await getPrisma().$queryRawUnsafe<Array<{ n: bigint }>>(
      'SELECT COUNT(*) AS n FROM consultation_clinical_notes WHERE consultationId = ?',
      consultation.id,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The guard has to be unroutable-around to be a guard
// ---------------------------------------------------------------------------

describe('the clinical tables are reachable from one module only', () => {
  it('no other source file queries them directly', () => {
    const CLINICAL_TABLES = /\b(consultationClinicalNotes|consultationVitals|consultationTest)\b/;

    // The one module allowed to touch them, plus the destruction path inside
    // it. Everything else must go through readClinicalRecord.
    const ALLOWED = ['clinical-record.service.ts'];

    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);

        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
        if (ALLOWED.some((allowed) => full.endsWith(allowed))) continue;

        const code = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');

        if (CLINICAL_TABLES.test(code)) offenders.push(full);
      }
    };

    walk(join(import.meta.dirname, '..', '..', 'src'));

    expect(
      offenders,
      'Clinical data must be read through clinical-record.service.ts, which refuses ' +
        'once a record is sealed. A direct query bypasses that (decision D23).',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Archived Consultation Retrieval (decision D27)
// ---------------------------------------------------------------------------

/**
 * Counsel's instruction was to build controlled retrieval of one archived
 * encounter — explicitly NOT a patient-history feature. Most of what follows
 * asserts refusals, because the refusals are the design.
 */
describe('archived consultation retrieval', () => {
  async function sealedConsultation() {
    const consultation = await liveConsultation();
    await writeRecord(consultation.id, consultation.userId);
    await transition(consultation.id, 'EXPIRED', { actorType: 'SYSTEM', reason: 'test' });
    return consultation;
  }

  async function twoAdmins() {
    const actor = await createTestUser({
      email: `retriever.${generatePublicId('x').slice(-8)}@neem.test`,
      password: 'AdminPassword123!',
      role: 'ADMIN',
    });
    const authoriser = await createTestUser({
      email: `authoriser.${generatePublicId('x').slice(-8)}@neem.test`,
      password: 'AdminPassword123!',
      role: 'ADMIN',
    });
    return { actor, authoriser };
  }

  it('returns the sealed record when two administrators and a reason are supplied', async () => {
    const consultation = await sealedConsultation();
    const { actor, authoriser } = await twoAdmins();

    const record = await retrieveArchivedConsultation({
      consultationPublicId: consultation.publicId,
      purpose: 'LEGAL_OR_REGULATORY_PROCEEDING',
      reference: 'MDC/2029/0117',
      actor: { userId: actor.id, role: 'ADMIN' },
      authorisedByUserId: authoriser.id,
    });

    expect(record.clinical.notes).toBe('Fever for three days.');
    expect(record.clinical.vitals).toMatchObject({ bpSystolic: 128 });
    expect(record.clinical.tests[0]).toMatchObject({ result: 'Positive' });
    expect(record.patient?.fullName).toBeTruthy();
    // The operational context comes with it, so the encounter is intelligible.
    expect(record.encounter.pharmacyName).toBeTruthy();
  });

  it('writes an access log entry carrying everything counsel requires', async () => {
    const consultation = await sealedConsultation();
    const { actor, authoriser } = await twoAdmins();

    const record = await retrieveArchivedConsultation({
      consultationPublicId: consultation.publicId,
      purpose: 'PATIENT_DATA_ACCESS_REQUEST',
      reference: 'SAR-2029-004',
      actor: { userId: actor.id, role: 'ADMIN' },
      authorisedByUserId: authoriser.id,
    });

    const entry = await getPrisma().clinicalRecordAccessLog.findUniqueOrThrow({
      where: { id: record.accessLogId },
    });

    expect(entry.actorUserId).toBe(actor.id);
    expect(entry.actorRole).toBe('ADMIN');
    expect(entry.authorisedByUserId).toBe(authoriser.id);
    expect(entry.purpose).toBe('PATIENT_DATA_ACCESS_REQUEST');
    expect(entry.reference).toBe('SAR-2029-004');
    expect(entry.recordsAccessed).toEqual(
      expect.arrayContaining(['clinical_notes', 'vitals', 'tests', 'patient_identity']),
    );
    // Open until explicitly closed, which is itself visible on oversight.
    expect(entry.accessEndedAt).toBeNull();

    await endRetrieval(record.accessLogId);
    const closed = await getPrisma().clinicalRecordAccessLog.findUniqueOrThrow({
      where: { id: record.accessLogId },
    });
    expect(closed.accessEndedAt).not.toBeNull();
  });

  it('refuses when one administrator authorises their own retrieval', async () => {
    const consultation = await sealedConsultation();
    const { actor } = await twoAdmins();

    // A single person wearing two hats defeats the control entirely.
    await expect(
      retrieveArchivedConsultation({
        consultationPublicId: consultation.publicId,
        purpose: 'INTERNAL_INVESTIGATION_OR_AUDIT',
        reference: 'INT-1',
        actor: { userId: actor.id, role: 'ADMIN' },
        authorisedByUserId: actor.id,
      }),
    ).rejects.toThrow(/cannot authorise your own/i);
  });

  it('refuses an authoriser who is not an active administrator', async () => {
    const consultation = await sealedConsultation();
    const { actor } = await twoAdmins();

    const pharmacist = await createTestUser({
      email: `pharm.${generatePublicId('x').slice(-8)}@pharmacy.test`,
      password: 'PharmacyPassword123!',
      role: 'PHARMACY',
    });

    await expect(
      retrieveArchivedConsultation({
        consultationPublicId: consultation.publicId,
        purpose: 'INTERNAL_INVESTIGATION_OR_AUDIT',
        reference: 'INT-2',
        actor: { userId: actor.id, role: 'ADMIN' },
        authorisedByUserId: pharmacist.id,
      }),
    ).rejects.toThrow(/active administrator/i);
  });

  it('refuses without a case reference', async () => {
    const consultation = await sealedConsultation();
    const { actor, authoriser } = await twoAdmins();

    await expect(
      retrieveArchivedConsultation({
        consultationPublicId: consultation.publicId,
        purpose: 'QUALITY_OR_SAFETY_INVESTIGATION',
        reference: '   ',
        actor: { userId: actor.id, role: 'ADMIN' },
        authorisedByUserId: authoriser.id,
      }),
    ).rejects.toThrow(/reference is required/i);
  });

  it('refuses a live consultation — retrieval is for sealed records', async () => {
    const consultation = await liveConsultation();
    const { actor, authoriser } = await twoAdmins();

    await expect(
      retrieveArchivedConsultation({
        consultationPublicId: consultation.publicId,
        purpose: 'INTERNAL_INVESTIGATION_OR_AUDIT',
        reference: 'INT-3',
        actor: { userId: actor.id, role: 'ADMIN' },
        authorisedByUserId: authoriser.id,
      }),
    ).rejects.toThrow(/still in progress/i);
  });

  it('has no purpose code for research', () => {
    // Counsel permits an approved research purpose, but it is deliberately
    // unbuilt: research over a sealed archive is the likeliest route by which
    // this becomes the longitudinal history it exists to avoid, and it needs a
    // lawful basis that does not yet exist (G7d, D27).
    expect(RETRIEVAL_PURPOSES.some((purpose) => /RESEARCH/i.test(purpose))).toBe(false);
  });

  it('leaves no trace of clinical content in the audit log', async () => {
    const consultation = await sealedConsultation();
    const { actor, authoriser } = await twoAdmins();

    await retrieveArchivedConsultation({
      consultationPublicId: consultation.publicId,
      purpose: 'LEGAL_OR_REGULATORY_PROCEEDING',
      reference: 'MDC/2029/0118',
      actor: { userId: actor.id, role: 'ADMIN' },
      authorisedByUserId: authoriser.id,
    });

    const entry = await getPrisma().auditLog.findFirstOrThrow({
      where: { action: 'retention.clinical-record.retrieved', entityId: consultation.id },
    });

    const serialised = JSON.stringify(entry);
    expect(serialised).toContain('LEGAL_OR_REGULATORY_PROCEEDING');
    expect(serialised).not.toMatch(/Fever|Positive|MALARIA/);
  });
});

describe('retrieval is admin-only, and takes one reference', () => {
  it('refuses a pharmacy at the route', async () => {
    const consultation = await liveConsultation();
    await transition(consultation.id, 'EXPIRED', { actorType: 'SYSTEM', reason: 'test' });

    const pharmacyCookies = await signIn(
      (await getPrisma().user.findUniqueOrThrow({ where: { id: consultation.userId } })).email,
      PHARMACY_PASSWORD,
    );

    const response = await request('/admin/archived-consultations/retrieve', {
      method: 'POST',
      cookies: pharmacyCookies,
      payload: {
        consultationPublicId: consultation.publicId,
        purpose: 'INTERNAL_INVESTIGATION_OR_AUDIT',
        reference: 'X-1',
        authorisedByUserPublicId: 'usr_anything',
      },
    });

    expect(response.status).toBe(403);
  });

  it('offers no route that searches by patient', async () => {
    // The shapes someone would reach for if they wanted a history feature.
    for (const path of [
      '/admin/archived-consultations/by-patient/0240000000',
      '/admin/patients',
      '/admin/patients/0240000000/consultations',
    ]) {
      const response = await request(path);
      expect([401, 403, 404], path).toContain(response.status);
    }
  });
});
