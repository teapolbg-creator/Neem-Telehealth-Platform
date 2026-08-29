-- Runs once, on first container start (empty data volume).

-- Integration tests run against a real MySQL database rather than mocks,
-- because unique constraints and transaction behaviour are a large part of
-- what is being tested (payment idempotency, revenue allocation, 40h rule).
CREATE DATABASE IF NOT EXISTS `neem_test`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- Prisma Migrate builds a throwaway "shadow" database to detect schema drift.
-- Providing one explicitly is preferable to granting the application user
-- CREATE DATABASE across the server (least privilege — docs/security.md §6).
CREATE DATABASE IF NOT EXISTS `neem_shadow`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

GRANT ALL PRIVILEGES ON `neem_test`.*   TO 'neem'@'%';
GRANT ALL PRIVILEGES ON `neem_shadow`.* TO 'neem'@'%';

-- The append-only audit writer (docs/security.md §7). The account is created
-- here, but its grants are table-level and therefore cannot be issued until
-- migrations have created `audit_logs` — see scripts/grant-audit-user.sql,
-- applied by `npm run db:grants`.
CREATE USER IF NOT EXISTS 'neem_audit'@'%' IDENTIFIED BY 'neem_audit_dev';

FLUSH PRIVILEGES;
