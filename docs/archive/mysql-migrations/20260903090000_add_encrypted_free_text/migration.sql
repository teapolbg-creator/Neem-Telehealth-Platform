-- Patient-authored free text moves under field encryption (spec §58).
--
-- `feedback.comment` and `complaints.description` are written by the patient
-- and `complaints.resolutionNote` answers them. A patient explaining why they
-- were unhappy writes about their own care, so all three carry health
-- information whatever the form asked for -- and all three were plaintext
-- while every other patient field was encrypted.
--
-- Phase one of two. The columns are added nullable so the backfill has
-- somewhere to write:
--
--   npm run db:backfill:encrypt-free-text
--
-- Phase two (the next migration) drops the plaintext columns and makes
-- `descriptionEnc` required. Running phase two before the backfill on a
-- database that already has rows would lose their text, so the order is not
-- optional. On an empty database both apply cleanly in sequence.

ALTER TABLE `feedback` ADD COLUMN `commentEnc` TEXT NULL;
ALTER TABLE `complaints` ADD COLUMN `descriptionEnc` TEXT NULL;
ALTER TABLE `complaints` ADD COLUMN `resolutionNoteEnc` TEXT NULL;
