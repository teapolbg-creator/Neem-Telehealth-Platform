import { toDataURL } from 'qrcode';
import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { getEnv } from '../../config/env.ts';
import { generateToken, hashToken, hashIp } from '../../lib/crypto.ts';
import { addSeconds, addMinutes, systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { acceptsPatientArrival, patientSessionIsUsable } from '../../domain/consultation-state.ts';

/**
 * One-time consultation access tokens and device-bound patient sessions
 * (spec §10, §38; decision D6).
 *
 * The security model, stated plainly because it is the part of Neem that grants
 * access with no password:
 *
 *  - The token is 256 bits from a CSPRNG. Only its SHA-256 digest is stored;
 *    the raw value exists in exactly one place, the QR image, and is returned
 *    exactly once.
 *  - The QR encodes a URL and nothing else. No name, no age, no consultation
 *    id, no price (spec §60).
 *  - First presentation exchanges the token for a device-bound session cookie
 *    and marks it consumed. Presenting it again fails — but the patient can
 *    refresh freely, because they hold the session, not the token.
 *  - Losing the device requires a pharmacy-issued replacement, which revokes
 *    the previous token and is audited. That path is deliberately visible.
 */

export const PATIENT_SESSION_COOKIE = 'neem_patient';

export interface IssuedAccessToken {
  /** Raw token. Returned once, encoded into the QR, and never stored. */
  token: string;
  url: string;
  qrDataUrl: string;
  expiresAt: Date;
  sequence: number;
}

/**
 * Issues an access token for a consultation.
 *
 * Re-issuing revokes any outstanding token, so at most one is ever live. That
 * is what makes "the QR becomes invalid" true rather than aspirational.
 */
export async function issueAccessToken(
  consultationId: string,
  context: { issuedByUserId?: string; reason?: 'initial' | 'reissue'; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<IssuedAccessToken> {
  const consultation = await db.consultation.findUnique({
    where: { id: consultationId },
    select: { id: true, state: true },
  });
  if (!consultation) throw errors.notFound('Consultation not found.');

  if (!acceptsPatientArrival(consultation.state)) {
    throw errors.businessRule(
      `A consultation access code can only be issued once payment is confirmed. This consultation is ${consultation.state}.`,
    );
  }

  const ttlSeconds = await getIntSetting(SETTING_KEYS.QR_TOKEN_TTL_SECONDS, db);
  const now = clock.now();
  const expiresAt = addSeconds(now, ttlSeconds);

  const token = generateToken();

  const sequence = await db.$transaction(async (tx) => {
    const previous = await tx.consultationAccessToken.findFirst({
      where: { consultationId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });

    // Only one live token at a time.
    await tx.consultationAccessToken.updateMany({
      where: { consultationId, revokedAt: null, consumedAt: null },
      data: { revokedAt: now, revokedReason: 'superseded_by_reissue' },
    });

    const next = (previous?.sequence ?? 0) + 1;

    await tx.consultationAccessToken.create({
      data: {
        consultationId,
        tokenHash: hashToken(token),
        sequence: next,
        issuedByUserId: context.issuedByUserId ?? null,
        expiresAt,
      },
    });

    return next;
  });

  await recordAudit(
    {
      action:
        sequence === 1
          ? AUDIT_ACTIONS.CONSULTATION_TOKEN_ISSUED
          : AUDIT_ACTIONS.CONSULTATION_TOKEN_REISSUED,
      actorType: 'PHARMACY',
      actorId: context.issuedByUserId ?? null,
      entityType: 'consultation',
      entityId: consultationId,
      correlationId: context.correlationId,
      // The token itself never appears in the audit log.
      metadata: { sequence, expiresAt: expiresAt.toISOString() },
    },
    db,
  );

  const url = `${getEnv().WEB_ORIGIN}/s/${token}`;

  return {
    token,
    url,
    qrDataUrl: await toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 320 }),
    expiresAt,
    sequence,
  };
}

export interface PatientSessionGrant {
  sessionToken: string;
  consultationPublicId: string;
  expiresAt: Date;
}

/**
 * Exchanges a one-time token for a device-bound patient session.
 *
 * Every failure returns the same message. A patient who mistypes and an
 * attacker probing tokens must not be able to tell the difference between
 * "no such token", "already used" and "expired".
 */
export async function exchangeAccessToken(
  rawToken: string,
  context: { ip?: string; userAgent?: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<PatientSessionGrant> {
  const invalid = () =>
    errors.notFound(
      'This consultation link is no longer valid. Please ask the pharmacy for a new code.',
    );

  const record = await db.consultationAccessToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { consultation: { select: { id: true, publicId: true, state: true } } },
  });

  if (!record) throw invalid();

  const now = clock.now();
  if (record.consumedAt || record.revokedAt || record.expiresAt <= now) throw invalid();
  if (!acceptsPatientArrival(record.consultation.state)) throw invalid();

  const sessionMinutes = getEnv().PATIENT_SESSION_TIMEOUT_MINUTES;
  const sessionToken = generateToken();
  const expiresAt = addMinutes(now, sessionMinutes);

  await db.$transaction(async (tx) => {
    // Consume first. If the session write fails, the token is still spent —
    // failing closed is the right direction for a single-use credential.
    const consumed = await tx.consultationAccessToken.updateMany({
      where: { id: record.id, consumedAt: null, revokedAt: null },
      data: { consumedAt: now },
    });

    // A concurrent exchange won the race; treat it as a reuse attempt.
    if (consumed.count === 0) throw invalid();

    await tx.patientSession.upsert({
      where: { consultationId: record.consultation.id },
      update: {
        deviceSessionTokenHash: hashToken(sessionToken),
        deviceBoundAt: now,
        expiresAt,
      },
      create: {
        consultationId: record.consultation.id,
        deviceSessionTokenHash: hashToken(sessionToken),
        deviceBoundAt: now,
        expiresAt,
      },
    });

    if (record.consultation.state === 'ACTIVATED') {
      const { transition } = await import('./consultation.service.ts');
      await transition(
        record.consultation.id,
        'WAITING_FOR_PATIENT',
        { actorType: 'PATIENT', reason: 'token_exchanged' },
        tx,
        clock,
      );
    }
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.CONSULTATION_TOKEN_ISSUED,
      actorType: 'PATIENT',
      entityType: 'consultation',
      entityId: record.consultation.id,
      ipHash: hashIp(context.ip),
      correlationId: context.correlationId,
      metadata: { event: 'token_exchanged', sequence: record.sequence },
    },
    db,
  );

  return { sessionToken, consultationPublicId: record.consultation.publicId, expiresAt };
}

export interface PatientPrincipal {
  patientSessionId: string;
  consultationId: string;
  consultationPublicId: string;
  consultationState: string;
}

/**
 * Resolves a patient session cookie.
 *
 * Scoped to exactly one consultation: there is no parameter anywhere in the
 * patient API by which a session could address a different one (spec §102).
 */
export async function resolvePatientSession(
  sessionToken: string | undefined,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<PatientPrincipal | null> {
  if (!sessionToken) return null;

  const session = await db.patientSession.findUnique({
    where: { deviceSessionTokenHash: hashToken(sessionToken) },
    include: { consultation: { select: { id: true, publicId: true, state: true } } },
  });

  // There is no `purgedAt` flag by design: access tokens are hard-deleted at
  // completion (spec §62), so the row's absence IS the signal. A soft-delete
  // column would invite exactly the "hide it from the UI" pattern the
  // specification forbids.
  if (!session) return null;
  if (session.expiresAt && session.expiresAt <= clock.now()) return null;
  if (!patientSessionIsUsable(session.consultation.state)) return null;

  return {
    patientSessionId: session.id,
    consultationId: session.consultation.id,
    consultationPublicId: session.consultation.publicId,
    consultationState: session.consultation.state,
  };
}

/** Invalidates every token for a consultation. Part of the completion path. */
export async function revokeAllTokens(
  consultationId: string,
  reason: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  await db.consultationAccessToken.updateMany({
    where: { consultationId, revokedAt: null },
    data: { revokedAt: clock.now(), revokedReason: reason.slice(0, 200) },
  });
}

/** Housekeeping sweep for tokens that were never used. */
export async function expireStaleTokens(
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const result = await db.consultationAccessToken.updateMany({
    where: { revokedAt: null, consumedAt: null, expiresAt: { lt: clock.now() } },
    data: { revokedAt: clock.now(), revokedReason: 'expired' },
  });
  return result.count;
}
