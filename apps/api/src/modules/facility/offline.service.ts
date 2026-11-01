import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type {
  OfflineKey,
  OfflineWalkIn,
  OfflineWalkInResult,
  PatientSummary,
} from '@neem/contracts';
import { getPrisma } from '../../db/prisma.ts';
import { decryptField, encryptField } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import {
  nameToken,
  nameWords,
  nhisHash,
  openVisit,
  phoneHash,
  recordTriage,
  registerPatient,
  searchPatients,
  type StaffContext,
} from './patient.service.ts';

/**
 * Walk-ins recorded offline (CHPS slice 4a, D88).
 *
 * The browser queues each walk-in encrypted with the CHO's own key and sends
 * it here when the connection returns. Arrival is where the checks the device
 * could not make happen: the duplicate search, and the clock.
 */

/** At most this many possible matches are shown for one walk-in. */
const MAX_CANDIDATES = 10;

/**
 * The CHO's offline key, made on first request. It never leaves the API
 * except to its owner, and the browser keeps it in memory only.
 */
export async function offlineKey(
  ctx: StaffContext,
  db: PrismaClient = getPrisma(),
): Promise<OfflineKey> {
  const member = await db.facilityUser.findUniqueOrThrow({
    where: { userId: ctx.userId },
    select: { offlineKeyEnc: true },
  });
  if (member.offlineKeyEnc) return { key: decryptField(member.offlineKeyEnc) };

  // Two first requests at once must agree on one key: only the first write lands.
  await db.facilityUser.updateMany({
    where: { userId: ctx.userId, offlineKeyEnc: null },
    data: { offlineKeyEnc: encryptField(randomBytes(32).toString('base64')) },
  });
  const stored = await db.facilityUser.findUniqueOrThrow({
    where: { userId: ctx.userId },
    select: { offlineKeyEnc: true },
  });
  return { key: decryptField(stored.offlineKeyEnc!) };
}

/**
 * The device's times moved onto the server's clock. A tablet whose clock is
 * an hour out records arrivals an hour out; the gap between its clock and
 * ours when it sends is the same gap, so it is taken off. Nothing is placed
 * in the future.
 */
function correctedTimes(input: OfflineWalkIn, now: Date) {
  const offset = now.getTime() - new Date(input.sentAt).getTime();
  const onServer = (iso: string) =>
    new Date(Math.min(new Date(iso).getTime() + offset, now.getTime()));
  const arrivedAt = onServer(input.capturedAt);
  const triagedAt = input.triage
    ? new Date(Math.max(onServer(input.triage.triagedAt).getTime(), arrivedAt.getTime()))
    : null;
  return { arrivedAt, triagedAt };
}

const at = (date: Date): Clock => ({ now: () => new Date(date) });

/**
 * Patients on file who may be this walk-in: the same phone or NHIS number, or
 * a name whose words all appear in the other ("Ama Serwaa" and "Ama Serwaa
 * Mensah"). Shown to the CHO, never merged by itself.
 */
async function possibleDuplicates(
  ctx: StaffContext,
  registration: OfflineWalkIn['registration'],
  db: PrismaClient,
): Promise<PatientSummary[]> {
  const words = nameWords(registration.fullName);
  const tokens = new Set(words.map(nameToken));
  const or = [
    ...(tokens.size ? [{ nameTokens: { hasSome: [...tokens] } }] : []),
    ...(registration.phone ? [{ phoneHash: phoneHash(registration.phone) }] : []),
    ...(registration.nhisNumber ? [{ nhisNumberHash: nhisHash(registration.nhisNumber) }] : []),
  ];
  if (or.length === 0) return [];

  const rows = await db.patient.findMany({
    where: { facilityId: ctx.facilityId, OR: or },
    select: { patientNumber: true, nameTokens: true, phoneHash: true, nhisNumberHash: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const matches = rows.filter((row) => {
    if (registration.phone && row.phoneHash === phoneHash(registration.phone)) return true;
    if (registration.nhisNumber && row.nhisNumberHash === nhisHash(registration.nhisNumber)) {
      return true;
    }
    const theirs = new Set(row.nameTokens);
    const oursInTheirs = [...tokens].every((token) => theirs.has(token));
    const theirsInOurs = row.nameTokens.every((token) => tokens.has(token));
    return tokens.size > 0 && (oursInTheirs || theirsInOurs);
  });

  const summaries: PatientSummary[] = [];
  for (const match of matches.slice(0, MAX_CANDIDATES)) {
    summaries.push(...(await searchPatients(ctx, { patientNumber: match.patientNumber }, db)));
  }
  return summaries;
}

/**
 * The visit this walk-in already became, if it arrived before: from this
 * queue, or from the ordinary registration form whose reply never came back,
 * which carries the same request id on the patient.
 */
async function alreadySaved(ctx: StaffContext, clientRequestId: string, db: PrismaClient) {
  const visit = await db.patientVisit.findUnique({
    where: { clientRequestId },
    include: { patient: true, triages: { select: { id: true }, take: 1 } },
  });
  if (visit && visit.facilityId === ctx.facilityId) {
    return {
      visit,
      patient: visit.patient,
      matchedExisting: visit.patient.clientRequestId !== clientRequestId,
    };
  }
  const patient = await db.patient.findUnique({
    where: { clientRequestId },
    include: {
      visits: {
        orderBy: { arrivedAt: 'asc' },
        take: 1,
        include: { triages: { select: { id: true }, take: 1 } },
      },
    },
  });
  if (patient && patient.facilityId === ctx.facilityId && patient.visits[0]) {
    return { visit: patient.visits[0], patient, matchedExisting: false };
  }
  return null;
}

/**
 * Saves one walk-in recorded offline: a new patient or a new visit on one on
 * file, with its triage. Sending the same walk-in again returns what the first
 * one made, and finishes its triage if that was all that failed.
 */
export async function syncWalkIn(
  ctx: StaffContext,
  input: OfflineWalkIn,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<OfflineWalkInResult> {
  const now = clock.now();
  const { arrivedAt, triagedAt } = correctedTimes(input, now);

  let saved = await alreadySaved(ctx, input.clientRequestId, db);

  if (!saved) {
    if (!input.decision) {
      const candidates = await possibleDuplicates(ctx, input.registration, db);
      if (candidates.length > 0) return { outcome: 'POSSIBLE_DUPLICATE', candidates };
    }

    if (input.decision?.kind === 'EXISTING') {
      await openVisit(
        ctx,
        input.decision.patientNumber,
        {
          presentingComplaint: input.registration.presentingComplaint,
          clientRequestId: input.clientRequestId,
        },
        db,
        at(arrivedAt),
      );
    } else {
      const { visitPublicId } = await registerPatient(
        ctx,
        { ...input.registration, clientRequestId: input.clientRequestId },
        db,
        at(arrivedAt),
      );
      // The visit carries the same request id, so a resend finds it whichever path made it.
      await db.patientVisit.update({
        where: { publicId: visitPublicId },
        data: { clientRequestId: input.clientRequestId },
      });
    }
    await db.patientVisit.update({
      where: { clientRequestId: input.clientRequestId },
      data: { syncedAt: now },
    });
    saved = (await alreadySaved(ctx, input.clientRequestId, db))!;

    await recordAudit(
      {
        action: AUDIT_ACTIONS.OFFLINE_WALK_IN_SYNCED,
        actorType: 'FACILITY',
        actorId: ctx.userId,
        entityType: 'patient_visit',
        entityId: saved.visit.id,
        correlationId: ctx.correlationId,
        metadata: {
          capturedAt: input.capturedAt,
          arrivedAt: arrivedAt.toISOString(),
          matchedExisting: saved.matchedExisting,
        },
      },
      db,
    );
  }

  if (input.triage && triagedAt && saved.visit.triages.length === 0) {
    const { triagedAt: _device, ...triage } = input.triage;
    await recordTriage(ctx, saved.visit.publicId, triage, db, at(triagedAt));
  }

  return {
    outcome: 'SAVED',
    patientNumber: saved.patient.patientNumber,
    visitPublicId: saved.visit.publicId,
    matchedExisting: saved.matchedExisting,
  };
}
