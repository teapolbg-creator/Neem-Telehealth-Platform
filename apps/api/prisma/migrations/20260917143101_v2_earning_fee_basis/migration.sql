-- AlterTable
ALTER TABLE "professional_earnings" ADD COLUMN     "feeMinor" INTEGER NOT NULL DEFAULT 0;

-- The amount the split was applied to. Added with a default so the column can
-- be made NOT NULL, backfilled from the gross (which is what earlier rows were
-- split on, before fees were taken off first), and the default then dropped so
-- every future row has to say what it split.
ALTER TABLE "professional_earnings" ADD COLUMN     "netMinor" INTEGER NOT NULL DEFAULT 0;
UPDATE "professional_earnings" SET "netMinor" = "grossMinor" WHERE "netMinor" = 0;
ALTER TABLE "professional_earnings" ALTER COLUMN "netMinor" DROP DEFAULT;
