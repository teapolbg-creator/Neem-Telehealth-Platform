import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CONNECTION_CHECK_DOWN_BYTES,
  CONNECTION_CHECK_UP_BYTES,
  type StationPairing,
  type StationSummary,
  type VideoQuality,
} from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';

/** Station connection checks and the facility's video quality (CHPS slice 4b, D89). */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

async function facilityWithCho() {
  const prisma = getPrisma();
  const district = await prisma.district.findFirstOrThrow({ where: { region: { name: 'Volta' } } });
  const facility = await prisma.facility.create({
    data: {
      publicId: generatePublicId('fac'),
      code: 'CHPS-ALPHA',
      name: 'Alpha CHPS',
      type: 'CHPS',
      districtId: district.id,
      community: 'Alpha',
      status: 'ACTIVE',
      createdByUserId: 'test',
      isDemo: true,
    },
  });
  const user = await createTestUser({
    email: 'cho@chps.test',
    password: 'ChoPassword123!',
    role: 'FACILITY',
  });
  await prisma.facilityUser.create({
    data: { facilityId: facility.id, userId: user.id, fullName: 'Alpha CHO' },
  });
  return { facility, cho: await signIn('cho@chps.test', 'ChoPassword123!') };
}

async function pairedStation(cho: Record<string, string>) {
  const created = await request<StationPairing>('/facility/stations', {
    method: 'POST',
    cookies: cho,
    payload: { label: 'Room 1' },
  });
  const paired = await request('/station/pair', {
    method: 'POST',
    payload: { code: created.body.data!.pairingCode },
  });
  return { publicId: created.body.data!.station.publicId, cookies: paired.cookies };
}

const stationPost = (cookies: Record<string, string>, path: string, payload: unknown) =>
  request(path, { method: 'POST', cookies, payload, headers: { 'x-neem-station': '1' } });

describe('station connection checks (D89)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('serves bytes to time, accepts an upload, and shows the result to the CHO', async () => {
    const { cho } = await facilityWithCho();
    const station = await pairedStation(cho);

    const before = await request<StationSummary[]>('/facility/stations', { cookies: cho });
    expect(before.body.data![0]!.link).toBeNull();

    const down = await request('/station/connection-check', { cookies: station.cookies });
    expect(down.status).toBe(200);
    expect(down.raw.headers['cache-control']).toBe('no-store');
    expect(down.raw.rawPayload.length).toBe(CONNECTION_CHECK_DOWN_BYTES);

    const up = await stationPost(station.cookies, '/station/connection-check/upload', {
      sample: 'x'.repeat(CONNECTION_CHECK_UP_BYTES),
    });
    expect(up.status).toBe(204);

    const report = await stationPost(station.cookies, '/station/connection-check', {
      downKbps: 850,
      upKbps: 240,
      rttMs: 410,
    });
    expect(report.status).toBe(200);

    const after = await request<StationSummary[]>('/facility/stations', { cookies: cho });
    expect(after.body.data![0]!.link).toMatchObject({ downKbps: 850, upKbps: 240, rttMs: 410 });
  });

  it('is the station’s alone', async () => {
    const { cho } = await facilityWithCho();
    expect((await request('/station/connection-check')).status).toBe(401);
    // A signed-in CHO is not a station.
    expect((await request('/station/connection-check', { cookies: cho })).status).toBe(401);
    const station = await pairedStation(cho);
    // Without the station header a write is refused, as for every station write.
    const bare = await request('/station/connection-check', {
      method: 'POST',
      cookies: station.cookies,
      payload: { downKbps: 1, upKbps: 1, rttMs: 1 },
    });
    expect(bare.status).toBe(403);
    const oversized = await stationPost(station.cookies, '/station/connection-check/upload', {
      sample: 'x'.repeat(CONNECTION_CHECK_UP_BYTES + 4096),
    });
    expect(oversized.status).toBe(400);
  });
});

describe('facility video quality (D89)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('is off until the CHO turns it on, and the change is audited', async () => {
    const { facility, cho } = await facilityWithCho();
    const initial = await request<VideoQuality>('/facility/video-quality', { cookies: cho });
    expect(initial.body.data).toEqual({ lowData: false });

    const set = await request<VideoQuality>('/facility/video-quality', {
      method: 'PUT',
      cookies: cho,
      payload: { lowData: true },
    });
    expect(set.body.data).toEqual({ lowData: true });
    expect(
      (await getPrisma().facility.findUniqueOrThrow({ where: { id: facility.id } })).lowDataVideo,
    ).toBe(true);
    const audit = await getPrisma().auditLog.findFirst({
      where: { action: 'facility.video-quality-set' },
    });
    expect(audit?.metadata).toEqual({ lowData: true });
  });
});
