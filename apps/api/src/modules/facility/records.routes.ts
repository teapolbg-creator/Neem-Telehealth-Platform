import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { staffContext } from './patient.service.ts';
import { dispenseAtFacility } from './chps-prescription.service.ts';
import { addAttachment, readAttachment } from './attachment.service.ts';

/**
 * Dispensing at the facility, and files kept with a visit (slice 2d, D83) —
 * docs/api.md §20.
 */

const params = z.object({ publicId: z.string().min(1).max(32) });
const doctorParams = z.object({
  publicId: z.string().min(1).max(32),
  attachmentId: z.string().min(1).max(32),
});

function sendFile(
  reply: FastifyReply,
  file: { body: Buffer; contentType: string; label: string },
  publicId: string,
) {
  return reply
    .header('content-type', file.contentType)
    .header('content-disposition', `inline; filename="${publicId}"`)
    .header('cache-control', 'private, no-store')
    .send(file.body);
}

export async function recordsRoutes(app: FastifyInstance): Promise<void> {
  const dispense = guard({
    roles: ['FACILITY'],
    permissions: [PERMISSIONS.CHPS_PRESCRIPTION_DISPENSE],
  });
  const upload = guard({ roles: ['FACILITY'], permissions: [PERMISSIONS.PATIENT_REGISTER] });
  const read = guard({ roles: ['FACILITY'], permissions: [PERMISSIONS.PATIENT_RECORD_READ] });
  const doctorOnly = guard({ roles: ['DOCTOR'], permissions: [PERMISSIONS.CONSULTATION_READ] });
  const ctx = (request: FastifyRequest, write: boolean) =>
    staffContext(requireAuth(request), { write, correlationId: request.correlationId });

  app.post(
    '/facility/prescriptions/:publicId/dispense',
    { preHandler: dispense },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const data = await dispenseAtFacility(await ctx(request, false), publicId);
      return reply.send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.post(
    '/facility/visits/:publicId/attachments',
    { preHandler: upload },
    async (request, reply) => {
      const { publicId } = params.parse(request.params);
      const staff = await ctx(request, true);
      const file = await request.file();
      if (!file) throw errors.validation([{ field: 'file', issue: 'No file was uploaded' }]);
      const label = String(
        (file.fields.label as { value?: string } | undefined)?.value ?? '',
      ).trim();
      if (label.length < 2 || label.length > 160) {
        throw errors.validation([{ field: 'label', issue: 'Say what the file is' }]);
      }
      const data = await addAttachment(staff, publicId, {
        label,
        mimeType: file.mimetype,
        body: await file.toBuffer(),
      });
      return reply.status(201).send({ data, meta: { requestId: request.correlationId } });
    },
  );

  app.get('/facility/attachments/:publicId', { preHandler: read }, async (request, reply) => {
    const { publicId } = params.parse(request.params);
    const staff = await ctx(request, false);
    const file = await readAttachment(
      publicId,
      async (attachment) => attachment.facilityId === staff.facilityId,
      { type: 'FACILITY', userId: staff.userId, correlationId: request.correlationId },
    );
    return sendFile(reply, file, publicId);
  });

  /*
   * The doctor of a CHPS consultation may read the files on that
   * consultation's visit (D74, D83), and no other visit's.
   */
  app.get(
    '/doctor/consultations/:publicId/attachments/:attachmentId',
    { preHandler: doctorOnly },
    async (request, reply) => {
      const principal = requireAuth(request);
      const { publicId, attachmentId } = doctorParams.parse(request.params);
      const consultation = await getPrisma().consultation.findUnique({
        where: { publicId },
        select: { doctorId: true, visitId: true },
      });
      if (!consultation || consultation.doctorId !== principal.organisationId) {
        throw errors.notFound('Attachment not found.');
      }
      const file = await readAttachment(
        attachmentId,
        async (attachment) => attachment.visitId === consultation.visitId,
        { type: 'DOCTOR', userId: principal.userId, correlationId: request.correlationId },
      );
      return sendFile(reply, file, attachmentId);
    },
  );
}
