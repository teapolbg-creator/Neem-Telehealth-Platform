-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(191) NOT NULL,
    `publicId` VARCHAR(32) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `role` ENUM('ADMIN', 'DOCTOR', 'PHARMACY') NOT NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `twoFactorSecretEnc` TEXT NULL,
    `twoFactorEnabledAt` DATETIME(3) NULL,
    `failedLoginCount` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `passwordChangedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_publicId_key`(`publicId`),
    UNIQUE INDEX `users_email_key`(`email`),
    INDEX `users_role_status_idx`(`role`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `csrfTokenHash` VARCHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `absoluteExpiresAt` DATETIME(3) NOT NULL,
    `ipHash` VARCHAR(64) NULL,
    `userAgent` VARCHAR(512) NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` VARCHAR(120) NULL,
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sessions_tokenHash_key`(`tokenHash`),
    INDEX `sessions_userId_revokedAt_idx`(`userId`, `revokedAt`),
    INDEX `sessions_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `two_factor_challenges` (
    `id` VARCHAR(191) NOT NULL,
    `challengeId` VARCHAR(64) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `enrollment` BOOLEAN NOT NULL DEFAULT false,
    `pendingSecretEnc` TEXT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `ipHash` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `two_factor_challenges_challengeId_key`(`challengeId`),
    INDEX `two_factor_challenges_userId_idx`(`userId`),
    INDEX `two_factor_challenges_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `two_factor_recovery_codes` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `codeHash` VARCHAR(255) NOT NULL,
    `usedAt` DATETIME(3) NULL,

    INDEX `two_factor_recovery_codes_userId_usedAt_idx`(`userId`, `usedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `password_reset_tokens` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `password_reset_tokens_tokenHash_key`(`tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admins` (
    `userId` VARCHAR(191) NOT NULL,
    `fullName` VARCHAR(160) NOT NULL,
    `title` VARCHAR(120) NULL,

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pharmacies` (
    `id` VARCHAR(191) NOT NULL,
    `publicId` VARCHAR(32) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `councilRegistrationNo` VARCHAR(80) NOT NULL,
    `ownerName` VARCHAR(160) NOT NULL,
    `responsiblePharmacistName` VARCHAR(160) NOT NULL,
    `responsiblePharmacistLicenceNo` VARCHAR(80) NULL,
    `addressLine1` VARCHAR(200) NOT NULL,
    `addressLine2` VARCHAR(200) NULL,
    `city` VARCHAR(120) NOT NULL,
    `region` VARCHAR(120) NOT NULL,
    `latitude` DECIMAL(10, 7) NULL,
    `longitude` DECIMAL(10, 7) NULL,
    `phone` VARCHAR(32) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `status` ENUM('PENDING', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `statusReason` VARCHAR(500) NULL,
    `approvedAt` DATETIME(3) NULL,
    `approvedByAdminId` VARCHAR(191) NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `pharmacies_publicId_key`(`publicId`),
    UNIQUE INDEX `pharmacies_councilRegistrationNo_key`(`councilRegistrationNo`),
    INDEX `pharmacies_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pharmacy_users` (
    `pharmacyId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `pharmacy_users_userId_key`(`userId`),
    PRIMARY KEY (`pharmacyId`, `userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pharmacy_hours` (
    `id` VARCHAR(191) NOT NULL,
    `pharmacyId` VARCHAR(191) NOT NULL,
    `dayOfWeek` TINYINT NOT NULL,
    `opensAt` VARCHAR(5) NOT NULL,
    `closesAt` VARCHAR(5) NOT NULL,

    UNIQUE INDEX `pharmacy_hours_pharmacyId_dayOfWeek_key`(`pharmacyId`, `dayOfWeek`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pharmacy_capabilities` (
    `id` VARCHAR(191) NOT NULL,
    `pharmacyId` VARCHAR(191) NOT NULL,
    `kind` ENUM('SERVICE', 'TEST', 'EQUIPMENT') NOT NULL,
    `code` VARCHAR(60) NOT NULL,
    `label` VARCHAR(160) NOT NULL,

    UNIQUE INDEX `pharmacy_capabilities_pharmacyId_kind_code_key`(`pharmacyId`, `kind`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pharmacy_documents` (
    `id` VARCHAR(191) NOT NULL,
    `pharmacyId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(60) NOT NULL,
    `storageKey` VARCHAR(400) NOT NULL,
    `mimeType` VARCHAR(120) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `uploadedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `verifiedAt` DATETIME(3) NULL,
    `verifiedByAdminId` VARCHAR(191) NULL,
    `note` VARCHAR(500) NULL,

    INDEX `pharmacy_documents_pharmacyId_idx`(`pharmacyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pharmacy_payout_details` (
    `pharmacyId` VARCHAR(191) NOT NULL,
    `method` VARCHAR(40) NOT NULL,
    `accountNameEnc` TEXT NOT NULL,
    `accountNumberEnc` TEXT NOT NULL,
    `bankOrNetwork` VARCHAR(120) NOT NULL,
    `verifiedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`pharmacyId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctors` (
    `id` VARCHAR(191) NOT NULL,
    `publicId` VARCHAR(32) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `fullName` VARCHAR(160) NOT NULL,
    `mdcNumber` VARCHAR(60) NOT NULL,
    `mdcIssuedAt` DATETIME(3) NULL,
    `mdcExpiresAt` DATETIME(3) NULL,
    `qualifiedAt` DATETIME(3) NULL,
    `yearsExperience` INTEGER NULL,
    `specialty` VARCHAR(160) NULL,
    `bio` TEXT NULL,
    `photoStorageKey` VARCHAR(400) NULL,
    `status` ENUM('PENDING', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `statusReason` VARCHAR(500) NULL,
    `approvedAt` DATETIME(3) NULL,
    `approvedByAdminId` VARCHAR(191) NULL,
    `employmentType` ENUM('FULL_TIME', 'PART_TIME', 'CONTRACT') NULL,
    `contractedHoursPerWeek` INTEGER NULL,
    `hourlyRateMinor` INTEGER NULL,
    `monthlySalaryMinor` INTEGER NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `doctors_publicId_key`(`publicId`),
    UNIQUE INDEX `doctors_userId_key`(`userId`),
    UNIQUE INDEX `doctors_mdcNumber_key`(`mdcNumber`),
    INDEX `doctors_status_idx`(`status`),
    INDEX `doctors_mdcExpiresAt_idx`(`mdcExpiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_documents` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `type` ENUM('MDC_LICENCE', 'GOVERNMENT_ID', 'EMPLOYMENT_VERIFICATION', 'PRACTICE_EVIDENCE', 'OTHER') NOT NULL,
    `storageKey` VARCHAR(400) NOT NULL,
    `mimeType` VARCHAR(120) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `uploadedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `verifiedAt` DATETIME(3) NULL,
    `verifiedByAdminId` VARCHAR(191) NULL,
    `note` VARCHAR(500) NULL,

    INDEX `doctor_documents_doctorId_type_idx`(`doctorId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_languages` (
    `doctorId` VARCHAR(191) NOT NULL,
    `languageId` VARCHAR(191) NOT NULL,
    `isPrimary` BOOLEAN NOT NULL DEFAULT false,

    INDEX `doctor_languages_languageId_idx`(`languageId`),
    PRIMARY KEY (`doctorId`, `languageId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_signatures` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `signatureDataEnc` LONGTEXT NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `capturedIpHash` VARCHAR(64) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,

    INDEX `doctor_signatures_doctorId_isActive_idx`(`doctorId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_subscriptions` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `periodStart` DATETIME(3) NOT NULL,
    `periodEnd` DATETIME(3) NOT NULL,
    `amountMinor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'GHS',
    `status` ENUM('PENDING', 'ACTIVE', 'GRACE', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `graceEndsAt` DATETIME(3) NULL,
    `renewedFromId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `doctor_subscriptions_doctorId_status_idx`(`doctorId`, `status`),
    INDEX `doctor_subscriptions_periodEnd_idx`(`periodEnd`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_performance_events` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `type` ENUM('RATING', 'COMPLAINT', 'MISSED_RESPONSE', 'COMPLETED', 'ABANDONED', 'AUDIT', 'RX_ISSUE') NOT NULL,
    `consultationId` VARCHAR(191) NULL,
    `numericValue` DECIMAL(10, 4) NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `doctor_performance_events_doctorId_type_occurredAt_idx`(`doctorId`, `type`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_quality_scores` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `periodStart` DATETIME(3) NOT NULL,
    `periodEnd` DATETIME(3) NOT NULL,
    `score` DECIMAL(6, 4) NOT NULL,
    `breakdown` JSON NOT NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `doctor_quality_scores_doctorId_periodStart_periodEnd_key`(`doctorId`, `periodStart`, `periodEnd`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shift_definitions` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `label` VARCHAR(120) NOT NULL,
    `startsAt` VARCHAR(5) NOT NULL,
    `endsAt` VARCHAR(5) NOT NULL,
    `crossesMidnight` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `shift_definitions_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_shift_assignments` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `shiftDefinitionId` VARCHAR(191) NOT NULL,
    `serviceDate` DATE NOT NULL,
    `status` ENUM('ASSIGNED', 'CONFIRMED', 'DECLINED', 'CANCELLED') NOT NULL DEFAULT 'ASSIGNED',
    `assignedByAdminId` VARCHAR(191) NULL,
    `confirmedAt` DATETIME(3) NULL,
    `minutesPlanned` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `doctor_shift_assignments_serviceDate_status_idx`(`serviceDate`, `status`),
    UNIQUE INDEX `doctor_shift_assignments_doctorId_serviceDate_shiftDefinitio_key`(`doctorId`, `serviceDate`, `shiftDefinitionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_service_hours` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `isoYear` INTEGER NOT NULL,
    `isoWeek` INTEGER NOT NULL,
    `minutesScheduled` INTEGER NOT NULL DEFAULT 0,
    `minutesServed` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `doctor_service_hours_doctorId_isoYear_isoWeek_key`(`doctorId`, `isoYear`, `isoWeek`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_presence` (
    `doctorId` VARCHAR(191) NOT NULL,
    `onlineSince` DATETIME(3) NULL,
    `lastHeartbeatAt` DATETIME(3) NULL,
    `currentLoad` INTEGER NOT NULL DEFAULT 0,
    `maxLoad` INTEGER NOT NULL DEFAULT 1,

    INDEX `doctor_presence_lastHeartbeatAt_idx`(`lastHeartbeatAt`),
    PRIMARY KEY (`doctorId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `languages` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(12) NOT NULL,
    `label` VARCHAR(80) NOT NULL,
    `subtitle` VARCHAR(80) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `languages_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consultations` (
    `id` VARCHAR(191) NOT NULL,
    `publicId` VARCHAR(32) NOT NULL,
    `pharmacyId` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NULL,
    `state` ENUM('PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_FAILED', 'PAID', 'ACTIVATED', 'WAITING_FOR_PATIENT', 'PATIENT_JOINED', 'WAITING_FOR_DOCTOR', 'ASSIGNED', 'REASSIGNING', 'DOCTOR_ACCEPTED', 'IN_PROGRESS', 'COMPLETING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'ABANDONED', 'REFUND_REQUESTED', 'REFUNDED') NOT NULL DEFAULT 'PENDING_PAYMENT',
    `type` ENUM('AUDIO', 'VIDEO', 'CALL_ME') NULL,
    `languageId` VARCHAR(191) NULL,
    `priceMinor` INTEGER NOT NULL,
    `discountMinor` INTEGER NOT NULL DEFAULT 0,
    `netMinor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'GHS',
    `promotionId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `paymentDeadlineAt` DATETIME(3) NULL,
    `activatedAt` DATETIME(3) NULL,
    `patientJoinedAt` DATETIME(3) NULL,
    `queuedAt` DATETIME(3) NULL,
    `assignedAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `durationSeconds` INTEGER NULL,
    `outcome` ENUM('ADVICE_ONLY', 'PRESCRIPTION', 'REFERRAL', 'EMERGENCY_REFERRAL', 'OTHER') NULL,
    `hasPrescription` BOOLEAN NOT NULL DEFAULT false,
    `hasReferral` BOOLEAN NOT NULL DEFAULT false,
    `cancellationReason` VARCHAR(500) NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `consultations_publicId_key`(`publicId`),
    INDEX `consultations_pharmacyId_createdAt_idx`(`pharmacyId`, `createdAt`),
    INDEX `consultations_doctorId_createdAt_idx`(`doctorId`, `createdAt`),
    INDEX `consultations_state_idx`(`state`),
    INDEX `consultations_completedAt_idx`(`completedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consultation_state_events` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `fromState` ENUM('PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_FAILED', 'PAID', 'ACTIVATED', 'WAITING_FOR_PATIENT', 'PATIENT_JOINED', 'WAITING_FOR_DOCTOR', 'ASSIGNED', 'REASSIGNING', 'DOCTOR_ACCEPTED', 'IN_PROGRESS', 'COMPLETING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'ABANDONED', 'REFUND_REQUESTED', 'REFUNDED') NULL,
    `toState` ENUM('PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_FAILED', 'PAID', 'ACTIVATED', 'WAITING_FOR_PATIENT', 'PATIENT_JOINED', 'WAITING_FOR_DOCTOR', 'ASSIGNED', 'REASSIGNING', 'DOCTOR_ACCEPTED', 'IN_PROGRESS', 'COMPLETING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'ABANDONED', 'REFUND_REQUESTED', 'REFUNDED') NOT NULL,
    `actorType` ENUM('ADMIN', 'DOCTOR', 'PHARMACY', 'PATIENT', 'SYSTEM') NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `reason` VARCHAR(500) NULL,
    `accepted` BOOLEAN NOT NULL DEFAULT true,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `consultation_state_events_consultationId_occurredAt_idx`(`consultationId`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consultation_access_tokens` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `sequence` INTEGER NOT NULL DEFAULT 1,
    `issuedByUserId` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` VARCHAR(200) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `consultation_access_tokens_tokenHash_key`(`tokenHash`),
    INDEX `consultation_access_tokens_expiresAt_idx`(`expiresAt`),
    UNIQUE INDEX `consultation_access_tokens_consultationId_sequence_key`(`consultationId`, `sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `patient_sessions` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `fullNameEnc` TEXT NULL,
    `age` INTEGER NULL,
    `sex` ENUM('FEMALE', 'MALE', 'OTHER') NULL,
    `phoneEnc` TEXT NULL,
    `paymentPhoneEnc` TEXT NULL,
    `deviceSessionTokenHash` VARCHAR(64) NULL,
    `deviceBoundAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `patient_sessions_consultationId_key`(`consultationId`),
    UNIQUE INDEX `patient_sessions_deviceSessionTokenHash_key`(`deviceSessionTokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consultation_clinical_notes` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `notesEnc` LONGTEXT NULL,
    `diagnosisEnc` TEXT NULL,
    `treatmentEnc` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `consultation_clinical_notes_consultationId_key`(`consultationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consultation_vitals` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `bpSystolic` INTEGER NULL,
    `bpDiastolic` INTEGER NULL,
    `pulseBpm` INTEGER NULL,
    `temperatureC` DECIMAL(4, 1) NULL,
    `weightKg` DECIMAL(5, 2) NULL,
    `spo2Percent` INTEGER NULL,
    `recordedByUserId` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `consultation_vitals_consultationId_idx`(`consultationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consultation_tests` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `testCode` VARCHAR(60) NOT NULL,
    `testLabel` VARCHAR(160) NOT NULL,
    `resultText` VARCHAR(500) NOT NULL,
    `recordedByUserId` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `consultation_tests_consultationId_idx`(`consultationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media_sessions` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(40) NOT NULL,
    `kind` ENUM('VIDEO', 'AUDIO', 'VOICE_BRIDGE') NOT NULL,
    `providerRoomRef` VARCHAR(120) NULL,
    `providerCallRef` VARCHAR(120) NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,
    `endReason` VARCHAR(120) NULL,
    `recordingEnabled` BOOLEAN NOT NULL DEFAULT false,

    INDEX `media_sessions_consultationId_idx`(`consultationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consultation_queue_entries` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `languageId` VARCHAR(191) NOT NULL,
    `state` ENUM('WAITING', 'OFFERING', 'ASSIGNED', 'RESOLVED', 'ABANDONED') NOT NULL DEFAULT 'WAITING',
    `enqueuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedAt` DATETIME(3) NULL,
    `offerAttempts` INTEGER NOT NULL DEFAULT 0,
    `noMatchAlertedAt` DATETIME(3) NULL,
    `delayAlertedAt` DATETIME(3) NULL,
    `priority` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `consultation_queue_entries_consultationId_key`(`consultationId`),
    INDEX `consultation_queue_entries_state_enqueuedAt_idx`(`state`, `enqueuedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consultation_assignments` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `offeredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `respondByAt` DATETIME(3) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `missedAt` DATETIME(3) NULL,
    `result` ENUM('PENDING', 'ACCEPTED', 'MISSED', 'WITHDRAWN', 'REASSIGNED') NOT NULL DEFAULT 'PENDING',
    `score` DECIMAL(6, 4) NULL,
    `scoreBreakdown` JSON NULL,
    `attemptNumber` INTEGER NOT NULL DEFAULT 1,

    INDEX `consultation_assignments_doctorId_offeredAt_idx`(`doctorId`, `offeredAt`),
    INDEX `consultation_assignments_result_respondByAt_idx`(`result`, `respondByAt`),
    UNIQUE INDEX `consultation_assignments_consultationId_doctorId_attemptNumb_key`(`consultationId`, `doctorId`, `attemptNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `prescriptions` (
    `id` VARCHAR(191) NOT NULL,
    `publicId` VARCHAR(32) NOT NULL,
    `verificationCode` VARCHAR(40) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `pharmacyId` VARCHAR(191) NOT NULL,
    `state` ENUM('DRAFT', 'ISSUED', 'ACTIVE', 'PENDING_SUBSTITUTION', 'SUBSTITUTION_APPROVED', 'SUBSTITUTION_REJECTED', 'DISPENSED', 'REVOKED') NOT NULL DEFAULT 'DRAFT',
    `patientName` VARCHAR(160) NOT NULL,
    `patientAge` INTEGER NOT NULL,
    `patientSex` ENUM('FEMALE', 'MALE', 'OTHER') NOT NULL,
    `issuedAt` DATETIME(3) NULL,
    `dispensedAt` DATETIME(3) NULL,
    `dispensedByUserId` VARCHAR(191) NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` VARCHAR(500) NULL,
    `revokedByDoctorId` VARCHAR(191) NULL,
    `signatureId` VARCHAR(191) NULL,
    `pdfStorageKey` VARCHAR(400) NULL,
    `currentVersion` INTEGER NOT NULL DEFAULT 1,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `prescriptions_publicId_key`(`publicId`),
    UNIQUE INDEX `prescriptions_verificationCode_key`(`verificationCode`),
    INDEX `prescriptions_pharmacyId_issuedAt_idx`(`pharmacyId`, `issuedAt`),
    INDEX `prescriptions_doctorId_issuedAt_idx`(`doctorId`, `issuedAt`),
    INDEX `prescriptions_state_idx`(`state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `prescription_items` (
    `id` VARCHAR(191) NOT NULL,
    `prescriptionId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `medication` VARCHAR(200) NOT NULL,
    `strength` VARCHAR(80) NULL,
    `form` VARCHAR(80) NULL,
    `dose` VARCHAR(120) NOT NULL,
    `frequency` VARCHAR(120) NOT NULL,
    `durationText` VARCHAR(120) NOT NULL,
    `quantity` VARCHAR(80) NOT NULL,
    `instructions` VARCHAR(500) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `supersededByItemId` VARCHAR(191) NULL,

    INDEX `prescription_items_prescriptionId_isActive_idx`(`prescriptionId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `prescription_versions` (
    `id` VARCHAR(191) NOT NULL,
    `prescriptionId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `state` ENUM('DRAFT', 'ISSUED', 'ACTIVE', 'PENDING_SUBSTITUTION', 'SUBSTITUTION_APPROVED', 'SUBSTITUTION_REJECTED', 'DISPENSED', 'REVOKED') NOT NULL,
    `changedByType` ENUM('ADMIN', 'DOCTOR', 'PHARMACY', 'PATIENT', 'SYSTEM') NOT NULL,
    `changedById` VARCHAR(191) NULL,
    `reason` VARCHAR(500) NULL,
    `snapshot` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `prescription_versions_prescriptionId_version_key`(`prescriptionId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `substitution_requests` (
    `id` VARCHAR(191) NOT NULL,
    `prescriptionId` VARCHAR(191) NOT NULL,
    `prescriptionItemId` VARCHAR(191) NOT NULL,
    `pharmacyId` VARCHAR(191) NOT NULL,
    `requestedByUserId` VARCHAR(191) NOT NULL,
    `proposedMedication` VARCHAR(200) NOT NULL,
    `proposedStrength` VARCHAR(80) NULL,
    `proposedForm` VARCHAR(80) NULL,
    `reason` VARCHAR(500) NOT NULL,
    `state` ENUM('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN') NOT NULL DEFAULT 'PENDING',
    `decidedByDoctorId` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `substitution_requests_prescriptionId_state_idx`(`prescriptionId`, `state`),
    INDEX `substitution_requests_state_createdAt_idx`(`state`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `referrals` (
    `id` VARCHAR(191) NOT NULL,
    `publicId` VARCHAR(32) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `pharmacyId` VARCHAR(191) NOT NULL,
    `hospitalName` VARCHAR(200) NOT NULL,
    `department` VARCHAR(160) NOT NULL,
    `reasonText` TEXT NOT NULL,
    `urgency` VARCHAR(40) NULL,
    `patientName` VARCHAR(160) NOT NULL,
    `patientAge` INTEGER NOT NULL,
    `patientSex` ENUM('FEMALE', 'MALE', 'OTHER') NOT NULL,
    `signatureId` VARCHAR(191) NULL,
    `pdfStorageKey` VARCHAR(400) NULL,
    `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isDemo` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `referrals_publicId_key`(`publicId`),
    INDEX `referrals_pharmacyId_issuedAt_idx`(`pharmacyId`, `issuedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` VARCHAR(191) NOT NULL,
    `publicId` VARCHAR(32) NOT NULL,
    `consultationId` VARCHAR(191) NULL,
    `doctorSubscriptionId` VARCHAR(191) NULL,
    `provider` VARCHAR(40) NOT NULL,
    `providerReference` VARCHAR(200) NOT NULL,
    `amountMinor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'GHS',
    `status` ENUM('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'ABANDONED', 'REVERSED') NOT NULL DEFAULT 'PENDING',
    `channel` VARCHAR(60) NULL,
    `paidAt` DATETIME(3) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `idempotencyKey` VARCHAR(120) NOT NULL,
    `failureReason` VARCHAR(300) NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payments_publicId_key`(`publicId`),
    UNIQUE INDEX `payments_providerReference_key`(`providerReference`),
    UNIQUE INDEX `payments_idempotencyKey_key`(`idempotencyKey`),
    INDEX `payments_status_paidAt_idx`(`status`, `paidAt`),
    INDEX `payments_consultationId_idx`(`consultationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_webhook_events` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(40) NOT NULL,
    `providerEventId` VARCHAR(200) NOT NULL,
    `eventType` VARCHAR(80) NOT NULL,
    `signatureValid` BOOLEAN NOT NULL,
    `payloadHash` VARCHAR(64) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,
    `processingResult` VARCHAR(80) NULL,
    `error` VARCHAR(500) NULL,

    INDEX `payment_webhook_events_receivedAt_idx`(`receivedAt`),
    UNIQUE INDEX `payment_webhook_events_provider_providerEventId_key`(`provider`, `providerEventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `revenue_allocations` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `grossMinor` INTEGER NOT NULL,
    `discountMinor` INTEGER NOT NULL DEFAULT 0,
    `netMinor` INTEGER NOT NULL,
    `pharmacySharePctBp` INTEGER NOT NULL,
    `pharmacyShareMinor` INTEGER NOT NULL,
    `neemShareMinor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'GHS',
    `calculatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reversedAt` DATETIME(3) NULL,

    UNIQUE INDEX `revenue_allocations_consultationId_key`(`consultationId`),
    UNIQUE INDEX `revenue_allocations_paymentId_key`(`paymentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refunds` (
    `id` VARCHAR(191) NOT NULL,
    `publicId` VARCHAR(32) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `requestedByType` ENUM('ADMIN', 'DOCTOR', 'PHARMACY', 'PATIENT', 'SYSTEM') NOT NULL,
    `requestedByRef` VARCHAR(64) NULL,
    `reason` VARCHAR(500) NOT NULL,
    `amountMinor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'GHS',
    `state` ENUM('REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'REQUESTED',
    `reviewedByAdminId` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(500) NULL,
    `providerRefundRef` VARCHAR(200) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `refunds_publicId_key`(`publicId`),
    UNIQUE INDEX `refunds_providerRefundRef_key`(`providerRefundRef`),
    INDEX `refunds_state_createdAt_idx`(`state`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pharmacy_payouts` (
    `id` VARCHAR(191) NOT NULL,
    `publicId` VARCHAR(32) NOT NULL,
    `pharmacyId` VARCHAR(191) NOT NULL,
    `periodStart` DATE NOT NULL,
    `periodEnd` DATE NOT NULL,
    `amountDueMinor` INTEGER NOT NULL,
    `amountPaidMinor` INTEGER NOT NULL DEFAULT 0,
    `currency` CHAR(3) NOT NULL DEFAULT 'GHS',
    `status` ENUM('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILED') NOT NULL DEFAULT 'PENDING',
    `paidAt` DATETIME(3) NULL,
    `paymentReference` VARCHAR(200) NULL,
    `markedByAdminId` VARCHAR(191) NULL,
    `reconciledAt` DATETIME(3) NULL,
    `note` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `pharmacy_payouts_publicId_key`(`publicId`),
    INDEX `pharmacy_payouts_status_idx`(`status`),
    UNIQUE INDEX `pharmacy_payouts_pharmacyId_periodStart_periodEnd_key`(`pharmacyId`, `periodStart`, `periodEnd`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotions` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `type` ENUM('PERCENT', 'FIXED') NOT NULL,
    `valueBp` INTEGER NULL,
    `valueMinor` INTEGER NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NOT NULL,
    `maxUses` INTEGER NULL,
    `usedCount` INTEGER NOT NULL DEFAULT 0,
    `pharmacyId` VARCHAR(191) NULL,
    `campaign` VARCHAR(120) NULL,
    `minAmountMinor` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `promotions_code_key`(`code`),
    INDEX `promotions_isActive_startsAt_endsAt_idx`(`isActive`, `startsAt`, `endsAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `promotion_redemptions` (
    `id` VARCHAR(191) NOT NULL,
    `promotionId` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `discountMinor` INTEGER NOT NULL,
    `redeemedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `promotion_redemptions_consultationId_key`(`consultationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `feedback` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `doctorRating` TINYINT NOT NULL,
    `neemRating` TINYINT NOT NULL,
    `category` ENUM('COMPLAINT', 'COMPLIMENT', 'SUGGESTION') NOT NULL,
    `comment` TEXT NULL,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `feedback_consultationId_key`(`consultationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `complaint_categories` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(60) NOT NULL,
    `label` VARCHAR(160) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `complaint_categories_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `complaints` (
    `id` VARCHAR(191) NOT NULL,
    `publicId` VARCHAR(32) NOT NULL,
    `feedbackId` VARCHAR(191) NULL,
    `consultationId` VARCHAR(191) NULL,
    `categoryId` VARCHAR(191) NOT NULL,
    `description` TEXT NOT NULL,
    `state` ENUM('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED') NOT NULL DEFAULT 'OPEN',
    `assignedAdminId` VARCHAR(191) NULL,
    `resolutionNote` TEXT NULL,
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `complaints_publicId_key`(`publicId`),
    INDEX `complaints_state_createdAt_idx`(`state`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_settings` (
    `key` VARCHAR(120) NOT NULL,
    `value` JSON NOT NULL,
    `valueType` VARCHAR(40) NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `category` VARCHAR(60) NOT NULL,
    `requiresConfirm` BOOLEAN NOT NULL DEFAULT false,
    `updatedByAdminId` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `system_settings_category_idx`(`category`),
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_setting_history` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(120) NOT NULL,
    `oldValue` JSON NULL,
    `newValue` JSON NOT NULL,
    `adminId` VARCHAR(191) NULL,
    `reason` VARCHAR(500) NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `system_setting_history_key_changedAt_idx`(`key`, `changedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_templates` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(80) NOT NULL,
    `channel` ENUM('IN_APP', 'BROWSER', 'SMS', 'EMAIL', 'WHATSAPP', 'PUSH') NOT NULL,
    `locale` VARCHAR(12) NOT NULL DEFAULT 'en',
    `subject` VARCHAR(200) NULL,
    `body` TEXT NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `updatedByAdminId` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `notification_templates_code_channel_locale_key`(`code`, `channel`, `locale`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` VARCHAR(191) NOT NULL,
    `recipientType` ENUM('ADMIN', 'DOCTOR', 'PHARMACY', 'PATIENT', 'SYSTEM') NOT NULL,
    `recipientRef` VARCHAR(64) NOT NULL,
    `channel` ENUM('IN_APP', 'BROWSER', 'SMS', 'EMAIL', 'WHATSAPP', 'PUSH') NOT NULL,
    `templateCode` VARCHAR(80) NOT NULL,
    `renderedPayloadHash` VARCHAR(64) NOT NULL,
    `status` ENUM('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED') NOT NULL DEFAULT 'QUEUED',
    `providerRef` VARCHAR(200) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` VARCHAR(500) NULL,
    `sentAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_recipientType_recipientRef_createdAt_idx`(`recipientType`, `recipientRef`, `createdAt`),
    INDEX `notifications_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(191) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `correlationId` VARCHAR(64) NULL,
    `actorType` ENUM('ADMIN', 'DOCTOR', 'PHARMACY', 'PATIENT', 'SYSTEM') NOT NULL,
    `actorId` VARCHAR(64) NULL,
    `action` VARCHAR(80) NOT NULL,
    `entityType` VARCHAR(60) NULL,
    `entityId` VARCHAR(64) NULL,
    `ipHash` VARCHAR(64) NULL,
    `userAgent` VARCHAR(512) NULL,
    `outcome` VARCHAR(20) NOT NULL DEFAULT 'SUCCESS',
    `metadata` JSON NULL,

    INDEX `audit_logs_occurredAt_idx`(`occurredAt`),
    INDEX `audit_logs_entityType_entityId_idx`(`entityType`, `entityId`),
    INDEX `audit_logs_actorType_actorId_occurredAt_idx`(`actorType`, `actorId`, `occurredAt`),
    INDEX `audit_logs_action_occurredAt_idx`(`action`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `retention_jobs` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NOT NULL,
    `scheduledFor` DATETIME(3) NOT NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `status` ENUM('SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'SCHEDULED',
    `rowsPurged` JSON NULL,
    `verifiedAt` DATETIME(3) NULL,
    `error` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `retention_jobs_status_scheduledFor_idx`(`status`, `scheduledFor`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consents` (
    `id` VARCHAR(191) NOT NULL,
    `consultationId` VARCHAR(191) NULL,
    `subjectRef` VARCHAR(64) NULL,
    `purpose` VARCHAR(120) NOT NULL,
    `granted` BOOLEAN NOT NULL,
    `grantedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `evidence` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `consents_consultationId_idx`(`consultationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `disclosure_logs` (
    `id` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(60) NOT NULL,
    `entityId` VARCHAR(64) NOT NULL,
    `recipientKind` VARCHAR(60) NOT NULL,
    `recipientRef` VARCHAR(200) NOT NULL,
    `consentId` VARCHAR(191) NULL,
    `lawfulBasis` VARCHAR(160) NULL,
    `disclosedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `disclosedBy` VARCHAR(64) NULL,

    INDEX `disclosure_logs_entityType_entityId_idx`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `two_factor_recovery_codes` ADD CONSTRAINT `two_factor_recovery_codes_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `password_reset_tokens_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `admins` ADD CONSTRAINT `admins_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pharmacy_users` ADD CONSTRAINT `pharmacy_users_pharmacyId_fkey` FOREIGN KEY (`pharmacyId`) REFERENCES `pharmacies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pharmacy_users` ADD CONSTRAINT `pharmacy_users_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pharmacy_hours` ADD CONSTRAINT `pharmacy_hours_pharmacyId_fkey` FOREIGN KEY (`pharmacyId`) REFERENCES `pharmacies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pharmacy_capabilities` ADD CONSTRAINT `pharmacy_capabilities_pharmacyId_fkey` FOREIGN KEY (`pharmacyId`) REFERENCES `pharmacies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pharmacy_documents` ADD CONSTRAINT `pharmacy_documents_pharmacyId_fkey` FOREIGN KEY (`pharmacyId`) REFERENCES `pharmacies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pharmacy_payout_details` ADD CONSTRAINT `pharmacy_payout_details_pharmacyId_fkey` FOREIGN KEY (`pharmacyId`) REFERENCES `pharmacies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctors` ADD CONSTRAINT `doctors_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_documents` ADD CONSTRAINT `doctor_documents_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_languages` ADD CONSTRAINT `doctor_languages_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_languages` ADD CONSTRAINT `doctor_languages_languageId_fkey` FOREIGN KEY (`languageId`) REFERENCES `languages`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_signatures` ADD CONSTRAINT `doctor_signatures_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_subscriptions` ADD CONSTRAINT `doctor_subscriptions_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_performance_events` ADD CONSTRAINT `doctor_performance_events_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_quality_scores` ADD CONSTRAINT `doctor_quality_scores_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_shift_assignments` ADD CONSTRAINT `doctor_shift_assignments_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_shift_assignments` ADD CONSTRAINT `doctor_shift_assignments_shiftDefinitionId_fkey` FOREIGN KEY (`shiftDefinitionId`) REFERENCES `shift_definitions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_service_hours` ADD CONSTRAINT `doctor_service_hours_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_presence` ADD CONSTRAINT `doctor_presence_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultations` ADD CONSTRAINT `consultations_pharmacyId_fkey` FOREIGN KEY (`pharmacyId`) REFERENCES `pharmacies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultations` ADD CONSTRAINT `consultations_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultations` ADD CONSTRAINT `consultations_languageId_fkey` FOREIGN KEY (`languageId`) REFERENCES `languages`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultations` ADD CONSTRAINT `consultations_promotionId_fkey` FOREIGN KEY (`promotionId`) REFERENCES `promotions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultation_state_events` ADD CONSTRAINT `consultation_state_events_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultation_access_tokens` ADD CONSTRAINT `consultation_access_tokens_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `patient_sessions` ADD CONSTRAINT `patient_sessions_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultation_clinical_notes` ADD CONSTRAINT `consultation_clinical_notes_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultation_vitals` ADD CONSTRAINT `consultation_vitals_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultation_tests` ADD CONSTRAINT `consultation_tests_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_sessions` ADD CONSTRAINT `media_sessions_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultation_queue_entries` ADD CONSTRAINT `consultation_queue_entries_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultation_queue_entries` ADD CONSTRAINT `consultation_queue_entries_languageId_fkey` FOREIGN KEY (`languageId`) REFERENCES `languages`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultation_assignments` ADD CONSTRAINT `consultation_assignments_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consultation_assignments` ADD CONSTRAINT `consultation_assignments_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `prescriptions` ADD CONSTRAINT `prescriptions_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `prescriptions` ADD CONSTRAINT `prescriptions_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `prescriptions` ADD CONSTRAINT `prescriptions_pharmacyId_fkey` FOREIGN KEY (`pharmacyId`) REFERENCES `pharmacies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `prescriptions` ADD CONSTRAINT `prescriptions_signatureId_fkey` FOREIGN KEY (`signatureId`) REFERENCES `doctor_signatures`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `prescription_items` ADD CONSTRAINT `prescription_items_prescriptionId_fkey` FOREIGN KEY (`prescriptionId`) REFERENCES `prescriptions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `prescription_versions` ADD CONSTRAINT `prescription_versions_prescriptionId_fkey` FOREIGN KEY (`prescriptionId`) REFERENCES `prescriptions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `substitution_requests` ADD CONSTRAINT `substitution_requests_prescriptionId_fkey` FOREIGN KEY (`prescriptionId`) REFERENCES `prescriptions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `substitution_requests` ADD CONSTRAINT `substitution_requests_prescriptionItemId_fkey` FOREIGN KEY (`prescriptionItemId`) REFERENCES `prescription_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `substitution_requests` ADD CONSTRAINT `substitution_requests_pharmacyId_fkey` FOREIGN KEY (`pharmacyId`) REFERENCES `pharmacies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `substitution_requests` ADD CONSTRAINT `substitution_requests_decidedByDoctorId_fkey` FOREIGN KEY (`decidedByDoctorId`) REFERENCES `doctors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `referrals` ADD CONSTRAINT `referrals_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `referrals` ADD CONSTRAINT `referrals_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `doctors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `referrals` ADD CONSTRAINT `referrals_pharmacyId_fkey` FOREIGN KEY (`pharmacyId`) REFERENCES `pharmacies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `referrals` ADD CONSTRAINT `referrals_signatureId_fkey` FOREIGN KEY (`signatureId`) REFERENCES `doctor_signatures`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_doctorSubscriptionId_fkey` FOREIGN KEY (`doctorSubscriptionId`) REFERENCES `doctor_subscriptions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `revenue_allocations` ADD CONSTRAINT `revenue_allocations_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `revenue_allocations` ADD CONSTRAINT `revenue_allocations_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunds` ADD CONSTRAINT `refunds_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pharmacy_payouts` ADD CONSTRAINT `pharmacy_payouts_pharmacyId_fkey` FOREIGN KEY (`pharmacyId`) REFERENCES `pharmacies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `promotions` ADD CONSTRAINT `promotions_pharmacyId_fkey` FOREIGN KEY (`pharmacyId`) REFERENCES `pharmacies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `promotion_redemptions` ADD CONSTRAINT `promotion_redemptions_promotionId_fkey` FOREIGN KEY (`promotionId`) REFERENCES `promotions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `promotion_redemptions` ADD CONSTRAINT `promotion_redemptions_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `feedback` ADD CONSTRAINT `feedback_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `complaints` ADD CONSTRAINT `complaints_feedbackId_fkey` FOREIGN KEY (`feedbackId`) REFERENCES `feedback`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `complaints` ADD CONSTRAINT `complaints_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `complaints` ADD CONSTRAINT `complaints_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `complaint_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `retention_jobs` ADD CONSTRAINT `retention_jobs_consultationId_fkey` FOREIGN KEY (`consultationId`) REFERENCES `consultations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
