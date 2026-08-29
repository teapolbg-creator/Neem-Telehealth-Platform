-- Integration tests run against a real MySQL database rather than mocks, because
-- unique constraints and transaction behaviour are a large part of what is being
-- tested (payment idempotency, revenue allocation, the 40-hour rule).
CREATE DATABASE IF NOT EXISTS `neem_test`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

GRANT ALL PRIVILEGES ON `neem_test`.* TO 'neem'@'%';

-- Least privilege for the audit writer (docs/security.md §7, docs/database.md §3.11).
-- The audit log must be append-only; this account cannot UPDATE or DELETE it.
-- Password is a development default and is overridden by AUDIT_DATABASE_URL.
CREATE USER IF NOT EXISTS 'neem_audit'@'%' IDENTIFIED BY 'neem_audit_dev';
GRANT INSERT, SELECT ON `neem`.`audit_logs` TO 'neem_audit'@'%';
GRANT INSERT, SELECT ON `neem_test`.`audit_logs` TO 'neem_audit'@'%';

FLUSH PRIVILEGES;
