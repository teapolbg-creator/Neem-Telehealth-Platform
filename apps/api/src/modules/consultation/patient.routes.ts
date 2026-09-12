import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  patientFeedbackSchema,
  patientIdentitySchema,
  patientLanguageSchema,
  patientModeSchema,
} from '@neem/contracts';
import { getEnv } from '../../config/env.ts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { requestContext } from '../../middleware/context.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import {
  listConsultationDocuments,
  readConsultationDocument,
} from '../documents/document.service.ts';
import { patientSessionIsUsable } from '../../domain/consultation-state.ts';
import { requestRefund } from '../payment/refund.service.ts';
import {
  PATIENT_SESSION_COOKIE,
  exchangeAccessToken,
  endPatientSession,
  resolvePatientSession,
  type PatientPrincipal,
} from './access-token.service.ts';
import {
  buildSessionView,
  captureIdentity,
  selectLanguage,
  selectModeAndEnterQueue,
  submitFeedback,
} from './patient-session.service.ts';

/**
 * Patient portal routes (spec §10, §71, §72).
 *
 * Patients have no account. Access comes from a one-time token, exchanged once
 * for a device-bound session cookie.
 *
 * Every route below is scoped to the single consultation bound to that
 * session. There is deliberately no route that takes a consultation identifier
 * from the client — a patient cannot address another patient's consultation
 * because the API offers no way to name one (spec §102).
 */

async function requirePatient(request: FastifyRequest): Promise<PatientPrincipal> {
  const token = request.cookies[PATIENT_SESSION_COOKIE];
  const principal = await resolvePatientSession(token);

  if (!principal) {
    throw errors.unauthenticated(
      'This consultation session has ended. Please ask the pharmacy for a new code.',
    );
  }
  return principal;
}

/**
 * Reading a session and changing something through it are different rights.
 *
 * `requirePatient` now resolves after the consultation ends, so the patient
 * can see their consultation reference and leave feedback. Nothing else may
 * happen through a finished session: without this guard, widening the read
 * would have let a completed consultation's language or mode be rewritten.
 */
function assertPatientCanAct(principal: PatientPrincipal): void {
  if (!patientSessionIsUsable(principal.consultationState)) {
    throw errors.businessRule('This consultation has ended.');
  }
}

function setPatientCookie(reply: FastifyReply, sessionToken: string, expiresAt: Date): void {
  reply.setCookie(PATIENT_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: getEnv().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function patientRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Exchanges the QR token for a session.
   *
   * POST rather than GET: a GET would be prefetched by scanners, chat
   * previews and mail clients, silently consuming a single-use token before
   * the patient ever arrived. The landing page performs this exchange.
   */
  app.post(
    '/s/exchange',
    {
      config: {
        rateLimit: {
          max: getEnv().RATE_LIMIT_QR_EXCHANGE_MAX,
          timeWindow: getEnv().RATE_LIMIT_QR_EXCHANGE_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const { token } = z.object({ token: z.string().min(20).max(200) }).parse(request.body);

      const grant = await exchangeAccessToken(token, requestContext(request));
      setPatientCookie(reply, grant.sessionToken, grant.expiresAt);

      // The consultation's public id is returned to the patient's own device
      // only; it never appears in a URL (spec §60).
      return reply.send({
        data: { consultationPublicId: grant.consultationPublicId },
        meta: { requestId: request.correlationId },
      });
    },
  );

  /** Everything the patient's screen needs, in one call. */
  app.get('/patient/session', async (request, reply) => {
    const principal = await requirePatient(request);
    const view = await buildSessionView(principal);

    return reply.send({ data: view, meta: { requestId: request.correlationId } });
  });

  /** Languages the patient may choose between (spec §29). */
  app.get('/patient/languages', async (request, reply) => {
    await requirePatient(request);

    const languages = await getPrisma().language.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, label: true, subtitle: true },
    });

    return reply.send({ data: languages, meta: { requestId: request.correlationId } });
  });

  app.post('/patient/session/identity', async (request, reply) => {
    const principal = await requirePatient(request);
    const identity = patientIdentitySchema.parse(request.body);

    assertPatientCanAct(principal);
    await captureIdentity(principal, identity);

    return reply.send({
      data: await buildSessionView(principal),
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/patient/session/language', async (request, reply) => {
    const principal = await requirePatient(request);
    const { languageCode } = patientLanguageSchema.parse(request.body);

    assertPatientCanAct(principal);
    await selectLanguage(principal, languageCode);

    return reply.send({
      data: await buildSessionView(principal),
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/patient/session/mode', async (request, reply) => {
    const principal = await requirePatient(request);
    const { type } = patientModeSchema.parse(request.body);

    assertPatientCanAct(principal);
    await selectModeAndEnterQueue(principal, type);

    return reply.send({
      data: await buildSessionView(principal),
      meta: { requestId: request.correlationId },
    });
  });

  /** What a complaint may be about, for the feedback form (spec §51). */
  app.get('/patient/complaint-categories', async (request, reply) => {
    await requirePatient(request);

    const categories = await getPrisma().complaintCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, label: true },
    });

    return reply.send({ data: categories, meta: { requestId: request.correlationId } });
  });

  /**
   * Patient feedback (spec §51, §52).
   *
   * The queue weights a doctor's mean rating at 0.3 and their complaint count
   * at 0.2 — half the quality score — and until this route existed nothing
   * wrote to the table those come from, so that half was permanently neutral
   * for every doctor and the routing it was meant to inform did not happen.
   *
   * Only after the consultation completed: there is nothing to rate before
   * that, and a cancelled consultation had no doctor. One per consultation,
   * enforced by a unique key rather than by asking first, so two taps on a
   * slow connection cannot double-count.
   *
   * Nothing here is ever returned to the doctor (spec §24, §52). It reaches
   * them only through the nightly aggregate, which is admin-facing.
   */
  app.post('/patient/feedback', async (request, reply) => {
    const principal = await requirePatient(request);
    const body = patientFeedbackSchema.parse(request.body);

    if (principal.consultationState !== 'COMPLETED') {
      throw errors.businessRule('Feedback can only be left once the consultation is complete.');
    }

    await submitFeedback(principal, body);

    return reply.status(201).send({
      data: { submitted: true },
      meta: { requestId: request.correlationId },
    });
  });

  /**
   * The patient asking for their money back (spec §41).
   *
   * Recorded, never granted. An administrator decides, and the patient is told
   * only that the request was received — a screen that implied a refund was
   * on its way would be making a promise nobody has yet agreed to.
   */
  app.post('/patient/refund-request', async (request, reply) => {
    const principal = await requirePatient(request);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(request.body);

    const result = await requestRefund(principal.consultationId, {
      reason,
      requestedByType: 'PATIENT',
      correlationId: request.correlationId,
    });

    return reply.status(201).send({
      data: { publicId: result.publicId, state: result.state },
      meta: { requestId: request.correlationId },
    });
  });

  /**
   * The patient leaving.
   *
   * Ends their participation without completing the consultation — only the
   * doctor completes (spec §16). The consultation is left for the doctor or an
   * administrator to resolve rather than being silently closed.
   *
   * Both halves of the leaving matter. Clearing the cookie is for the patient:
   * the next person to pick up the phone sees nothing. Ending the session on
   * the server is for everyone else — a token copied off the device stops
   * working here rather than at its own expiry, which is what "leave" has to
   * mean when the device is a handset on a pharmacy counter (spec §79, §102,
   * decision D34).
   */
  app.post('/patient/session/leave', async (request, reply) => {
    const principal = await requirePatient(request);

    await endPatientSession(principal.patientSessionId);
    reply.clearCookie(PATIENT_SESSION_COOKIE, { path: '/' });

    return reply.send({
      data: { state: principal.consultationState, message: 'You have left the consultation.' },
      meta: { requestId: request.correlationId },
    });
  });

  /**
   * The documents this consultation produced, and what has happened to each.
   *
   * This route and the one below it are the whole point of the product from
   * the patient's side: a consultation that issues a prescription nobody can
   * hand them has not finished. Until these existed the documents were
   * generated, stored, and readable only by the doctor, the pharmacy and an
   * administrator — the patient, whose documents they are, had no route at all.
   *
   * Readable after the consultation ends, which is when the documents exist.
   * `requirePatient` resolves on a finished session for exactly this kind of
   * read; the separate write guard is what stops a completed session changing
   * anything.
   */
  app.get('/patient/documents', async (request, reply) => {
    const principal = await requirePatient(request);
    const documents = await listConsultationDocuments(principal.consultationId);

    return reply.send({
      data: { documents },
      meta: { requestId: request.correlationId },
    });
  });

  /**
   * One document, as a PDF.
   *
   * The consultation comes from the session and never from the request, so
   * there is no parameter here by which a patient could name somebody else's
   * document — the same rule every other patient route follows (spec §102).
   * `publicId` selects among *their own* documents and is checked against the
   * consultation before a byte is read.
   *
   * Audited like every other clinical document read. A regulator asking who
   * opened a prescription should see the patient's own access in the same
   * trail as the pharmacy's, not a gap where it happened to be unlogged.
   */
  app.get('/patient/documents/:kind/:publicId.pdf', async (request, reply) => {
    const principal = await requirePatient(request);
    const params = z
      .object({
        kind: z.enum(['prescription', 'referral', 'summary']),
        publicId: z.string().min(1).max(64),
      })
      .parse(request.params);

    const document = await readConsultationDocument(
      principal.consultationId,
      params.kind,
      params.publicId,
    );

    await recordAudit(
      {
        action: AUDIT_ACTIONS.DOCUMENT_DOWNLOADED,
        actorType: 'PATIENT',
        entityType: params.kind,
        entityId: params.publicId,
        correlationId: request.correlationId,
        metadata: { consultationId: principal.consultationPublicId },
      },
      getPrisma(),
    );

    return (
      reply
        .header('content-type', 'application/pdf')
        /*
         * `inline` rather than `attachment`: this is a phone at a pharmacy
         * counter, and the patient needs to show the document to someone across
         * it far more often than they need a file in Downloads. Every mobile
         * browser offers a save from the viewer; none of them makes an opened
         * download easy to show.
         */
        .header('content-disposition', `inline; filename="${document.filename}"`)
        .header('cache-control', 'private, no-store')
        .send(document.buffer)
    );
  });
}
