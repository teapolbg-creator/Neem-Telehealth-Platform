import { subDays } from 'date-fns';
import { FEED_EVENT_LABELS, isAdminRole, type Feed, type FeedEventType } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { decryptField } from '../../lib/crypto.ts';
import type { AuthenticatedPrincipal } from '../auth/session.service.ts';

/**
 * The in-app notification feed (slice 5b, brief §9, D92).
 *
 * The durable surface D32 asked for is still the work itself: this says that
 * something happened and leads to it. Nothing here is the only place anything
 * is recorded, so it can be kept briefly and lost without harm.
 */

const FEED_LENGTH = 30;
const KEEP_DAYS = 90;

export const facilityAudience = (facilityId: string) => `FACILITY:${facilityId}`;
export const doctorAudience = (doctorId: string) => `DOCTOR:${doctorId}`;
export const ADMIN_AUDIENCE = 'ADMINS';

export async function publishFeedEvent(
  audience: string,
  type: FeedEventType,
  reference: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  await db.feedEvent.create({ data: { audience, type, reference, occurredAt: clock.now() } });
}

function audienceOf(principal: AuthenticatedPrincipal): string | null {
  if (isAdminRole(principal.role)) return ADMIN_AUDIENCE;
  if (!principal.organisationId) return null;
  if (principal.role === 'FACILITY') return facilityAudience(principal.organisationId);
  if (principal.role === 'DOCTOR') return doctorAudience(principal.organisationId);
  return null;
}

/** Where an entry leads and what it names, from the records as they stand. */
async function describe(
  audience: string,
  rows: Array<{ type: string; reference: string }>,
  db: Db,
): Promise<
  (row: { type: string; reference: string }) => Pick<Feed['items'][number], 'detail' | 'href'>
> {
  const references = [...new Set(rows.map((row) => row.reference))];

  if (audience.startsWith('FACILITY:')) {
    const patients = await db.patient.findMany({
      where: {
        patientNumber: { in: references },
        facilityId: audience.slice('FACILITY:'.length),
      },
      select: { patientNumber: true, fullNameEnc: true },
    });
    const names = new Map(
      patients.map((patient) => [patient.patientNumber, decryptField(patient.fullNameEnc)]),
    );
    return (row) => ({
      detail: names.get(row.reference) ?? null,
      href: names.has(row.reference) ? `/facility/patients/${row.reference}` : null,
    });
  }

  if (audience.startsWith('DOCTOR:')) {
    const consultations = await db.consultation.findMany({
      where: { publicId: { in: references } },
      select: {
        publicId: true,
        doctorId: true,
        facility: { select: { name: true } },
        pharmacy: { select: { name: true } },
      },
    });
    const byReference = new Map(consultations.map((row) => [row.publicId, row]));
    const doctorId = audience.slice('DOCTOR:'.length);
    return (row) => {
      const consultation = byReference.get(row.reference);
      return {
        detail: consultation?.facility?.name ?? consultation?.pharmacy?.name ?? null,
        // A request they have not accepted opens from the queue, if it is still open.
        href:
          consultation?.doctorId === doctorId && row.type !== 'CONSULTATION_OFFERED'
            ? `/doctor/consultations/${row.reference}`
            : row.type === 'CONSULTATION_OFFERED'
              ? '/doctor/queue'
              : null,
      };
    };
  }

  const doctors = await db.doctor.findMany({
    where: { id: { in: references } },
    select: { id: true, fullName: true },
  });
  const doctorNames = new Map(doctors.map((doctor) => [doctor.id, doctor.fullName]));
  return (row) =>
    doctorNames.has(row.reference)
      ? { detail: doctorNames.get(row.reference)!, href: null }
      : { detail: row.reference, href: '/admin/monitoring' };
}

export async function readFeed(
  principal: AuthenticatedPrincipal,
  db: Db = getPrisma(),
): Promise<Feed> {
  const audience = audienceOf(principal);
  if (!audience) return { unread: 0, items: [] };

  const user = await db.user.findUniqueOrThrow({
    where: { id: principal.userId },
    select: { feedReadAt: true, createdAt: true },
  });
  const [rows, unread] = await Promise.all([
    db.feedEvent.findMany({
      where: { audience },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: FEED_LENGTH,
    }),
    db.feedEvent.count({
      where: { audience, occurredAt: { gt: user.feedReadAt ?? user.createdAt } },
    }),
  ]);
  const describeRow = await describe(audience, rows, db);

  return {
    unread,
    items: rows.map((row) => ({
      id: row.id,
      type: row.type as FeedEventType,
      label: FEED_EVENT_LABELS[row.type as FeedEventType] ?? row.type,
      ...describeRow(row),
      occurredAt: row.occurredAt.toISOString(),
    })),
  };
}

export async function markFeedRead(
  principal: AuthenticatedPrincipal,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  await db.user.update({ where: { id: principal.userId }, data: { feedReadAt: clock.now() } });
}

export async function purgeOldFeedEvents(
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<number> {
  const { count } = await db.feedEvent.deleteMany({
    where: { occurredAt: { lt: subDays(clock.now(), KEEP_DAYS) } },
  });
  return count;
}
