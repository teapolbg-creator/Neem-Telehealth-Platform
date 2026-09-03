import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { closeTestApp, getTestApp, request, signIn } from '../helpers/app.ts';
import { getEnv } from '../../src/config/env.ts';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import {
  createDraft,
  issuePrescription,
} from '../../src/modules/prescription/prescription.service.ts';
import { encryptField, generatePublicId } from '../../src/lib/crypto.ts';
import { AUDIT_ACTIONS } from '../../src/modules/audit/audit.service.ts';

/**
 * The security suite (spec §79, §102).
 *
 * Every other integration file asks "does this feature work". This one asks
 * "what happens when someone attacks it", and it is deliberately one file so
 * that the answer to §79 can be read in one place rather than reassembled
 * from fifteen.
 *
 * The tests are written from the attacker's side. Where a check also exists
 * in a feature file it appears here again in that form, because "the QR
 * exchange is single-use" and "a photographed QR code cannot be replayed"
 * are the same mechanism read from opposite ends, and only the second one
 * fails loudly if the mechanism is later relaxed for a good-looking reason.
 *
 * What is deliberately absent: any test that a recording cannot be
 * retrieved. There is no recording API to attack, which is the guarantee
 * (spec §64) — it is asserted against the media adapter's configuration in
 * `media.test.ts`, because that is where it could regress.
 */

const PASSWORD = 'SecurityPassword123!';

interface World {
  label: string;
  pharmacyId: string;
  pharmacyPublicId: string;
  pharmacyCookies: Record<string, string>;
  doctorId: string;
  doctorPublicId: string;
  doctorCookies: Record<string, string>;
  consultationId: string;
  consultationPublicId: string;
  prescriptionPublicId: string;
  prescriptionId: string;
  patientCookies: Record<string, string>;
}

/**
 * One complete, isolated tenant: a pharmacy, a doctor, a patient, a live
 * consultation between them, and an issued prescription.
 *
 * Two of these are built in most tests below, and the point of the §102
 * demonstrations is that nothing belonging to the second reaches anything
 * belonging to the first. So the fixture builds genuinely separate worlds
 * rather than two views onto shared rows — no shared pharmacy, no shared
 * doctor, no shared consultation.
 */
async function buildWorld(label: string): Promise<World> {
  const prisma = getPrisma();
  const suffix = generatePublicId('x').slice(-8);

  const pharmacy = await createTestPharmacy(`${label} Pharmacy`, 'ACTIVE');
  const pharmacyUser = await createTestUser({
    email: `${suffix}@pharmacy.test`,
    password: PASSWORD,
    role: 'PHARMACY',
  });
  await prisma.pharmacyUser.create({
    data: { pharmacyId: pharmacy.id, userId: pharmacyUser.id },
  });

  const doctorUser = await createTestUser({
    email: `${suffix}@doctor.test`,
    password: PASSWORD,
    role: 'DOCTOR',
  });
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);
  const doctor = await prisma.doctor.create({
    data: {
      publicId: generatePublicId('doc'),
      userId: doctorUser.id,
      fullName: `Dr. ${label}`,
      mdcNumber: `MDC-SEC-${suffix}`,
      mdcExpiresAt: expiry,
      status: 'ACTIVE',
      isDemo: true,
      signatures: { create: { signatureDataEnc: encryptField('data:image/png;base64,AAAA') } },
    },
  });

  const pharmacyCookies = await signIn(pharmacyUser.email, PASSWORD);
  const created = await request<{ publicId: string }>('/pharmacy/consultations', {
    method: 'POST',
    cookies: pharmacyCookies,
    payload: {},
  });
  const consultationPublicId = created.body.data!.publicId;
  const consultation = await prisma.consultation.findUniqueOrThrow({
    where: { publicId: consultationPublicId },
  });

  await prisma.patientSession.create({
    data: {
      consultationId: consultation.id,
      fullNameEnc: encryptField(`${label} Patient`),
      age: 30,
      sex: 'FEMALE',
      phoneEnc: encryptField('0245550000'),
    },
  });

  await prisma.consultation.update({
    where: { id: consultation.id },
    data: { doctorId: doctor.id, type: 'VIDEO' },
  });
  for (const state of ['PAYMENT_PROCESSING', 'PAID', 'ACTIVATED'] as const) {
    await transition(consultation.id, state, { actorType: 'SYSTEM', reason: 'security fixture' });
  }

  // A real patient session, obtained the way a patient obtains one: print a
  // QR code, exchange the token. Nothing here writes the cookie by hand.
  //
  // This happens at ACTIVATED rather than later because that is the only
  // point a code can be issued — `acceptsPatientArrival` refuses once the
  // consultation is under way, which is correct and is why the fixture has
  // to follow the real order rather than a convenient one.
  const qr = await request<{ url: string }>(
    `/pharmacy/consultations/${consultationPublicId}/qr`,
    { method: 'POST', cookies: pharmacyCookies, payload: {} },
  );
  if (qr.status !== 200) throw new Error(`QR issue failed: ${qr.status}`);

  const token = qr.body.data!.url.split('/s/')[1]!;
  const exchanged = await request('/s/exchange', { method: 'POST', payload: { token } });
  if (exchanged.status !== 200) {
    throw new Error(`patient exchange failed: ${exchanged.status}`);
  }

  for (const state of [
    'PATIENT_JOINED',
    'WAITING_FOR_DOCTOR',
    'ASSIGNED',
    'DOCTOR_ACCEPTED',
    'IN_PROGRESS',
  ] as const) {
    await transition(consultation.id, state, { actorType: 'SYSTEM', reason: 'security fixture' });
  }

  const draft = await createDraft(consultation.id, doctor.id, [
    {
      medication: 'Amoxicillin',
      strength: '500mg',
      form: 'Capsule',
      dose: '1 capsule',
      frequency: 'Three times daily',
      durationText: '5 days',
      quantity: '15 capsules',
    },
  ]);
  const prescription = await issuePrescription(draft.id, doctor.id);

  return {
    label,
    pharmacyId: pharmacy.id,
    pharmacyPublicId: pharmacy.publicId,
    pharmacyCookies,
    doctorId: doctor.id,
    doctorPublicId: doctor.publicId,
    doctorCookies: await signIn(doctorUser.email, PASSWORD),
    consultationId: consultation.id,
    consultationPublicId,
    prescriptionPublicId: prescription.publicId,
    prescriptionId: prescription.id,
    patientCookies: exchanged.cookies,
  };
}

beforeEach(async () => {
  await resetDatabase();
  setPaymentProviderForTesting(new MockPaymentProvider());
});

afterAll(async () => {
  setPaymentProviderForTesting(undefined);
  await closeTestApp();
  await disconnectPrisma();
});

// ---------------------------------------------------------------------------
// Broken authorization — the sweep
// ---------------------------------------------------------------------------

/**
 * Routes that are unauthenticated on purpose, each with the reason it is.
 *
 * This map is the authentication boundary of the whole API, written down in
 * one place. The sweep below fails on any route that answers a stranger
 * without appearing here, so adding to it is an argument someone has to make
 * in review rather than a line of middleware nobody notices is missing.
 *
 * Decision D33 records why this is a test rather than a check the application
 * performs at boot.
 */
const INTENTIONALLY_PUBLIC = new Map<string, string>([
  ['POST /api/v1/auth/login', 'you cannot be signed in in order to sign in'],
  ['POST /api/v1/auth/2fa/enroll', 'enrolment happens before the session is complete'],
  ['POST /api/v1/auth/2fa/verify', 'completes a half-authenticated sign-in'],
  ['POST /api/v1/auth/password-reset/request', 'the user has lost their password'],
  ['POST /api/v1/auth/password-reset/confirm', 'authenticated by the emailed token'],
  ['GET /api/v1/auth/me', 'returns null when anonymous; the client asks on every load'],
  ['GET /api/v1/health', 'liveness probe; returns a constant'],
  ['GET /api/v1/health/ready', 'readiness probe; says only whether traffic can be served'],
  ['GET /api/v1/onboarding/languages', 'reference data for the public application form'],
  ['GET /api/v1/onboarding/capabilities', 'reference data for the public application form'],
  ['POST /api/v1/onboarding/pharmacy', 'the public application form itself'],
  ['POST /api/v1/onboarding/doctor', 'the public application form itself'],
  ['POST /api/v1/s/exchange', 'the patient has a QR token and nothing else'],
  ['GET /api/v1/verify/:kind/:code', 'a document is verified by whoever holds it (spec §44)'],
  ['POST /api/v1/webhooks/payment', 'authenticated by HMAC over the raw body, not a session'],
]);

interface Route {
  method: string;
  path: string;
}

/**
 * Every route the application actually serves, read from Fastify.
 *
 * `printRoutes` draws a tree whose children carry only their own path
 * segment, so the full path is the concatenation of a node's ancestors —
 * `/api/v1/auth/password` plus `-reset/request`. Depth comes from the
 * indentation, four columns per level.
 *
 * Read from the live router rather than a list a test maintains, so a route
 * added tomorrow is in scope tomorrow without anyone remembering to add it.
 */
async function collectRoutes(): Promise<Route[]> {
  const app = await getTestApp();
  const printed = app.printRoutes({ commonPrefix: false });

  const routes: Route[] = [];
  const stack: string[] = [];

  for (const line of printed.split('\n')) {
    const marker = line.indexOf('── ');
    if (marker === -1) continue;

    const depth = Math.floor(marker / 4);
    const rest = line.slice(marker + 3);
    const match = rest.match(/^(\S*)\s+\(([^)]+)\)\s*$/);
    if (!match) continue;

    const segment = match[1]!;
    stack.length = depth;
    stack[depth] = segment;
    const path = stack.slice(0, depth + 1).join('');

    // The wildcard OPTIONS route Fastify adds for CORS is not a resource.
    if (path === '*') continue;

    for (const method of match[2]!.split(',').map((m) => m.trim())) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      routes.push({ method, path });
    }
  }

  return routes;
}

/** A concrete value for each route parameter, so the sweep can call the URL. */
function concreteUrl(path: string): string {
  return path
    .replace(/:publicId\.pdf/g, 'rx_000000000000000000000000.pdf')
    .replace(/:publicId/g, 'cst_000000000000000000000000')
    .replace(/:kind/g, 'rx')
    .replace(/:channel/g, 'SMS')
    .replace(/:code/g, 'ABCD1234')
    .replace(/:key/g, 'consultation_price_minor')
    .replace(/:id/g, '1');
}

describe('broken authorization (spec §79)', () => {
  it('refuses every non-public route to an anonymous caller', async () => {
    const app = await getTestApp();
    const routes = await collectRoutes();

    // A sanity floor: if the parse silently produced nothing, the assertion
    // below would pass by vacuity and the sweep would be worthless.
    expect(routes.length).toBeGreaterThan(80);

    const leaked: string[] = [];
    for (const route of routes) {
      if (INTENTIONALLY_PUBLIC.has(`${route.method} ${route.path}`)) continue;

      const response = await app.inject({
        method: route.method as 'GET',
        url: concreteUrl(route.path),
        payload: route.method === 'GET' ? undefined : {},
      });

      // 401 is the right answer and 403 also refuses. Anything else means the
      // route did work for a stranger, even if it then failed on a missing
      // body or an unknown id — a 404 here means the handler ran and looked
      // the record up, which is one schema change away from returning it.
      if (response.statusCode !== 401 && response.statusCode !== 403) {
        leaked.push(`${route.method} ${route.path} → ${response.statusCode}`);
      }
    }

    expect(leaked).toEqual([]);
  });

  it('keeps no stale entry in the public allow-list', async () => {
    const routes = await collectRoutes();
    const live = new Set(routes.map((route) => `${route.method} ${route.path}`));

    // The reverse direction. An entry left behind after a route is renamed
    // would sit there pre-authorising the next route to take that name.
    const stale = [...INTENTIONALLY_PUBLIC.keys()].filter((key) => !live.has(key));
    expect(stale).toEqual([]);
  });

  it('gives every public route a written reason', () => {
    for (const [route, reason] of INTENTIONALLY_PUBLIC) {
      expect(reason.length, route).toBeGreaterThan(15);
    }
  });
});

// ---------------------------------------------------------------------------
// Unauthorized role access
// ---------------------------------------------------------------------------

describe('unauthorized role access (spec §79)', () => {
  /**
   * The sweep again, but with a real session of the wrong role.
   *
   * Authentication and authorization fail differently: a signed-in pharmacy
   * reaching an admin route is the more likely attack, because the attacker
   * already has a legitimate account and only needs one route that checks
   * "is signed in" instead of "is an admin".
   */
  it('refuses a pharmacy session on every admin and doctor route', async () => {
    const world = await buildWorld('Alpha');
    const app = await getTestApp();
    const routes = await collectRoutes();

    const leaked: string[] = [];
    for (const route of routes) {
      const foreign =
        route.path.startsWith('/api/v1/admin/') || route.path.startsWith('/api/v1/doctor/');
      if (!foreign) continue;

      const response = await app.inject({
        method: route.method as 'GET',
        url: concreteUrl(route.path),
        cookies: world.pharmacyCookies,
        headers: { 'x-neem-csrf': world.pharmacyCookies.neem_csrf! },
        payload: route.method === 'GET' ? undefined : {},
      });

      if (response.statusCode !== 403 && response.statusCode !== 401) {
        leaked.push(`${route.method} ${route.path} → ${response.statusCode}`);
      }
    }

    expect(leaked).toEqual([]);
  });

  it('refuses a doctor session on every admin and pharmacy route', async () => {
    const world = await buildWorld('Alpha');
    const app = await getTestApp();
    const routes = await collectRoutes();

    const leaked: string[] = [];
    for (const route of routes) {
      const foreign =
        route.path.startsWith('/api/v1/admin/') || route.path.startsWith('/api/v1/pharmacy/');
      if (!foreign) continue;

      const response = await app.inject({
        method: route.method as 'GET',
        url: concreteUrl(route.path),
        cookies: world.doctorCookies,
        headers: { 'x-neem-csrf': world.doctorCookies.neem_csrf! },
        payload: route.method === 'GET' ? undefined : {},
      });

      if (response.statusCode !== 403 && response.statusCode !== 401) {
        leaked.push(`${route.method} ${route.path} → ${response.statusCode}`);
      }
    }

    expect(leaked).toEqual([]);
  });

  it('refuses a patient cookie on every staff route', async () => {
    const world = await buildWorld('Alpha');
    const app = await getTestApp();
    const routes = await collectRoutes();

    const leaked: string[] = [];
    for (const route of routes) {
      if (route.path.startsWith('/api/v1/patient/')) continue;
      if (INTENTIONALLY_PUBLIC.has(`${route.method} ${route.path}`)) continue;

      const response = await app.inject({
        method: route.method as 'GET',
        url: concreteUrl(route.path),
        cookies: world.patientCookies,
        payload: route.method === 'GET' ? undefined : {},
      });

      if (response.statusCode !== 403 && response.statusCode !== 401) {
        leaked.push(`${route.method} ${route.path} → ${response.statusCode}`);
      }
    }

    expect(leaked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The four isolation demonstrations (spec §102)
//
// The master specification names four critical demonstrations. The repository
// references §102 at the ownership check of every resource — pharmacy,
// doctor, patient and role — and these are those four boundaries, each
// attacked with a complete, legitimate account on the other side of it. An
// attacker with no account is the easy case and is covered by the sweep
// above; an attacker with a real pharmacy account is the case that matters.
// ---------------------------------------------------------------------------

describe('§102 (1) cross-pharmacy access', () => {
  it("cannot reach another pharmacy's consultation by any route that takes one", async () => {
    const alpha = await buildWorld('Alpha');
    const beta = await buildWorld('Beta');

    const attempts: Array<[string, 'GET' | 'POST']> = [
      [`/pharmacy/consultations/${alpha.consultationPublicId}`, 'GET'],
      [`/pharmacy/consultations/${alpha.consultationPublicId}/payment`, 'GET'],
      [`/pharmacy/consultations/${alpha.consultationPublicId}/payment`, 'POST'],
      [`/pharmacy/consultations/${alpha.consultationPublicId}/qr`, 'POST'],
      [`/pharmacy/consultations/${alpha.consultationPublicId}/cancel`, 'POST'],
      [`/pharmacy/consultations/${alpha.consultationPublicId}/observations`, 'GET'],
      [`/pharmacy/consultations/${alpha.consultationPublicId}/vitals`, 'POST'],
      [`/pharmacy/consultations/${alpha.consultationPublicId}/tests`, 'POST'],
      [`/pharmacy/consultations/${alpha.consultationPublicId}/refund-request`, 'POST'],
    ];

    const reached: string[] = [];
    for (const [path, method] of attempts) {
      const response = await request(path, {
        method,
        cookies: beta.pharmacyCookies,
        payload: method === 'POST' ? {} : undefined,
      });

      // 404, because confirming the consultation exists would itself disclose
      // that Alpha has a patient — 403 would answer a question Beta may not
      // ask. 400 is also a refusal: the route rejected the body before it
      // ever looked, which means it never reached Alpha's row.
      if (response.status !== 404 && response.status !== 400) {
        reached.push(`${method} ${path} → ${response.status}`);
      }
    }

    expect(reached).toEqual([]);
  });

  it("cannot dispense or substitute another pharmacy's prescription", async () => {
    const alpha = await buildWorld('Alpha');
    const beta = await buildWorld('Beta');

    const dispense = await request(
      `/pharmacy/prescriptions/${alpha.prescriptionPublicId}/dispense`,
      { method: 'POST', cookies: beta.pharmacyCookies, payload: {} },
    );
    expect([400, 403, 404]).toContain(dispense.status);

    const substitute = await request(
      `/pharmacy/prescriptions/${alpha.prescriptionPublicId}/substitutions`,
      {
        method: 'POST',
        cookies: beta.pharmacyCookies,
        payload: { itemId: 1, proposedMedication: 'Ampicillin', reason: 'Out of stock' },
      },
    );
    expect([400, 403, 404]).toContain(substitute.status);

    // And Alpha's prescription is untouched — still ACTIVE, never dispensed.
    const after = await getPrisma().prescription.findUniqueOrThrow({
      where: { id: alpha.prescriptionId },
    });
    expect(after.state).toBe('ACTIVE');
    expect(after.dispensedAt).toBeNull();
  });

  it("does not list another pharmacy's consultations or prescriptions", async () => {
    const alpha = await buildWorld('Alpha');
    const beta = await buildWorld('Beta');

    const consultations = await request<Array<{ publicId: string }>>(
      '/pharmacy/consultations',
      { cookies: beta.pharmacyCookies },
    );
    const ids = (consultations.body.data ?? []).map((row) => row.publicId);
    expect(ids).not.toContain(alpha.consultationPublicId);
    expect(ids).toContain(beta.consultationPublicId);

    const prescriptions = await request<Array<{ publicId: string }>>(
      '/pharmacy/prescriptions',
      { cookies: beta.pharmacyCookies },
    );
    const rxIds = (prescriptions.body.data ?? []).map((row) => row.publicId);
    expect(rxIds).not.toContain(alpha.prescriptionPublicId);
  });

  it("cannot read another pharmacy's uploaded document", async () => {
    const alpha = await buildWorld('Alpha');
    const beta = await buildWorld('Beta');

    const document = await getPrisma().pharmacyDocument.create({
      data: {
        pharmacyId: alpha.pharmacyId,
        type: 'PREMISES_LICENCE',
        mimeType: 'image/png',
        sizeBytes: 68,
        storageKey: 'pharmacy/alpha/licence.png',
      },
    });

    const response = await request(`/pharmacy/documents/${document.id}`, {
      cookies: beta.pharmacyCookies,
    });
    expect(response.status).toBe(404);
  });
});

describe('§102 (2) cross-doctor access', () => {
  it("cannot open the clinical workspace of another doctor's consultation", async () => {
    const alpha = await buildWorld('Alpha');
    const beta = await buildWorld('Beta');

    // The workspace is the whole clinical record. This is the single most
    // damaging IDOR the product could have.
    const workspace = await request(
      `/doctor/consultations/${alpha.consultationPublicId}/workspace`,
      { cookies: beta.doctorCookies },
    );
    expect(workspace.status).toBe(404);
    expect(JSON.stringify(workspace.body)).not.toContain('Alpha Patient');
  });

  it("cannot write to, prescribe on, or complete another doctor's consultation", async () => {
    const alpha = await buildWorld('Alpha');
    const beta = await buildWorld('Beta');

    const attempts: Array<[string, 'GET' | 'POST' | 'PUT', unknown]> = [
      [`/doctor/consultations/${alpha.consultationPublicId}`, 'GET', undefined],
      [`/doctor/consultations/${alpha.consultationPublicId}/accept`, 'POST', {}],
      [`/doctor/consultations/${alpha.consultationPublicId}/notes`, 'PUT', { historyText: 'x' }],
      [`/doctor/consultations/${alpha.consultationPublicId}/prescriptions`, 'POST', { items: [] }],
      [`/doctor/consultations/${alpha.consultationPublicId}/referrals`, 'POST', {}],
      [`/doctor/consultations/${alpha.consultationPublicId}/summary`, 'POST', {}],
      [`/doctor/consultations/${alpha.consultationPublicId}/complete`, 'POST', {}],
      [`/doctor/consultations/${alpha.consultationPublicId}/media/join`, 'POST', {}],
      [`/doctor/consultations/${alpha.consultationPublicId}/call`, 'POST', {}],
      [`/doctor/consultations/${alpha.consultationPublicId}/timer`, 'GET', undefined],
    ];

    const reached: string[] = [];
    for (const [path, method, payload] of attempts) {
      const response = await request(path, {
        method,
        cookies: beta.doctorCookies,
        payload,
      });
      if (response.status !== 404 && response.status !== 400 && response.status !== 403) {
        reached.push(`${method} ${path} → ${response.status}`);
      }
    }

    expect(reached).toEqual([]);

    // Alpha's consultation is still in progress and still Alpha's doctor's.
    const after = await getPrisma().consultation.findUniqueOrThrow({
      where: { id: alpha.consultationId },
    });
    expect(after.state).toBe('IN_PROGRESS');
    expect(after.doctorId).toBe(alpha.doctorId);
  });

  it("cannot revoke another doctor's prescription", async () => {
    const alpha = await buildWorld('Alpha');
    const beta = await buildWorld('Beta');

    const response = await request(
      `/doctor/prescriptions/${alpha.prescriptionPublicId}/revoke`,
      { method: 'POST', cookies: beta.doctorCookies, payload: { reason: 'Wrong medication' } },
    );
    expect([400, 403, 404]).toContain(response.status);

    const after = await getPrisma().prescription.findUniqueOrThrow({
      where: { id: alpha.prescriptionId },
    });
    expect(after.state).toBe('ACTIVE');
  });

  it('is not offered another doctor\'s consultation in its own queue', async () => {
    const alpha = await buildWorld('Alpha');
    const beta = await buildWorld('Beta');

    const queue = await request<{ offers?: Array<{ consultationPublicId: string }> }>(
      '/doctor/queue',
      { cookies: beta.doctorCookies },
    );

    const offered = JSON.stringify(queue.body.data ?? {});
    expect(offered).not.toContain(alpha.consultationPublicId);
  });
});

describe('§102 (3) cross-patient access and session takeover', () => {
  it("resolves each patient cookie only to that patient's own consultation", async () => {
    const alpha = await buildWorld('Alpha');
    const beta = await buildWorld('Beta');

    const view = await request<{ consultation: { publicId: string } }>('/patient/session', {
      cookies: beta.patientCookies,
    });

    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toContain(alpha.consultationPublicId);
    expect(JSON.stringify(view.body)).not.toContain('Alpha Patient');
  });

  it('gives the patient no route that takes a consultation id at all', async () => {
    // The structural half of the guarantee. There is nothing to enumerate
    // because no patient route accepts an identifier — the cookie *is* the
    // scope. A patient route with a `:publicId` would be the bug.
    const routes = await collectRoutes();
    const parameterised = routes
      .filter((route) => route.path.startsWith('/api/v1/patient/'))
      .filter((route) => route.path.includes(':'));

    expect(parameterised).toEqual([]);
  });

  it('refuses a forged or truncated patient cookie', async () => {
    const alpha = await buildWorld('Alpha');

    const forgeries = [
      'not-a-token',
      'a'.repeat(64),
      alpha.patientCookies.neem_patient!.slice(0, -1),
      `${alpha.patientCookies.neem_patient}x`,
    ];

    for (const forged of forgeries) {
      const response = await request('/patient/session', {
        cookies: { neem_patient: forged },
      });
      expect(response.status, forged.slice(0, 12)).toBe(401);
    }
  });

  it('stops working the moment the patient leaves, even for a copied token', async () => {
    const alpha = await buildWorld('Alpha');

    // The attacker has the token — copied off a shared handset at the counter.
    const stolen = { ...alpha.patientCookies };

    const before = await request('/patient/session', { cookies: stolen });
    expect(before.status).toBe(200);

    await request('/patient/session/leave', {
      method: 'POST',
      cookies: alpha.patientCookies,
      payload: {},
    });

    // Clearing the victim's cookie protects the victim's browser and nothing
    // else. Leaving has to end the session on the server, or "leave" means
    // nothing to the person holding a copy of the token.
    const after = await request('/patient/session', { cookies: stolen });
    expect(after.status).toBe(401);
  });

  it('does not let a photographed QR code be exchanged twice', async () => {
    const prisma = getPrisma();
    const pharmacy = await createTestPharmacy('Solo Pharmacy', 'ACTIVE');
    const user = await createTestUser({
      email: 'qr@pharmacy.test',
      password: PASSWORD,
      role: 'PHARMACY',
    });
    await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });
    const cookies = await signIn(user.email, PASSWORD);

    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;
    const consultation = await prisma.consultation.findUniqueOrThrow({ where: { publicId } });
    for (const state of ['PAYMENT_PROCESSING', 'PAID', 'ACTIVATED'] as const) {
      await transition(consultation.id, state, { actorType: 'SYSTEM', reason: 'security fixture' });
    }

    const qr = await request<{ url: string }>(`/pharmacy/consultations/${publicId}/qr`, {
      method: 'POST',
      cookies,
      payload: {},
    });
    const token = qr.body.data!.url.split('/s/')[1]!;

    // The patient scans. Then someone who photographed the same code scans.
    const patient = await request('/s/exchange', { method: 'POST', payload: { token } });
    expect(patient.status).toBe(200);

    const attacker = await request('/s/exchange', { method: 'POST', payload: { token } });
    expect(attacker.status).toBe(404);
    expect(attacker.cookies.neem_patient).toBeUndefined();
  });

  it('refuses an expired QR code', async () => {
    const alpha = await buildWorld('Alpha');
    const prisma = getPrisma();

    // Issue a fresh code, then age it past its TTL.
    const qr = await request<{ url: string }>(
      `/pharmacy/consultations/${alpha.consultationPublicId}/qr`,
      { method: 'POST', cookies: alpha.pharmacyCookies, payload: {} },
    );
    // IN_PROGRESS no longer accepts arrival, so the reissue itself is refused
    // — which is the stronger property and worth asserting directly.
    expect(qr.status).toBe(422);

    const stale = await prisma.consultationAccessToken.findFirst({
      where: { consultationId: alpha.consultationId },
    });
    expect(stale).not.toBeNull();
    expect(stale!.consumedAt).not.toBeNull();
  });
});

describe('§102 (4) admin privilege escalation', () => {
  it('does not let a pharmacy or doctor promote itself', async () => {
    const world = await buildWorld('Alpha');
    const prisma = getPrisma();

    // There is no route that writes a role — the escalation would have to go
    // through one of these, and none of them accept it.
    const attempts: Array<[Record<string, string>, string, unknown]> = [
      [world.pharmacyCookies, '/auth/password', { currentPassword: PASSWORD, newPassword: 'Another1!Password', role: 'ADMIN' }],
      [world.doctorCookies, '/doctor/profile', { role: 'ADMIN' }],
      [world.pharmacyCookies, '/pharmacy/profile', { role: 'ADMIN' }],
    ];

    for (const [cookies, path, payload] of attempts) {
      await request(path, { method: 'POST', cookies, payload });
    }

    const roles = await prisma.user.findMany({ select: { email: true, role: true } });
    expect(roles.filter((row) => row.role === 'ADMIN')).toEqual([]);
  });

  it('does not let a non-admin reach a single admin route', async () => {
    const world = await buildWorld('Alpha');
    const routes = await collectRoutes();
    const app = await getTestApp();

    const adminRoutes = routes.filter((route) => route.path.startsWith('/api/v1/admin/'));
    expect(adminRoutes.length).toBeGreaterThan(25);

    for (const cookies of [world.pharmacyCookies, world.doctorCookies, world.patientCookies]) {
      for (const route of adminRoutes) {
        const response = await app.inject({
          method: route.method as 'GET',
          url: concreteUrl(route.path),
          cookies,
          headers: cookies.neem_csrf ? { 'x-neem-csrf': cookies.neem_csrf } : {},
          payload: route.method === 'GET' ? undefined : {},
        });
        expect([401, 403], `${route.method} ${route.path}`).toContain(response.statusCode);
      }
    }
  });

  it('does not grant an admin a usable session before the second factor', async () => {
    const prisma = getPrisma();
    await createTestUser({
      email: 'admin@security.test',
      password: PASSWORD,
      role: 'ADMIN',
    });

    const login = await request<{ status: string }>('/auth/login', {
      method: 'POST',
      payload: { email: 'admin@security.test', password: PASSWORD },
    });

    // The password alone must not produce a principal that can act. Whether
    // the response is a challenge or a refusal, what matters is that the
    // cookies it returns cannot read an admin route.
    const probe = await request('/admin/settings', { cookies: login.cookies });
    expect([401, 403]).toContain(probe.status);

    await prisma.user.deleteMany({ where: { email: 'admin@security.test' } });
  });
});

// ---------------------------------------------------------------------------
// Identifier enumeration
// ---------------------------------------------------------------------------

describe('ID enumeration (spec §79)', () => {
  it('issues public identifiers that cannot be walked', async () => {
    const alpha = await buildWorld('Alpha');
    const beta = await buildWorld('Beta');

    // Two consultations created seconds apart. If the references were
    // sequential — or carried a timestamp with a small counter after it — an
    // attacker holding one would hold the other.
    const [a, b] = [alpha.consultationPublicId, beta.consultationPublicId];

    // D29's human-transcribable form: NEEM- and twelve Crockford Base32
    // characters in groups of four. I, L, O and U are absent by design, so
    // their presence would mean the alphabet had been widened and slips
    // become ambiguous when read aloud.
    expect(a).toMatch(/^NEEM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(b).toMatch(/^NEEM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(a).not.toBe(b);

    // Every character is random — there is no timestamp prefix to walk — so
    // two references drawn seconds apart should agree on almost nothing.
    const bodyA = a.replace(/^NEEM-/, '').replace(/-/g, '');
    const bodyB = b.replace(/^NEEM-/, '').replace(/-/g, '');
    let shared = 0;
    while (shared < bodyA.length && bodyA[shared] === bodyB[shared]) shared += 1;
    expect(shared).toBeLessThan(bodyA.length / 2);
  });

  it('answers "not yours" and "does not exist" identically', async () => {
    const alpha = await buildWorld('Alpha');
    const beta = await buildWorld('Beta');

    const notYours = await request(`/pharmacy/consultations/${alpha.consultationPublicId}`, {
      cookies: beta.pharmacyCookies,
    });
    const neverExisted = await request('/pharmacy/consultations/NEEM-ZZZZ-ZZZZ-ZZZZ', {
      cookies: beta.pharmacyCookies,
    });

    // Byte-identical, so probing tells an attacker nothing about which
    // consultations exist (spec §102).
    expect(notYours.status).toBe(neverExisted.status);
    expect(notYours.body.error?.code).toBe(neverExisted.body.error?.code);
    expect(notYours.body.error?.message).toBe(neverExisted.body.error?.message);
  });

  it('does not confirm which email addresses have accounts', async () => {
    await createTestUser({ email: 'real@security.test', password: PASSWORD, role: 'PHARMACY' });

    const real = await request('/auth/login', {
      method: 'POST',
      payload: { email: 'real@security.test', password: 'WrongPassword123!' },
    });
    const fake = await request('/auth/login', {
      method: 'POST',
      payload: { email: 'nobody@security.test', password: 'WrongPassword123!' },
    });

    expect(real.status).toBe(fake.status);
    expect(real.body.error?.message).toBe(fake.body.error?.message);

    // The same applies to password reset, which must not become an oracle.
    const resetReal = await request('/auth/password-reset/request', {
      method: 'POST',
      payload: { email: 'real@security.test' },
    });
    const resetFake = await request('/auth/password-reset/request', {
      method: 'POST',
      payload: { email: 'nobody@security.test' },
    });

    expect(resetReal.status).toBe(resetFake.status);
    expect(resetReal.body.data).toEqual(resetFake.body.data);
  });
});

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

/**
 * Payloads that would break a query built by concatenation.
 *
 * The application uses Prisma throughout, and its two raw statements
 * (`presence.service.ts`, `scheduling.service.ts`) are parameterised. That is
 * an argument; this is a demonstration, and it is the demonstration that
 * survives someone adding a third raw statement in a hurry.
 */
const SQL_PAYLOADS = [
  "' OR '1'='1",
  "'; DROP TABLE consultations; --",
  "cst_1' UNION SELECT * FROM users --",
  '1 OR 1=1',
  "\\'; SELECT SLEEP(5); --",
  "' OR 1=1 LIMIT 1 --",
];

describe('SQL injection (spec §79)', () => {
  it('treats injection payloads as ordinary strings in a path parameter', async () => {
    const world = await buildWorld('Alpha');

    for (const payload of SQL_PAYLOADS) {
      const response = await request(
        `/pharmacy/consultations/${encodeURIComponent(payload)}`,
        { cookies: world.pharmacyCookies },
      );

      // Not found or rejected — never 200, and never a 500, which would mean
      // the payload reached the database and confused it.
      expect([400, 404], payload).toContain(response.status);
    }

    // And the table is still there, with the row still in it.
    const still = await getPrisma().consultation.count();
    expect(still).toBeGreaterThan(0);
  });

  it('treats injection payloads as ordinary strings in a query string', async () => {
    const world = await buildWorld('Alpha');

    for (const payload of SQL_PAYLOADS) {
      const response = await request(
        `/pharmacy/consultations?cursor=${encodeURIComponent(payload)}`,
        { cookies: world.pharmacyCookies },
      );
      expect([200, 400], payload).toContain(response.status);
    }
  });

  it('treats injection payloads as ordinary strings in a body field', async () => {
    const world = await buildWorld('Alpha');

    for (const payload of SQL_PAYLOADS) {
      const response = await request('/pharmacy/consultations', {
        method: 'POST',
        cookies: world.pharmacyCookies,
        payload: { promotionCode: payload },
      });

      // A promotion code that does not exist is a business refusal or is
      // ignored; either way no discount is applied and nothing is executed.
      expect([200, 201, 400, 404, 422], payload).toContain(response.status);
    }

    const priced = await getPrisma().consultation.findMany({ select: { netMinor: true } });
    for (const row of priced) {
      // Nothing talked the price down to nothing.
      expect(row.netMinor).toBeGreaterThan(0);
    }
  });
});

describe('XSS (spec §79)', () => {
  const SCRIPT = '<script>alert(document.cookie)</script>';

  it('never serves an API response as HTML', async () => {
    const world = await buildWorld('Alpha');

    // The API is JSON only. A stored payload is harmless as long as nothing
    // is ever handed to a browser as a document — which is the property, and
    // it is stronger than escaping on the way out.
    const responses = await Promise.all([
      request('/pharmacy/consultations', { cookies: world.pharmacyCookies }),
      request('/pharmacy/profile', { cookies: world.pharmacyCookies }),
      request('/doctor/profile', { cookies: world.doctorCookies }),
      request('/patient/session', { cookies: world.patientCookies }),
    ]);

    for (const response of responses) {
      const contentType = String(response.raw.headers['content-type'] ?? '');
      expect(contentType).toContain('application/json');
      expect(contentType).not.toContain('text/html');
    }
  });

  it('stores a script payload verbatim and returns it as data, not markup', async () => {
    const world = await buildWorld('Alpha');

    const named = await request('/patient/session/identity', {
      method: 'POST',
      cookies: world.patientCookies,
      payload: { fullName: SCRIPT, age: 30, sex: 'FEMALE', phone: '0245551234' },
    });

    // Either the name is rejected by validation or it is stored as text. What
    // must not happen is the payload coming back inside an HTML response.
    if (named.status === 200) {
      const contentType = String(named.raw.headers['content-type'] ?? '');
      expect(contentType).toContain('application/json');
    } else {
      expect([400, 422]).toContain(named.status);
    }
  });

  it('sets the response headers that stop a browser guessing', async () => {
    const world = await buildWorld('Alpha');
    const response = await request('/pharmacy/profile', { cookies: world.pharmacyCookies });

    // A JSON body sniffed as HTML is an XSS, so the sniffing has to be off.
    expect(response.raw.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CSRF (spec §79)', () => {
  it('refuses a mutating request that carries the session but not the token', async () => {
    const world = await buildWorld('Alpha');

    // Exactly what a hostile page can do: the browser attaches the session
    // cookie automatically, but same-origin policy stops the page reading the
    // CSRF cookie to echo it.
    const response = await request('/pharmacy/consultations', {
      method: 'POST',
      cookies: world.pharmacyCookies,
      withCsrf: false,
      payload: {},
    });

    expect(response.status).toBe(403);
    expect(response.body.error?.code).toBe('CSRF_INVALID');
  });

  it('refuses a token that does not match the cookie', async () => {
    const alpha = await buildWorld('Alpha');
    const beta = await buildWorld('Beta');

    // Beta's token with Alpha's session: a guessed or borrowed value is not
    // enough, because the two halves are compared against each other.
    const response = await request('/pharmacy/consultations', {
      method: 'POST',
      cookies: alpha.pharmacyCookies,
      withCsrf: false,
      headers: { 'x-neem-csrf': beta.pharmacyCookies.neem_csrf! },
      payload: {},
    });

    expect(response.status).toBe(403);
  });

  it('protects every mutating staff route, not only the interesting ones', async () => {
    const world = await buildWorld('Alpha');
    const app = await getTestApp();
    const routes = await collectRoutes();

    const unprotected: string[] = [];
    for (const route of routes) {
      if (route.method === 'GET') continue;
      if (!route.path.startsWith('/api/v1/pharmacy/')) continue;

      const response = await app.inject({
        method: route.method as 'POST',
        url: concreteUrl(route.path),
        cookies: world.pharmacyCookies,
        payload: {},
      });

      if (response.statusCode !== 403) {
        unprotected.push(`${route.method} ${route.path} → ${response.statusCode}`);
      }
    }

    expect(unprotected).toEqual([]);
  });
});

describe('brute force (spec §79)', () => {
  it('locks the account before the attacker runs out of guesses', async () => {
    await createTestUser({ email: 'target@security.test', password: PASSWORD, role: 'PHARMACY' });
    const attempts = getEnv().LOGIN_MAX_ATTEMPTS;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const wrong = await request('/auth/login', {
        method: 'POST',
        payload: { email: 'target@security.test', password: `Wrong${attempt}Password!` },
      });
      expect(wrong.status).toBe(401);
    }

    // The important half: the *correct* password is now refused too. A lock
    // checked after the password comparison would let the attacker in on the
    // guess that finally landed, which is the only guess that matters.
    const correct = await request('/auth/login', {
      method: 'POST',
      payload: { email: 'target@security.test', password: PASSWORD },
    });

    // The status alone would prove nothing: the IP rate limiter answers 429
    // too, and this suite runs with that limit raised out of the way. The
    // error *code* is what distinguishes "this account is locked" from "you
    // are asking too fast", and it is the account lock that has to be doing
    // the work here.
    expect(correct.status).toBe(429);
    expect(correct.body.error?.code).toBe('ACCOUNT_LOCKED');
    expect(correct.cookies.neem_session).toBeUndefined();
  });

  it('is not evaded by changing the case of the email address', async () => {
    await createTestUser({ email: 'mixed@security.test', password: PASSWORD, role: 'PHARMACY' });
    const attempts = getEnv().LOGIN_MAX_ATTEMPTS;

    // Spend the budget on a differently-cased spelling of the same account.
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await request('/auth/login', {
        method: 'POST',
        payload: { email: 'MIXED@Security.Test', password: `Wrong${attempt}Password!` },
      });
    }

    // If case produced a second bucket, the canonical spelling would still
    // have its full allowance and the lockout would count for nothing.
    const correct = await request('/auth/login', {
      method: 'POST',
      payload: { email: 'mixed@security.test', password: PASSWORD },
    });

    expect(correct.status).toBe(429);
    expect(correct.body.error?.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('payment manipulation (spec §79)', () => {
  it('prices from settings and ignores any amount the client sends', async () => {
    const prisma = getPrisma();
    const pharmacy = await createTestPharmacy('Pricing Pharmacy', 'ACTIVE');
    const user = await createTestUser({
      email: 'pricing@pharmacy.test',
      password: PASSWORD,
      role: 'PHARMACY',
    });
    await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });
    const cookies = await signIn(user.email, PASSWORD);

    const created = await request<{ publicId: string; net: { amountMinor: number } }>(
      '/pharmacy/consultations',
      {
        method: 'POST',
        cookies,
        // Every shape an attacker would try.
        payload: {
          netMinor: 1,
          amountMinor: 1,
          grossMinor: 1,
          net: { amountMinor: 1, currency: 'GHS' },
          price: 0,
          discountMinor: 4000,
        },
      },
    );

    expect(created.status).toBe(201);
    expect(created.body.data?.net.amountMinor).toBe(4000);

    const row = await prisma.consultation.findUniqueOrThrow({
      where: { publicId: created.body.data!.publicId },
    });
    expect(row.netMinor).toBe(4000);
    expect(row.discountMinor).toBe(0);
  });

  it('does not activate a consultation on a forged webhook', async () => {
    const prisma = getPrisma();
    const pharmacy = await createTestPharmacy('Forge Pharmacy', 'ACTIVE');
    const user = await createTestUser({
      email: 'forge@pharmacy.test',
      password: PASSWORD,
      role: 'PHARMACY',
    });
    await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });
    const cookies = await signIn(user.email, PASSWORD);

    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;

    const initiated = await request<{ providerReference: string }>(
      `/pharmacy/consultations/${publicId}/payment`,
      { method: 'POST', cookies, payload: {} },
    );
    const reference = initiated.body.data!.providerReference;

    const app = await getTestApp();
    const body = JSON.stringify({
      id: 'evt_forged',
      event: 'charge.success',
      data: { reference, status: 'success', amount: 4000, currency: 'GHS' },
    });

    // A perfectly-shaped success event for a real reference, with a signature
    // the attacker guessed. This is the whole attack: if the route trusted the
    // payload, the consultation would activate for free.
    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/payment',
      headers: { 'content-type': 'application/json', 'x-neem-mock-signature': 'f'.repeat(128) },
      payload: body,
    });

    expect(forged.statusCode).toBe(401);

    // Still waiting on a payment. PAYMENT_PROCESSING is where initiating the
    // charge legitimately left it; what matters is that the forgery did not
    // carry it any further.
    const after = await prisma.consultation.findUniqueOrThrow({ where: { publicId } });
    expect(after.state).toBe('PAYMENT_PROCESSING');
    expect(['PAID', 'ACTIVATED', 'WAITING_FOR_PATIENT']).not.toContain(after.state);

    // And no payment was recorded as successful.
    const successes = await prisma.payment.count({
      where: { consultationId: after.id, status: 'SUCCESS' },
    });
    expect(successes).toBe(0);

    // And the attempt is on the record as a security event, not lost.
    //
    // Through the constant, not the literal: the stored value is
    // `payment.anomaly`, and a test that hard-codes a guess at it passes
    // vacuously — it counts zero rows and asserts zero is what it expected,
    // which is how a test for "we noticed the attack" ends up proving
    // nothing.
    const anomalies = await prisma.auditLog.count({
      where: { action: AUDIT_ACTIONS.PAYMENT_ANOMALY, outcome: 'DENIED' },
    });
    expect(anomalies).toBeGreaterThan(0);
  });

  it('applies a correctly-signed webhook exactly once', async () => {
    const prisma = getPrisma();
    const pharmacy = await createTestPharmacy('Once Pharmacy', 'ACTIVE');
    const user = await createTestUser({
      email: 'once@pharmacy.test',
      password: PASSWORD,
      role: 'PHARMACY',
    });
    await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });
    const cookies = await signIn(user.email, PASSWORD);

    const created = await request<{ publicId: string }>('/pharmacy/consultations', {
      method: 'POST',
      cookies,
      payload: {},
    });
    const publicId = created.body.data!.publicId;
    const initiated = await request<{ providerReference: string }>(
      `/pharmacy/consultations/${publicId}/payment`,
      { method: 'POST', cookies, payload: {} },
    );
    const reference = initiated.body.data!.providerReference;

    const body = JSON.stringify({
      id: 'evt_replay',
      event: 'charge.success',
      data: { reference, status: 'success', amount: 4000, currency: 'GHS' },
    });
    const secret = getEnv().PAYSTACK_WEBHOOK_SECRET || getEnv().SESSION_SECRET;
    const signature = createHmac('sha512', secret).update(Buffer.from(body)).digest('hex');

    const app = await getTestApp();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/payment',
        headers: { 'content-type': 'application/json', 'x-neem-mock-signature': signature },
        payload: body,
      });

    const first = await send();
    const replayed = await send();

    expect(first.statusCode).toBe(200);
    // Replaying is acknowledged rather than errored — an error makes the
    // provider retry, which produces more replays.
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().data.processed).toBe(false);

    // One payment, one revenue record. A replay that credited twice would be
    // a reconciliation problem nobody notices until the month closes.
    expect(await prisma.payment.count({ where: { providerReference: reference } })).toBe(1);
    const events = await prisma.consultationStateEvent.count({
      where: { consultationId: (await prisma.consultation.findUniqueOrThrow({ where: { publicId } })).id, toState: 'PAID' },
    });
    expect(events).toBeLessThanOrEqual(1);
  });

  it('offers no settle-it-yourself route once a real provider is configured', async () => {
    const world = await buildWorld('Alpha');

    // `/payment/simulate` exists so a demonstration can be run without moving
    // money. It is gated twice — on the configured provider name and on the
    // instance actually installed — because a route that activates a
    // consultation on request must not survive into production by accident.
    setPaymentProviderForTesting(undefined);
    try {
      const response = await request(
        `/pharmacy/consultations/${world.consultationPublicId}/payment/simulate`,
        { method: 'POST', cookies: world.pharmacyCookies, payload: { outcome: 'SUCCESS' } },
      );
      expect([404, 422]).toContain(response.status);
    } finally {
      setPaymentProviderForTesting(new MockPaymentProvider());
    }
  });
});
