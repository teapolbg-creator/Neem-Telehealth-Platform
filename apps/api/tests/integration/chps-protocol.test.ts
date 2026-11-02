import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { PatientRecord, TriageRule, TriageRuleAdmin } from '@neem/contracts';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';

/** The approved triage protocol (CHPS slice 5c, D93). */

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

async function adminCookies(role: 'ADMIN' | 'OPS_ADMIN') {
  const email = `${generatePublicId('x').slice(-8).toLowerCase()}@admin.test`;
  const secret = authenticator.generateSecret(20);
  const user = await createTestUser({
    email,
    password: 'AdminPassword123!',
    role,
    twoFactorSecretEnc: encryptTotpSecret(secret),
    twoFactorEnabled: true,
  });
  await getPrisma().admin.create({ data: { userId: user.id, fullName: `Test ${role}` } });
  const login = await request<{ challengeId: string }>('/auth/login', {
    method: 'POST',
    payload: { email, password: 'AdminPassword123!' },
  });
  const verify = await request('/auth/2fa/verify', {
    method: 'POST',
    payload: { challengeId: login.body.data!.challengeId, code: authenticator.generate(secret) },
  });
  return verify.cookies;
}

async function chocookies() {
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
  return signIn('cho@chps.test', 'ChoPassword123!');
}

async function triaged(cookies: Record<string, string>, fullName: string, value: number) {
  const registered = await request<{ patientNumber: string; visitPublicId: string }>(
    '/facility/patients',
    {
      method: 'POST',
      cookies,
      payload: {
        fullName,
        sex: 'FEMALE',
        ageYears: 28,
        community: 'Alpha',
        consentGivenBy: 'PATIENT',
        presentingComplaint: 'Short of breath',
      },
    },
  );
  const { patientNumber, visitPublicId } = registered.body.data!;
  const saved = await request(`/facility/visits/${visitPublicId}/triage`, {
    method: 'POST',
    cookies,
    payload: { category: 'GREEN', vitals: { spo2Percent: value } },
  });
  expect(saved.status).toBe(201);
  const record = await request<PatientRecord>(`/facility/patients/${patientNumber}`, { cookies });
  return record.body.data!.visits[0]!;
}

// A made-up number: the point is the mechanism, not the threshold.
const RULE = {
  reading: 'spo2Percent',
  comparison: 'BELOW',
  threshold: 50,
  suggestedCategory: 'RED',
  message: 'Test message.',
  source: 'Test protocol, not a real document',
  approvedBy: 'Test approver',
};

describe('the triage protocol (D93)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('ships with no rules, so nothing is flagged', async () => {
    expect(await getPrisma().triageProtocolRule.count()).toBe(0);
    const cho = await chocookies();
    const rules = await request<TriageRule[]>('/facility/triage-protocol', { cookies: cho });
    expect(rules.body.data).toEqual([]);
    const visit = await triaged(cho, 'Efua Asante', 45);
    expect(visit.triage!.protocolFlags).toEqual([]);
  });

  it('flags from a rule, keeps what was shown, and leaves the decision to the CHO', async () => {
    const admin = await adminCookies('ADMIN');
    const cho = await chocookies();
    const added = await request<TriageRuleAdmin[]>('/admin/triage-protocol', {
      method: 'POST',
      cookies: admin,
      payload: RULE,
    });
    expect(added.status).toBe(201);
    const id = added.body.data![0]!.id;

    const crossed = await triaged(cho, 'Efua Asante', 45);
    expect(crossed.triage!.protocolFlags).toEqual([
      {
        ruleId: id,
        message: 'Test message.',
        source: RULE.source,
        suggestedCategory: 'RED',
      },
    ]);
    // It suggested Red. The CHO chose Green, and Green is what stands.
    expect(crossed.triage!.category).toBe('GREEN');
    expect(crossed.status).toBe('TRIAGED');

    expect((await triaged(cho, 'Akua Mensah', 90)).triage!.protocolFlags).toEqual([]);

    const retired = await request(`/admin/triage-protocol/${id}/retire`, {
      method: 'POST',
      cookies: admin,
    });
    expect(retired.status).toBe(200);
    expect((await triaged(cho, 'Ama Serwaa', 45)).triage!.protocolFlags).toEqual([]);

    // A retired rule is kept and listed, and what it raised then still stands.
    const listed = await request<TriageRuleAdmin[]>('/admin/triage-protocol', { cookies: admin });
    expect(listed.body.data![0]!.retiredAt).not.toBeNull();
    const stored = await getPrisma().triageRecord.count({
      where: { protocolFlagsEnc: { not: null } },
    });
    expect(stored).toBe(1);

    const audited = await getPrisma().auditLog.count({
      where: { action: { startsWith: 'triage-protocol.' } },
    });
    expect(audited).toBe(2);
  });

  it('needs a source and an approver, and only the super administrator may enter rules', async () => {
    const admin = await adminCookies('ADMIN');
    const ops = await adminCookies('OPS_ADMIN');
    const cho = await chocookies();

    const noSource = await request('/admin/triage-protocol', {
      method: 'POST',
      cookies: admin,
      payload: { ...RULE, source: '' },
    });
    expect(noSource.status).toBe(400);
    const noApprover = await request('/admin/triage-protocol', {
      method: 'POST',
      cookies: admin,
      payload: { ...RULE, approvedBy: '' },
    });
    expect(noApprover.status).toBe(400);

    for (const cookies of [ops, cho]) {
      const refused = await request('/admin/triage-protocol', {
        method: 'POST',
        cookies,
        payload: RULE,
      });
      expect(refused.status).toBe(403);
    }
  });
});
