/*
  Warnings:

  - Added the required column `actorRole` to the `clinical_record_access_log` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `clinical_record_access_log` ADD COLUMN `accessEndedAt` DATETIME(3) NULL,
    ADD COLUMN `actorRole` VARCHAR(40) NOT NULL;
