import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { getPrisma } from '../../db/prisma.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { listSettings, updateSetting } from '../settings/settings.service.ts';
import { SETTING_KEYS, type SettingKey } from '../settings/settings.defaults.ts';
import {
  financialSummary,
  last30Days,
  operationalSummary,
  outcomeMix,
  satisfactionSummary,
  type Period,
} from './analytics.service.ts';

/**
 * Admin analytics and configuration (spec §54, §96, §100).
 *
 * Deliberately absent: any route that reports a diagnosis, a medication or a
 * test result, in aggregate or otherwise. There is no query behind one — a
 * "most common condition" chart is a medical history with a bar chart on top
 * (spec §13).
 */

const periodQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function resolvePeriod(query: { from?: Date; to?: Date }): Period {
  const fallback = last30Days();
  return { from: query.from ?? fallback.from, to: query.to ?? fallback.to };
}

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  const analyticsOnly = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.ANALYTICS_READ] });
  const settingsOnly = guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.SETTINGS_MANAGE] });

  app.get('/admin/analytics/operational', { preHandler: analyticsOnly }, async (request, reply) => {
    const period = resolvePeriod(periodQuery.parse(request.query));

    return reply.send({
      data: await operationalSummary(period),
      meta: { requestId: request.correlationId },
    });
  });

  app.get(
    '/admin/analytics/financial',
    { preHandler: guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.FINANCE_READ_ALL] }) },
    async (request, reply) => {
      const period = resolvePeriod(periodQuery.parse(request.query));

      return reply.send({
        data: await financialSummary(period),
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.get(
    '/admin/analytics/satisfaction',
    { preHandler: guard({ roles: ['ADMIN'], permissions: [PERMISSIONS.QUALITY_READ] }) },
    async (request, reply) => {
      const period = resolvePeriod(periodQuery.parse(request.query));

      return reply.send({
        data: await satisfactionSummary(period),
        meta: { requestId: request.correlationId },
      });
    },
  );

  /**
   * What consultations concluded with, and how much of the period's clinical
   * data still exists.
   *
   * The coverage figure travels with the mix so the screen can say plainly
   * when a period is no longer complete, rather than presenting a partial
   * total as a whole one (the Phase 9 exit criterion).
   */
  app.get('/admin/analytics/outcomes', { preHandler: analyticsOnly }, async (request, reply) => {
    const period = resolvePeriod(periodQuery.parse(request.query));

    return reply.send({
      data: await outcomeMix(period),
      meta: { requestId: request.correlationId },
    });
  });

  /*
   * There is deliberately no `GET /admin/analytics/coverage`.
   *
   * It existed and returned exactly what `/outcomes` already carries — the
   * same `clinicalCoverage(period)` value, with none of the context that
   * makes it meaningful. Nothing called it. Two endpoints for one figure is
   * two places for the figure to disagree, and the coverage number exists
   * precisely so a period whose records have been destroyed cannot be read as
   * a whole one (the Phase 9 exit criterion). It travels with the mix it
   * qualifies.
   */

  // -------------------------------------------------------------------------
  // Settings (spec §96)
  // -------------------------------------------------------------------------

  app.get('/admin/settings', { preHandler: settingsOnly }, async (request, reply) => {
    const settings = await listSettings();

    return reply.send({
      data: settings.map((setting) => ({
        key: setting.key,
        value: setting.value,
        valueType: setting.valueType,
        category: setting.category,
        description: setting.description,
        /**
         * Whether changing this needs a reason.
         *
         * Flagged on the setting itself rather than inferred by the screen, so
         * a new sensitive setting is protected the moment it is seeded and not
         * when someone remembers to update a list in the UI (spec §96).
         */
        requiresConfirm: setting.requiresConfirm,
        updatedAt: setting.updatedAt.toISOString(),
      })),
      meta: { requestId: request.correlationId },
    });
  });

  app.patch('/admin/settings/:key', { preHandler: settingsOnly }, async (request, reply) => {
    const principal = requireAuth(request);
    // Validated against the real catalogue, so an unknown key is a 400 rather
    // than reaching the service and becoming a 404 about a setting that never
    // existed.
    const { key } = z
      .object({ key: z.enum(Object.values(SETTING_KEYS) as [SettingKey, ...SettingKey[]]) })
      .parse(request.params);
    const body = z
      .object({ value: z.unknown(), reason: z.string().trim().max(500).optional() })
      .parse(request.body);

    // `updateSetting` refuses a sensitive change with no reason and writes the
    // previous value to append-only history (spec §96).
    await updateSetting(key, body.value, { adminId: principal.userId, reason: body.reason });

    return reply.send({ data: { key }, meta: { requestId: request.correlationId } });
  });

  /** What a setting used to be, and who changed it. */
  app.get('/admin/settings/:key/history', { preHandler: settingsOnly }, async (request, reply) => {
    const { key } = z.object({ key: z.string().min(1) }).parse(request.params);

    const history = await getPrisma().systemSettingHistory.findMany({
      where: { key },
      orderBy: { changedAt: 'desc' },
      take: 50,
    });

    return reply.send({
      data: history.map((entry) => ({
        oldValue: entry.oldValue,
        newValue: entry.newValue,
        reason: entry.reason,
        changedAt: entry.changedAt.toISOString(),
      })),
      meta: { requestId: request.correlationId },
    });
  });
}
