import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DistrictReport } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';

/**
 * The district dashboard (CHPS slice 3b, D85): the facility report summed over
 * the officer's area, compared facility by facility, and never wider than it.
 */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

const today = new Date().toISOString().slice(0, 10);
const range = `from=${today}&to=${today}`;

async function facilityWithCho(label: string, districtId: string, subDistrictId?: string) {
  const prisma = getPrisma();
  const facility = await prisma.facility.create({
    data: {
      publicId: generatePublicId('fac'),
      code: `CHPS-${label}`,
      name: `${label} CHPS`,
      type: 'CHPS',
      districtId,
      subDistrictId: subDistrictId ?? null,
      community: label,
      status: 'ACTIVE',
      createdByUserId: 'test',
      isDemo: true,
    },
  });
  const email = `cho-${label.toLowerCase()}@chps.test`;
  const user = await createTestUser({ email, password: 'ChoPassword123!', role: 'FACILITY' });
  await prisma.facilityUser.create({
    data: { facilityId: facility.id, userId: user.id, fullName: `${label} CHO` },
  });
  return { facility, cookies: await signIn(email, 'ChoPassword123!') };
}

/** A walk-in registered and triaged at the facility. */
async function walkIn(cho: Record<string, string>, name: string, category: string) {
  const created = await request<{ visitPublicId: string }>('/facility/patients', {
    method: 'POST',
    cookies: cho,
    payload: {
      fullName: name,
      sex: 'FEMALE',
      ageYears: 30,
      community: 'Somewhere',
      consentGivenBy: 'PATIENT',
      presentingComplaint: `Private complaint of ${name}`,
    },
  });
  expect(created.status).toBe(201);
  await request(`/facility/visits/${created.body.data!.visitPublicId}/triage`, {
    method: 'POST',
    cookies: cho,
    payload: { category },
  });
}

async function officer(scope: {
  level: 'REGION' | 'DISTRICT' | 'SUB_DISTRICT';
  regionId: string;
  districtId?: string;
  subDistrictId?: string;
}) {
  const email = `${generatePublicId('x').slice(-8).toLowerCase()}@ghs.test`;
  const user = await createTestUser({ email, password: 'OfficerPassword123!', role: 'DISTRICT' });
  await getPrisma().districtOfficer.create({
    data: {
      userId: user.id,
      fullName: 'Esi Officer',
      scopeLevel: scope.level,
      regionId: scope.regionId,
      districtId: scope.districtId ?? null,
      subDistrictId: scope.subDistrictId ?? null,
      createdByUserId: 'test',
    },
  });
  return signIn(email, 'OfficerPassword123!');
}

/** Two facilities in one Volta district (one in a sub-district), one in another. */
async function area() {
  const prisma = getPrisma();
  const [home, away] = await prisma.district.findMany({
    where: { region: { name: 'Volta' } },
    orderBy: { name: 'asc' },
    take: 2,
  });
  const sub = await prisma.subDistrict.create({
    data: { districtId: home!.id, name: 'North' },
  });
  const alpha = await facilityWithCho('Alpha', home!.id, sub.id);
  const beta = await facilityWithCho('Beta', home!.id);
  const gamma = await facilityWithCho('Gamma', away!.id);

  await walkIn(alpha.cookies, 'Akua One', 'RED');
  await walkIn(alpha.cookies, 'Akua Two', 'GREEN');
  await walkIn(beta.cookies, 'Ama Three', 'YELLOW');
  await walkIn(gamma.cookies, 'Abena Four', 'RED');

  return { regionId: home!.regionId, home: home!, away: away!, sub, alpha, beta, gamma };
}

describe('district dashboard (D85)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('sums the district’s facilities, line by line, and nothing beyond it', async () => {
    const { regionId, home } = await area();
    const cookies = await officer({ level: 'DISTRICT', regionId, districtId: home.id });

    const report = await request<DistrictReport>(`/district/report?${range}`, { cookies });
    expect(report.status).toBe(200);
    const data = report.body.data!;
    expect(data.filteredTo).toBeNull();
    expect(data.totals.attendance.visits).toBe(3);
    expect(data.totals.attendance.newPatients).toBe(3);
    expect(data.totals.attendance.byTriage).toMatchObject({ RED: 1, GREEN: 1, YELLOW: 1 });
    expect(data.totals.days).toHaveLength(1);
    expect(data.byFacility).toEqual([
      expect.objectContaining({ name: 'Alpha CHPS', subDistrict: 'North', visits: 2, red: 1 }),
      expect.objectContaining({ name: 'Beta CHPS', subDistrict: null, visits: 1, red: 0 }),
    ]);

    // Counts only: what a patient said stays at the facility.
    expect(JSON.stringify(data)).not.toContain('Private complaint');
    expect(data).not.toHaveProperty('complaints');
  });

  it('narrows by sub-district or facility, and refuses anything outside the area', async () => {
    const { regionId, home, away, sub, beta, gamma } = await area();
    const cookies = await officer({ level: 'DISTRICT', regionId, districtId: home.id });

    const north = await request<DistrictReport>(
      `/district/report?${range}&subDistrictId=${sub.id}`,
      { cookies },
    );
    expect(north.body.data!.filteredTo).toBe('North');
    expect(north.body.data!.totals.attendance.visits).toBe(2);

    const one = await request<DistrictReport>(
      `/district/report?${range}&facility=${beta.facility.publicId}`,
      { cookies },
    );
    expect(one.body.data!.filteredTo).toBe('Beta CHPS');
    expect(one.body.data!.byFacility).toHaveLength(1);
    expect(one.body.data!.totals.attendance.visits).toBe(1);

    for (const outside of [`facility=${gamma.facility.publicId}`, `districtId=${away.id}`]) {
      const refused = await request(`/district/report?${range}&${outside}`, { cookies });
      expect(refused.status, outside).toBe(404);
    }
  });

  it('gives a regional officer every district, filterable by district', async () => {
    const { regionId, away } = await area();
    const cookies = await officer({ level: 'REGION', regionId });

    const all = await request<DistrictReport>(`/district/report?${range}`, { cookies });
    expect(all.body.data!.totals.attendance.visits).toBe(4);
    expect(all.body.data!.byFacility).toHaveLength(3);

    const keta = await request<DistrictReport>(`/district/report?${range}&districtId=${away.id}`, {
      cookies,
    });
    expect(keta.body.data!.filteredTo).toBe(away.name);
    expect(keta.body.data!.totals.attendance.byTriage.RED).toBe(1);
  });

  it('is the district officer’s alone, for at most 92 days', async () => {
    const { regionId, home, alpha } = await area();
    const cookies = await officer({ level: 'DISTRICT', regionId, districtId: home.id });

    const long = await request('/district/report?from=2026-01-01&to=2026-06-30', { cookies });
    expect(long.status).toBe(400);
    expect((await request(`/district/report?${range}`, { cookies: alpha.cookies })).status).toBe(
      403,
    );
  });
});
