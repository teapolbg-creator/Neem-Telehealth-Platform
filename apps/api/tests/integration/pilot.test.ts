import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { disconnectPrisma, getPrisma } from '../../src/db/prisma.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';
import { NOTIFICATION_TEMPLATES } from '../../src/modules/notification/templates.ts';
import { closeTestApp, request } from '../helpers/app.ts';
import { createTestUser, resetDatabase } from '../helpers/database.ts';

/**
 * Pilot expressions of interest from the public marketing site.
 *
 * The rule this file exists to hold: the submit route is open, and being open
 * must never mean it grants anything. A submission creates a row and nothing
 * else — no user, no session, no capability.
 */

const ADMIN = { email: 'pilotadmin@test.local', password: 'AdminPassword123!' };

function validApplication(overrides: Record<string, unknown> = {}) {
  return {
    role: 'DOCTOR',
    fullName: 'Dr. Ama Mensah',
    phone: '0244123456',
    email: 'ama@example.com',
    specialty: 'General practice',
    organisation: 'Korle Bu Teaching Hospital',
    location: 'Accra',
    yearsOfPractice: '8',
    additionalInfo: 'Available weekday evenings.',
    consent: true,
    ...overrides,
  };
}

async function signInAdmin(): Promise<Record<string, string>> {
  const secret = authenticator.generateSecret(20);
  await createTestUser({
    ...ADMIN,
    role: 'ADMIN',
    twoFactorSecretEnc: encryptTotpSecret(secret),
    twoFactorEnabled: true,
  });

  const login = await request('/auth/login', { method: 'POST', payload: ADMIN });
  const challengeId = (login.body.data as { challengeId: string }).challengeId;

  const verify = await request('/auth/2fa/verify', {
    method: 'POST',
    payload: { challengeId, code: authenticator.generate(secret) },
  });

  return verify.cookies;
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeTestApp();
  await disconnectPrisma();
});

describe('submitting an expression of interest', () => {
  it('stores the application and returns a reference', async () => {
    const response = await request<{ reference: string }>('/pilot-applications', {
      method: 'POST',
      payload: validApplication(),
    });

    expect(response.status).toBe(201);
    expect(response.body.data?.reference).toMatch(/^pil_/);

    const row = await getPrisma().pilotApplication.findUnique({
      where: { publicId: response.body.data!.reference },
    });

    expect(row?.status).toBe('NEW');
    expect(row?.organisation).toBe('Korle Bu Teaching Hospital');
    // Consent is recorded as a moment, not a flag.
    expect(row?.consentAt).toBeInstanceOf(Date);
  });

  it('grants nothing — no user account is created', async () => {
    await request('/pilot-applications', { method: 'POST', payload: validApplication() });

    // The whole reason an unauthenticated write endpoint is acceptable here.
    const users = await getPrisma().user.count();
    const doctors = await getPrisma().doctor.count();
    expect(users).toBe(0);
    expect(doctors).toBe(0);
  });

  it('normalises the phone number, so one number is not two leads', async () => {
    const first = await request<{ reference: string }>('/pilot-applications', {
      method: 'POST',
      payload: validApplication({ phone: '0244123456' }),
    });

    const row = await getPrisma().pilotApplication.findUnique({
      where: { publicId: first.body.data!.reference },
    });

    expect(row?.phone).toBe('+233244123456');
  });

  it('rejects a submission without consent', async () => {
    const response = await request('/pilot-applications', {
      method: 'POST',
      payload: validApplication({ consent: false }),
    });

    expect(response.status).toBe(400);
  });

  it('requires a specialty from a doctor but not from a pharmacy', async () => {
    const doctor = await request('/pilot-applications', {
      method: 'POST',
      payload: validApplication({ specialty: undefined }),
    });
    expect(doctor.status).toBe(400);

    const pharmacy = await request('/pilot-applications', {
      method: 'POST',
      payload: validApplication({
        role: 'PHARMACY',
        specialty: undefined,
        email: 'counter@example.com',
        organisation: 'Adabraka Pharmacy',
      }),
    });
    expect(pharmacy.status).toBe(201);
  });

  it('rejects a phone number that is not Ghanaian', async () => {
    const response = await request('/pilot-applications', {
      method: 'POST',
      payload: validApplication({ phone: '+44 7700 900000' }),
    });

    expect(response.status).toBe(400);
  });

  it('updates the existing row when someone submits twice', async () => {
    const first = await request<{ reference: string }>('/pilot-applications', {
      method: 'POST',
      payload: validApplication({ location: 'Accra' }),
    });

    const second = await request<{ reference: string }>('/pilot-applications', {
      method: 'POST',
      payload: validApplication({ location: 'Kumasi' }),
    });

    // Same person, same role: one lead, not two, and the newer details win.
    expect(second.body.data?.reference).toBe(first.body.data?.reference);
    expect(await getPrisma().pilotApplication.count()).toBe(1);

    const row = await getPrisma().pilotApplication.findFirst();
    expect(row?.location).toBe('Kumasi');
  });

  it('treats the same person applying in the other role as a separate lead', async () => {
    await request('/pilot-applications', { method: 'POST', payload: validApplication() });
    await request('/pilot-applications', {
      method: 'POST',
      payload: validApplication({ role: 'PHARMACY', specialty: undefined }),
    });

    expect(await getPrisma().pilotApplication.count()).toBe(2);
  });

  it('does not drag a resolved application back to NEW', async () => {
    const first = await request<{ reference: string }>('/pilot-applications', {
      method: 'POST',
      payload: validApplication(),
    });

    await getPrisma().pilotApplication.update({
      where: { publicId: first.body.data!.reference },
      data: { status: 'DECLINED' },
    });

    await request('/pilot-applications', { method: 'POST', payload: validApplication() });

    const row = await getPrisma().pilotApplication.findFirst();
    // Someone re-applying after a decline should be visible as exactly that,
    // not silently reset to look like a fresh lead.
    expect(row?.status).toBe('DECLINED');
    expect(row?.statusNote).toContain('again');
  });

  it('tells the team that something arrived', async () => {
    await request('/pilot-applications', { method: 'POST', payload: validApplication() });

    const notification = await getPrisma().notification.findFirst({
      where: { templateCode: 'admin.pilot.application-received' },
    });

    expect(notification).not.toBeNull();
    expect(notification?.recipientType).toBe('ADMIN');
  });

  it('does not put the applicant into that message', () => {
    // The notifications table stores a payload hash, never the text, so the
    // enforcement point is the template's declared variables: the renderer
    // refuses any placeholder that is not on this list, so a template cannot
    // quietly grow a {{fullName}}.
    const template = NOTIFICATION_TEMPLATES.find(
      (entry) => entry.code === 'admin.pilot.application-received',
    );

    expect(template).toBeDefined();
    expect(template?.variables).toEqual(['role', 'reference']);

    for (const forbidden of ['fullName', 'phone', 'email', 'organisation', 'additionalInfo']) {
      expect(template?.body).not.toContain(forbidden);
    }
  });
});

describe('reading applications', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await request('/admin/pilot-applications');
    expect(response.status).toBe(401);
  });

  it('lists and filters them for an admin', async () => {
    await request('/pilot-applications', { method: 'POST', payload: validApplication() });
    await request('/pilot-applications', {
      method: 'POST',
      payload: validApplication({
        role: 'PHARMACY',
        specialty: undefined,
        email: 'counter@example.com',
        fullName: 'Kwame Owusu',
        organisation: 'Adabraka Pharmacy',
      }),
    });

    const cookies = await signInAdmin();

    const all = await request<Array<{ role: string }>>('/admin/pilot-applications', { cookies });
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(2);

    const doctorsOnly = await request<Array<{ role: string }>>(
      '/admin/pilot-applications?role=DOCTOR',
      { cookies },
    );
    expect(doctorsOnly.body.data).toHaveLength(1);
    expect(doctorsOnly.body.data?.[0]?.role).toBe('DOCTOR');

    const search = await request<Array<{ fullName: string }>>(
      '/admin/pilot-applications?search=Adabraka',
      { cookies },
    );
    expect(search.body.data?.[0]?.fullName).toBe('Kwame Owusu');
  });

  it('does not expose the source address in the list', async () => {
    await request('/pilot-applications', { method: 'POST', payload: validApplication() });
    const cookies = await signInAdmin();

    const list = await request<Array<Record<string, unknown>>>('/admin/pilot-applications', {
      cookies,
    });

    expect(list.body.data?.[0]).not.toHaveProperty('sourceIp');
  });

  it('records a status change against the admin who made it', async () => {
    const created = await request<{ reference: string }>('/pilot-applications', {
      method: 'POST',
      payload: validApplication(),
    });
    const cookies = await signInAdmin();

    const updated = await request<{ status: string; statusNote: string }>(
      `/admin/pilot-applications/${created.body.data!.reference}/status`,
      { method: 'PATCH', cookies, payload: { status: 'CONTACTED', note: 'Called, keen.' } },
    );

    expect(updated.status).toBe(200);
    expect(updated.body.data?.status).toBe('CONTACTED');

    const row = await getPrisma().pilotApplication.findFirst();
    expect(row?.reviewedByAdmin).toBeTruthy();
    expect(row?.reviewedAt).toBeInstanceOf(Date);
  });

  it('exports CSV with formula-shaped cells neutralised', async () => {
    await request('/pilot-applications', {
      method: 'POST',
      // A cell beginning with = is executed by Excel and Sheets when opened.
      payload: validApplication({ additionalInfo: '=1+1' }),
    });
    const cookies = await signInAdmin();

    const csv = await request('/admin/pilot-applications/export.csv', { cookies });

    expect(csv.status).toBe(200);
    expect(csv.raw.headers['content-type']).toContain('text/csv');
    expect(csv.raw.body).toContain('"\'=1+1"');
    // The phone number is the other cell that starts with a dangerous character.
    expect(csv.raw.body).toContain('"\'+233244123456"');
  });
});
