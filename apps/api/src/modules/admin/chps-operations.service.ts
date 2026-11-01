import type { ConsultationChannel } from '@prisma/client';
import type { ChpsFacilityLive, ChpsOperationsOverview, DoctorUtilisation } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { STATION_ONLINE_WINDOW_MS } from '../facility/station.service.ts';
import { HEARTBEAT_STALE_SECONDS } from '../queue/presence.service.ts';

/**
 * Neem operations' live view of CHPS (slice 3c, D86).
 *
 * Read fresh on every request from the same records the facilities and
 * doctors use, so it cannot disagree with what they see. Days are UTC days,
 * which in Ghana are local days.
 */

/** Requested and not yet with a doctor, as the CHO's Today page counts them (D76). */
const WAITING_STATES = ['WAITING_FOR_DOCTOR', 'ASSIGNED', 'REASSIGNING'] as const;
/** Accepted and not finished. */
const WITH_DOCTOR_STATES = ['DOCTOR_ACCEPTED', 'IN_PROGRESS', 'INTERRUPTED', 'COMPLETING'] as const;
/** A visit that has not ended. */
const OPEN_VISIT_STATUSES = ['AWAITING_TRIAGE', 'TRIAGED', 'ESCALATED'] as const;

const latest = (dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((best, date) => (date && (!best || date > best) ? date : best), null);

export async function chpsOperationsOverview(
  utilisationDays: number,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<ChpsOperationsOverview> {
  const now = clock.now();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // "1 day" is today; "7 days" is today and the six before it.
  const periodStart = new Date(today.getTime() - (utilisationDays - 1) * 86_400_000);
  const heartbeatSince = new Date(now.getTime() - HEARTBEAT_STALE_SECONDS * 1000);

  const [facilities, openVisits, visitsToday, liveConsultations, completed, presences] =
    await Promise.all([
      db.facility.findMany({
        where: { type: 'CHPS' },
        include: {
          district: { select: { name: true, region: { select: { name: true } } } },
          stations: {
            where: { revokedAt: null, tokenHash: { not: null } },
            select: { lastSeenAt: true },
          },
          staff: {
            select: {
              user: {
                select: {
                  lastLoginAt: true,
                  sessions: {
                    orderBy: { lastSeenAt: 'desc' },
                    take: 1,
                    select: { lastSeenAt: true },
                  },
                },
              },
            },
          },
        },
      }),
      db.patientVisit.findMany({
        where: { status: { in: [...OPEN_VISIT_STATUSES] } },
        select: { facilityId: true, status: true },
      }),
      db.patientVisit.groupBy({
        by: ['facilityId'],
        where: { arrivedAt: { gte: today } },
        _count: { _all: true },
      }),
      db.consultation.findMany({
        where: {
          channel: 'CHPS',
          state: { in: [...WAITING_STATES, ...WITH_DOCTOR_STATES] },
        },
        select: { facilityId: true, state: true, queuedAt: true, createdAt: true },
      }),
      db.consultation.findMany({
        where: { state: 'COMPLETED', completedAt: { gte: periodStart }, doctorId: { not: null } },
        select: { doctorId: true, channel: true, durationSeconds: true },
      }),
      db.doctorPresence.findMany({
        where: { onlineSince: { not: null }, lastHeartbeatAt: { gte: heartbeatSince } },
        select: { doctorId: true, currentLoad: true, maxLoad: true },
      }),
    ]);

  // ---- facilities -------------------------------------------------------
  const todayCount = new Map(visitsToday.map((row) => [row.facilityId, row._count._all]));

  const rows: ChpsFacilityLive[] = facilities.map((facility) => {
    const mine = openVisits.filter((visit) => visit.facilityId === facility.id);
    const consultations = liveConsultations.filter((c) => c.facilityId === facility.id);
    const waiting = consultations.filter((c) =>
      (WAITING_STATES as readonly string[]).includes(c.state),
    );
    const oldestQueued = waiting
      .map((c) => (c.queuedAt ?? c.createdAt).getTime())
      .reduce<number | null>(
        (oldest, time) => (oldest === null || time < oldest ? time : oldest),
        null,
      );

    return {
      publicId: facility.publicId,
      name: facility.name,
      code: facility.code,
      district: facility.district.name,
      region: facility.district.region.name,
      status: facility.status,
      equipmentStatus: facility.equipmentStatus,
      connectivityStatus: facility.connectivityStatus,
      stations: {
        paired: facility.stations.length,
        online: facility.stations.filter(
          (s) => s.lastSeenAt && now.getTime() - s.lastSeenAt.getTime() < STATION_ONLINE_WINDOW_MS,
        ).length,
        lastSeenAt: latest(facility.stations.map((s) => s.lastSeenAt))?.toISOString() ?? null,
      },
      visitsToday: todayCount.get(facility.id) ?? 0,
      awaitingTriage: mine.filter((visit) => visit.status === 'AWAITING_TRIAGE').length,
      openEmergencies: mine.filter((visit) => visit.status === 'ESCALATED').length,
      waitingForDoctor: waiting.length,
      longestWaitMinutes:
        oldestQueued === null
          ? null
          : Math.max(0, Math.floor((now.getTime() - oldestQueued) / 60_000)),
      withDoctor: consultations.length - waiting.length,
      staffLastActiveAt:
        latest(
          facility.staff.flatMap((member) => [
            member.user.lastLoginAt,
            member.user.sessions[0]?.lastSeenAt,
          ]),
        )?.toISOString() ?? null,
    };
  });

  rows.sort(
    (a, b) =>
      b.openEmergencies - a.openEmergencies ||
      (b.longestWaitMinutes ?? -1) - (a.longestWaitMinutes ?? -1) ||
      a.name.localeCompare(b.name),
  );

  // ---- doctors ----------------------------------------------------------
  const online = new Map(presences.map((p) => [p.doctorId, p]));
  const doctorIds = new Set([...online.keys(), ...completed.map((c) => c.doctorId!)]);
  const doctors =
    doctorIds.size === 0
      ? []
      : await db.doctor.findMany({
          where: { id: { in: [...doctorIds] } },
          select: { id: true, publicId: true, fullName: true },
        });

  const utilisation: DoctorUtilisation[] = doctors.map((doctor) => {
    const done = completed.filter((c) => c.doctorId === doctor.id);
    const byChannel = (channel: ConsultationChannel) =>
      done.filter((c) => c.channel === channel).length;
    const presence = online.get(doctor.id);
    return {
      publicId: doctor.publicId,
      name: doctor.fullName,
      online: Boolean(presence),
      currentLoad: presence?.currentLoad ?? 0,
      maxLoad: presence?.maxLoad ?? 0,
      completed: {
        COUNTER: byChannel('COUNTER'),
        DIRECT: byChannel('DIRECT'),
        CHPS: byChannel('CHPS'),
      },
      consultationMinutes: Math.round(
        done.reduce((sum, c) => sum + (c.durationSeconds ?? 0), 0) / 60,
      ),
    };
  });
  utilisation.sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      b.completed.CHPS +
        b.completed.COUNTER +
        b.completed.DIRECT -
        (a.completed.CHPS + a.completed.COUNTER + a.completed.DIRECT) ||
      a.name.localeCompare(b.name),
  );

  const sum = (pick: (row: ChpsFacilityLive) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);

  return {
    generatedAt: now.toISOString(),
    utilisationDays,
    totals: {
      facilities: rows.length,
      activeFacilities: rows.filter((row) => row.status === 'ACTIVE').length,
      stationsPaired: sum((row) => row.stations.paired),
      stationsOnline: sum((row) => row.stations.online),
      visitsToday: sum((row) => row.visitsToday),
      openEmergencies: sum((row) => row.openEmergencies),
      waitingForDoctor: sum((row) => row.waitingForDoctor),
      withDoctor: sum((row) => row.withDoctor),
      doctorsOnline: presences.length,
    },
    facilities: rows,
    doctors: utilisation,
  };
}
