-- AlterTable
ALTER TABLE "consultations" ADD COLUMN     "firstStartedAt" TIMESTAMP(3),
ADD COLUMN     "unservedDeadlineAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "consultations_unservedDeadlineAt_idx" ON "consultations"("unservedDeadlineAt");

-- CreateIndex
CREATE INDEX "consultations_rejoinableUntil_idx" ON "consultations"("rejoinableUntil");


-- Backfill the first start from the only record of it we have (D61).
--
-- `startedAt` is rewritten on every entry to IN_PROGRESS, so for a consultation
-- that resumed after an interruption this is the resume rather than the true
-- beginning. It is still the best available answer and it is what these records
-- already reported, so nothing a patient has seen changes; what changes is that
-- from here on the value stops moving.
--
-- Deliberately NOT backfilling `unservedDeadlineAt`. Giving every open
-- consultation a deadline would hand the sweep a backlog to close in bulk, and
-- consultations already stuck are exactly the ones that need looking at rather
-- than closing automatically. They are handled by the reconciliation procedure.
UPDATE "consultations"
SET "firstStartedAt" = "startedAt"
WHERE "startedAt" IS NOT NULL AND "firstStartedAt" IS NULL;
