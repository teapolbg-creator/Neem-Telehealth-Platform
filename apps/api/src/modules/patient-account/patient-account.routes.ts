import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getEnv } from '../../config/env.ts';
import { errors } from '../../lib/errors.ts';
import { getBooleanSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import {
  findDocumentConsultationId,
  listConsultationDocuments,
  readConsultationDocument,
} from '../documents/document.service.ts';
import {
  accountConsultationRefs,
  endAccountSession,
  listAccountConsultations,
  requestSignInCode,
  resolveAccountSession,
  verifySignInCode,
  type AccountPrincipal,
} from './patient-account.service.ts';

/**
 * Signing in as a patient, and coming back for what a consultation produced
 * (v2, docs/v2-patient-direct-plan.md phase 3).
 *
 * A code to the patient's own contact, and a cookie afterwards. No password
 * exists to be reused or stolen, and the account reaches exactly two things:
 * which consultations are theirs, and the documents those produced. Clinical
 * notes are sealed at completion and are not reachable here at all.
 */

export const PATIENT_ACCOUNT_COOKIE = 'neem_patient_account';

async function requireAccount(request: FastifyRequest): Promise<AccountPrincipal> {
  const principal = await resolveAccountSession(request.cookies[PATIENT_ACCOUNT_COOKIE]);

  if (!principal) {
    throw errors.unauthenticated('Please sign in to see your consultations and documents.');
  }
  return principal;
}

/** The whole journey is off until the patient-direct service is authorised. */
async function assertAvailable(): Promise<void> {
  if (!(await getBooleanSetting(SETTING_KEYS.CHANNELS_DIRECT_ENABLED))) {
    throw errors.businessRule('Patient accounts are not available yet.');
  }
}

export async function patientAccountRoutes(app: FastifyInstance): Promise<void> {
  const env = getEnv();

  /*
   * Rate limited like the sign-in routes it resembles: both send something to
   * a stranger's contact on request, and both are what an attacker hammers.
   */
  const codeLimit = {
    config: { rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: '1 minute' } },
  };

  app.post('/patient/account/code', codeLimit, async (request, reply) => {
    await assertAvailable();

    const body = z.object({ contact: z.string().trim().min(3).max(160) }).parse(request.body);
    await requestSignInCode(body.contact, {
      ip: request.ip,
      correlationId: request.correlationId,
    });

    /*
     * The same answer whether or not the contact was known. Anything else
     * turns this into a way of asking whether somebody is a Neem patient.
     */
    return reply
      .status(202)
      .send({ data: { status: 'CODE_SENT' }, meta: { requestId: request.correlationId } });
  });

  app.post('/patient/account/verify', codeLimit, async (request, reply) => {
    await assertAvailable();

    const body = z
      .object({
        contact: z.string().trim().min(3).max(160),
        code: z
          .string()
          .trim()
          .regex(/^\d{6}$/, 'A code is six digits.'),
      })
      .parse(request.body);

    const session = await verifySignInCode(body.contact, body.code, {
      ip: request.ip,
      correlationId: request.correlationId,
    });

    reply.setCookie(PATIENT_ACCOUNT_COOKIE, session.token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: session.expiresAt,
    });

    return reply.send({
      data: { status: 'SIGNED_IN', publicId: session.publicId },
      meta: { requestId: request.correlationId },
    });
  });

  app.get('/patient/account', async (request, reply) => {
    const principal = await requireAccount(request);

    return reply.send({
      data: {
        publicId: principal.publicId,
        contactKind: principal.contactKind,
        consultations: await listAccountConsultations(principal.accountId),
      },
      meta: { requestId: request.correlationId },
    });
  });

  app.get('/patient/account/documents', async (request, reply) => {
    const principal = await requireAccount(request);
    const refs = await accountConsultationRefs(principal.accountId);

    const grouped = await Promise.all(
      refs.map(async (ref) => ({
        consultationReference: ref.publicId,
        documents: await listConsultationDocuments(ref.id),
      })),
    );

    return reply.send({
      data: { consultations: grouped.filter((group) => group.documents.length > 0) },
      meta: { requestId: request.correlationId },
    });
  });

  app.get('/patient/account/documents/:kind/:publicId.pdf', async (request, reply) => {
    const principal = await requireAccount(request);
    const params = z
      .object({
        kind: z.enum(['prescription', 'referral', 'summary']),
        publicId: z.string().min(1).max(64),
      })
      .parse(request.params);

    /*
     * Ownership is asked of the database, not inferred from the request. The
     * same refusal covers a document that does not exist and one that belongs
     * to somebody else, so an id cannot be tested for existence.
     */
    const notFound = errors.notFound('That document was not found.');
    const consultationId = await findDocumentConsultationId(params.kind, params.publicId);
    if (!consultationId) throw notFound;

    const refs = await accountConsultationRefs(principal.accountId);
    if (!refs.some((ref) => ref.id === consultationId)) throw notFound;

    const document = await readConsultationDocument(consultationId, params.kind, params.publicId);

    await recordAudit({
      action: AUDIT_ACTIONS.DOCUMENT_DOWNLOADED,
      actorType: 'PATIENT',
      entityType: params.kind,
      entityId: params.publicId,
      correlationId: request.correlationId,
      metadata: { patientAccountId: principal.accountId },
    });

    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${document.filename}"`)
      .header('cache-control', 'private, no-store')
      .send(document.buffer);
  });

  app.post('/patient/account/logout', async (request, reply) => {
    await endAccountSession(request.cookies[PATIENT_ACCOUNT_COOKIE]);
    reply.clearCookie(PATIENT_ACCOUNT_COOKIE, { path: '/' });

    return reply.send({
      data: { status: 'SIGNED_OUT' },
      meta: { requestId: request.correlationId },
    });
  });
}
