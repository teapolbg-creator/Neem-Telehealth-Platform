import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  patientIdentitySchema,
  patientLanguageSchema,
  patientModeSchema,
} from '@neem/contracts';
import { getEnv } from '../../config/env.ts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { requestContext } from '../../middleware/context.ts';
import {
  PATIENT_SESSION_COOKIE,
  exchangeAccessToken,
  resolvePatientSession,
  type PatientPrincipal,
} from './access-token.service.ts';
import {
  buildSessionView,
  captureIdentity,
  selectLanguage,
  selectModeAndEnterQueue,
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
    { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const { token } = z
        .object({ token: z.string().min(20).max(200) })
        .parse(request.body);

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

    await captureIdentity(principal, identity);

    return reply.send({
      data: await buildSessionView(principal),
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/patient/session/language', async (request, reply) => {
    const principal = await requirePatient(request);
    const { languageCode } = patientLanguageSchema.parse(request.body);

    await selectLanguage(principal, languageCode);

    return reply.send({
      data: await buildSessionView(principal),
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/patient/session/mode', async (request, reply) => {
    const principal = await requirePatient(request);
    const { type } = patientModeSchema.parse(request.body);

    await selectModeAndEnterQueue(principal, type);

    return reply.send({
      data: await buildSessionView(principal),
      meta: { requestId: request.correlationId },
    });
  });

  /**
   * The patient leaving.
   *
   * Ends their participation without completing the consultation — only the
   * doctor completes (spec §16). The consultation is left for the doctor or an
   * administrator to resolve rather than being silently closed.
   */
  app.post('/patient/session/leave', async (request, reply) => {
    const principal = await requirePatient(request);

    reply.clearCookie(PATIENT_SESSION_COOKIE, { path: '/' });

    return reply.send({
      data: { state: principal.consultationState, message: 'You have left the consultation.' },
      meta: { requestId: request.correlationId },
    });
  });
}
