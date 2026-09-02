import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  cancelConsultationSchema,
  createConsultationSchema,
  initiatePaymentSchema,
  paginationQuerySchema,
} from '@neem/contracts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock } from '../../lib/clock.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import {
  cancelConsultation,
  createConsultation,
  getConsultationByPublicId,
  listConsultations,
} from './consultation.service.ts';
import { issueAccessToken } from './access-token.service.ts';
import { readPatientPanel } from './patient-session.service.ts';
import {
  initiatePayment,
  isMockPaymentProvider,
  secondsRemaining,
  verifyAndSettle,
} from '../payment/payment.service.ts';
import { queryBoolean } from '../../lib/query.ts';

/**
 * Pharmacy consultation routes (spec §18, §73).
 *
 * Ownership is checked on every route: a pharmacy addressing another
 * pharmacy's consultation gets a 404, not a 403, because confirming the
 * consultation exists would itself be a disclosure (spec §102).
 */

function requirePharmacy(request: FastifyRequest): { userId: string; pharmacyId: string } {
  const principal = requireAuth(request);

  if (principal.role !== 'PHARMACY' || !principal.organisationId) {
    throw errors.forbidden('This area is for pharmacy accounts.');
  }
  return { userId: principal.userId, pharmacyId: principal.organisationId };
}

export async function pharmacyConsultationRoutes(app: FastifyInstance): Promise<void> {
  const pharmacyOnly = guard({
    roles: ['PHARMACY'],
    permissions: [PERMISSIONS.CONSULTATION_CREATE],
  });
  const pharmacyRead = guard({ roles: ['PHARMACY'], permissions: [PERMISSIONS.CONSULTATION_READ] });

  /** Starts a consultation. Takes no patient details — see finding C2. */
  app.post('/pharmacy/consultations', { preHandler: pharmacyOnly }, async (request, reply) => {
    const { userId, pharmacyId } = requirePharmacy(request);
    const input = createConsultationSchema.parse(request.body ?? {});

    const consultation = await createConsultation(
      { pharmacyId, promotionCode: input.promotionCode },
      { actorId: userId, correlationId: request.correlationId },
    );

    return reply.status(201).send({
      data: {
        publicId: consultation.publicId,
        state: consultation.state,
        price: { amountMinor: consultation.priceMinor, currency: consultation.currency },
        discount: { amountMinor: consultation.discountMinor, currency: consultation.currency },
        net: { amountMinor: consultation.netMinor, currency: consultation.currency },
        paymentDeadlineAt: consultation.paymentDeadlineAt?.toISOString() ?? null,
        secondsRemaining: secondsRemaining(consultation.paymentDeadlineAt),
      },
      meta: { requestId: request.correlationId },
    });
  });

  app.post(
    '/pharmacy/consultations/:publicId/payment',
    { preHandler: pharmacyOnly },
    async (request, reply) => {
      const { userId, pharmacyId } = requirePharmacy(request);
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);
      const input = initiatePaymentSchema.parse(request.body ?? {});

      const result = await initiatePayment(
        publicId,
        { payerPhone: input.payerPhone, pharmacyId },
        { actorId: userId, correlationId: request.correlationId },
      );

      return reply.send({
        data: {
          ...result,
          // Surfaced, never hidden: in mock mode nothing has actually been
          // charged, and the UI says so (spec §93).
          note: result.isMockProvider
            ? 'Mock payment provider — no money has moved. Settle it from the pharmacy screen to continue.'
            : undefined,
        },
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * Authoritative payment status.
   *
   * Re-verifies with the provider rather than reporting our cached row, so a
   * payment completed out-of-band is picked up even if the webhook is delayed.
   */
  app.get(
    '/pharmacy/consultations/:publicId/payment',
    { preHandler: pharmacyRead },
    async (request, reply) => {
      const { pharmacyId } = requirePharmacy(request);
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);

      const consultation = await getConsultationByPublicId(publicId);
      if (consultation.pharmacyId !== pharmacyId) throw errors.notFound('Consultation not found.');

      const payment = consultation.payments[0];

      if (payment && payment.status !== 'SUCCESS' && payment.status !== 'ABANDONED') {
        await verifyAndSettle(payment.providerReference, {
          actorType: 'PHARMACY',
          correlationId: request.correlationId,
        }).catch(() => undefined);
      }

      const fresh = await getConsultationByPublicId(publicId);

      return reply.send({
        data: {
          consultationPublicId: fresh.publicId,
          consultationState: fresh.state,
          paymentStatus: fresh.payments[0]?.status ?? 'NONE',
          amount: { amountMinor: fresh.netMinor, currency: fresh.currency },
          secondsRemaining: secondsRemaining(fresh.paymentDeadlineAt),
          isMockProvider: isMockPaymentProvider(),
          canRetry: fresh.state === 'PAYMENT_FAILED' || fresh.state === 'PENDING_PAYMENT',
        },
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * The QR code for an activated consultation.
   *
   * Issues a fresh single-use token each time it is called, revoking any
   * previous one — which is also the "patient lost their phone" path
   * (decision D6). Every issue is audited.
   */
  app.post(
    '/pharmacy/consultations/:publicId/qr',
    { preHandler: pharmacyOnly },
    async (request, reply) => {
      const { userId, pharmacyId } = requirePharmacy(request);
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);

      const consultation = await getConsultationByPublicId(publicId);
      if (consultation.pharmacyId !== pharmacyId) throw errors.notFound('Consultation not found.');

      const issued = await issueAccessToken(consultation.id, {
        issuedByUserId: userId,
        correlationId: request.correlationId,
      });

      // The raw token is not returned — only the QR image and the URL that
      // carries it, which is what the patient scans.
      return reply.send({
        data: {
          qrDataUrl: issued.qrDataUrl,
          url: issued.url,
          expiresAt: issued.expiresAt.toISOString(),
          sequence: issued.sequence,
        },
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.get('/pharmacy/consultations', { preHandler: pharmacyRead }, async (request, reply) => {
    const { pharmacyId } = requirePharmacy(request);
    const query = paginationQuerySchema
      .extend({ activeOnly: queryBoolean.optional() })
      .parse(request.query);

    const result = await listConsultations({
      pharmacyId,
      activeOnly: query.activeOnly,
      limit: query.limit,
      cursor: query.cursor,
    });

    return reply.send({
      data: result.items.map((consultation) => ({
        publicId: consultation.publicId,
        state: consultation.state,
        type: consultation.type,
        language: consultation.language,
        net: { amountMinor: consultation.netMinor, currency: consultation.currency },
        createdAt: consultation.createdAt.toISOString(),
        paymentDeadlineAt: consultation.paymentDeadlineAt?.toISOString() ?? null,
        secondsRemaining: secondsRemaining(consultation.paymentDeadlineAt),
        doctor: consultation.doctor,
        hasPrescription: consultation.hasPrescription,
        hasReferral: consultation.hasReferral,
        durationSeconds: consultation.durationSeconds,
        outcome: consultation.outcome,
      })),
      meta: {
        requestId: request.correlationId,
        page: { cursor: result.nextCursor, hasMore: result.hasMore },
      },
    });
  });

  /**
   * One consultation, including the temporary patient panel.
   *
   * The four patient fields are readable only while the consultation is live;
   * after completion the row is gone and this returns null (spec §18).
   * Clinical notes are never included — the pharmacy does not see them at any
   * point (spec §73).
   */
  app.get(
    '/pharmacy/consultations/:publicId',
    { preHandler: pharmacyRead },
    async (request, reply) => {
      const { pharmacyId } = requirePharmacy(request);
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);

      const consultation = await getConsultationByPublicId(publicId);
      if (consultation.pharmacyId !== pharmacyId) throw errors.notFound('Consultation not found.');

      // The pharmacy captured this number with the patient in front of them,
      // so it is theirs to see. The doctor's panel deliberately omits it.
      const patient = await readPatientPanel(consultation.id, undefined, { includePhone: true });

      return reply.send({
        data: {
          publicId: consultation.publicId,
          state: consultation.state,
          type: consultation.type,
          language: consultation.language,
          price: { amountMinor: consultation.priceMinor, currency: consultation.currency },
          discount: { amountMinor: consultation.discountMinor, currency: consultation.currency },
          net: { amountMinor: consultation.netMinor, currency: consultation.currency },
          createdAt: consultation.createdAt.toISOString(),
          paymentDeadlineAt: consultation.paymentDeadlineAt?.toISOString() ?? null,
          secondsRemaining: secondsRemaining(consultation.paymentDeadlineAt),
          activatedAt: consultation.activatedAt?.toISOString() ?? null,
          patientJoinedAt: consultation.patientJoinedAt?.toISOString() ?? null,
          startedAt: consultation.startedAt?.toISOString() ?? null,
          completedAt: consultation.completedAt?.toISOString() ?? null,
          durationSeconds: consultation.durationSeconds,
          outcome: consultation.outcome,
          hasPrescription: consultation.hasPrescription,
          hasReferral: consultation.hasReferral,
          doctor: consultation.doctor,
          paymentStatus: consultation.payments[0]?.status ?? 'NONE',
          patient,
          isDemo: consultation.isDemo,
        },
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.post(
    '/pharmacy/consultations/:publicId/cancel',
    { preHandler: guard({ roles: ['PHARMACY'], permissions: [PERMISSIONS.CONSULTATION_CANCEL] }) },
    async (request, reply) => {
      const { userId, pharmacyId } = requirePharmacy(request);
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);
      const { reason } = cancelConsultationSchema.parse(request.body);

      const result = await cancelConsultation(publicId, reason, {
        actorType: 'PHARMACY',
        actorId: userId,
        pharmacyId,
        correlationId: request.correlationId,
      });

      return reply.send({
        data: {
          state: result.state,
          refundOwed: result.refundOwed,
          // Stated plainly: a paid consultation is never silently discarded
          // (spec §37). Refund approval is an admin decision (spec §41).
          message: result.refundOwed
            ? 'Consultation cancelled. This consultation was paid for, so a refund request has been raised for Neem administration to review.'
            : 'Consultation cancelled.',
        },
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * Development-only: settles a mock payment.
   *
   * Present only when the mock provider is active, and it does not assert that
   * money moved — it drives the *simulator* to the state a real provider would
   * reach, after which the ordinary verification path runs unchanged.
   */
  app.post(
    '/pharmacy/consultations/:publicId/payment/simulate',
    { preHandler: pharmacyOnly },
    async (request, reply) => {
      if (!isMockPaymentProvider()) {
        throw errors.notFound('Not found.');
      }

      const { pharmacyId } = requirePharmacy(request);
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);
      const { outcome } = z
        .object({ outcome: z.enum(['SUCCESS', 'FAILED']).default('SUCCESS') })
        .parse(request.body ?? {});

      const consultation = await getConsultationByPublicId(publicId);
      if (consultation.pharmacyId !== pharmacyId) throw errors.notFound('Consultation not found.');

      const payment = consultation.payments[0];
      if (!payment) throw errors.businessRule('No payment has been started for this consultation.');

      const { MockPaymentProvider } = await import('../../adapters/payment/index.ts');
      const { getPaymentProvider } = await import('../../adapters/payment/index.ts');
      const provider = getPaymentProvider();

      if (!(provider instanceof MockPaymentProvider)) {
        throw errors.notFound('Not found.');
      }
      provider.settle(payment.providerReference, outcome);

      const settled = await verifyAndSettle(payment.providerReference, {
        actorType: 'PHARMACY',
        correlationId: request.correlationId,
      });

      return reply.send({
        data: { ...settled, simulated: true },
        meta: { requestId: request.correlationId },
      });
    },
  );

  /** Point-of-care capabilities this pharmacy declared, for the vitals form. */
  app.get('/pharmacy/capabilities', { preHandler: pharmacyRead }, async (request, reply) => {
    const { pharmacyId } = requirePharmacy(request);

    const capabilities = await getPrisma().pharmacyCapability.findMany({
      where: { pharmacyId },
      orderBy: { code: 'asc' },
    });

    return reply.send({
      data: capabilities.map((capability) => ({
        kind: capability.kind,
        code: capability.code,
        label: capability.label,
      })),
      meta: { requestId: request.correlationId },
    });
  });

  void systemClock;
}
