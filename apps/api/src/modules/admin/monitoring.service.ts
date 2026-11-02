import type { UserRole } from '@prisma/client';
import type { SecurityEvent, SystemMonitoring } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS } from '../audit/audit.service.ts';
import { STATION_ONLINE_WINDOW_MS, toDevice, toLink } from '../facility/station.service.ts';
import { HEARTBEAT_STALE_SECONDS } from '../queue/presence.service.ts';

/**
 * System monitoring (slice 3d, D87): what the system has already written,
 * counted. Nothing new is collected for this page except refused station
 * pairings, which were not recorded before.
 */

const SECURITY_ACTIONS = {
  [AUDIT_ACTIONS.LOGIN_FAILED]: 'Sign-in failed',
  [AUDIT_ACTIONS.LOGIN_LOCKED]: 'Account locked',
  [AUDIT_ACTIONS.TWO_FACTOR_FAILED]: 'Wrong 2FA code',
  [AUDIT_ACTIONS.STATION_PAIRING_REFUSED]: 'Station pairing refused',
} as const;

/** How many security events the super administrator sees listed. */
const RECENT_SECURITY_EVENTS = 50;

const STAFF_ROLES: UserRole[] = [
  'ADMIN',
  'OPS_ADMIN',
  'DOCTOR',
  'PHARMACY',
  'FACILITY',
  'DISTRICT',
];

export async function systemMonitoring(
  windowHours: number,
  options: { includeSecurityEvents: boolean },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<SystemMonitoring> {
  const now = clock.now();
  const since = new Date(now.getTime() - windowHours * 3_600_000);
  const heartbeatSince = new Date(now.getTime() - HEARTBEAT_STALE_SECONDS * 1000);
  const securityWhere = {
    action: { in: Object.keys(SECURITY_ACTIONS) },
    occurredAt: { gte: since },
  };

  const [
    sessions,
    presences,
    stations,
    roomsOpened,
    activeVideoSessions,
    interruptions,
    roomsReplaced,
    failedNotifications,
    webhooks,
    securityCounts,
    recentSecurity,
  ] = await Promise.all([
    db.session.findMany({
      where: {
        revokedAt: null,
        expiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
        user: { role: { in: STAFF_ROLES } },
      },
      select: { user: { select: { role: true } } },
    }),
    db.doctorPresence.findMany({
      where: { onlineSince: { not: null } },
      select: { lastHeartbeatAt: true },
    }),
    db.facilityStation.findMany({
      where: { revokedAt: null, tokenHash: { not: null } },
      select: {
        publicId: true,
        label: true,
        lastSeenAt: true,
        linkMeasuredAt: true,
        linkDownKbps: true,
        linkUpKbps: true,
        linkRttMs: true,
        deviceBatteryPercent: true,
        deviceCharging: true,
        deviceHasCamera: true,
        deviceHasMicrophone: true,
        deviceBrowser: true,
        facility: { select: { name: true, publicId: true } },
      },
    }),
    db.mediaSession.count({ where: { startedAt: { gte: since } } }),
    db.mediaSession.count({ where: { endedAt: null } }),
    db.consultationStateEvent.count({
      where: { toState: 'INTERRUPTED', accepted: true, occurredAt: { gte: since } },
    }),
    db.mediaSession.count({ where: { endReason: 'room_replaced', endedAt: { gte: since } } }),
    db.notification.groupBy({
      by: ['channel'],
      where: { status: 'FAILED', createdAt: { gte: since } },
      _count: { _all: true },
    }),
    db.mediaWebhookEvent.groupBy({
      by: ['signatureValid'],
      where: { receivedAt: { gte: since } },
      _count: { _all: true },
    }),
    db.auditLog.groupBy({ by: ['action'], where: securityWhere, _count: { _all: true } }),
    options.includeSecurityEvents
      ? db.auditLog.findMany({
          where: securityWhere,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          take: RECENT_SECURITY_EVENTS,
          select: { occurredAt: true, action: true, actorId: true, metadata: true },
        })
      : Promise.resolve(null),
  ]);

  // ---- sessions ---------------------------------------------------------
  const byRole: Partial<Record<UserRole, number>> = {};
  for (const session of sessions) {
    byRole[session.user.role] = (byRole[session.user.role] ?? 0) + 1;
  }

  // ---- stations ---------------------------------------------------------
  const isOnline = (lastSeenAt: Date | null) =>
    lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() < STATION_ONLINE_WINDOW_MS;
  const offline = stations
    .filter((station) => !isOnline(station.lastSeenAt))
    .sort((a, b) => (a.lastSeenAt?.getTime() ?? 0) - (b.lastSeenAt?.getTime() ?? 0))
    .map((station) => ({
      publicId: station.publicId,
      label: station.label,
      facilityName: station.facility.name,
      facilityPublicId: station.facility.publicId,
      lastSeenAt: station.lastSeenAt?.toISOString() ?? null,
    }));

  // ---- security ---------------------------------------------------------
  const countOf = (action: string) =>
    securityCounts.find((row) => row.action === action)?._count._all ?? 0;

  let recent: SecurityEvent[] | null = null;
  if (recentSecurity) {
    const actorIds = [
      ...new Set(recentSecurity.map((row) => row.actorId).filter((id): id is string => !!id)),
    ];
    const accounts = actorIds.length
      ? await db.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, email: true, role: true },
        })
      : [];
    const accountOf = new Map(accounts.map((account) => [account.id, account]));
    recent = recentSecurity.map((row) => {
      const account = row.actorId ? accountOf.get(row.actorId) : undefined;
      const metadata = (row.metadata ?? {}) as { reason?: unknown };
      return {
        occurredAt: row.occurredAt.toISOString(),
        action: row.action,
        label: SECURITY_ACTIONS[row.action as keyof typeof SECURITY_ACTIONS] ?? row.action,
        account: account ? { email: account.email, role: account.role } : null,
        reason: typeof metadata.reason === 'string' ? metadata.reason : null,
      };
    });
  }

  const webhookCount = (valid: boolean) =>
    webhooks.find((row) => row.signatureValid === valid)?._count._all ?? 0;

  return {
    generatedAt: now.toISOString(),
    windowHours,
    sessions: { active: sessions.length, byRole },
    doctors: {
      online: presences.filter((p) => p.lastHeartbeatAt && p.lastHeartbeatAt >= heartbeatSince)
        .length,
      staleHeartbeat: presences.filter(
        (p) => !p.lastHeartbeatAt || p.lastHeartbeatAt < heartbeatSince,
      ).length,
    },
    stations: {
      paired: stations.length,
      online: stations.length - offline.length,
      offline,
      all: stations.map((station) => ({
        publicId: station.publicId,
        label: station.label,
        facilityName: station.facility.name,
        facilityPublicId: station.facility.publicId,
        online: isOnline(station.lastSeenAt),
        lastSeenAt: station.lastSeenAt?.toISOString() ?? null,
        link: toLink(station),
        device: toDevice(station),
      })),
    },
    activeVideoSessions,
    calls: { roomsOpened, interruptions, roomsReplaced },
    notifications: {
      failed: failedNotifications.reduce((sum, row) => sum + row._count._all, 0),
      byChannel: Object.fromEntries(
        failedNotifications.map((row) => [row.channel, row._count._all]),
      ),
    },
    webhooks: {
      received: webhookCount(true) + webhookCount(false),
      invalidSignatures: webhookCount(false),
    },
    security: {
      loginFailures: countOf(AUDIT_ACTIONS.LOGIN_FAILED),
      lockouts: countOf(AUDIT_ACTIONS.LOGIN_LOCKED),
      twoFactorFailures: countOf(AUDIT_ACTIONS.TWO_FACTOR_FAILED),
      pairingRefusals: countOf(AUDIT_ACTIONS.STATION_PAIRING_REFUSED),
      recent,
    },
  };
}
