-- Decision D23 — clinical records are retained sealed, not deleted at completion.
--
-- Three changes:
--   1. `consultations.clinicalSealedAt` marks a record as closed to the product.
--   2. Vitals and point-of-care results become encrypted. They were plaintext,
--      which was defensible when the rows lived for minutes and is not over a
--      multi-year retention period.
--   3. `clinical_record_access_log` is created for break-glass access, which is
--      deliberately unbuilt pending counsel (G7c). Correct contents: zero rows.
--
-- DATA LOSS, AND WHY IT IS ACCEPTABLE HERE.
-- The plaintext vitals and test results cannot be converted in SQL: encryption
-- is AES-256-GCM performed in application code with the application's key.
-- Existing rows are therefore deleted rather than migrated. That is acceptable
-- **only** because every row in this database today is synthetic — demo seed
-- and test fixtures — and no patient data has ever been entered.
--
-- A deployment holding real vitals MUST NOT run this as written. It needs a
-- Node data migration that reads each row, encrypts it, and writes the blob
-- back, run between adding the new column and dropping the old ones.

-- 1. Sealing marker -----------------------------------------------------------
ALTER TABLE `consultations` ADD COLUMN `clinicalSealedAt` DATETIME(3) NULL;

-- 2. Vitals: six plaintext readings become one encrypted observation ----------
DELETE FROM `consultation_vitals`;

ALTER TABLE `consultation_vitals`
  DROP COLUMN `bpSystolic`,
  DROP COLUMN `bpDiastolic`,
  DROP COLUMN `pulseBpm`,
  DROP COLUMN `temperatureC`,
  DROP COLUMN `weightKg`,
  DROP COLUMN `spo2Percent`,
  ADD COLUMN `readingsEnc` TEXT NOT NULL;

-- 3. Test results encrypted; the code and label stay legible ------------------
DELETE FROM `consultation_tests`;

ALTER TABLE `consultation_tests`
  DROP COLUMN `resultText`,
  ADD COLUMN `resultEnc` TEXT NOT NULL;

-- 4. Break-glass access log ---------------------------------------------------
CREATE TABLE `clinical_record_access_log` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `actorUserId` VARCHAR(191) NOT NULL,
    `authorisedByUserId` VARCHAR(191) NOT NULL,
    `purpose` VARCHAR(60) NOT NULL,
    `reference` VARCHAR(200) NOT NULL,
    `recordsAccessed` JSON NOT NULL,
    `accessedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `clinical_record_access_log_consultationId_idx`(`consultationId`),
    INDEX `clinical_record_access_log_accessedAt_idx`(`accessedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ON DELETE RESTRICT: the log outlives the records it describes. Destroying a
-- record at the end of its retention period must never erase the evidence that
-- someone opened it.
ALTER TABLE `clinical_record_access_log`
  ADD CONSTRAINT `clinical_record_access_log_consultationId_fkey`
  FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
