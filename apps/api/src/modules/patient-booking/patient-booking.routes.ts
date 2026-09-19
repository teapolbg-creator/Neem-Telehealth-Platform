import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getEnv } from '../../config/env.ts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { getBooleanSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { PATIENT_SESSION_COOKIE } from '../consultation/access-token.service.ts';
import {
  initiatePayment,
  isMockPaymentProvider,
  secondsRemaining,
  verifyAndSettle,
} from '../payment/payment.service.ts';
import {
  resolveAccountSession,
  type AccountPrincipal,
} from '../patient-account/patient-account.service.ts';
import { PATIENT_ACCOUNT_COOKIE } from '../patient-account/patient-account.routes.ts';
import {
  admitPaidBooking,
  createImmediateBooking,
  ownedBooking,
} from './patient-booking.service.ts';

/**
 * Booking a consultation as a patient (v2, plan phase 4).
 *
 * Three steps, in the order money demands: book, pay, and only then join the
 * queue. The queue, the call and the documents afterwards are the counter's
 * own machinery, reached through the patient session this mints.
 */

async function requireAccount(request: FastifyRequest): Promise<AccountPrincipal> {
  const principal = await resolveAccountSession(request.cookies[PATIENT_ACCOUNT_COOKIE]);
  if (!principal) throw errors.unauthenticated('Please sign in to book a consultation.');
  return principal;
}

async function assertAvailable(): Promise<void> {
  if (!(await getBooleanSetting(SETTING_KEYS.CHANNELS_DIRECT_ENABLED))) {
    throw errors.businessRule('Booking is not available yet.');
  }
}

export async function patientBookingRoutes(app: FastifyInstance): Promise<void> {
  const env = getEnv();

  app.post('/patient/bookings/immediate', async (request, reply) => {
    /*
     * Who is asking, before what they are asking for. A caller with no session
     * is refused as unauthenticated whatever the switch says — otherwise the
     * switch would answer questions on behalf of people who never signed in.
     */
    const principal = await requireAccount(request);
    await assertAvailable();

    const body = z
      .object({
        serviceCode: z.string().trim().min(3).max(40),
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

    const booking = await createImmediateBooking(principal.accountId, body, {
      ip: request.ip,
      correlationId: request.correlationId,
    });

    /*
     * The same cookie the QR exchange sets, so the waiting screen, the call and
     * the documents need no knowledge of which service created the booking.
     */
    reply.setCookie(PATIENT_SESSION_COOKIE, booking.sessionToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: booking.sessionExpiresAt,
    });

    return reply.status(201).send({
      data: {
        consultationReference: booking.consultationReference,
        price: booking.price,
        paymentDeadlineAt: booking.paymentDeadlineAt,
      },
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/patient/bookings/:reference/payment', async (request, reply) => {
    const principal = await requireAccount(request);
    await assertAvailable();
    const { reference } = z.object({ reference: z.string().min(1).max(64) }).parse(request.params);

    const consultation = await ownedBooking(principal.accountId, reference);

    const result = await initiatePayment(
      consultation.publicId,
      {
        patientAccountId: principal.accountId,
        // Paystack needs an address for the receipt; the patient's own is the
        // honest one, rather than the synthetic per-transaction address the
        // counter has to use (spec §60).
        payerEmail:
          principal.contactKind === 'EMAIL' ? (principal.contact ?? undefined) : undefined,
        // Back to Neem when the checkout is done. The page it lands on asks
        // the API what happened; Paystack's own query string decides nothing.
        callbackUrl: `${getEnv().WEB_ORIGIN}/book/paid?booking=${encodeURIComponent(consultation.publicId)}`,
      },
      { actorType: 'PATIENT', correlationId: request.correlationId },
    );

    return reply.send({
      data: {
        authorizationUrl: result.authorizationUrl,
        providerReference: result.providerReference,
        isMockProvider: result.isMockProvider,
      },
      meta: { requestId: request.correlationId },
    });
  });

  /**
   * The screen the patient watches while paying.
   *
   * It re-verifies with the provider rather than trusting anything the browser
   * saw (spec §34), and admits the patient to the queue the moment the payment
   * is confirmed — there is no counter to do it for them.
   */
  app.get('/patient/bookings/:reference/payment', async (request, reply) => {
    const principal = await requireAccount(request);
    const { reference } = z.object({ reference: z.string().min(1).max(64) }).parse(request.params);

    const consultation = await ownedBooking(principal.accountId, reference);
    const payment = await newestPayment(consultation.id);

    if (payment && payment.status !== 'SUCCESS') {
      await verifyAndSettle(payment.providerReference, {
        actorType: 'SYSTEM',
        correlationId: request.correlationId,
      }).catch((error: unknown) => {
        request.log.warn(
          { err: error, providerReference: payment.providerReference },
          'payment verification failed',
        );
      });
    }

    const queued = await admitPaidBooking(reference, principal.accountId);
    const fresh = await ownedBooking(principal.accountId, reference);
    const appointment = await getPrisma().appointment.findFirst({
      where: { consultationId: fresh.id },
      select: { startsAt: true },
    });

    return reply.send({
      data: {
        consultationReference: fresh.publicId,
        state: fresh.state,
        paymentStatus: payment?.status ?? 'NONE',
        secondsRemaining: secondsRemaining(fresh.paymentDeadlineAt),
        isMockProvider: isMockPaymentProvider(),
        joinedQueue: queued || fresh.state === 'WAITING_FOR_DOCTOR',
        // So the page Paystack returns to knows which kind of booking it is.
        appointmentAt: appointment?.startsAt.toISOString() ?? null,
      },
      meta: { requestId: request.correlationId },
    });
  });
}

/** The newest payment attempt on a consultation, if one has been started. */
async function newestPayment(consultationId: string) {
  return getPrisma().payment.findFirst({
    where: { consultationId },
    orderBy: { createdAt: 'desc' },
    select: { status: true, providerReference: true },
  });
}
