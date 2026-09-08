-- CreateTable
CREATE TABLE `pilot_applications` (
    `id` VARCHAR(191) NOT NULL,
    `publicId` VARCHAR(32) NOT NULL,
    `role` ENUM('DOCTOR', 'PHARMACY') NOT NULL,
    `fullName` VARCHAR(160) NOT NULL,
    `phone` VARCHAR(24) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `specialty` VARCHAR(120) NULL,
    `yearsOfPractice` VARCHAR(40) NULL,
    `organisation` VARCHAR(200) NOT NULL,
    `location` VARCHAR(160) NOT NULL,
    `additionalInfo` TEXT NULL,
    `status` ENUM('NEW', 'CONTACTED', 'ONBOARDED', 'DECLINED', 'SPAM') NOT NULL DEFAULT 'NEW',
    `statusNote` VARCHAR(500) NULL,
    `consentAt` DATETIME(3) NOT NULL,
    `sourceIp` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewedByAdmin` VARCHAR(64) NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `pilot_applications_publicId_key`(`publicId`),
    INDEX `pilot_applications_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `pilot_applications_role_status_idx`(`role`, `status`),
    UNIQUE INDEX `pilot_applications_email_role_key`(`email`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
