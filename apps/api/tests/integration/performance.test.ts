import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApp, request, signIn } from '../helpers/app.ts';
import { getPrisma, disconnectPrisma } from '../../src/db/prisma.ts';
import { createTestPharmacy, createTestUser, resetDatabase } from '../helpers/database.ts';
import {
  MockPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { authenticator } from 'otplib';
import { generateConsultationReference, generatePublicId } from '../../src/lib/crypto.ts';
import { encryptTotpSecret } from '../../src/modules/auth/totp.service.ts';

/**
 * Pagination and the indexes the request path depends on (Phase 10).
 *
 * Two different failures, both of which look like nothing in development and
 * like an outage at a hundred pharmacies:
 *
 *  1. **An unbounded list.** A route that hands back every row it has is a
 *     denial of service anybody with an account can trigger, and it gets
 *     worse every day the product runs.
 *  2. **A missing index on the authentication path.** Every authenticated
 *     request resolves a session by token hash. Without an index that is a
 *     full table scan per request — invisible at fifty rows, fatal at a
 *     million, and not the sort of thing that shows up in a feature test.
 */

const PASSWORD = 'PerformancePassword123!';

async function pharmacyWithConsultations(count: number) {
  const prisma = getPrisma();
  const pharmacy = await createTestPharmacy('Busy Pharmacy', 'ACTIVE');
  const user = await createTestUser({
    email: 'busy@pharmacy.test',
    password: PASSWORD,
    role: 'PHARMACY',
  });
  await prisma.pharmacyUser.create({ data: { pharmacyId: pharmacy.id, userId: user.id } });

  // Written directly: the point is a list long enough to page through, and
  // driving 60 consultations through the payment flow would take minutes to
  // prove something about pagination.
  const now = Date.now();
  await prisma.consultation.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      publicId: generateConsultationReference(),
      pharmacyId: pharmacy.id,
      state: 'PENDING_PAYMENT' as const,
      priceMinor: 4000,
      discountMinor: 0,
      netMinor: 4000,
      currency: 'GHS',
      // Distinct timestamps, because a cursor over a tied sort key is exactly
      // where "skips a row" and "returns one twice" come from.
      createdAt: new Date(now - index * 1000),
      isDemo: true,
    })),
  });

  return { pharmacy, cookies: await signIn(user.email, PASSWORD) };
}

/** A signed-in administrator, second factor and all. */
async function adminCookies(): Promise<Record<string, string>> {
  const secret = authenticator.generateSecret(20);
  const credentials = { email: 'auditor@performance.test', password: PASSWORD };

  await createTestUser({
    ...credentials,
    role: 'ADMIN',
    twoFactorSecretEnc: encryptTotpSecret(secret),
    twoFactorEnabled: true,
  });

  const login = await request<{ challengeId: string }>('/auth/login', {
    method: 'POST',
    payload: credentials,
  });
  const verify = await request('/auth/2fa/verify', {
    method: 'POST',
    payload: { challengeId: login.body.data!.challengeId, code: authenticator.generate(secret) },
  });

  return verify.cookies;
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

describe('pagination', () => {
  it('caps the page size a caller can ask for', async () => {
    const { cookies } = await pharmacyWithConsultations(60);

    const huge = await request<Array<{ publicId: string }>>(
      '/pharmacy/consultations?limit=100000',
      { cookies },
    );

    // Either the request is refused as invalid or it is served at the ceiling.
    // What must not happen is 100,000 being honoured.
    if (huge.status === 200) {
      expect(huge.body.data!.length).toBeLessThanOrEqual(100);
    } else {
      expect(huge.status).toBe(400);
    }
  });

  it('defaults to a page rather than everything', async () => {
    const { cookies } = await pharmacyWithConsultations(60);

    const page = await request<Array<{ publicId: string }>>('/pharmacy/consultations', {
      cookies,
    });

    expect(page.status).toBe(200);
    expect(page.body.data!.length).toBeLessThan(60);
  });

  it('walks the whole list once, with no row skipped or repeated', async () => {
    const { cookies } = await pharmacyWithConsultations(60);

    const seen: string[] = [];
    let cursor: string | undefined;

    // A bound, so a cursor that fails to advance fails the test instead of
    // looping until the runner gives up.
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit: '7' });
      if (cursor) query.set('cursor', cursor);

      const response = await request<Array<{ publicId: string }>>(
        `/pharmacy/consultations?${query}`,
        { cookies },
      );
      expect(response.status).toBe(200);

      const rows = response.body.data ?? [];
      if (rows.length === 0) break;

      seen.push(...rows.map((row) => row.publicId));

      const paging = (response.body.meta as { page?: { cursor?: string; hasMore?: boolean } })
        ?.page;
      if (!paging?.hasMore) break;

      cursor = paging.cursor;
      expect(cursor, 'hasMore was true but no cursor was returned').toBeTruthy();
    }

    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
  });
});

/**
 * Indexes the request path cannot do without.
 *
 * Asserted against `information_schema` rather than by timing a query: a
 * timing test on a small database passes whatever the plan is, and would then
 * pass forever while the index that made it fast sat dropped.
 *
 * Each entry is here because something reads it on a hot path, and the note
 * says what. Removing an `@@index` from the schema fails this test with the
 * reason attached, which is the point.
 */
const REQUIRED_INDEXES: Array<{ table: string; columns: string; why: string }> = [
  {
    table: 'sessions',
    columns: 'tokenHash',
    why: 'every authenticated request resolves its principal by this hash',
  },
  {
    table: 'patient_sessions',
    columns: 'deviceSessionTokenHash',
    why: "every request from a patient's phone resolves through this hash",
  },
  {
    table: 'consultation_access_tokens',
    columns: 'tokenHash',
    why: 'every QR scan looks the token up by hash',
  },
  {
    table: 'consultations',
    columns: 'publicId',
    why: 'the consultation reference is how every screen and every human names one',
  },
  {
    table: 'consultations',
    columns: 'pharmacyId,createdAt',
    why: "the pharmacy's own consultation list, newest first, on every dashboard load",
  },
  {
    table: 'consultations',
    columns: 'doctorId,createdAt',
    why: "the doctor's own history, and the 40-hour and capacity calculations",
  },
  {
    table: 'payments',
    columns: 'providerReference',
    why: 'every webhook and every verification finds its payment by this reference',
  },
  {
    table: 'payments',
    columns: 'idempotencyKey',
    why: 'the uniqueness that makes a replayed webhook a no-op rather than a double charge',
  },
  {
    table: 'prescriptions',
    columns: 'pharmacyId,issuedAt',
    why: 'the dispensing queue at the counter',
  },
  {
    table: 'prescriptions',
    columns: 'verificationCode',
    why: 'the public verification route, which is unauthenticated and therefore sprayable',
  },
  {
    table: 'audit_logs',
    columns: 'entityType,entityId',
    why: "the audit trail for one record, which is how a disclosure question gets answered",
  },
];

describe('indexes on the request path', () => {
  it('has every index the hot paths depend on', async () => {
    const rows = await getPrisma().$queryRaw<
      Array<{ TABLE_NAME: string; cols: string }>
    >`
      SELECT TABLE_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
      GROUP BY TABLE_NAME, INDEX_NAME
    `;

    // An index whose leading columns match is enough: MySQL can use a prefix
    // of a composite index, so `(pharmacyId, createdAt, state)` satisfies a
    // requirement for `(pharmacyId, createdAt)`.
    const missing = REQUIRED_INDEXES.filter(
      (required) =>
        !rows.some(
          (row) =>
            row.TABLE_NAME === required.table &&
            (row.cols === required.columns || row.cols.startsWith(`${required.columns},`)),
        ),
    ).map((required) => `${required.table}(${required.columns}) — ${required.why}`);

    expect(missing).toEqual([]);
  });

  it('finds a session by token hash without scanning the table', async () => {
    // The one place a plan check is worth having, because it is per-request.
    // `ref`/`const`/`eq_ref` mean an index was used; `ALL` is a full scan.
    const user = await createTestUser({
      email: 'plan@test.local',
      password: PASSWORD,
      role: 'PHARMACY',
    });
    await getPrisma().session.create({
      data: {
        userId: user.id,
        tokenHash: 'a'.repeat(64),
        csrfTokenHash: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 28_800_000),
      },
    });

    const plan = await getPrisma().$queryRaw<Array<{ type: string; key: string | null }>>`
      EXPLAIN SELECT id FROM sessions WHERE tokenHash = ${'a'.repeat(64)}
    `;

    expect(plan[0]?.type).not.toBe('ALL');
    expect(plan[0]?.key).not.toBeNull();
  });
});

describe('the audit log can be read past its first page', () => {
  /**
   * The audit log is the record that answers "who saw this, and when".
   *
   * Its route accepted a cursor and ignored it, so only the newest hundred
   * entries were ever reachable — the log was written correctly and could not
   * be read. Bounded and unreachable are different failures and this covers
   * both: the page does not grow with the table, *and* the pages join up.
   *
   * Driven through the real route, second factor and all. Testing the query
   * in isolation would have passed against the broken version, because the
   * bug was not in the query — it was the route accepting a cursor and never
   * passing it on.
   */
  it('pages through without skipping or repeating an entry', async () => {
    const prisma = getPrisma();
    const cookies = await adminCookies();

    // Deliberately tied timestamps: a consultation transition writes several
    // entries in the same millisecond, and a cursor keyed on a non-unique
    // column loses rows exactly there. Ten distinct instants, 200 rows.
    const base = Date.now();
    await prisma.auditLog.createMany({
      data: Array.from({ length: 200 }, (_, index) => ({
        action: 'consultation.created',
        actorType: 'SYSTEM' as const,
        outcome: 'SUCCESS' as const,
        correlationId: generatePublicId('cor'),
        occurredAt: new Date(base - Math.floor(index / 20) * 1000),
      })),
    });

    const limit = 25;
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 40; page += 1) {
      const query = new URLSearchParams({
        limit: String(limit),
        action: 'consultation.created',
      });
      if (cursor) query.set('cursor', cursor);

      const response = await request<Array<{ id: string }>>(`/admin/audit-logs?${query}`, {
        cookies,
      });
      expect(response.status).toBe(200);

      const rows = response.body.data ?? [];

      // Bounded: the page never grows with the table.
      expect(rows.length).toBeLessThanOrEqual(limit);

      seen.push(...rows.map((row) => row.id));

      const paging = (response.body.meta as { page?: { cursor?: string; hasMore?: boolean } })
        ?.page;
      if (!paging?.hasMore) break;

      cursor = paging.cursor;
      expect(cursor, 'hasMore was true but no cursor was returned').toBeTruthy();
    }

    expect(seen).toHaveLength(200);
    expect(new Set(seen).size).toBe(200);
  });
});
