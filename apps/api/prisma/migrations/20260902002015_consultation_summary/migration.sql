-- CreateTable
CREATE TABLE `consultation_summaries` (
    `id` VARCHAR(191) NOT NULL,
    `publicId` VARCHAR(32) NOT NULL,
    `verificationCode` VARCHAR(40) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `pharmacyId` VARCHAR(191) NOT NULL,
    `patientName` VARCHAR(160) NOT NULL,
    `patientAge` INTEGER NOT NULL,
    `patientSex` ENUM('FEMALE', 'MALE', 'OTHER') NOT NULL,
    `presentingComplaint` VARCHAR(500) NOT NULL,
    `assessment` TEXT NOT NULL,
    `advice` TEXT NOT NULL,
    `safetyNetting` TEXT NOT NULL,
    `signatureId` VARCHAR(191) NULL,
    `pdfStorageKey` VARCHAR(400) NULL,
    `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isDemo` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `consultation_summaries_publicId_key`(`publicId`),
    UNIQUE INDEX `consultation_summaries_verificationCode_key`(`verificationCode`),
    UNIQUE INDEX `consultation_summaries_consultationId_key`(`consultationId`),
    INDEX `consultation_summaries_pharmacyId_issuedAt_idx`(`pharmacyId`, `issuedAt`),
    INDEX `consultation_summaries_doctorId_issuedAt_idx`(`doctorId`, `issuedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `consultation_summaries` ADD CONSTRAINT `consultation_summaries_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultation_summaries` ADD CONSTRAINT `consultation_summaries_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultation_summaries` ADD CONSTRAINT `consultation_summaries_pharmacyId_fkey` FOREIGN KEY (`pharmacyId`) REFERENCES `pharmacies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultation_summaries` ADD CONSTRAINT `consultation_summaries_signatureId_fkey` FOREIGN KEY (`signatureId`) REFERENCES `doctor_signatures`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
