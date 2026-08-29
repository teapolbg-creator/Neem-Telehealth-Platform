-- Applied AFTER migrations, because these are table-level grants and MySQL
-- requires the table to exist.
--
-- The audit log must be append-only (spec §61). This account holds INSERT and
-- SELECT and nothing else: no UPDATE, no DELETE, and no access to any other
-- table. An attacker who obtains these credentials cannot rewrite history, and
-- cannot read patient or clinical data either.
GRANT INSERT, SELECT ON `neem`.`audit_logs`      TO 'neem_audit'@'%';
GRANT INSERT, SELECT ON `neem_test`.`audit_logs` TO 'neem_audit'@'%';
FLUSH PRIVILEGES;
