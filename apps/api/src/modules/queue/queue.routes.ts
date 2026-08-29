import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock } from '../../lib/clock.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { getIntSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { acceptOffer, offerNextDoctor, processWaitingQueue } from './allocation.service.ts';
import { getPresence, goOffline, goOnline, heartbeat } from './presence.service.ts';
import { readPatientPanel } from '../consultation/patient-session.service.ts';

/**
 * Doctor queue routes (spec §24, §30).
 *
 * **There is deliberately no decline endpoint.** Doctors cannot reject an
 * assigned consultation (spec §30). The only responses available are to accept
 * or to let the window lapse, which records a missed response and reassigns.
 *
 * Also deliberately absent: anything returning a rating or quality score to a
 * doctor (spec §24, §52).
 */

function requireDoctor(request: FastifyRequest): { userId: string; doctorId: string } {
  const principal = requireAuth(request);

  if (principal.role !== 'DOCTOR' || !principal.organisationId) {
    throw errors.forbidden('This area is for doctor accounts.');
  }
  return { userId: principal.userId, doctorId: principal.organisationId };
}

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  const doctorOnly = guard({ roles: ['DOCTOR'] });

  // -------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------

  app.get('/doctor/presence', { preHandler: doctorOnly }, async (request, reply) => {
    const { doctorId } = requireDoctor(request);

    return reply.send({
      data: await getPresence(doctorId),
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/doctor/presence/online', { preHandler: doctorOnly }, async (request, reply) => {
    const { doctorId } = requireDoctor(request);
    const result = await goOnline(doctorId);

    // A doctor coming online may unblock a consultation that had nobody
    // eligible when it was enqueued.
    void processWaitingQueue().catch(() => undefined);

    return reply.send({
      data: { ...result, onlineSince: result.onlineSince.toISOString() },
      meta: { requestId: request.correlationId },
    });
  });

  /**
   * Heartbeat.
   *
   * Presence lapses on its own if this stops, so a doctor who closes their
   * laptop drops out of allocation rather than being offered consultations
   * they will never see.
   */
  app.post('/doctor/presence/heartbeat', { preHandler: doctorOnly }, async (request, reply) => {
    const { doctorId } = requireDoctor(request);
    await heartbeat(doctorId);

    return reply.send({ data: { ok: true }, meta: { requestId: request.correlationId } });
  });

  app.post('/doctor/presence/offline', { preHandler: doctorOnly }, async (request, reply) => {
    const { doctorId } = requireDoctor(request);
    await goOffline(doctorId);

    return reply.send({ data: { online: false }, meta: { requestId: request.correlationId } });
  });

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  /**
   * The doctor's current offer, if any, with the time remaining.
   *
   * The countdown here is presentation only. The window is enforced by a
   * server-side sweep, so a paused or tampered client changes nothing.
   */
  app.get('/doctor/queue', { preHandler: doctorOnly }, async (request, reply) => {
    const { doctorId } = requireDoctor(request);
    const prisma = getPrisma();
    const now = systemClock.now();

    const offer = await prisma.consultationAssignment.findFirst({
      where: { doctorId, result: 'PENDING', respondByAt: { gt: now } },
      include: {
        consultation: {
          include: {
            pharmacy: { select: { name: true, city: true } },
            language: { select: { code: true, label: true } },
          },
        },
      },
      orderBy: { offeredAt: 'desc' },
    });

    const windowSeconds = await getIntSetting(SETTING_KEYS.QUEUE_RESPONSE_WINDOW_SECONDS, prisma);

    if (!offer) {
      return reply.send({
        data: { offer: null, windowSeconds },
        meta: { requestId: request.correlationId },
      });
    }

    return reply.send({
      data: {
        windowSeconds,
        offer: {
          consultationPublicId: offer.consultation.publicId,
          type: offer.consultation.type,
          language: offer.consultation.language,
          pharmacy: offer.consultation.pharmacy,
          offeredAt: offer.offeredAt.toISOString(),
          respondByAt: offer.respondByAt.toISOString(),
          secondsRemaining: Math.max(
            0,
            Math.floor((offer.respondByAt.getTime() - now.getTime()) / 1000),
          ),
          // The doctor is NOT told their score or why they were chosen —
          // that is admin-facing routing data (spec §52).
        },
      },
      meta: { requestId: request.correlationId },
    });
  });

  app.post(
    '/doctor/consultations/:publicId/accept',
    { preHandler: guard({ roles: ['DOCTOR'], permissions: [PERMISSIONS.CONSULTATION_CONDUCT] }) },
    async (request, reply) => {
      const { doctorId } = requireDoctor(request);
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);

      const result = await acceptOffer(publicId, doctorId);

      if (!result.accepted) {
        throw errors.conflict(result.reason ?? 'That offer is no longer open.');
      }

      return reply.send({
        data: { accepted: true, consultationPublicId: publicId },
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * The accepted consultation's clinical context.
   *
   * Demographics, vitals and point-of-care results for THIS consultation only.
   * There is no history: past clinical data no longer exists, and consultation
   * history is operational, never medical (spec §13, §24).
   */
  app.get(
    '/doctor/consultations/:publicId',
    { preHandler: guard({ roles: ['DOCTOR'], permissions: [PERMISSIONS.CONSULTATION_READ] }) },
    async (request, reply) => {
      const { doctorId } = requireDoctor(request);
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);

      const consultation = await getPrisma().consultation.findUnique({
        where: { publicId },
        include: {
          pharmacy: { select: { name: true, city: true } },
          language: { select: { code: true, label: true } },
          vitals: { orderBy: { recordedAt: 'desc' } },
          tests: { orderBy: { recordedAt: 'desc' } },
        },
      });

      // 404 rather than 403: a doctor must not be able to confirm that another
      // doctor's consultation exists (spec §102).
      if (!consultation || consultation.doctorId !== doctorId) {
        throw errors.notFound('Consultation not found.');
      }

      const patient = await readPatientPanel(consultation.id);

      return reply.send({
        data: {
          publicId: consultation.publicId,
          state: consultation.state,
          type: consultation.type,
          language: consultation.language,
          pharmacy: consultation.pharmacy,
          patient,
          vitals: consultation.vitals[0] ?? null,
          tests: consultation.tests.map((test) => ({
            code: test.testCode,
            label: test.testLabel,
            result: test.resultText,
            recordedAt: test.recordedAt.toISOString(),
          })),
          startedAt: consultation.startedAt?.toISOString() ?? null,
          durationSeconds: await getIntSetting(SETTING_KEYS.CONSULTATION_DURATION_SECONDS),
        },
        meta: { requestId: request.correlationId },
      });
    },
  );

  // -------------------------------------------------------------------------
  // Admin queue oversight (spec §53)
  // -------------------------------------------------------------------------

  app.get(
    '/admin/queue',
    { preHandler: guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.CONSULTATION_ASSIGN] }) },
    async (request, reply) => {
      const prisma = getPrisma();
      const now = systemClock.now();

      const entries = await prisma.consultationQueueEntry.findMany({
        where: { state: { in: ['WAITING', 'OFFERING'] } },
        include: {
          language: { select: { code: true, label: true } },
          consultation: {
            include: {
              pharmacy: { select: { name: true } },
              assignments: { orderBy: { offeredAt: 'desc' }, take: 1 },
            },
          },
        },
        orderBy: { enqueuedAt: 'asc' },
      });

      return reply.send({
        data: entries.map((entry) => ({
          consultationPublicId: entry.consultation.publicId,
          state: entry.consultation.state,
          queueState: entry.state,
          language: entry.language,
          pharmacyName: entry.consultation.pharmacy.name,
          waitingSeconds: Math.floor((now.getTime() - entry.enqueuedAt.getTime()) / 1000),
          offerAttempts: entry.offerAttempts,
          noLanguageMatch: entry.noMatchAlertedAt !== null,
          delayed: entry.delayAlertedAt !== null,
          // Admins DO see the routing score — this is the fairness audit trail.
          lastOfferScore: entry.consultation.assignments[0]?.score
            ? Number(entry.consultation.assignments[0].score)
            : null,
        })),
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * Manual assignment.
   *
   * An escape hatch for a starved queue. It still runs through the ordinary
   * allocation path, so the language gate and every other eligibility rule
   * continue to apply — an admin can prioritise, but cannot assign a doctor
   * who does not speak the patient's language (spec §29).
   */
  app.post(
    '/admin/queue/:publicId/reallocate',
    { preHandler: guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.CONSULTATION_ASSIGN] }) },
    async (request, reply) => {
      const { publicId } = z.object({ publicId: z.string().min(1) }).parse(request.params);

      const consultation = await getPrisma().consultation.findUnique({
        where: { publicId },
        select: { id: true },
      });
      if (!consultation) throw errors.notFound('Consultation not found.');

      const result = await offerNextDoctor(consultation.id);

      return reply.send({
        data: {
          offered: result.offered,
          reason: result.reason,
          languageStarved: result.languageStarved ?? false,
          message: result.offered
            ? 'Consultation offered to the next eligible doctor.'
            : result.languageStarved
              ? 'No doctor who speaks this patient’s language is currently available. The consultation remains in the queue.'
              : 'No eligible doctor is available. The consultation remains in the queue.',
        },
        meta: { requestId: request.correlationId },
      });
    },
  );
}
