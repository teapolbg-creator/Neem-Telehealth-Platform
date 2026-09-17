import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { closeTestApp, request } from '../helpers/app.ts';
import { createTestDoctor, resetDatabase, setDirectChannelEnabled } from '../helpers/database.ts';
import {
  MockNotificationProvider,
  resetNotificationProviders,
  setNotificationProviderForTesting,
} from '../../src/adapters/notification/index.ts';
import { generatePublicId } from '../../src/lib/crypto.ts';

/**
 * A patient signing in to their own account (v2, plan phase 3).
 *
 * The counter's patient session dies with the consultation, which is right for
 * somebody standing in a shop and useless to somebody who booked from home and
 * wants their prescription two days later. These cover what the account is
 * for, and the two things it must never do: reach another patient's documents,
 * or reach anything clinical.
 */

const EMAIL = 'ama@example.test';
const OTHER = 'kofi@example.test';

const email = new MockNotificationProvider('EMAIL');

beforeEach(async () => {
  await resetDatabase();
  await setDirectChannelEnabled(true);

  resetNotificationProviders();
  email.clear();
  setNotificationProviderForTesting('EMAIL', email);
});

afterAll(async () => {
  resetNotificationProviders();
  await closeTestApp();
  await disconnectPrisma();
});

/** The code as the patient receives it: read from the message actually sent. */
async function codeSentTo(contact: string): Promise<string> {
  const asked = await request('/patient/account/code', {
    method: 'POST',
    payload: { contact },
  });
  expect(asked.status).toBe(202);

  const message = email
    .sent()
    .filter((sent) => sent.to === contact)
    .at(-1);
  const code = /\b(\d{6})\b/.exec(message?.body ?? '')?.[1];

  expect(code, 'a six-digit code should have been sent').toBeTruthy();
  return code!;
}

async function signIn(contact: string): Promise<Record<string, string>> {
  const code = await codeSentTo(contact);
  const verified = await request('/patient/account/verify', {
    method: 'POST',
    payload: { contact, code },
  });

  expect(verified.status).toBe(200);
  return verified.cookies;
}

/** A completed consultation belonging to an account, with a document on it. */
async function consultationFor(contact: string, opts: { prescription?: boolean } = {}) {
  const prisma = getPrisma();
  const account = await prisma.patientAccount.findFirstOrThrow({
    orderBy: { createdAt: 'desc' },
    where: { contactKind: 'EMAIL' },
  });

  const consultation = await prisma.consultation.create({
    data: {
      publicId: `NEEM-ACC-${generatePublicId('c').slice(-8).toUpperCase()}`,
      channel: 'DIRECT',
      state: 'COMPLETED',
      priceMinor: 5000,
      netMinor: 5000,
      currency: 'GHS',
      patientAccountId: account.id,
    },
  });

  if (opts.prescription) {
    const { doctor } = await createTestDoctor('Dr. Account');

    await prisma.prescription.create({
      data: {
        publicId: generatePublicId('rx'),
        verificationCode: generatePublicId('v'),
        consultationId: consultation.id,
        doctorId: doctor.id,
        state: 'ISSUED',
        issuedAt: new Date(),
        patientName: 'Ama Mensah',
        patientAge: 31,
        patientSex: 'FEMALE',
      },
    });
  }

  return { accountId: account.id, consultation, contact };
}

describe('signing in', () => {
  it('sends a code and exchanges it for a session', async () => {
    const cookies = await signIn(EMAIL);

    const me = await request<{ publicId: string; contactKind: string }>('/patient/account', {
      cookies,
    });
    expect(me.status).toBe(200);
    expect(me.body.data?.contactKind).toBe('EMAIL');
  });

  it('refuses a wrong code, and counts the attempt against it', async () => {
    await codeSentTo(EMAIL);

    const wrong = await request('/patient/account/verify', {
      method: 'POST',
      payload: { contact: EMAIL, code: '000000' },
    });

    expect(wrong.status).toBe(401);
    const code = await getPrisma().patientAuthCode.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
    });
    expect(code.attempts).toBe(1);
    expect(code.consumedAt).toBeNull();
  });

  it('burns a code once it has been used', async () => {
    const code = await codeSentTo(EMAIL);

    const first = await request('/patient/account/verify', {
      method: 'POST',
      payload: { contact: EMAIL, code },
    });
    const second = await request('/patient/account/verify', {
      method: 'POST',
      payload: { contact: EMAIL, code },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it('will not send a code by SMS while SMS is switched off', async () => {
    const response = await request('/patient/account/code', {
      method: 'POST',
      payload: { contact: '0244000111' },
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.error?.message).toMatch(/only be sent by email/i);
  });

  it('is unavailable entirely while the patient-direct service is off', async () => {
    await setDirectChannelEnabled(false);

    const response = await request('/patient/account/code', {
      method: 'POST',
      payload: { contact: EMAIL },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.error?.message).toMatch(/not available yet/i);
  });

  it('refuses everything to a caller with no session', async () => {
    expect((await request('/patient/account')).status).toBe(401);
    expect((await request('/patient/account/documents')).status).toBe(401);
  });
});

describe('what the account reaches', () => {
  it('lists its own consultations and their documents', async () => {
    const cookies = await signIn(EMAIL);
    const { consultation } = await consultationFor(EMAIL, { prescription: true });

    const mine = await request<{ consultations: Array<{ publicId: string }> }>('/patient/account', {
      cookies,
    });
    expect(mine.body.data?.consultations.map((row) => row.publicId)).toContain(
      consultation.publicId,
    );

    const documents = await request<{
      consultations: Array<{ consultationReference: string; documents: Array<{ kind: string }> }>;
    }>('/patient/account/documents', { cookies });

    const group = documents.body.data?.consultations.find(
      (row) => row.consultationReference === consultation.publicId,
    );
    expect(group?.documents.map((doc) => doc.kind)).toContain('prescription');
  });

  it('reaches nothing belonging to another patient', async () => {
    await signIn(OTHER);
    const theirs = await consultationFor(OTHER, { prescription: true });
    const prescription = await getPrisma().prescription.findFirstOrThrow({
      where: { consultationId: theirs.consultation.id },
    });

    const mine = await signIn(EMAIL);

    const documents = await request<{ consultations: unknown[] }>('/patient/account/documents', {
      cookies: mine,
    });
    expect(documents.body.data?.consultations).toEqual([]);

    // Knowing the document's id is not enough, which is the point.
    const stolen = await request(
      `/patient/account/documents/prescription/${prescription.publicId}.pdf`,
      { cookies: mine },
    );
    expect(stolen.status).toBe(404);
  });

  it('ends the session on sign-out', async () => {
    const cookies = await signIn(EMAIL);

    const out = await request('/patient/account/logout', { method: 'POST', cookies });
    expect(out.status).toBe(200);

    expect((await request('/patient/account', { cookies })).status).toBe(401);
  });
});
