import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { getEnv } from '../../config/env.ts';
import { errors } from '../../lib/errors.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { getBooleanSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { PATIENT_SESSION_COOKIE } from '../consultation/access-token.service.ts';
import {
  resolveAccountSession,
  type AccountPrincipal,
} from '../patient-account/patient-account.service.ts';
import { PATIENT_ACCOUNT_COOKIE } from '../patient-account/patient-account.routes.ts';
import {
  listAvailability,
  listSlots,
  setAvailability,
  type AvailabilityWindow,
} from './availability.service.ts';
import {
  listAccountAppointments,
  ownedAppointment,
  reserveAppointment,
} from './appointment.service.ts';

/**
 * Booking a professional for a particular time (v2, plan phase 6).
 *
 * Paying for a reservation, and watching it clear, is the same pair of routes
 * an immediate booking uses — the money does not care which journey created
 * the consultation, and one payment surface is one place for it to be wrong.
 */

async function requireAccount(request: FastifyRequest): Promise<AccountPrincipal> {
  const principal = await resolveAccountSession(request.cookies[PATIENT_ACCOUNT_COOKIE]);
  if (!principal) throw errors.unauthenticated('Please sign in to book an appointment.');
  return principal;
}

async function assertAvailable(): Promise<void> {
  if (!(await getBooleanSetting(SETTING_KEYS.CHANNELS_DIRECT_ENABLED))) {
    throw errors.businessRule('Booking is not available yet.');
  }
}

const windowSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  endsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

export async function appointmentRoutes(app: FastifyInstance): Promise<void> {
  const env = getEnv();

  // -------------------------------------------------------------------------
  // The professional's own diary
  // -------------------------------------------------------------------------

  const professionalOnly = guard({
    roles: ['DOCTOR'],
    permissions: [PERMISSIONS.CONSULTATION_CONDUCT],
  });

  app.get('/doctor/availability', { preHandler: professionalOnly }, async (request, reply) => {
    const { organisationId } = requireAuth(request);
    if (!organisationId) throw errors.notFound('Professional not found.');

    return reply.send({
      data: await listAvailability(organisationId),
      meta: { requestId: request.correlationId },
    });
  });

  /**
   * Replaces the whole weekly pattern.
   *
   * The professional's own, not an administrator's: when somebody can be
   * booked is a statement about their week, and there is no route by which one
   * professional's diary can be written by anybody else.
   */
  app.put('/doctor/availability', { preHandler: professionalOnly }, async (request, reply) => {
    const { organisationId } = requireAuth(request);
    if (!organisationId) throw errors.notFound('Professional not found.');

    const body = z.object({ windows: z.array(windowSchema).max(50) }).parse(request.body) as {
      windows: AvailabilityWindow[];
    };

    return reply.send({
      data: await setAvailability(organisationId, body.windows),
      meta: { requestId: request.correlationId },
    });
  });

  // -------------------------------------------------------------------------
  // The patient's side
  // -------------------------------------------------------------------------

  /**
   * The free slots for a service.
   *
   * Behind the account session rather than public: this is every professional's
   * working week, and it is not something to hand to anyone who asks.
   */
  app.get('/patient/appointments/slots', async (request, reply) => {
    await requireAccount(request);
    await assertAvailable();

    const query = z
      .object({
        serviceCode: z.string().trim().min(3).max(40),
        from: z.string().datetime().optional(),
        days: z.coerce.number().int().min(1).max(31).optional(),
      })
      .parse(request.query);

    const slots = await listSlots({
      serviceCode: query.serviceCode,
      from: query.from ? new Date(query.from) : undefined,
      days: query.days,
    });

    return reply.send({ data: slots, meta: { requestId: request.correlationId } });
  });

  app.get('/patient/appointments', async (request, reply) => {
    const principal = await requireAccount(request);

    return reply.send({
      data: await listAccountAppointments(principal.accountId),
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/patient/appointments', async (request, reply) => {
    const principal = await requireAccount(request);
    await assertAvailable();

    const body = z
      .object({
        serviceCode: z.string().trim().min(3).max(40),
        professionalPublicId: z.string().trim().min(3).max(40),
        startsAt: z.string().datetime(),
        languageCode: z.string().trim().min(2).max(8),
        // Call Me is switched off platform-wide (D38) and is not offered here.
        type: z.enum(['AUDIO', 'VIDEO']),
        fullName: z.string().trim().min(2).max(160),
        age: z.number().int().min(0).max(120),
        sex: z.enum(['MALE', 'FEMALE', 'OTHER']),
        phone: z.string().trim().min(9).max(20),
        reason: z.string().trim().min(3).max(500),
        /*
         * Both must be true, and the schema is where that is enforced: a
         * booking that proceeded without them would be a consultation nobody
         * can show was agreed to.
         */
        acceptsRemoteConsultation: z.literal(true),
        readEmergencyGuidance: z.literal(true),
      })
      .parse(request.body);

    const reserved = await reserveAppointment(
      principal.accountId,
      { ...body, startsAt: new Date(body.startsAt) },
      { ip: request.ip, correlationId: request.correlationId },
    );

    /*
     * The same cookie the QR exchange sets, so the waiting screen, the call
     * and the documents need no knowledge of which journey booked it. It
     * outlives the wait, because the appointment may be days away.
     */
    reply.setCookie(PATIENT_SESSION_COOKIE, reserved.sessionToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: reserved.sessionExpiresAt,
    });

    return reply.status(201).send({
      data: {
        appointmentReference: reserved.appointmentReference,
        consultationReference: reserved.consultationReference,
        startsAt: reserved.startsAt,
        endsAt: reserved.endsAt,
        professional: reserved.professional,
        price: reserved.price,
        reservationExpiresAt: reserved.reservationExpiresAt,
      },
      meta: { requestId: request.correlationId },
    });
  });

  app.get('/patient/appointments/:reference', async (request, reply) => {
    const principal = await requireAccount(request);
    const { reference } = z.object({ reference: z.string().min(1).max(64) }).parse(request.params);

    const appointment = await ownedAppointment(principal.accountId, reference);

    return reply.send({
      data: {
        reference: appointment.publicId,
        consultationReference: appointment.consultation.publicId,
        consultationState: appointment.consultation.state,
        state: appointment.state,
        startsAt: appointment.startsAt.toISOString(),
        endsAt: appointment.endsAt.toISOString(),
        professional: appointment.doctor,
        service: appointment.service,
        reservationExpiresAt: appointment.reservationExpiresAt?.toISOString() ?? null,
      },
      meta: { requestId: request.correlationId },
    });
  });
}
