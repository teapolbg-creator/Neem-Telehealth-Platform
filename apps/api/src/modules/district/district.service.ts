import type { Prisma } from '@prisma/client';
import type { DistrictOverview, GeoScopeLevel } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { toScopeView } from '../admin/staff-account.service.ts';
import { facilityInclude, toSummary } from '../facility/facility.service.ts';

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

export async function districtOverview(
  userId: string,
  db: Db = getPrisma(),
): Promise<DistrictOverview> {
  const officer = await db.districtOfficer.findUnique({
    where: { userId },
    include: {
      region: { select: { id: true, name: true } },
      district: { select: { id: true, name: true } },
      subDistrict: { select: { id: true, name: true } },
    },
  });
  if (!officer) throw errors.notFound('No district is assigned to this account.');

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
