-- Anchor the recovery budget of consultations already interrupted (D67).
--
-- `interruptedAt` describes the current break. Before this release, resuming
-- did NOT clear it, so on existing records that value is also the first break.
-- Copying it across keeps their budget where it has effectively always been
-- rather than handing every open interruption a fresh hour the moment the cap
-- starts being enforced.
--
-- Separate from the schema migration so that one's checksum stays intact on
-- environments that have already applied it.
UPDATE "consultations"
SET "firstInterruptedAt" = "interruptedAt"
WHERE "interruptedAt" IS NOT NULL AND "firstInterruptedAt" IS NULL;
