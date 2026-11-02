import type { Prisma } from '@prisma/client';
import { startOfDay } from 'date-fns';
import type { DoctorHistory, DoctorHistoryQuery } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { decryptField } from '../../lib/crypto.ts';
import { OCCUPYING_CONSULTATION_STATES } from '../../domain/consultation-state.ts';
import { nameToken, nameWords, normalisePatientNumber } from '../facility/patient.service.ts';

/**
 * A doctor's own consultations (slice 5a, brief §B5, D91).
 *
 * The doctor comes from the session, so nothing here can reach another's. This
 * is the list, not the record: opening a consultation is what is logged.
 */

const PAGE_SIZE = 30;

export async function doctorHistory(
  doctorId: string,
  query: DoctorHistoryQuery,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<DoctorHistory> {
  const now = clock.now();

  // An offer they have not accepted is not theirs yet.
  const mine: Prisma.ConsultationWhereInput = { doctorId, state: { not: 'ASSIGNED' } };
  const where: Prisma.ConsultationWhereInput = { ...mine };

  if (query.facility) where.facility = { publicId: query.facility };
  if (query.from || query.to) {
    where.createdAt = {
      ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
      ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
    };
  }
  if (query.patient) {
    const number = normalisePatientNumber(query.patient);
    where.chpsPatient = number.startsWith('NM-')
      ? { patientNumber: number }
      : { nameTokens: { hasEvery: nameWords(query.patient).map(nameToken) } };
  }

  const [rows, facilities, pending, active, completedToday, completedTotal] = await Promise.all([
    db.consultation.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        publicId: true,
        channel: true,
        state: true,
        type: true,
        createdAt: true,
        completedAt: true,
        facility: { select: { name: true } },
        pharmacy: { select: { name: true } },
        chpsPatient: { select: { fullNameEnc: true, patientNumber: true } },
      },
    }),
    db.facility.findMany({
      where: { consultations: { some: mine } },
      orderBy: { name: 'asc' },
      select: { publicId: true, name: true },
    }),
    db.consultationAssignment.count({
      where: {
        doctorId,
        result: 'PENDING',
        respondByAt: { gt: now },
        consultation: { state: 'ASSIGNED' },
      },
    }),
    db.consultation.count({
      where: { doctorId, state: { in: [...OCCUPYING_CONSULTATION_STATES], not: 'ASSIGNED' } },
    }),
    db.consultation.count({ where: { doctorId, completedAt: { gte: startOfDay(now) } } }),
    db.consultation.count({ where: { doctorId, completedAt: { not: null } } }),
  ]);

  const page = rows.slice(0, PAGE_SIZE);

  return {
    workload: { pending, active, completedToday, completedTotal },
    facilities,
    rows: page.map((row) => ({
      publicId: row.publicId,
      channel: row.channel,
      state: row.state,
      type: row.type,
      origin: row.facility?.name ?? row.pharmacy?.name ?? null,
      patientName: row.chpsPatient ? decryptField(row.chpsPatient.fullNameEnc) : null,
      patientNumber: row.chpsPatient?.patientNumber ?? null,
      requestedAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    })),
    nextCursor: rows.length > PAGE_SIZE ? (page[page.length - 1]?.id ?? null) : null,
  };
}
