import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { getEnv } from '../../config/env.ts';
import { getLogger } from '../../lib/logger.ts';
import { resolveSession, SESSION_COOKIE } from '../auth/session.service.ts';
import {
  PATIENT_SESSION_COOKIE,
  resolvePatientSession,
} from '../consultation/access-token.service.ts';

/**
 * Real-time updates (spec §31).
 *
 * Socket.IO on the same HTTP server, authenticated at the handshake with the
 * *same* session cookies as REST — no second token scheme to get wrong.
 *
 * The governing rule for what travels over a socket: **ids and states only**.
 * No clinical content, no patient identifiers, no queue scores. A client that
 * needs detail fetches it over REST, where the ordinary authorization applies
 * (docs/architecture.md §5).
 */

let io: SocketServer | undefined;

/** Rooms. Membership is decided server-side at connect; clients cannot join. */
const consultationRoom = (publicId: string) => `consultation:${publicId}`;
const doctorRoom = (doctorId: string) => `doctor:${doctorId}`;
const pharmacyRoom = (pharmacyId: string) => `pharmacy:${pharmacyId}`;
const ADMIN_ROOM = 'admin';

export function initialiseRealtime(server: HttpServer): SocketServer {
  const env = getEnv();
  const log = getLogger();

  io = new SocketServer(server, {
    path: '/realtime',
    cors: { origin: [env.WEB_ORIGIN], credentials: true },
    serveClient: false,
  });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookies(socket.handshake.headers.cookie);

      // A staff session: join the rooms that principal is entitled to.
      const principal = await resolveSession(cookies[SESSION_COOKIE]);
      if (principal) {
        socket.data.kind = principal.role;
        socket.data.principalId = principal.userId;

        if (principal.role === 'ADMIN') socket.join(ADMIN_ROOM);
        if (principal.role === 'DOCTOR' && principal.organisationId) {
          socket.join(doctorRoom(principal.organisationId));
        }
        if (principal.role === 'PHARMACY' && principal.organisationId) {
          socket.join(pharmacyRoom(principal.organisationId));
        }
        return next();
      }

      // A patient session: scoped to exactly one consultation.
      const patient = await resolvePatientSession(cookies[PATIENT_SESSION_COOKIE]);
      if (patient) {
        socket.data.kind = 'PATIENT';
        socket.data.consultationPublicId = patient.consultationPublicId;
        socket.join(consultationRoom(patient.consultationPublicId));
        return next();
      }

      // Anonymous sockets are refused outright rather than connected and
      // silently starved — a client that cannot subscribe should know.
      next(new Error('unauthenticated'));
    } catch (error) {
      log.warn({ err: error }, 'realtime handshake failed');
      next(new Error('unauthenticated'));
    }
  });

  io.on('connection', (socket: Socket) => {
    log.debug({ kind: socket.data.kind }, 'realtime client connected');

    // Deliberately no client-driven `join`. Room membership is decided above,
    // from the authenticated principal; letting a client name its own room
    // would be a subscription-based information leak.
    socket.on('disconnect', (reason) => {
      log.debug({ kind: socket.data.kind, reason }, 'realtime client disconnected');
    });
  });

  log.info({ path: '/realtime' }, 'realtime server ready');
  return io;
}

export async function closeRealtime(): Promise<void> {
  await io?.close();
  io = undefined;
}

/**
 * Emitters.
 *
 * All are no-ops when the socket server is not running — under test, and in
 * any context where realtime is not wired up. A missing socket must never
 * break a business operation that has already committed.
 */
export function emitToConsultation(publicId: string, event: string, payload: unknown): void {
  io?.to(consultationRoom(publicId)).emit(event, payload);
}

export function emitToDoctor(doctorId: string, event: string, payload: unknown): void {
  io?.to(doctorRoom(doctorId)).emit(event, payload);
}

export function emitToPharmacy(pharmacyId: string, event: string, payload: unknown): void {
  io?.to(pharmacyRoom(pharmacyId)).emit(event, payload);
}

export function emitToAdmins(event: string, payload: unknown): void {
  io?.to(ADMIN_ROOM).emit(event, payload);
}

export function isRealtimeReady(): boolean {
  return io !== undefined;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};

  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([name, value]) => [name, decodeURIComponent(value)]),
  );
}
