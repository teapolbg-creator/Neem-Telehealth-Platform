import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getEnv } from '../../config/env.ts';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import {
  PATIENT_SESSION_COOKIE,
  resolvePatientSession,
  type PatientPrincipal,
} from '../consultation/access-token.service.ts';
import { getTimer, joinMediaSession, leaveMediaSession, placeCallMe } from './media.service.ts';

/**
 * Media routes (spec §32, §33).
 *
 * Deliberately absent, and no amount of client work can add them: any route
 * that starts, stops, lists, or downloads a recording. Consultations are never
 * recorded (spec §32, decision D8).
 *
 * The patient's routes take no consultation identifier — their session is
 * bound to exactly one consultation, so there is no parameter to tamper with
 * (spec §102).
 */

async function requirePatient(request: FastifyRequest): Promise<PatientPrincipal> {
  const principal = await resolvePatientSession(request.cookies[PATIENT_SESSION_COOKIE]);

  if (!principal) {
    throw errors.unauthenticated(
      'This consultation session has ended. Please ask the pharmacy for a new code.',
    );
  }
  return principal;
}

function requireDoctorId(request: FastifyRequest): string {
  const principal = requireAuth(request);

  if (principal.role !== 'DOCTOR' || !principal.organisationId) {
    throw errors.forbidden('This area is for doctor accounts.');
  }
  return principal.organisationId;
}

/** Resolves a consultation the calling doctor is actually assigned to. */
async function requireOwnConsultation(publicId: string, doctorId: string): Promise<string> {
  const consultation = await getPrisma().consultation.findUnique({
    where: { publicId },
    select: { id: true, doctorId: true },
  });

  // 404, never 403: a doctor must not learn that another doctor's
  // consultation exists (spec §102).
  if (!consultation || consultation.doctorId !== doctorId) {
    throw errors.notFound('Consultation not found.');
  }
  return consultation.id;
}

const publicIdParams = z.object({ publicId: z.string().min(1).max(32) });

/**
 * How often one doctor may ask for a bridge.
 *
 * Configurable rather than a constant, like every other limit in the system.
 * The default is the value this used to hard-code.
 */
function callLimit() {
  const env = getEnv();
  return { max: env.RATE_LIMIT_CALL_MAX, timeWindow: env.RATE_LIMIT_CALL_WINDOW };
}

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  const doctorOnly = guard({
    roles: ['DOCTOR'],
    permissions: [PERMISSIONS.CONSULTATION_READ],
  });

  // -------------------------------------------------------------------------
  // Patient
  // -------------------------------------------------------------------------

  /**
   * Joins, or rejoins, the consultation's media session.
   *
   * Safe to call again after a reload or a dropped connection: the room is the
   * same, only the join credential is fresh.
   */
  app.post('/patient/consultation/media/join', async (request, reply) => {
    const principal = await requirePatient(request);
    const session = await joinMediaSession(principal.consultationId, 'PATIENT');

    return reply.send({ data: session, meta: { requestId: request.correlationId } });
  });

  app.post('/patient/consultation/media/leave', async (request, reply) => {
    const principal = await requirePatient(request);
    await leaveMediaSession(principal.consultationId, 'PATIENT');

    return reply.send({ data: { ok: true }, meta: { requestId: request.correlationId } });
  });

  /**
   * The consultation timer.
   *
   * Read-only, on both sides. Nothing here can end a consultation — see the
   * note on `getTimer` (spec §15).
   */
  app.get('/patient/consultation/timer', async (request, reply) => {
    const principal = await requirePatient(request);
    const timer = await getTimer(principal.consultationId);

    return reply.send({ data: timer, meta: { requestId: request.correlationId } });
  });

  // -------------------------------------------------------------------------
  // Doctor
  // -------------------------------------------------------------------------

  app.post(
    '/doctor/consultations/:publicId/media/join',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const doctorId = requireDoctorId(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await requireOwnConsultation(publicId, doctorId);

      const session = await joinMediaSession(consultationId, 'DOCTOR');

      return reply.send({ data: session, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/doctor/consultations/:publicId/media/leave',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const doctorId = requireDoctorId(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await requireOwnConsultation(publicId, doctorId);

      await leaveMediaSession(consultationId, 'DOCTOR');

      return reply.send({ data: { ok: true }, meta: { requestId: request.correlationId } });
    },
  );

  app.get(
    '/doctor/consultations/:publicId/timer',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const doctorId = requireDoctorId(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await requireOwnConsultation(publicId, doctorId);

      const timer = await getTimer(consultationId);

      return reply.send({ data: timer, meta: { requestId: request.correlationId } });
    },
  );

  /**
   * Places the Call Me bridge (spec §33).
   *
   * The doctor initiates; the platform dials both parties. The response
   * carries no phone number — only what the patient's handset will display.
   */
  app.post(
    '/doctor/consultations/:publicId/call',
    { preHandler: doctorOnly, config: { rateLimit: callLimit() } },
    async (request, reply) => {
      const doctorId = requireDoctorId(request);
      const { publicId } = publicIdParams.parse(request.params);
      const consultationId = await requireOwnConsultation(publicId, doctorId);

      const call = await placeCallMe(consultationId, doctorId);

      return reply.send({ data: call, meta: { requestId: request.correlationId } });
    },
  );
}
