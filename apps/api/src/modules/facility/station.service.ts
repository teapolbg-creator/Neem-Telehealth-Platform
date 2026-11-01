import { randomInt } from 'node:crypto';
import type { ConsultationState, PrismaClient } from '@prisma/client';
import { addMinutes } from 'date-fns';
import {
  STATION_PAIRING_MINUTES,
  type ConnectionReport,
  type StationPairing,
  type StationState,
  type StationSummary,
} from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import {
  decryptField,
  generatePublicId,
  generateToken,
  hashIp,
  hashToken,
} from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { acceptsCallJoin, isTerminal } from '../../domain/consultation-state.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import {
  joinMediaSession,
  leaveMediaSession,
  type MediaSessionView,
} from '../media/media.service.ts';
import { activeConsultationFor } from './chps-consultation.service.ts';
import type { StaffContext } from './patient.service.ts';

/**
 * Consultation stations (CHPS slice 1d, D77).
 *
 * A CHO adds a station and gets a short pairing code; the station's screen
 * takes the code and receives a long-lived credential of its own, held in an
 * httpOnly cookie. With it the station can read its state, join the call it
 * has been given and leave it. That is all: no route a station can reach
 * returns a patient record.
 *
 * The CHO decides what a station shows by sending a consultation to it.
 * When that consultation ends, the station forgets it on its next poll, so
 * the next patient walks up to a welcome screen.
 */

export const STATION_COOKIE = 'neem_station';
/** A station is a fixture; re-pairing it every few days would be a burden. */
export const STATION_CREDENTIAL_DAYS = 180;
/** A station polling every few seconds counts as online for this long after. */
export const STATION_ONLINE_WINDOW_MS = 60_000;
/** lastSeenAt is written at most this often, so polling does not write every time. */
const SEEN_WRITE_INTERVAL_MS = 20_000;

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generatePairingCode(): string {
  return Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

/** Forgives the misreadings of O, I and L, as card numbers do (D75). */
function normalisePairingCode(code: string): string {
  return code.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}

const pairingHash = (code: string) => hashToken(`station-pairing:${normalisePairingCode(code)}`);

// ---------------------------------------------------------------------------
// The CHO's side
// ---------------------------------------------------------------------------

const stationInclude = {
  consultation: {
    select: {
      state: true,
      visit: { select: { publicId: true } },
      patientSession: { select: { fullNameEnc: true } },
    },
  },
} as const;

type StationRow = Awaited<ReturnType<typeof findStations>>[number];

function findStations(facilityId: string, db: Db) {
  return db.facilityStation.findMany({
    where: { facilityId },
    orderBy: { createdAt: 'asc' },
    include: stationInclude,
  });
}

function toSummary(row: StationRow, now: Date): StationSummary {
  const consultation = row.consultation;
  return {
    publicId: row.publicId,
    label: row.label,
    status: row.revokedAt ? 'REVOKED' : row.tokenHash ? 'PAIRED' : 'AWAITING_PAIRING',
    online: Boolean(
      row.tokenHash &&
      row.lastSeenAt &&
      now.getTime() - row.lastSeenAt.getTime() < STATION_ONLINE_WINDOW_MS,
    ),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    pairedAt: row.pairedAt?.toISOString() ?? null,
    current:
      consultation && !isTerminal(consultation.state) && consultation.visit
        ? {
            visitPublicId: consultation.visit.publicId,
            patientName: consultation.patientSession?.fullNameEnc
              ? decryptField(consultation.patientSession.fullNameEnc)
              : 'Patient',
            consultationState: consultation.state,
          }
        : null,
    link:
      row.linkMeasuredAt &&
      row.linkDownKbps !== null &&
      row.linkUpKbps !== null &&
      row.linkRttMs !== null
        ? {
            downKbps: row.linkDownKbps,
            upKbps: row.linkUpKbps,
            rttMs: row.linkRttMs,
            measuredAt: row.linkMeasuredAt.toISOString(),
          }
        : null,
  };
}

export async function listStations(
  ctx: StaffContext,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<StationSummary[]> {
  const now = clock.now();
  return (await findStations(ctx.facilityId, db)).map((row) => toSummary(row, now));
}

async function findOwnStation(ctx: StaffContext, publicId: string, db: Db) {
  const station = await db.facilityStation.findUnique({
    where: { publicId },
    include: stationInclude,
  });
  if (!station || station.facilityId !== ctx.facilityId) {
    throw errors.notFound('Station not found.');
  }
  return station;
}

/** Issues a fresh pairing code. Any credential the station held stops working. */
async function issuePairingCode(stationId: string, db: Db, clock: Clock) {
  const code = generatePairingCode();
  const pairingExpiresAt = addMinutes(clock.now(), STATION_PAIRING_MINUTES);
  await db.facilityStation.update({
    where: { id: stationId },
    data: {
      pairingCodeHash: pairingHash(code),
      pairingExpiresAt,
      tokenHash: null,
      pairedAt: null,
      revokedAt: null,
    },
  });
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, pairingExpiresAt };
}

export async function createStation(
  ctx: StaffContext,
  label: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<StationPairing> {
  const station = await db.facilityStation.create({
    data: {
      publicId: generatePublicId('stn'),
      facilityId: ctx.facilityId,
      label,
      createdByUserId: ctx.userId,
    },
  });
  const pairing = await issuePairingCode(station.id, db, clock);
  await audit(ctx, AUDIT_ACTIONS.STATION_CREATED, station.id, { label }, db);

  return {
    station: toSummary(await findOwnStation(ctx, station.publicId, db), clock.now()),
    pairingCode: pairing.code,
    pairingExpiresAt: pairing.pairingExpiresAt.toISOString(),
  };
}

/** Re-pairing: for a replaced device, a cleared browser, or a lost code. */
export async function repairStation(
  ctx: StaffContext,
  publicId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<StationPairing> {
  const station = await findOwnStation(ctx, publicId, db);
  const pairing = await issuePairingCode(station.id, db, clock);
  await audit(ctx, AUDIT_ACTIONS.STATION_PAIRING_ISSUED, station.id, {}, db);

  return {
    station: toSummary(await findOwnStation(ctx, publicId, db), clock.now()),
    pairingCode: pairing.code,
    pairingExpiresAt: pairing.pairingExpiresAt.toISOString(),
  };
}

/** A lost or stolen device: its credential stops working at once. */
export async function revokeStation(
  ctx: StaffContext,
  publicId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<StationSummary> {
  const station = await findOwnStation(ctx, publicId, db);
  await db.facilityStation.update({
    where: { id: station.id },
    data: {
      tokenHash: null,
      pairingCodeHash: null,
      pairingExpiresAt: null,
      revokedAt: clock.now(),
      consultationId: null,
      assignedAt: null,
      assignedByUserId: null,
    },
  });
  await audit(ctx, AUDIT_ACTIONS.STATION_REVOKED, station.id, {}, db);
  return toSummary(await findOwnStation(ctx, publicId, db), clock.now());
}

/**
 * Sends a visit's open consultation to a station. A station shows one
 * consultation at a time; one already showing a live consultation must be
 * cleared first, so a patient mid-call is never swapped out by a misclick.
 */
export async function sendToStation(
  ctx: StaffContext,
  visitPublicId: string,
  stationPublicId: string,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<StationSummary> {
  const visit = await db.patientVisit.findUnique({ where: { publicId: visitPublicId } });
  if (!visit || visit.facilityId !== ctx.facilityId) throw errors.notFound('Visit not found.');

  const consultation = await activeConsultationFor(visit.id, db);
  if (!consultation) {
    throw errors.businessRule(
      'Request a doctor for this patient before sending them to a station.',
    );
  }

  const station = await findOwnStation(ctx, stationPublicId, db);
  if (!station.tokenHash) {
    throw errors.businessRule(
      'That station is not paired. Pair it before sending a patient to it.',
    );
  }
  if (
    station.consultation &&
    station.consultationId !== consultation.id &&
    !isTerminal(station.consultation.state)
  ) {
    throw errors.conflict(
      'That station is showing another patient’s consultation. Clear it first.',
    );
  }

  await db.$transaction(async (tx) => {
    // One station per consultation: taking it from any other station.
    await tx.facilityStation.updateMany({
      where: { consultationId: consultation.id, NOT: { id: station.id } },
      data: { consultationId: null, assignedAt: null, assignedByUserId: null },
    });
    await tx.facilityStation.update({
      where: { id: station.id },
      data: {
        consultationId: consultation.id,
        assignedAt: clock.now(),
        assignedByUserId: ctx.userId,
      },
    });
  });
  await audit(
    ctx,
    AUDIT_ACTIONS.STATION_ASSIGNED,
    station.id,
    {
      consultation: consultation.publicId,
    },
    db,
  );

  return toSummary(await findOwnStation(ctx, stationPublicId, db), clock.now());
}

/** Takes whatever the station is showing off it, back to the welcome screen. */
export async function clearStation(
  ctx: StaffContext,
  publicId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<StationSummary> {
  const station = await findOwnStation(ctx, publicId, db);
  await db.facilityStation.update({
    where: { id: station.id },
    data: { consultationId: null, assignedAt: null, assignedByUserId: null },
  });
  await audit(ctx, AUDIT_ACTIONS.STATION_CLEARED, station.id, {}, db);
  return toSummary(await findOwnStation(ctx, publicId, db), clock.now());
}

async function audit(
  ctx: StaffContext,
  action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
  stationId: string,
  metadata: Record<string, unknown>,
  db: Db,
) {
  await recordAudit(
    {
      action,
      actorType: 'FACILITY',
      actorId: ctx.userId,
      entityType: 'facility_station',
      entityId: stationId,
      correlationId: ctx.correlationId,
      metadata,
    },
    db,
  );
}

// ---------------------------------------------------------------------------
// The station's side
// ---------------------------------------------------------------------------

export interface StationPrincipal {
  stationId: string;
  facilityId: string;
}

/**
 * Exchanges a pairing code for the station's credential. The code is spent
 * either way, so a code seen over a shoulder cannot be used a second time.
 */
export async function pairStation(
  code: string,
  context: { correlationId?: string; ip?: string },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ token: string; expiresAt: Date }> {
  const now = clock.now();
  const station = await db.facilityStation.findUnique({
    where: { pairingCodeHash: pairingHash(code) },
    include: { facility: { select: { status: true } } },
  });
  if (!station || !station.pairingExpiresAt || station.pairingExpiresAt <= now) {
    // Counted on the monitoring page (D87): a run of these is someone guessing.
    await recordAudit(
      {
        action: AUDIT_ACTIONS.STATION_PAIRING_REFUSED,
        actorType: 'SYSTEM',
        outcome: 'FAILURE',
        ipHash: hashIp(context.ip),
        entityType: station ? 'facility_station' : undefined,
        entityId: station?.id,
        correlationId: context.correlationId,
        metadata: { reason: station ? 'expired_code' : 'unknown_code' },
      },
      db,
    );
    throw errors.unauthenticated(
      'That pairing code is not valid. Ask the facility staff for a new one.',
    );
  }
  if (station.facility.status !== 'ACTIVE') {
    throw errors.businessRule('This facility is not active on Neem yet.');
  }

  const token = generateToken();
  await db.facilityStation.update({
    where: { id: station.id },
    data: {
      tokenHash: hashToken(token),
      pairingCodeHash: null,
      pairingExpiresAt: null,
      pairedAt: now,
      lastSeenAt: now,
      revokedAt: null,
    },
  });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.STATION_PAIRED,
      actorType: 'FACILITY',
      entityType: 'facility_station',
      entityId: station.id,
      correlationId: context.correlationId,
    },
    db,
  );

  const expiresAt = new Date(now.getTime() + STATION_CREDENTIAL_DAYS * 86_400_000);
  return { token, expiresAt };
}

export async function resolveStation(
  token: string | undefined,
  db: Db = getPrisma(),
): Promise<StationPrincipal | null> {
  if (!token) return null;
  const station = await db.facilityStation.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, facilityId: true, revokedAt: true },
  });
  if (!station || station.revokedAt) return null;
  return { stationId: station.id, facilityId: station.facilityId };
}

const WAITING: readonly ConsultationState[] = ['WAITING_FOR_DOCTOR', 'ASSIGNED', 'REASSIGNING'];

/**
 * What the station screen may show. Also how a finished consultation leaves
 * the station: once it has ended it is cleared here, on the station's own
 * next poll, and the screen returns to the welcome.
 */
export async function stationState(
  principal: StationPrincipal,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<StationState> {
  const now = clock.now();
  const station = await db.facilityStation.findUniqueOrThrow({
    where: { id: principal.stationId },
    include: {
      facility: { select: { name: true, status: true } },
      consultation: {
        select: {
          id: true,
          publicId: true,
          state: true,
          type: true,
          doctor: { select: { fullName: true } },
          patientSession: { select: { fullNameEnc: true } },
        },
      },
    },
  });

  const consultation = station.consultation;
  const ended = consultation !== null && isTerminal(consultation.state);
  const stale =
    !station.lastSeenAt || now.getTime() - station.lastSeenAt.getTime() > SEEN_WRITE_INTERVAL_MS;

  if (ended || stale) {
    await db.facilityStation.update({
      where: { id: station.id },
      data: {
        ...(stale ? { lastSeenAt: now } : {}),
        ...(ended ? { consultationId: null, assignedAt: null, assignedByUserId: null } : {}),
      },
    });
  }

  const base = {
    station: { label: station.label },
    facility: { name: station.facility.name },
  };

  if (!consultation || ended || station.facility.status !== 'ACTIVE') {
    return {
      ...base,
      mode: 'IDLE',
      sessionKey: null,
      patientFirstName: null,
      doctorName: null,
      kind: null,
    };
  }

  const fullName = consultation.patientSession?.fullNameEnc
    ? decryptField(consultation.patientSession.fullNameEnc)
    : '';

  return {
    ...base,
    mode: acceptsCallJoin(consultation.state)
      ? 'READY'
      : WAITING.includes(consultation.state)
        ? 'WAITING_FOR_DOCTOR'
        : 'IDLE',
    sessionKey: consultation.publicId,
    // A greeting, not an identity: the first word of the name and no more.
    patientFirstName: fullName.split(/\s+/)[0] || null,
    doctorName: acceptsCallJoin(consultation.state)
      ? (consultation.doctor?.fullName ?? null)
      : null,
    kind: consultation.type === 'AUDIO' ? 'AUDIO' : 'VIDEO',
  };
}

async function assignedConsultation(principal: StationPrincipal, db: Db) {
  const station = await db.facilityStation.findUniqueOrThrow({
    where: { id: principal.stationId },
    select: { consultationId: true },
  });
  if (!station.consultationId) {
    throw errors.businessRule('This station has no consultation to join.');
  }
  return station.consultationId;
}

/** The patient's side of the call, joined from the station (D77). */
export async function stationJoin(
  principal: StationPrincipal,
  db: PrismaClient = getPrisma(),
): Promise<MediaSessionView> {
  return joinMediaSession(await assignedConsultation(principal, db), 'PATIENT', db);
}

export async function stationLeave(
  principal: StationPrincipal,
  db: PrismaClient = getPrisma(),
): Promise<void> {
  await leaveMediaSession(await assignedConsultation(principal, db), 'PATIENT', db);
}

// ---------------------------------------------------------------------------
// Connection (slice 4b, D89)
// ---------------------------------------------------------------------------

/**
 * What the station measured, kept as reported: the line from the station to
 * Neem, which the CHO sees beside the station. Neem draws no conclusion.
 */
export async function recordConnection(
  principal: StationPrincipal,
  report: ConnectionReport,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  await db.facilityStation.update({
    where: { id: principal.stationId },
    data: {
      linkDownKbps: report.downKbps,
      linkUpKbps: report.upKbps,
      linkRttMs: report.rttMs,
      linkMeasuredAt: clock.now(),
    },
  });
}

export async function videoQuality(ctx: StaffContext, db: Db = getPrisma()) {
  const facility = await db.facility.findUniqueOrThrow({
    where: { id: ctx.facilityId },
    select: { lowDataVideo: true },
  });
  return { lowData: facility.lowDataVideo };
}

/** The facility's choice; it applies from the next join, not mid-call. */
export async function setVideoQuality(ctx: StaffContext, lowData: boolean, db: Db = getPrisma()) {
  await db.facility.update({ where: { id: ctx.facilityId }, data: { lowDataVideo: lowData } });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.FACILITY_VIDEO_QUALITY_SET,
      actorType: 'FACILITY',
      actorId: ctx.userId,
      entityType: 'facility',
      entityId: ctx.facilityId,
      correlationId: ctx.correlationId,
      metadata: { lowData },
    },
    db,
  );
  return { lowData };
}
