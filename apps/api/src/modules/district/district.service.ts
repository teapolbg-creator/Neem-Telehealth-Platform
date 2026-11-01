import type { Prisma } from '@prisma/client';
import type {
  DistrictOverview,
  DistrictReport,
  DistrictReportQuery,
  GeoScopeLevel,
} from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { toScopeView } from '../admin/staff-account.service.ts';
import { facilityInclude, toSummary } from '../facility/facility.service.ts';
import {
  recordsFor,
  reportPeriod,
  reportRecords,
  reportTotals,
} from '../facility/report.service.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';

/**
 * What a district health officer may see (CHPS slice 3a, D84).
 *
 * Their area is read from the database on every call, never from the session
 * or the URL, so a changed scope takes effect at once and nobody can widen
 * theirs by editing a request.
 */

export interface OfficerScope {
  level: GeoScopeLevel;
  regionId: string;
  districtId: string | null;
  subDistrictId: string | null;
}

export async function officerScope(userId: string, db: Db = getPrisma()): Promise<OfficerScope> {
  const officer = await db.districtOfficer.findUnique({ where: { userId } });
  // A DISTRICT user with no profile is misconfigured; they see nothing.
  if (!officer) throw errors.notFound('No district is assigned to this account.');
  return {
    level: officer.scopeLevel,
    regionId: officer.regionId,
    districtId: officer.districtId,
    subDistrictId: officer.subDistrictId,
  };
}

/** The facilities inside the area: one equality on its narrowest column. */
export function facilitiesInScope(scope: OfficerScope): Prisma.FacilityWhereInput {
  switch (scope.level) {
    case 'SUB_DISTRICT':
      return { subDistrictId: scope.subDistrictId! };
    case 'DISTRICT':
      return { districtId: scope.districtId! };
    case 'REGION':
      return { district: { regionId: scope.regionId } };
  }
}

const scopeViewInclude = {
  region: { select: { id: true, name: true } },
  district: { select: { id: true, name: true } },
  subDistrict: { select: { id: true, name: true } },
} satisfies Prisma.DistrictOfficerInclude;

async function officerWithScope(userId: string, db: Db) {
  const officer = await db.districtOfficer.findUnique({
    where: { userId },
    include: scopeViewInclude,
  });
  if (!officer) throw errors.notFound('No district is assigned to this account.');
  return officer;
}

export async function districtOverview(
  userId: string,
  db: Db = getPrisma(),
): Promise<DistrictOverview> {
  const officer = await officerWithScope(userId, db);
  const scope = await officerScope(userId, db);
  const facilities = await db.facility.findMany({
    where: { ...facilitiesInScope(scope), type: 'CHPS' },
    include: facilityInclude,
    orderBy: [{ district: { name: 'asc' } }, { name: 'asc' }],
  });

  return {
    officer: { fullName: officer.fullName, title: officer.title },
    scope: toScopeView(officer),
    facilities: facilities.map(toSummary),
  };
}

/**
 * The district dashboard (slice 3b, D85): the facility report summed over the
 * CHPS compounds in the officer's area, narrowed by the filters, and each
 * facility's line beside it.
 *
 * A filter is ANDed with the area, never instead of it, so a district or
 * facility outside the area simply matches nothing; that is refused as not
 * found rather than answered with zeros that would look like a real report.
 */
export async function districtReport(
  userId: string,
  query: DistrictReportQuery,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<DistrictReport> {
  const period = reportPeriod(query);
  const officer = await officerWithScope(userId, db);
  const scope = await officerScope(userId, db);

  const filters: Prisma.FacilityWhereInput[] = [];
  if (query.districtId) filters.push({ districtId: query.districtId });
  if (query.subDistrictId) filters.push({ subDistrictId: query.subDistrictId });
  if (query.facility) filters.push({ publicId: query.facility });

  const facilities = await db.facility.findMany({
    where: { AND: [facilitiesInScope(scope), { type: 'CHPS' }, ...filters] },
    include: { district: { select: { name: true } }, subDistrict: { select: { name: true } } },
    orderBy: [{ district: { name: 'asc' } }, { name: 'asc' }],
  });
  if (filters.length > 0 && facilities.length === 0) {
    throw errors.notFound('Nothing in your area matches that filter.');
  }

  const records = await reportRecords(
    facilities.map((facility) => facility.id),
    period.period,
    db,
  );

  const byFacility = facilities.map((facility) => {
    const totals = reportTotals(recordsFor(records, facility.id), period);
    return {
      publicId: facility.publicId,
      name: facility.name,
      code: facility.code,
      district: facility.district.name,
      subDistrict: facility.subDistrict?.name ?? null,
      status: facility.status,
      visits: totals.attendance.visits,
      newPatients: totals.attendance.newPatients,
      red: totals.attendance.byTriage.RED,
      emergencies: totals.attendance.emergencies,
      consultationsRequested: totals.consultations.requested,
      consultationsCompleted: totals.consultations.completed,
      noDoctorAvailable: totals.consultations.noDoctorAvailable,
      medianWaitMinutes: totals.consultations.waitMinutes.median,
      referrals: totals.referrals.issued,
      followUpsMissed: totals.followUps.missed,
    };
  });

  // Every facility left matches every filter, so the first names them all.
  const first = facilities[0];
  const filteredTo = query.facility
    ? (first?.name ?? null)
    : query.subDistrictId
      ? (first?.subDistrict?.name ?? null)
      : query.districtId
        ? (first?.district.name ?? null)
        : null;

  return {
    scope: toScopeView(officer),
    from: query.from,
    to: query.to,
    generatedAt: clock.now().toISOString(),
    filteredTo,
    totals: reportTotals(records, period),
    byFacility,
  };
}
