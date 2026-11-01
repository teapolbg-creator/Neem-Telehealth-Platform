import { randomInt } from 'node:crypto';
import type { Prisma, PrismaClient, TriageCategory, VisitStatus } from '@prisma/client';
import { startOfDay } from 'date-fns';
import {
  CHPS_CONSENT_VERSION,
  OPEN_VISIT_STATUSES,
  ghanaPhoneSchema,
  type FacilityDaySummary,
  type PatientRecord,
  type PatientRegistration,
  type PatientSummary,
  type PatientUpdate,
  type TriageCreate,
  type TriageView,
  type VisitView,
  type VitalSigns,
} from '@neem/contracts';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import {
  decryptField,
  decryptNullable,
  encryptField,
  encryptNullable,
  generatePublicId,
  keyedHash,
} from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import type { AuthenticatedPrincipal } from '../auth/session.service.ts';
import { toEncounterSummary } from '../clinical/chps-encounter.service.ts';
import {
  referralActorIds,
  referralInclude,
  toReferralView,
  visitHasReferral,
} from './referral.service.ts';
import {
  activeConsultationFor,
  toConsultationView,
  withdrawWaitingRequest,
} from './chps-consultation.service.ts';

/**
 * CHPS patients, walk-in visits and triage (CHPS slice 1b, D74, D75).
 *
 * Every function takes the signed-in staff member and works only inside
 * their own facility: a patient, a visit or a search result from another
 * facility is "not found", never "forbidden", because confirming it exists
 * would itself be a disclosure.
 *
 * Identity and clinical text are encrypted. What has to be searchable is a
 * keyed hash: the words of a name, a phone number, an NHIS number. Opening a
 * full record is written to the access log (D74).
 */

const OPEN = OPEN_VISIT_STATUSES as VisitStatus[];

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/** Lower-case, accents removed, split into words of two letters or more. */
export function nameWords(name: string): string[] {
  return [
    ...new Set(
      name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 2),
    ),
  ];
}

const nameToken = (word: string) => keyedHash(`chps-patient-name:${word}`);
const phoneHash = (phone: string) => keyedHash(`chps-patient-phone:${phone}`);
const nhisHash = (nhis: string) => keyedHash(`chps-patient-nhis:${nhis}`);

/**
 * Crockford base32 — no I, L, O or U — so a number read aloud or copied by
 * hand from a card is not mistaken for another.
 */
const PATIENT_NUMBER_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generatePatientNumber(): string {
  const chars = Array.from(
    { length: 8 },
    () => PATIENT_NUMBER_ALPHABET[randomInt(PATIENT_NUMBER_ALPHABET.length)],
  );
  return `NM-${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** Accepts "nm4k7q9x2m", "NM-4K7Q-9X2M" and the usual misreadings of O, I and L. */
export function normalisePatientNumber(input: string): string {
  const compact = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/^NM/, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return compact.length === 8 ? `NM-${compact.slice(0, 4)}-${compact.slice(4)}` : input.trim();
}

/** A date of birth from an estimated age, anchored to today's date. */
function birthDateFromAge(years: number, months: number, now: Date): Date {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCMonth(date.getUTCMonth() - (years * 12 + months));
  return date;
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

export interface StaffContext {
  userId: string;
  facilityId: string;
  correlationId?: string;
}

/**
 * The staff member's facility. Reading works whatever the facility's status,
 * because records stay the facility's; changing anything needs it active.
 */
export async function staffContext(
  principal: AuthenticatedPrincipal,
  options: { write: boolean; correlationId?: string },
  db: Db = getPrisma(),
): Promise<StaffContext> {
  if (principal.role !== 'FACILITY' || !principal.organisationId) {
    throw errors.notFound('This account is not attached to a facility.');
  }
  if (options.write) {
    const facility = await db.facility.findUnique({
      where: { id: principal.organisationId },
      select: { status: true },
    });
    if (facility?.status !== 'ACTIVE') {
      throw errors.businessRule(
        'This facility is not active on Neem yet. Care for patients through your usual arrangements.',
      );
    }
  }
  return {
    userId: principal.userId,
    facilityId: principal.organisationId,
    correlationId: options.correlationId,
  };
}

async function audit(
  ctx: StaffContext,
  action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown>,
  db: Db,
) {
  await recordAudit(
    {
      action,
      actorType: 'FACILITY',
      actorId: ctx.userId,
      entityType,
      entityId,
      correlationId: ctx.correlationId,
      metadata,
    },
    db,
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const consultationInclude = {
  orderBy: { createdAt: 'desc' },
  take: 1,
  include: {
    doctor: { select: { fullName: true } },
    language: { select: { label: true } },
    encounter: { select: { contentEnc: true, version: true, finalisedAt: true } },
  },
} satisfies Prisma.PatientVisit$consultationsArgs;

const visitInclude = {
  triages: { orderBy: { recordedAt: 'desc' } },
  consultations: consultationInclude,
  referrals: { orderBy: { issuedAt: 'desc' }, include: referralInclude },
} satisfies Prisma.PatientVisitInclude;

type VisitRow = Prisma.PatientVisitGetPayload<{ include: typeof visitInclude }>;

export async function staffNames(userIds: string[], db: Db): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const members = await db.facilityUser.findMany({
    where: { userId: { in: [...new Set(userIds)] } },
    select: { userId: true, fullName: true },
  });
  return new Map(members.map((member) => [member.userId, member.fullName]));
}

export function toTriageView(
  row: VisitRow['triages'][number],
  names: Map<string, string>,
): TriageView {
  return {
    id: row.id,
    category: row.category,
    vitals: JSON.parse(decryptField(row.vitalsEnc)) as VitalSigns,
    symptoms: decryptNullable(row.symptomsEnc),
    observations: decryptNullable(row.observationsEnc),
    recordedBy: names.get(row.recordedByUserId) ?? 'Former staff member',
    recordedAt: row.recordedAt.toISOString(),
  };
}

function toVisitView(row: VisitRow, names: Map<string, string>): VisitView {
  const triages = row.triages.map((triage) => toTriageView(triage, names));
  return {
    publicId: row.publicId,
    status: row.status,
    presentingComplaint: decryptField(row.presentingComplaintEnc),
    arrivedAt: row.arrivedAt.toISOString(),
    escalatedAt: row.escalatedAt?.toISOString() ?? null,
    escalationNote: decryptNullable(row.escalationNoteEnc),
    closedAt: row.closedAt?.toISOString() ?? null,
    closingNote: decryptNullable(row.closingNoteEnc),
    triage: triages[0] ?? null,
    triageHistory: triages,
    consultation: row.consultations[0] ? toConsultationView(row.consultations[0]) : null,
    encounter: row.consultations[0]
      ? toEncounterSummary(
          row.consultations[0].encounter,
          row.consultations[0].doctor?.fullName ?? null,
        )
      : null,
    referrals: row.referrals.map((referral) => toReferralView(referral, names)),
  };
}

const dateOnly = (date: Date) => date.toISOString().slice(0, 10);

function parseJson<T>(value: string | null): T | null {
  const plain = decryptNullable(value);
  return plain === null ? null : (JSON.parse(plain) as T);
}

// ---------------------------------------------------------------------------
// Search and registration
// ---------------------------------------------------------------------------

export async function searchPatients(
  ctx: StaffContext,
  query: { name?: string; phone?: string; nhisNumber?: string; patientNumber?: string },
  db: Db = getPrisma(),
): Promise<PatientSummary[]> {
  const where: Prisma.PatientWhereInput = { facilityId: ctx.facilityId };

  if (query.patientNumber) {
    where.patientNumber = normalisePatientNumber(query.patientNumber);
  }
  if (query.phone) {
    const phone = ghanaPhoneSchema.safeParse(query.phone);
    if (!phone.success) return [];
    where.phoneHash = phoneHash(phone.data);
  }
  if (query.nhisNumber) {
    where.nhisNumberHash = nhisHash(query.nhisNumber.replace(/[\s-]/g, ''));
  }
  if (query.name) {
    const words = nameWords(query.name);
    if (words.length === 0) return [];
    // Every word searched for must be one of the patient's words.
    where.nameTokens = { hasEvery: words.map(nameToken) };
  }

  const rows = await db.patient.findMany({
    where,
    take: 20,
    orderBy: { createdAt: 'desc' },
    include: {
      visits: {
        orderBy: { arrivedAt: 'desc' },
        take: 1,
        select: { arrivedAt: true, status: true },
      },
    },
  });

  const openVisits = new Set(
    (
      await db.patientVisit.findMany({
        where: { patientId: { in: rows.map((row) => row.id) }, status: { in: OPEN } },
        select: { patientId: true },
      })
    ).map((visit) => visit.patientId),
  );

  return rows.map((row) => ({
    publicId: row.publicId,
    patientNumber: row.patientNumber,
    fullName: decryptField(row.fullNameEnc),
    sex: row.sex,
    dateOfBirth: dateOnly(row.dateOfBirth),
    dobIsEstimated: row.dobIsEstimated,
    community: row.community,
    hasOpenVisit: openVisits.has(row.id),
    lastVisitAt: row.visits[0]?.arrivedAt.toISOString() ?? null,
  }));
}

/**
 * Registers a walk-in and opens their first visit, together.
 *
 * A registration resubmitted with the same `clientRequestId` — a CHO pressing
 * the button again on a connection that dropped the reply — returns the
 * patient already made instead of a second one.
 */
export async function registerPatient(
  ctx: StaffContext,
  input: PatientRegistration,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ patientNumber: string; visitPublicId: string }> {
  if (input.clientRequestId) {
    const existing = await db.patient.findUnique({
      where: { clientRequestId: input.clientRequestId },
      include: { visits: { orderBy: { arrivedAt: 'asc' }, take: 1 } },
    });
    if (existing && existing.facilityId === ctx.facilityId && existing.visits[0]) {
      return { patientNumber: existing.patientNumber, visitPublicId: existing.visits[0].publicId };
    }
  }

  const now = clock.now();
  const dateOfBirth = input.dateOfBirth
    ? new Date(`${input.dateOfBirth}T00:00:00Z`)
    : birthDateFromAge(input.ageYears ?? 0, input.ageMonths ?? 0, now);
  if (dateOfBirth > now) {
    throw errors.validation(
      [{ field: 'dateOfBirth', issue: 'A date of birth cannot be in the future.' }],
      'A date of birth cannot be in the future.',
    );
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await db.$transaction(async (tx) => {
        const patient = await tx.patient.create({
          data: {
            publicId: generatePublicId('pat'),
            patientNumber: generatePatientNumber(),
            facilityId: ctx.facilityId,
            fullNameEnc: encryptField(input.fullName),
            nameTokens: nameWords(input.fullName).map(nameToken),
            sex: input.sex,
            dateOfBirth,
            dobIsEstimated: !input.dateOfBirth,
            phoneEnc: encryptNullable(input.phone),
            phoneHash: input.phone ? phoneHash(input.phone) : null,
            community: input.community,
            nhisStatus: input.nhisStatus,
            nhisNumberEnc: encryptNullable(input.nhisNumber),
            nhisNumberHash: input.nhisNumber ? nhisHash(input.nhisNumber) : null,
            emergencyContactEnc: input.emergencyContact
              ? encryptField(JSON.stringify(input.emergencyContact))
              : null,
            representativeEnc: input.representative
              ? encryptField(JSON.stringify(input.representative))
              : null,
            allergiesEnc: encryptNullable(input.allergies),
            medicationsEnc: encryptNullable(input.medications),
            medicalHistoryEnc: encryptNullable(input.medicalHistory),
            consentGivenBy: input.consentGivenBy,
            consentVersion: CHPS_CONSENT_VERSION,
            consentAt: now,
            consentRecordedByUserId: ctx.userId,
            registeredByUserId: ctx.userId,
            clientRequestId: input.clientRequestId ?? null,
          },
        });
        const visit = await tx.patientVisit.create({
          data: {
            publicId: generatePublicId('vis'),
            patientId: patient.id,
            facilityId: ctx.facilityId,
            presentingComplaintEnc: encryptField(input.presentingComplaint),
            arrivedAt: now,
            createdByUserId: ctx.userId,
          },
        });
        return { patient, visit };
      });

      await audit(
        ctx,
        AUDIT_ACTIONS.PATIENT_REGISTERED,
        'patient',
        result.patient.id,
        { consentGivenBy: input.consentGivenBy, consentVersion: CHPS_CONSENT_VERSION },
        db,
      );

      return { patientNumber: result.patient.patientNumber, visitPublicId: result.visit.publicId };
    } catch (error) {
      // A patient-number collision is one in a trillion; try another.
      if (isUniqueConstraintError(error, 'patientNumber')) continue;
      // The same submission arrived twice at once; the other one won.
      if (input.clientRequestId && isUniqueConstraintError(error, 'clientRequestId')) {
        const winner = await db.patient.findUnique({
          where: { clientRequestId: input.clientRequestId },
          include: { visits: { orderBy: { arrivedAt: 'asc' }, take: 1 } },
        });
        if (winner?.facilityId === ctx.facilityId && winner.visits[0]) {
          return { patientNumber: winner.patientNumber, visitPublicId: winner.visits[0].publicId };
        }
        throw errors.conflict('This registration was already submitted.');
      }
      throw error;
    }
  }
  throw errors.internal('Could not allocate a patient number.');
}

async function findPatient(ctx: StaffContext, patientNumber: string, db: Db) {
  const patient = await db.patient.findUnique({
    where: { patientNumber: normalisePatientNumber(patientNumber) },
  });
  if (!patient || patient.facilityId !== ctx.facilityId) {
    throw errors.notFound('Patient not found.');
  }
  return patient;
}

/** The full record. Every call is written to the access log (D74). */
export async function getPatientRecord(
  ctx: StaffContext,
  patientNumber: string,
  db: Db = getPrisma(),
): Promise<PatientRecord> {
  const patient = await findPatient(ctx, patientNumber, db);
  const visits = await db.patientVisit.findMany({
    where: { patientId: patient.id },
    orderBy: { arrivedAt: 'desc' },
    include: visitInclude,
  });

  await db.patientRecordAccess.create({
    data: {
      patientId: patient.id,
      actorUserId: ctx.userId,
      actorRole: 'FACILITY',
      facilityId: ctx.facilityId,
      purpose: 'care',
    },
  });

  const names = await staffNames(
    visits.flatMap((visit) => [
      ...visit.triages.map((triage) => triage.recordedByUserId),
      ...referralActorIds(visit.referrals),
    ]),
    db,
  );
  const visitViews = visits.map((visit) => toVisitView(visit, names));

  return {
    publicId: patient.publicId,
    patientNumber: patient.patientNumber,
    fullName: decryptField(patient.fullNameEnc),
    sex: patient.sex,
    dateOfBirth: dateOnly(patient.dateOfBirth),
    dobIsEstimated: patient.dobIsEstimated,
    community: patient.community,
    hasOpenVisit: visits.some((visit) => OPEN.includes(visit.status)),
    lastVisitAt: visits[0]?.arrivedAt.toISOString() ?? null,
    phone: decryptNullable(patient.phoneEnc),
    nhisStatus: patient.nhisStatus,
    nhisNumber: decryptNullable(patient.nhisNumberEnc),
    emergencyContact: parseJson(patient.emergencyContactEnc),
    representative: parseJson(patient.representativeEnc),
    allergies: decryptNullable(patient.allergiesEnc),
    medications: decryptNullable(patient.medicationsEnc),
    medicalHistory: decryptNullable(patient.medicalHistoryEnc),
    consent: {
      givenBy: patient.consentGivenBy,
      version: patient.consentVersion,
      at: patient.consentAt.toISOString(),
    },
    registeredAt: patient.createdAt.toISOString(),
    visits: visitViews,
  };
}

export async function updatePatient(
  ctx: StaffContext,
  patientNumber: string,
  input: PatientUpdate,
  db: Db = getPrisma(),
): Promise<PatientRecord> {
  const patient = await findPatient(ctx, patientNumber, db);
  const nhisStatus = input.nhisStatus ?? patient.nhisStatus;
  const keepsNumber =
    input.nhisNumber !== undefined ? Boolean(input.nhisNumber) : patient.nhisNumberEnc !== null;
  if (nhisStatus === 'NOT_MEMBER' && keepsNumber) {
    throw errors.validation(
      [{ field: 'nhisNumber', issue: 'A non-member has no NHIS number.' }],
      'A non-member has no NHIS number.',
    );
  }

  const data: Prisma.PatientUpdateInput = {};
  if (input.phone !== undefined) {
    data.phoneEnc = encryptNullable(input.phone);
    data.phoneHash = input.phone ? phoneHash(input.phone) : null;
  }
  if (input.community !== undefined) data.community = input.community;
  if (input.nhisStatus !== undefined) data.nhisStatus = input.nhisStatus;
  if (input.nhisNumber !== undefined) {
    data.nhisNumberEnc = encryptNullable(input.nhisNumber);
    data.nhisNumberHash = input.nhisNumber ? nhisHash(input.nhisNumber) : null;
  }
  if (input.emergencyContact !== undefined) {
    data.emergencyContactEnc = input.emergencyContact
      ? encryptField(JSON.stringify(input.emergencyContact))
      : null;
  }
  if (input.allergies !== undefined) data.allergiesEnc = encryptNullable(input.allergies);
  if (input.medications !== undefined) data.medicationsEnc = encryptNullable(input.medications);
  if (input.medicalHistory !== undefined) {
    data.medicalHistoryEnc = encryptNullable(input.medicalHistory);
  }

  await db.patient.update({ where: { id: patient.id }, data });
  await audit(
    ctx,
    AUDIT_ACTIONS.PATIENT_UPDATED,
    'patient',
    patient.id,
    {
      fields: Object.keys(input),
    },
    db,
  );

  return getPatientRecord(ctx, patient.patientNumber, db);
}

// ---------------------------------------------------------------------------
// Visits
// ---------------------------------------------------------------------------

/** A returning patient's new visit. One open visit per patient at a time. */
export async function openVisit(
  ctx: StaffContext,
  patientNumber: string,
  input: { presentingComplaint: string; clientRequestId?: string },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ visitPublicId: string }> {
  const patient = await findPatient(ctx, patientNumber, db);

  if (input.clientRequestId) {
    const existing = await db.patientVisit.findUnique({
      where: { clientRequestId: input.clientRequestId },
    });
    if (existing && existing.patientId === patient.id) return { visitPublicId: existing.publicId };
  }

  const open = await db.patientVisit.findFirst({
    where: { patientId: patient.id, status: { in: OPEN } },
  });
  if (open) {
    throw errors.conflict('This patient already has a visit in progress. Continue that one.', {
      visit: open.publicId,
    });
  }

  const visit = await db.patientVisit.create({
    data: {
      publicId: generatePublicId('vis'),
      patientId: patient.id,
      facilityId: ctx.facilityId,
      presentingComplaintEnc: encryptField(input.presentingComplaint),
      arrivedAt: clock.now(),
      createdByUserId: ctx.userId,
      clientRequestId: input.clientRequestId ?? null,
    },
  });
  await audit(ctx, AUDIT_ACTIONS.VISIT_OPENED, 'patient_visit', visit.id, {}, db);
  return { visitPublicId: visit.publicId };
}

async function findOpenVisit(ctx: StaffContext, publicId: string, db: Db) {
  const visit = await db.patientVisit.findUnique({ where: { publicId } });
  if (!visit || visit.facilityId !== ctx.facilityId) throw errors.notFound('Visit not found.');
  if (!OPEN.includes(visit.status)) {
    throw errors.businessRule('This visit has ended. Open a new visit for the patient.');
  }
  return visit;
}

/**
 * Records a triage assessment. Red sends the visit to the emergency path at
 * once (D74): it never becomes an ordinary waiting patient.
 */
export async function recordTriage(
  ctx: StaffContext,
  visitPublicId: string,
  input: TriageCreate,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ status: VisitStatus; category: TriageCategory }> {
  const visit = await findOpenVisit(ctx, visitPublicId, db);
  const now = clock.now();

  const status: VisitStatus =
    input.category === 'RED' || visit.status === 'ESCALATED' ? 'ESCALATED' : 'TRIAGED';

  await db.triageRecord.create({
    data: {
      visitId: visit.id,
      category: input.category,
      vitalsEnc: encryptField(JSON.stringify(input.vitals ?? {})),
      symptomsEnc: encryptNullable(input.symptoms),
      observationsEnc: encryptNullable(input.observations),
      recordedByUserId: ctx.userId,
      recordedAt: now,
    },
  });
  await db.patientVisit.update({
    where: { id: visit.id },
    data: { status, escalatedAt: status === 'ESCALATED' ? (visit.escalatedAt ?? now) : null },
  });
  if (status === 'ESCALATED') {
    await withdrawWaitingRequest(ctx, visit.id, db as PrismaClient, clock);
  }

  await audit(
    ctx,
    AUDIT_ACTIONS.TRIAGE_RECORDED,
    'patient_visit',
    visit.id,
    {
      category: input.category,
      status,
    },
    db,
  );

  return { status, category: input.category };
}

/** The emergency path, from any open visit, triaged or not. */
export async function escalateVisit(
  ctx: StaffContext,
  visitPublicId: string,
  note: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ status: VisitStatus }> {
  const visit = await findOpenVisit(ctx, visitPublicId, db);
  await db.patientVisit.update({
    where: { id: visit.id },
    data: {
      status: 'ESCALATED',
      escalatedAt: visit.escalatedAt ?? clock.now(),
      escalationNoteEnc: encryptField(note),
    },
  });
  // An emergency does not wait in the queue (D74, D76).
  await withdrawWaitingRequest(ctx, visit.id, db as PrismaClient, clock);
  await audit(ctx, AUDIT_ACTIONS.VISIT_ESCALATED, 'patient_visit', visit.id, {}, db);
  return { status: 'ESCALATED' };
}

/** Ends a visit at the facility: completed there, or cancelled. */
export async function closeVisit(
  ctx: StaffContext,
  visitPublicId: string,
  input: { outcome: 'CLOSED' | 'CANCELLED' | 'REFERRED'; note: string },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ status: VisitStatus }> {
  const visit = await findOpenVisit(ctx, visitPublicId, db);
  if (await activeConsultationFor(visit.id, db)) {
    throw errors.businessRule(
      'A doctor request for this visit is still open. Withdraw it, or wait for the doctor to finish, before ending the visit.',
    );
  }
  if (input.outcome === 'REFERRED' && !(await visitHasReferral(visit.id, db))) {
    throw errors.businessRule('Record the referral before ending the visit as referred.');
  }
  await db.patientVisit.update({
    where: { id: visit.id },
    data: {
      status: input.outcome,
      closedAt: clock.now(),
      closedByUserId: ctx.userId,
      closingNoteEnc: encryptField(input.note),
    },
  });
  await audit(
    ctx,
    AUDIT_ACTIONS.VISIT_CLOSED,
    'patient_visit',
    visit.id,
    {
      outcome: input.outcome,
    },
    db,
  );
  return { status: input.outcome };
}

// ---------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------

/**
 * Today at this facility: counts, and the board of visits still open plus
 * those that arrived today. "Today" is the UTC day, which in Ghana is the
 * local day.
 */
export async function facilityDay(
  ctx: StaffContext,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<FacilityDaySummary> {
  const dayStart = startOfDay(clock.now());

  const visits = await db.patientVisit.findMany({
    where: {
      facilityId: ctx.facilityId,
      OR: [{ arrivedAt: { gte: dayStart } }, { status: { in: OPEN } }],
    },
    orderBy: { arrivedAt: 'asc' },
    include: {
      patient: {
        select: { patientNumber: true, fullNameEnc: true, sex: true, dateOfBirth: true },
      },
      triages: { orderBy: { recordedAt: 'desc' }, take: 1, select: { category: true } },
      consultations: consultationInclude,
    },
  });

  const today = visits.filter((visit) => visit.arrivedAt >= dayStart);

  return {
    date: dateOnly(dayStart),
    seenToday: today.length,
    waiting: visits.filter((visit) => ['AWAITING_TRIAGE', 'TRIAGED'].includes(visit.status)).length,
    escalatedToday: visits.filter(
      (visit) => visit.escalatedAt !== null && visit.escalatedAt >= dayStart,
    ).length,
    closedToday: visits.filter(
      (visit) => visit.status === 'CLOSED' && visit.closedAt !== null && visit.closedAt >= dayStart,
    ).length,
    awaitingDoctor: visits.filter((visit) =>
      ['WAITING_FOR_DOCTOR', 'ASSIGNED', 'REASSIGNING'].includes(
        visit.consultations[0]?.state ?? '',
      ),
    ).length,
    withDoctor: visits.filter((visit) =>
      ['DOCTOR_ACCEPTED', 'IN_PROGRESS', 'INTERRUPTED', 'COMPLETING'].includes(
        visit.consultations[0]?.state ?? '',
      ),
    ).length,
    board: visits.map((visit) => ({
      publicId: visit.publicId,
      status: visit.status,
      arrivedAt: visit.arrivedAt.toISOString(),
      presentingComplaint: decryptField(visit.presentingComplaintEnc),
      triageCategory: visit.triages[0]?.category ?? null,
      consultation: visit.consultations[0] ? toConsultationView(visit.consultations[0]) : null,
      patient: {
        patientNumber: visit.patient.patientNumber,
        fullName: decryptField(visit.patient.fullNameEnc),
        sex: visit.patient.sex,
        dateOfBirth: dateOnly(visit.patient.dateOfBirth),
      },
    })),
  };
}
