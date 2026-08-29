import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getPaymentProvider, WebhookSignatureError } from '../../adapters/payment/index.ts';
import { getPrisma } from '../../db/prisma.ts';
import { getLogger } from '../../lib/logger.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { handleWebhookEvent } from './payment.service.ts';

/**
 * Payment provider webhooks (spec §34, §59, §68).
 *
 * Three properties this route must have, and does:
 *
 *  1. **Raw body.** Signatures are computed over the exact bytes sent. A
 *     parsed-then-restringified body would not match, so a custom content-type
 *     parser hands the adapter the original Buffer.
 *  2. **Signature before parse.** Nothing in an unauthenticated payload is
 *     trusted, including its shape.
 *  3. **No session, no CSRF.** The provider has neither. The signature *is*
 *     the authentication (docs/api.md §8).
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Preserve the raw bytes for signature verification.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
  );

  app.post('/webhooks/payment', async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body));
    const provider = getPaymentProvider();
    const log = getLogger();

    let event;
    try {
      event = provider.parseWebhook(raw, request.headers);
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        // A bad signature is a security event, not a validation error: it means
        // someone is attempting to forge a payment confirmation (spec §79).
        await recordAudit(
          {
            action: AUDIT_ACTIONS.PAYMENT_ANOMALY,
            actorType: 'SYSTEM',
            outcome: 'DENIED',
            correlationId: request.correlationId,
            metadata: { reason: 'invalid_webhook_signature', provider: provider.name },
          },
          getPrisma(),
        );

        log.warn({ provider: provider.name }, 'rejected webhook with invalid signature');
        return reply.status(401).send({
          error: { code: 'UNAUTHENTICATED', message: 'Invalid signature.' },
          meta: { requestId: request.correlationId },
        });
      }
      throw error;
    }

    const payloadHash = createHash('sha256').update(raw).digest('hex');

    const result = await handleWebhookEvent(
      event,
      provider.name,
      payloadHash,
      request.correlationId,
    );

    // Always 200 once the signature checks out, including for duplicates.
    // A provider that receives an error retries, and retrying a duplicate
    // achieves nothing except more duplicates.
    return reply.status(200).send({
      data: { received: true, processed: result.processed, reason: result.reason },
      meta: { requestId: request.correlationId },
    });
  });
}
