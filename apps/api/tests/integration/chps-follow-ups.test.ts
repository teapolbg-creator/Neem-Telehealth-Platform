import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  FacilityDaySummary,
  FollowUpListRow,
  FollowUpView,
  PatientRecord,
  ReferralView,
} from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';

/**
 * Follow-ups (CHPS slice 2b, D81).
 */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

const PASSWORD = 'ChoPassword123!';

async function facilityWithCho(label: string) {
  const prisma = getPrisma();
  const district = await prisma.district.findFirstOrThrow({ where: { region: { name: 'Volta' } } });
  const facility = await prisma.facility.create({
    data: {
      publicId: generatePublicId('fac'),
      code: `CHPS-${label}`,
      name: `${label} CHPS`,
      type: 'CHPS',
      districtId: district.id,
      community: label,
      status: 'ACTIVE',
      createdByUserId: 'test',
      isDemo: true,
    },
  });
  const email = `cho-${label.toLowerCase()}@chps.test`;
  const user = await createTestUser({ email, password: PASSWORD, role: 'FACILITY' });
  await prisma.facilityUser.create({
    data: { facilityId: facility.id, userId: user.id, fullName: `${label} CHO` },
  });
  return { facility, cookies: await signIn(email, PASSWORD) };
}

async function walkIn(cookies: Record<string, string>, fullName = 'Adwoa Pokuaa') {
  const created = await request<{ patientNumber: string; visitPublicId: string }>(
    '/facility/patients',
    {
      method: 'POST',
      cookies,
      payload: {
        fullName,
        sex: 'FEMALE',
        ageYears: 45,
        community: 'Avenorpeme',
        phone: '024 555 1234',
        consentGivenBy: 'PATIENT',
        presentingComplaint: 'High blood pressure check',
      },
    },
  );
  return created.body.data!;
}

function day(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const setFollowUp = (cookies: Record<string, string>, visit: string, body: object) =>
  request<FollowUpView>(`/facility/visits/${visit}/follow-ups`, {
    method: 'POST',
    cookies,
    payload: { dueDate: day(3), instructions: 'Recheck BP after starting amlodipine', ...body },
  });

const list = (cookies: Record<string, string>, view: string) =>
  request<FollowUpListRow[]>(`/facility/follow-ups?view=${view}`, { cookies });

describe('follow-ups', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('sets a follow-up from a visit and lists it as upcoming, then due', async () => {
    const cho = await facilityWithCho('Alpha');
    const { patientNumber, visitPublicId } = await walkIn(cho.cookies);

    const later = await setFollowUp(cho.cookies, visitPublicId, {});
    expect(later.status).toBe(201);
    expect(later.body.data).toMatchObject({ status: 'DUE', dueDate: day(3), overdue: false });

    expect((await list(cho.cookies, 'upcoming')).body.data).toHaveLength(1);
    expect((await list(cho.cookies, 'due')).body.data).toEqual([]);

    await setFollowUp(cho.cookies, visitPublicId, {
      dueDate: day(0),
      instructions: 'Collect results',
    });
    const due = await list(cho.cookies, 'due');
    expect(due.body.data).toEqual([
      expect.objectContaining({
        dueDate: day(0),
        overdue: false,
        patient: expect.objectContaining({ fullName: 'Adwoa Pokuaa', phone: '+233245551234' }),
      }),
    ]);

    const today = await request<FacilityDaySummary>('/facility/today', { cookies: cho.cookies });
    expect(today.body.data!.followUpsDue).toBe(1);

    const record = await request<PatientRecord>(`/facility/patients/${patientNumber}`, {
      cookies: cho.cookies,
    });
    expect(record.body.data!.visits[0]!.followUps.map((f) => f.dueDate)).toEqual([day(0), day(3)]);
  });

  it('refuses a date in the past', async () => {
    const cho = await facilityWithCho('Alpha');
    const { visitPublicId } = await walkIn(cho.cookies);
    expect((await setFollowUp(cho.cookies, visitPublicId, { dueDate: day(-1) })).status).toBe(400);
  });

  it('shows a late follow-up as overdue and never marks it missed by itself', async () => {
    const cho = await facilityWithCho('Alpha');
    const { visitPublicId } = await walkIn(cho.cookies);
    await setFollowUp(cho.cookies, visitPublicId, {});
    await getPrisma().followUp.updateMany({
      data: { dueDate: new Date(`${day(-5)}T00:00:00Z`) },
    });

    const due = await list(cho.cookies, 'due');
    expect(due.body.data).toEqual([expect.objectContaining({ status: 'DUE', overdue: true })]);
  });

  it('links a follow-up to the visit at which the patient came back', async () => {
    const cho = await facilityWithCho('Alpha');
    const { patientNumber, visitPublicId } = await walkIn(cho.cookies);
    const followUp = (await setFollowUp(cho.cookies, visitPublicId, {})).body.data!;
    await request(`/facility/visits/${visitPublicId}/close`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { outcome: 'CLOSED', note: 'Advised' },
    });

    const returned = await request<{ visitPublicId: string }>(
      `/facility/patients/${patientNumber}/visits`,
      { method: 'POST', cookies: cho.cookies, payload: { presentingComplaint: 'BP follow-up' } },
    );
    const done = await request<FollowUpView>(`/facility/follow-ups/${followUp.publicId}/complete`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { note: 'BP 138/86, improving' },
    });
    expect(done.body.data).toMatchObject({
      status: 'DONE',
      resolved: {
        by: 'Alpha CHO',
        note: 'BP 138/86, improving',
        visitPublicId: returned.body.data!.visitPublicId,
      },
    });

    // Resolved once.
    const again = await request(`/facility/follow-ups/${followUp.publicId}/missed`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { note: 'oops' },
    });
    expect(again.status).toBe(422);
  });

  it('records a missed or cancelled follow-up with what happened', async () => {
    const cho = await facilityWithCho('Alpha');
    const { visitPublicId } = await walkIn(cho.cookies);
    const first = (await setFollowUp(cho.cookies, visitPublicId, {})).body.data!;
    const second = (await setFollowUp(cho.cookies, visitPublicId, { dueDate: day(5) })).body.data!;

    const missed = await request<FollowUpView>(`/facility/follow-ups/${first.publicId}/missed`, {
      method: 'POST',
      cookies: cho.cookies,
      payload: { note: 'Called twice, no answer' },
    });
    expect(missed.body.data).toMatchObject({
      status: 'MISSED',
      resolved: { note: 'Called twice, no answer' },
    });

    const cancelled = await request<FollowUpView>(
      `/facility/follow-ups/${second.publicId}/cancel`,
      { method: 'POST', cookies: cho.cookies, payload: { reason: 'Hospital is following her up' } },
    );
    expect(cancelled.body.data!.status).toBe('CANCELLED');
    expect((await list(cho.cookies, 'upcoming')).body.data).toEqual([]);
  });

  it('can come from a referral’s feedback, but only that patient’s referral', async () => {
    const cho = await facilityWithCho('Alpha');
    const first = await walkIn(cho.cookies);
    const other = await walkIn(cho.cookies, 'Yaw Mensah');
    const referral = await request<ReferralView>(
      `/facility/visits/${first.visitPublicId}/referrals`,
      {
        method: 'POST',
        cookies: cho.cookies,
        payload: { urgency: 'ROUTINE', reason: 'Eye review', destinationName: 'Eye clinic' },
      },
    );
    const ref = referral.body.data!.publicId;

    const linked = await setFollowUp(cho.cookies, first.visitPublicId, { referralPublicId: ref });
    expect(linked.body.data!.referralPublicId).toBe(ref);

    const wrong = await setFollowUp(cho.cookies, other.visitPublicId, { referralPublicId: ref });
    expect(wrong.status).toBe(404);
  });

  it('keeps each facility’s follow-ups to itself', async () => {
    const alpha = await facilityWithCho('Alpha');
    const beta = await facilityWithCho('Beta');
    const { visitPublicId } = await walkIn(alpha.cookies);
    const followUp = (await setFollowUp(alpha.cookies, visitPublicId, { dueDate: day(0) })).body
      .data!;

    expect((await list(beta.cookies, 'all')).body.data).toEqual([]);
    expect(
      (
        await request(`/facility/follow-ups/${followUp.publicId}/complete`, {
          method: 'POST',
          cookies: beta.cookies,
          payload: {},
        })
      ).status,
    ).toBe(404);
    expect((await setFollowUp(beta.cookies, visitPublicId, {})).status).toBe(404);
  });
});
