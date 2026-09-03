import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { NOTIFICATION_TEMPLATES, validateTemplateBody } from './templates.ts';

/**
 * Notification template administration (spec §58, §60).
 *
 * Deliberately absent: any route that lists what was sent. `notifications`
 * holds a hash rather than a body, so there is nothing to list — see decision
 * D32. The log answers "was this sent" and "did it fail", and cannot
 * reconstruct what it said.
 *
 * An administrator may reword a notification. They may not make one carry
 * clinical content: every save is validated against the same rules the
 * catalogue is, and a body that fails them is refused rather than saved and
 * discovered later.
 */
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const adminOnly = guard({
    roles: ['ADMIN'],
    permissions: [PERMISSIONS.NOTIFICATION_TEMPLATE_MANAGE],
  });

  app.get('/admin/notification-templates', { preHandler: adminOnly }, async (request, reply) => {
    const rows = await getPrisma().notificationTemplate.findMany({
      orderBy: [{ code: 'asc' }, { channel: 'asc' }],
    });

    return reply.send({
      data: rows.map((row) => {
        const definition = NOTIFICATION_TEMPLATES.find((entry) => entry.code === row.code);

        return {
          code: row.code,
          channel: row.channel,
          locale: row.locale,
          subject: row.subject,
          body: row.body,
          isActive: row.isActive,
          updatedAt: row.updatedAt.toISOString(),
          // What this notification is for, and what it may say. Shown beside
          // the editor so an author is not guessing.
          description: definition?.description ?? null,
          variables: definition?.variables ?? [],
          /** True when the wording still matches what Neem shipped. */
          isDefault: definition ? row.body === definition.body : false,
        };
      }),
      meta: { requestId: request.correlationId },
    });
  });

  app.patch(
    '/admin/notification-templates/:code/:channel',
    { preHandler: adminOnly },
    async (request, reply) => {
      const principal = requireAuth(request);
      const params = z
        .object({ code: z.string().min(1), channel: z.string().min(1) })
        .parse(request.params);

      const body = z
        .object({
          subject: z.string().trim().max(200).nullable().optional(),
          body: z.string().trim().min(1).max(2000).optional(),
          isActive: z.boolean().optional(),
        })
        .parse(request.body);

      const definition = NOTIFICATION_TEMPLATES.find((entry) => entry.code === params.code);
      if (!definition) throw errors.notFound('No such notification.');

      /**
       * Validated before it is saved, not before it is sent.
       *
       * A template carrying clinical content is a defect the moment it exists;
       * catching it at send time would mean it had already been reviewed,
       * approved and left in place.
       */
      if (body.body !== undefined) {
        const problems = validateTemplateBody(body.body, definition.variables);
        if (problems.length > 0) {
          throw errors.validation(
            problems.map((problem) => ({ field: 'body', issue: problem.problem })),
          );
        }
      }
      if (body.subject) {
        const problems = validateTemplateBody(body.subject, definition.variables);
        if (problems.length > 0) {
          throw errors.validation(
            problems.map((problem) => ({ field: 'subject', issue: problem.problem })),
          );
        }
      }

      const updated = await getPrisma().notificationTemplate.update({
        where: {
          code_channel_locale: {
            code: params.code,
            // Prisma's enum; an unknown channel fails the lookup as a 404.
            channel: params.channel as never,
            locale: 'en',
          },
        },
        data: {
          ...(body.subject !== undefined ? { subject: body.subject } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          updatedByAdminId: principal.userId,
        },
      });

      await recordAudit(
        {
          action: AUDIT_ACTIONS.NOTIFICATION_TEMPLATE_CHANGED,
          actorType: 'ADMIN',
          actorId: principal.userId,
          entityType: 'notification_template',
          entityId: updated.id,
          // Which template changed, never the wording — an audit log that
          // recorded message bodies would be the archive D32 refuses.
          metadata: { code: params.code, channel: params.channel, isActive: updated.isActive },
        },
        getPrisma(),
      );

      return reply.send({
        data: { code: updated.code, channel: updated.channel, isActive: updated.isActive },
        meta: { requestId: request.correlationId },
      });
    },
  );
}
