-- Phase two: the plaintext columns go.
--
-- Requires `npm run db:backfill:encrypt-free-text` to have run against any
-- database that held rows. The backfill refuses to leave a row half-migrated,
-- so if it completed there is nothing here to lose.
--
-- `descriptionEnc` becomes NOT NULL because a complaint with no description is
-- not a complaint anyone can answer.

ALTER TABLE `complaints` MODIFY COLUMN `descriptionEnc` TEXT NOT NULL;

ALTER TABLE `feedback` DROP COLUMN `comment`;
ALTER TABLE `complaints` DROP COLUMN `description`;
ALTER TABLE `complaints` DROP COLUMN `resolutionNote`;
