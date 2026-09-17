import { randomInt } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { addSeconds, systemClock, type Clock } from '../../lib/clock.ts';
import {
  decryptNullable,
  encryptField,
  generatePublicId,
  generateToken,
  hashIp,
  hashToken,
  keyedHash,
  safeEqual,
} from '../../lib/crypto.ts';
import { getBooleanSetting, getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { notify } from '../notification/notification.service.ts';

/**
 * A patient who can come back (v2).
 *
 * The counter never needed this: the patient is in the shop, and their session
 * dies with the consultation. A patient who booked from home needs to reach
 * their prescription on Thursday for a consultation they had on Monday.
 *
 * The account holds one contact and nothing else. Signing in is a code sent to
 * that contact — no password to forget, reuse or leak, and nothing to reset.
 * What it unlocks is deliberately narrow: the consultations that belong to it
 * and the documents they produced. Clinical notes are sealed at completion and
 * are not reachable through an account at all.
 */

export type ContactKind = 'EMAIL' | 'PHONE';

export interface Contact {
  kind: ContactKind;
  /** Normalised: lower-cased address, or a local-format Ghanaian number. */
  value: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const GHANA_MOBILE = /^(?:\+?233|0)(\d{9})$/;

/**
 * One spelling per person, so "0244 000 111" and "+233244000111" are the same
 * account rather than two.
 */
export function normaliseContact(raw: string): Contact {
  const trimmed = raw.trim();

  if (trimmed.includes('@')) {
    const value = trimmed.toLowerCase();
    if (!EMAIL.test(value)) throw errors.businessRule('That email address does not look right.');
    return { kind: 'EMAIL', value };
  }

  const digits = trimmed.replace(/[\s()-]/g, '');
  const match = GHANA_MOBILE.exec(digits);
  if (!match) throw errors.businessRule('That phone number does not look right.');

  return { kind: 'PHONE', value: `0${match[1]}` };
}

function sixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

async function findOrCreateAccount(contact: Contact, db: PrismaClient) {
  const contactHash = keyedHash(`patient:${contact.kind}:${contact.value}`);

  const existing = await db.patientAccount.findUnique({ where: { contactHash } });
  if (existing) return existing;

  return db.patientAccount.create({
    data: {
      publicId: generatePublicId('pat'),
      contactKind: contact.kind,
      contactHash,
      contactEnc: encryptField(contact.value),
    },
  });
}

/**
 * Sends a sign-in code, and says nothing about whether the contact was known.
 *
 * The caller always gets the same answer: an account that exists and one that
 * has just been created are indistinguishable from outside, so this cannot be
 * used to ask whether somebody is a Neem patient.
 */
export async function requestSignInCode(
  rawContact: string,
  context: { ip?: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  const contact = normaliseContact(rawContact);

  /*
   * Codes go by email, and only by email.
   *
   * An SMS to a patient carries a consultation reference and nothing else, so
   * a code cannot travel that way — and a code nobody can receive is worse
   * than a refusal, because the patient waits for a message that was never
   * going to arrive. Phone accounts stay in the model for when that changes.
   */
  if (contact.kind === 'PHONE') {
    throw errors.businessRule(
      'Codes can only be sent by email at the moment. Please use an email address.',
    );
  }

  const account = await findOrCreateAccount(contact, db);
  const ttlSeconds = await getIntSetting(SETTING_KEYS.PATIENT_CODE_TTL_SECONDS, db);
  const code = sixDigitCode();

  await db.patientAuthCode.create({
    data: {
      accountId: account.id,
      codeHash: keyedHash(code),
      expiresAt: addSeconds(clock.now(), ttlSeconds),
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PATIENT_ACCOUNT_CODE_SENT,
      actorType: 'SYSTEM',
      entityType: 'patient_account',
      entityId: account.id,
      correlationId: context.correlationId,
      // The contact itself is never in an audit row; the account already is it.
      metadata: { contactKind: account.contactKind, ipHash: hashIp(context.ip) },
    },
    db,
  );

  await notify(
    {
      templateCode: 'patient.account.code',
      recipient: { type: 'PATIENT_ACCOUNT', accountId: account.id },
      variables: { code, minutes: Math.max(1, Math.round(ttlSeconds / 60)) },
      correlationId: context.correlationId,
    },
    db,
    clock,
  );
}

export interface SignedInAccount {
  token: string;
  expiresAt: Date;
  accountId: string;
  publicId: string;
}

/**
 * Exchanges a code for a session, and burns the code either way.
 *
 * Attempts are counted on the code row, so guessing is bounded no matter how
 * many processes serve the requests. Every failure answers the same way: a
 * wrong code, an expired one and an unknown contact are not distinguishable.
 */
export async function verifySignInCode(
  rawContact: string,
  code: string,
  context: { ip?: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<SignedInAccount> {
  const refused = errors.unauthenticated('That code is not valid. Please ask for a new one.');
  const contact = normaliseContact(rawContact);
  const contactHash = keyedHash(`patient:${contact.kind}:${contact.value}`);

  const account = await db.patientAccount.findUnique({ where: { contactHash } });
  if (!account) throw refused;

  const maxAttempts = await getIntSetting(SETTING_KEYS.PATIENT_CODE_MAX_ATTEMPTS, db);
  const now = clock.now();

  const candidate = await db.patientAuthCode.findFirst({
    where: { accountId: account.id, consumedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
  });
  if (!candidate || candidate.attempts >= maxAttempts) throw refused;

  if (!safeEqual(candidate.codeHash, keyedHash(code))) {
    await db.patientAuthCode.update({
      where: { id: candidate.id },
      data: { attempts: { increment: 1 } },
    });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.PATIENT_ACCOUNT_SIGN_IN_FAILED,
        actorType: 'SYSTEM',
        outcome: 'FAILURE',
        entityType: 'patient_account',
        entityId: account.id,
        correlationId: context.correlationId,
        metadata: { attempts: candidate.attempts + 1, ipHash: hashIp(context.ip) },
      },
      db,
    );

    throw refused;
  }

  const sessionHours = await getIntSetting(SETTING_KEYS.PATIENT_SESSION_HOURS, db);
  const token = generateToken();
  const expiresAt = addSeconds(now, sessionHours * 3600);

  await db.$transaction(async (tx) => {
    await tx.patientAuthCode.update({ where: { id: candidate.id }, data: { consumedAt: now } });
    await tx.patientAccount.update({
      where: { id: account.id },
      data: { verifiedAt: account.verifiedAt ?? now, lastSeenAt: now },
    });
    await tx.patientAccountSession.create({
      data: {
        accountId: account.id,
        tokenHash: hashToken(token),
        expiresAt,
        ipHash: hashIp(context.ip),
      },
    });
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PATIENT_ACCOUNT_SIGNED_IN,
      actorType: 'PATIENT',
      entityType: 'patient_account',
      entityId: account.id,
      correlationId: context.correlationId,
      metadata: { ipHash: hashIp(context.ip) },
    },
    db,
  );

  return { token, expiresAt, accountId: account.id, publicId: account.publicId };
}

export interface AccountPrincipal {
  accountId: string;
  publicId: string;
  contactKind: ContactKind;
  contact: string | null;
}

export async function resolveAccountSession(
  token: string | undefined,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<AccountPrincipal | null> {
  if (!token) return null;

  const session = await db.patientAccountSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { account: true },
  });

  if (!session || session.revokedAt || session.expiresAt <= clock.now()) return null;

  return {
    accountId: session.accountId,
    publicId: session.account.publicId,
    contactKind: session.account.contactKind,
    contact: decryptNullable(session.account.contactEnc),
  };
}

export async function endAccountSession(
  token: string | undefined,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  if (!token) return;

  await db.patientAccountSession.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: clock.now() },
  });
}

export interface AccountConsultation {
  publicId: string;
  state: string;
  serviceName: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** The consultations this account booked. Operational history, never clinical. */
export async function listAccountConsultations(
  accountId: string,
  db: Db = getPrisma(),
): Promise<AccountConsultation[]> {
  const rows = await db.consultation.findMany({
    where: { patientAccountId: accountId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      publicId: true,
      state: true,
      createdAt: true,
      completedAt: true,
      service: { select: { name: true } },
    },
  });

  return rows.map((row) => ({
    publicId: row.publicId,
    state: row.state,
    serviceName: row.service?.name ?? null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  }));
}

/**
 * The consultation ids this account may read documents for.
 *
 * Ownership is asked of the database rather than inferred from anything the
 * caller sent, which is what stops one patient reaching another's document by
 * knowing its public id.
 */
export async function accountConsultationRefs(
  accountId: string,
  db: Db = getPrisma(),
): Promise<Array<{ id: string; publicId: string }>> {
  return db.consultation.findMany({
    where: { patientAccountId: accountId },
    select: { id: true, publicId: true },
    orderBy: { createdAt: 'desc' },
  });
}
