import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@neem/contracts';
import { getPrisma } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { guard, requireAuth } from '../../middleware/auth.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import {
  NOTIFICATION_TEMPLATES,
  TEMPLATES_WITHOUT_PRODUCER,
  validateTemplateBody,
} from './templates.ts';

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

  /**
   * Every notification Neem can send.
   *
   * Listed from the **catalogue**, not from the table. `notify()` reads the
   * catalogue and treats a row as an override (see `notification.service.ts`),
   * so a template with no row is still sent — it is simply unedited. Listing
   * the table instead made those invisible here, which is a screen that
   * disagrees with the system it administers.
   *
   * That is not hypothetical: it is exactly what happened on a database
   * seeded before these templates existed. The screen opened empty while
   * every message was being sent correctly.
   */
  app.get('/admin/notification-templates', { preHandler: adminOnly }, async (request, reply) => {
    const rows = await getPrisma().notificationTemplate.findMany();
    const overrides = new Map(rows.map((row) => [`${row.code}|${row.channel}`, row]));

    const data = NOTIFICATION_TEMPLATES.flatMap((definition) =>
      definition.channels.map((channel) => {
        const override = overrides.get(`${definition.code}|${channel}`);

        const subject = override?.subject ?? definition.subject ?? null;
        const body = override?.body ?? definition.body;

        return {
          code: definition.code,
          channel,
          locale: definition.locale,
          subject,
          body,
          // A template nobody has edited is on, because that is how it is
          // sent. Absence of a row is "untouched", never "disabled".
          isActive: override?.isActive ?? true,
          updatedAt: override?.updatedAt.toISOString() ?? null,
          // What this notification is for, and what it may say. Shown beside
          // the editor so an author is not guessing.
          description: definition.description,
          variables: definition.variables,
          /** True when the wording still matches what Neem shipped. */
          isDefault: body === definition.body && subject === (definition.subject ?? null),
          /**
           * False when nothing in Neem sends this message today.
           *
           * Reported because the alternative is a screen that invites an
           * administrator to word a notification with care and never tells
           * them it will not be delivered. See TEMPLATES_WITHOUT_PRODUCER.
           */
          hasProducer: !TEMPLATES_WITHOUT_PRODUCER.has(definition.code),
        };
      }),
    );

    data.sort((a, b) => a.code.localeCompare(b.code) || a.channel.localeCompare(b.channel));

    return reply.send({ data, meta: { requestId: request.correlationId } });
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

      // A template is only sent on the channels it declares, so editing it on
      // any other channel would write a row nothing ever reads.
      if (!definition.channels.includes(params.channel as never)) {
        throw errors.notFound('This notification is not sent on that channel.');
      }

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

      /**
       * Upsert, because the row is an override that may not exist yet.
       *
       * `update` failed outright for any template nobody had edited, which
       * made the first edit of a notification impossible — the one case that
       * is guaranteed to happen to every template exactly once. The created
       * row starts from the catalogue so an edit to the body alone does not
       * blank the subject.
       */
      const updated = await getPrisma().notificationTemplate.upsert({
        where: {
          code_channel_locale: {
            code: params.code,
            channel: params.channel as never,
            locale: definition.locale,
          },
        },
        update: {
          ...(body.subject !== undefined ? { subject: body.subject } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          updatedByAdminId: principal.userId,
        },
        create: {
          code: params.code,
          channel: params.channel as never,
          locale: definition.locale,
          subject: body.subject !== undefined ? body.subject : (definition.subject ?? null),
          body: body.body ?? definition.body,
          isActive: body.isActive ?? true,
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
