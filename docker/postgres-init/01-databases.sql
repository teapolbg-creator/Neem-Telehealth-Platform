-- Runs once, on first container start (empty data volume).

-- Integration tests run against a real database rather than mocks, because
-- unique constraints and transaction behaviour are a large part of what is
-- being tested (payment idempotency, revenue allocation, the 40-hour rule).
CREATE DATABASE neem_test OWNER neem;

-- Prisma Migrate builds a throwaway "shadow" database to detect schema drift.
-- Providing one explicitly is preferable to granting the application role
-- CREATEDB across the cluster (least privilege — docs/security.md §6).
CREATE DATABASE neem_shadow OWNER neem;

-- The append-only audit writer (docs/security.md §7).
--
-- The role is created here; its privileges are table-level and so cannot be
-- granted until migrations have created `audit_logs` — see
-- scripts/grant-audit-user.mjs, applied by `npm run db:grants`.
--
-- NOLOGIN is deliberately not set: this account exists to be connected as by
-- an operator reading the log out of band.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'neem_audit') THEN
    CREATE ROLE neem_audit LOGIN PASSWORD 'neem_audit_dev';
  END IF;
END
$$;
