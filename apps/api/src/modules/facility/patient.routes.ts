import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PERMISSIONS,
  patientRegistrationSchema,
  patientSearchSchema,
  patientUpdateSchema,
  triageCreateSchema,
  chpsConsultationCancelSchema,
  chpsConsultationRequestSchema,
  offlineWalkInSchema,
  visitCloseSchema,
  visitCreateSchema,
  visitEscalateSchema,
} from '@neem/contracts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import {
  closeVisit,
  escalateVisit,
  facilityDay,
  getPatientRecord,
  openVisit,
  recordTriage,
  registerPatient,
  searchPatients,
  staffContext,
  updatePatient,
} from './patient.service.ts';
import { cancelRequest, requestConsultation } from './chps-consultation.service.ts';
import { offlineKey, syncWalkIn } from './offline.service.ts';

/**
 * CHPS patients, visits and triage (CHPS slice 1b, D75) — docs/api.md §14.
 *
 * Facility staff only, and only within their own facility, which comes from
 * the session. Nothing in a URL can point a CHO at another facility's patient.
 */

const patientParams = z.object({ patientNumber: z.string().min(1).max(16) });
const visitParams = z.object({ publicId: z.string().min(1).max(32) });

export async function patientRoutes(app: FastifyInstance): Promise<void> {
  const register = guard({ roles: ['FACILITY'], permissions: [PERMISSIONS.PATIENT_REGISTER] });
  const readRecord = guard({
    roles: ['FACILITY'],
    permissions: [PERMISSIONS.PATIENT_RECORD_READ],
  });
  const triage = guard({ roles: ['FACILITY'], permissions: [PERMISSIONS.TRIAGE_WRITE] });
  const requestDoctor = guard({
    roles: ['FACILITY'],
    permissions: [PERMISSIONS.CHPS_CONSULTATION_REQUEST],
  });

  // Sending a walk-in recorded offline registers and triages in one step (D88).
  const syncOffline = guard({
    roles: ['FACILITY'],
    permissions: [PERMISSIONS.PATIENT_REGISTER, PERMISSIONS.TRIAGE_WRITE],
  });

  const ctx = (request: FastifyRequest, write: boolean) =>
    staffContext(requireAuth(request), { write, correlationId: request.correlationId });

  app.get('/facility/today', { preHandler: readRecord }, async (request, reply) => {
    const data = await facilityDay(await ctx(request, false));
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });

  app.get('/facility/patients', { preHandler: readRecord }, async (request, reply) => {
    const query = patientSearchSchema.parse(request.query);
    const data = await searchPatients(await ctx(request, false), query);
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });

  app.post('/facility/patients', { preHandler: register }, async (request, reply) => {
    const input = patientRegistrationSchema.parse(request.body);
    const data = await registerPatient(await ctx(request, true), input);
    return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
  });

  app.get('/facility/offline-key', { preHandler: syncOffline }, async (request, reply) => {
    const data = await offlineKey(await ctx(request, false));
    return reply
      .header('cache-control', 'no-store')
      .send({ data, meta: { requestId: request.correlationId } });
  });

  app.post('/facility/offline/walk-ins', { preHandler: syncOffline }, async (request, reply) => {
    const input = offlineWalkInSchema.parse(request.body);
    const data = await syncWalkIn(await ctx(request, true), input);
    return reply
      .status(data.outcome === 'SAVED' ? 201 : 200)
      .send({ data, meta: { requestId: request.correlationId } });
  });

  app.get(
    '/facility/patients/:patientNumber',
    { preHandler: readRecord },
    async (request, reply) => {
      const { patientNumber } = patientParams.parse(request.params);
      const data = await getPatientRecord(await ctx(request, false), patientNumber);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.patch(
    '/facility/patients/:patientNumber',
    { preHandler: register },
    async (request, reply) => {
      const { patientNumber } = patientParams.parse(request.params);
      const input = patientUpdateSchema.parse(request.body);
      const data = await updatePatient(await ctx(request, true), patientNumber, input);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/facility/patients/:patientNumber/visits',
    { preHandler: register },
    async (request, reply) => {
      const { patientNumber } = patientParams.parse(request.params);
      const input = visitCreateSchema.parse(request.body);
      const data = await openVisit(await ctx(request, true), patientNumber, input);
      return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post('/facility/visits/:publicId/triage', { preHandler: triage }, async (request, reply) => {
    const { publicId } = visitParams.parse(request.params);
    const input = triageCreateSchema.parse(request.body);
    const data = await recordTriage(await ctx(request, true), publicId, input);
    return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
  });

  app.post(
    '/facility/visits/:publicId/escalate',
    { preHandler: triage },
    async (request, reply) => {
      const { publicId } = visitParams.parse(request.params);
      const { note } = visitEscalateSchema.parse(request.body);
      const data = await escalateVisit(await ctx(request, true), publicId, note);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/facility/visits/:publicId/consultation',
    { preHandler: requestDoctor },
    async (request, reply) => {
      const { publicId } = visitParams.parse(request.params);
      const input = chpsConsultationRequestSchema.parse(request.body);
      const data = await requestConsultation(await ctx(request, true), publicId, input);
      return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/facility/visits/:publicId/consultation/cancel',
    { preHandler: requestDoctor },
    async (request, reply) => {
      const { publicId } = visitParams.parse(request.params);
      const { reason } = chpsConsultationCancelSchema.parse(request.body);
      const data = await cancelRequest(await ctx(request, true), publicId, reason);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post('/facility/visits/:publicId/close', { preHandler: triage }, async (request, reply) => {
    const { publicId } = visitParams.parse(request.params);
    const input = visitCloseSchema.parse(request.body);
    const data = await closeVisit(await ctx(request, true), publicId, input);
    return reply.send({ data, meta: { requestId: request.correlationId } });
  });
}
