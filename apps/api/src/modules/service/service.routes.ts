import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { getBooleanSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS } from '../settings/settings.defaults.ts';
import { createService, listServices, updateService } from './service.service.ts';

/**
 * The service catalogue (v2, docs/v2-patient-direct-plan.md phase 2).
 *
 * The public list is how a patient sees what they can book and what it costs
 * before any payment is asked for, and it stays empty until the patient-direct
 * service is switched on. Administering the catalogue is a money operation and
 * sits behind the settings permission, audited on every change.
 */
export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  const adminOnly = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.SETTINGS_MANAGE] });

  /**
   * Unauthenticated: a patient has no account at the moment they are choosing.
   *
   * `enabled` is stated rather than implied. An empty list because the service
   * is switched off and an empty list because nothing is offered are different
   * facts, and a screen that cannot tell them apart shows the wrong message.
   */
  app.get('/patient/services', async (request, reply) => {
    const enabled = await getBooleanSetting(SETTING_KEYS.CHANNELS_DIRECT_ENABLED);

    return reply.send({
      data: {
        enabled,
        services: enabled ? await listServices({ activeOnly: true }) : [],
      },
      meta: { requestId: request.correlationId },
    });
  });

  app.get('/admin/services', { preHandler: adminOnly }, async (request, reply) => {
    return reply.send({
      data: await listServices(),
      meta: { requestId: request.correlationId },
    });
  });

  app.post('/admin/services', { preHandler: adminOnly }, async (request, reply) => {
    const principal = requireAuth(request);

    const body = z
      .object({
        code: z
          .string()
          .trim()
          .min(3)
          .max(40)
          .regex(/^[A-Z0-9_]+$/, 'Use capitals, digits and underscores.'),
        name: z.string().trim().min(3).max(120),
        description: z.string().trim().max(500).optional(),
        clinic: z.enum(['GENERAL', 'WEIGHT_LOSS']),
        discipline: z.enum(['DOCTOR', 'DIETITIAN', 'TRAINER']),
        // Pesewas, as everywhere else money is handled.
        priceMinor: z.number().int().min(1).max(10_000_000),
        currency: z.string().trim().length(3).toUpperCase().optional(),
        durationSeconds: z.number().int().min(60).max(7200).optional(),
        sortOrder: z.number().int().min(0).max(1000).optional(),
      })
      .parse(request.body);

    const service = await createService(body, {
      adminId: principal.userId,
      correlationId: request.correlationId,
    });

    return reply.status(201).send({ data: service, meta: { requestId: request.correlationId } });
  });

  app.patch('/admin/services/:code', { preHandler: adminOnly }, async (request, reply) => {
    const principal = requireAuth(request);
    const { code } = z.object({ code: z.string().min(1) }).parse(request.params);

    const body = z
      .object({
        name: z.string().trim().min(3).max(120).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        priceMinor: z.number().int().min(1).max(10_000_000).optional(),
        durationSeconds: z.number().int().min(60).max(7200).nullable().optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(1000).optional(),
      })
      .parse(request.body);

    const service = await updateService(code, body, {
      adminId: principal.userId,
      correlationId: request.correlationId,
    });

    return reply.send({ data: service, meta: { requestId: request.correlationId } });
  });
}
