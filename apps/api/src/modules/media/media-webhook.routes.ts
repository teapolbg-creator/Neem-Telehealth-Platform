import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getEnv } from '../../config/env.ts';
import { getPrisma, isUniqueConstraintError } from '../../db/prisma.ts';
import { getLogger } from '../../lib/logger.ts';
import { systemClock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { emitToDoctor } from '../realtime/realtime.service.ts';
import { recordAttendance } from './media.service.ts';

/**
 * What Whereby tells us about who is in a room (D57).
 *
 * The browser cannot be relied on for this. A closed tab, a phone that dies
 * or a tunnel with no signal all produce exactly nothing, and those are the
 * cases this whole feature exists for. So the provider's own account of who
 * joined and left is taken as the second, better source.
 *
 * **It is attendance, never status.** Nothing here completes a consultation,
 * charges anybody, pays anybody or marks anyone abandoned. A `session.ended`
 * event means the room emptied, which is not the same as care finishing —
 * treating it as completion is precisely the bug this guards against.
 *
 * The shape follows the payment webhook: raw body, signature before parse,
 * insert before handle, always 200 once the signature checks out.
 */

/** Whereby signs `${timestamp}.${rawBody}` with HMAC-SHA256. */
const SIGNATURE_HEADER = 'whereby-signature';

/**
 * How stale a signature may be.
 *
 * Long enough to survive a slow retry, short enough that a captured request
 * cannot be replayed a day later.
 */
const TOLERANCE_SECONDS = 300;

interface WherebyEvent {
  id?: string;
  apiVersion?: string;
  createdAt?: string;
  type?: string;
  data?: {
    roomName?: string;
    roomSessionId?: string;
    meetingId?: string;
    participantId?: string;
    displayName?: string;
    externalId?: string;
    roleName?: string;
    numClients?: number;
  };
}

class WebhookSignatureError extends Error {}

export function verifyWherebySignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
): WherebyEvent {
  if (!header) throw new WebhookSignatureError('No signature header.');

  const parts = new Map(
    header
      .split(',')
      .map((piece) => piece.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );

  const timestamp = parts.get('t');
  const provided = parts.get('v1');
  if (!timestamp || !provided) throw new WebhookSignatureError('Malformed signature header.');

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    throw new WebhookSignatureError('Signature timestamp is outside the accepted window.');
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${raw.toString('utf8')}`)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WebhookSignatureError('Signature does not match.');
  }

  return JSON.parse(raw.toString('utf8')) as WherebyEvent;
}

/**
 * The room name carries our consultation's public id, and nothing else.
 *
 * Rooms are created with a `neem-` prefix and Whereby appends its own
 * identifier, so the mapping back is by the media session we stored rather
 * than by parsing a name we do not control.
 */
async function consultationFor(event: WherebyEvent) {
  const meetingId = event.data?.meetingId;
  const roomName = event.data?.roomName;

  const session = await getPrisma().mediaSession.findFirst({
    where: meetingId
      ? { providerRoomRef: meetingId }
      : roomName
        ? { providerRoomRef: { contains: roomName.replace(/^\//, '') } }
        : { id: '__none__' },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      consultationId: true,
      consultation: { select: { publicId: true, state: true, doctorId: true } },
    },
  });

  return session;
}

/**
 * Which side of the consultation this participant is.
 *
 * Rooms are joined through a host URL for the doctor and a plain one for the
 * patient, which is what Whereby reports as the role. Anything it does not
 * recognise is treated as the patient: assuming a stranger is the doctor
 * would let an attendance record claim clinical presence.
 */
function participantOf(event: WherebyEvent): 'PATIENT' | 'DOCTOR' {
  const role = event.data?.roleName?.toLowerCase();
  return role === 'host' || role === 'owner' ? 'DOCTOR' : 'PATIENT';
}

export async function mediaWebhookRoutes(app: FastifyInstance): Promise<void> {
  const env = getEnv();
  const log = getLogger();

  // The signature is over the bytes as they arrived, so the body must not be
  // parsed before it is checked.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.post('/webhooks/whereby', async (request, reply) => {
    const secret = env.WHEREBY_WEBHOOK_SECRET;
    if (!secret) {
      // Not configured is not an error to the sender: answering 200 stops
      // Whereby retrying something this deployment has deliberately not set up.
      return reply.send({ data: { received: true, processed: false, reason: 'not_configured' } });
    }

    const raw = request.body as Buffer;
    let event: WherebyEvent;

    try {
      event = verifyWherebySignature(raw, request.headers[SIGNATURE_HEADER] as string, secret);
    } catch (error) {
      await recordAudit({
        action: AUDIT_ACTIONS.MEDIA_WEBHOOK_REJECTED,
        actorType: 'SYSTEM',
        outcome: 'DENIED',
        correlationId: request.correlationId,
        metadata: { reason: 'invalid_webhook_signature', provider: 'whereby' },
      });
      log.warn({ err: error }, 'rejected a Whereby webhook');

      return reply
        .status(401)
        .send({ error: { code: 'UNAUTHENTICATED', message: 'Invalid signature.' } });
    }

    const payloadHash = createHash('sha256').update(raw).digest('hex');
    const type = event.type ?? 'unknown';
    /*
     * Whereby's own id where it sends one, and otherwise something stable
     * derived from the event itself — a duplicate delivery has to collide
     * with the first, or the point of the ledger is lost.
     */
    const providerEventId = event.id ?? `${type}:${payloadHash}`;

    try {
      await getPrisma().mediaWebhookEvent.create({
        data: {
          provider: 'whereby',
          providerEventId,
          eventType: type,
          signatureValid: true,
          payloadHash,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return reply.send({ data: { received: true, processed: false, reason: 'duplicate' } });
      }
      throw error;
    }

    let result = 'ignored';
    try {
      result = await handle(event, type, request.correlationId);
    } catch (error) {
      log.warn({ err: error, type }, 'could not handle a Whereby webhook');
      result = 'failed';
    }

    await getPrisma().mediaWebhookEvent.updateMany({
      where: { provider: 'whereby', providerEventId },
      data: { processedAt: systemClock.now(), processingResult: result.slice(0, 80) },
    });

    return reply.send({ data: { received: true, processed: result !== 'failed', reason: result } });
  });
}

async function handle(event: WherebyEvent, type: string, correlationId?: string): Promise<string> {
  const session = await consultationFor(event);
  if (!session?.consultation) return 'unknown_room';

  const { consultationId } = session;
  const participant = participantOf(event);

  /*
   * A late event must never reopen what is finished.
   *
   * Whereby retries, and a delivery can arrive minutes after a doctor has
   * completed the consultation. Attendance for a finished consultation is
   * simply not recorded: there is nothing it could usefully say, and plenty
   * it could wrongly imply.
   */
  const state = session.consultation.state;
  if (
    state === 'COMPLETED' ||
    state === 'CANCELLED' ||
    state === 'EXPIRED' ||
    state === 'REFUNDED' ||
    state === 'ABANDONED'
  ) {
    return 'consultation_closed';
  }

  if (type === 'room.client.joined') {
    await recordAttendance({
      consultationId,
      mediaSessionId: session.id,
      participant,
      event: 'JOINED',
      source: 'WEBHOOK',
      providerSessionRef: event.data?.roomSessionId ?? null,
    });
    return 'joined';
  }

  if (type === 'room.client.left') {
    await recordAttendance({
      consultationId,
      mediaSessionId: session.id,
      participant,
      event: 'LEFT',
      source: 'WEBHOOK',
      providerSessionRef: event.data?.roomSessionId ?? null,
    });

    /*
     * The doctor is told, and decides. This is the case the browser cannot
     * report: a patient whose phone died sends nothing at all.
     */
    if (participant === 'PATIENT' && session.consultation.doctorId) {
      emitToDoctor(session.consultation.doctorId, 'consultation.patient_left', {
        consultationPublicId: session.consultation.publicId,
      });
    }
    return 'left';
  }

  if (type === 'room.session.ended') {
    /*
     * The room emptied. That is all it means.
     *
     * Not completion, not abandonment, not a reason to charge or pay anybody.
     * The consultation stays exactly as it is until a doctor acts.
     */
    await recordAttendance({
      consultationId,
      mediaSessionId: session.id,
      participant,
      event: 'SESSION_ENDED',
      source: 'WEBHOOK',
      providerSessionRef: event.data?.roomSessionId ?? null,
    });

    await recordAudit({
      action: AUDIT_ACTIONS.CALL_ROOM_SESSION_ENDED,
      actorType: 'SYSTEM',
      entityType: 'consultation',
      entityId: consultationId,
      correlationId,
      metadata: { note: 'room emptied; consultation left unchanged' },
    });
    return 'session_ended';
  }

  return 'ignored';
}
