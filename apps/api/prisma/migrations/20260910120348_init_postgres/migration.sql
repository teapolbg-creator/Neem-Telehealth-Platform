-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'DOCTOR', 'PHARMACY');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "DoctorStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PharmacyStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ConsultationState" AS ENUM ('PENDING_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_FAILED', 'PAID', 'ACTIVATED', 'WAITING_FOR_PATIENT', 'PATIENT_JOINED', 'WAITING_FOR_DOCTOR', 'ASSIGNED', 'REASSIGNING', 'DOCTOR_ACCEPTED', 'IN_PROGRESS', 'COMPLETING', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'ABANDONED', 'REFUND_REQUESTED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ConsultationType" AS ENUM ('AUDIO', 'VIDEO', 'CALL_ME');

-- CreateEnum
CREATE TYPE "ConsultationOutcome" AS ENUM ('ADVICE_ONLY', 'PRESCRIPTION', 'REFERRAL', 'EMERGENCY_REFERRAL', 'OTHER');

-- CreateEnum
CREATE TYPE "PrescriptionState" AS ENUM ('DRAFT', 'ISSUED', 'ACTIVE', 'PENDING_SUBSTITUTION', 'SUBSTITUTION_APPROVED', 'SUBSTITUTION_REJECTED', 'DISPENSED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SubstitutionState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'ABANDONED', 'REVERSED');

-- CreateEnum
CREATE TYPE "RefundState" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'GRACE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FeedbackCategory" AS ENUM ('COMPLAINT', 'COMPLIMENT', 'SUGGESTION');

-- CreateEnum
CREATE TYPE "PatientSex" AS ENUM ('FEMALE', 'MALE', 'OTHER');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'BROWSER', 'SMS', 'EMAIL', 'WHATSAPP', 'PUSH');

-- CreateEnum
CREATE TYPE "DoctorDocumentType" AS ENUM ('MDC_LICENCE', 'GOVERNMENT_ID', 'EMPLOYMENT_VERIFICATION', 'PRACTICE_EVIDENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "PharmacyCapabilityKind" AS ENUM ('SERVICE', 'TEST', 'EQUIPMENT');

-- CreateEnum
CREATE TYPE "ShiftAssignmentStatus" AS ENUM ('ASSIGNED', 'CONFIRMED', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QueueEntryState" AS ENUM ('WAITING', 'OFFERING', 'ASSIGNED', 'RESOLVED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "AssignmentResult" AS ENUM ('PENDING', 'ACCEPTED', 'MISSED', 'WITHDRAWN', 'REASSIGNED');

-- CreateEnum
CREATE TYPE "PerformanceEventType" AS ENUM ('RATING', 'COMPLAINT', 'MISSED_RESPONSE', 'COMPLETED', 'ABANDONED', 'AUDIT', 'RX_ISSUE');

-- CreateEnum
CREATE TYPE "ComplaintState" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('ADMIN', 'DOCTOR', 'PHARMACY', 'PATIENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "RetentionJobStatus" AS ENUM ('SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "MediaSessionKind" AS ENUM ('VIDEO', 'AUDIO', 'VOICE_BRIDGE');

-- CreateEnum
CREATE TYPE "PilotApplicantRole" AS ENUM ('DOCTOR', 'PHARMACY');

-- CreateEnum
CREATE TYPE "PilotApplicationStatus" AS ENUM ('NEW', 'CONTACTED', 'ONBOARDED', 'DECLINED', 'SPAM');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "twoFactorSecretEnc" TEXT,
    "twoFactorEnabledAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "passwordChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "csrfTokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "ipHash" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" VARCHAR(120),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_challenges" (
    "id" TEXT NOT NULL,
    "challengeId" VARCHAR(64) NOT NULL,
    "userId" TEXT NOT NULL,
    "enrollment" BOOLEAN NOT NULL DEFAULT false,
    "pendingSecretEnc" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "ipHash" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_recovery_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" VARCHAR(255) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "two_factor_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admins" (
    "userId" TEXT NOT NULL,
    "fullName" VARCHAR(160) NOT NULL,
    "title" VARCHAR(120),

    CONSTRAINT "admins_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "pharmacies" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "councilRegistrationNo" VARCHAR(80) NOT NULL,
    "ownerName" VARCHAR(160) NOT NULL,
    "responsiblePharmacistName" VARCHAR(160) NOT NULL,
    "responsiblePharmacistLicenceNo" VARCHAR(80),
    "addressLine1" VARCHAR(200) NOT NULL,
    "addressLine2" VARCHAR(200),
    "city" VARCHAR(120) NOT NULL,
    "region" VARCHAR(120) NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "phone" VARCHAR(32) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "status" "PharmacyStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" VARCHAR(500),
    "approvedAt" TIMESTAMP(3),
    "approvedByAdminId" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pharmacies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_users" (
    "pharmacyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "pharmacy_users_pkey" PRIMARY KEY ("pharmacyId","userId")
);

-- CreateTable
CREATE TABLE "pharmacy_hours" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "dayOfWeek" SMALLINT NOT NULL,
    "opensAt" VARCHAR(5) NOT NULL,
    "closesAt" VARCHAR(5) NOT NULL,

    CONSTRAINT "pharmacy_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_capabilities" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "kind" "PharmacyCapabilityKind" NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "label" VARCHAR(160) NOT NULL,

    CONSTRAINT "pharmacy_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_documents" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "storageKey" VARCHAR(400) NOT NULL,
    "mimeType" VARCHAR(120) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "verifiedByAdminId" TEXT,
    "note" VARCHAR(500),

    CONSTRAINT "pharmacy_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_payout_details" (
    "pharmacyId" TEXT NOT NULL,
    "method" VARCHAR(40) NOT NULL,
    "accountNameEnc" TEXT NOT NULL,
    "accountNumberEnc" TEXT NOT NULL,
    "bankOrNetwork" VARCHAR(120) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pharmacy_payout_details_pkey" PRIMARY KEY ("pharmacyId")
);

-- CreateTable
CREATE TABLE "doctors" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" VARCHAR(160) NOT NULL,
    "mdcNumber" VARCHAR(60) NOT NULL,
    "mdcIssuedAt" TIMESTAMP(3),
    "mdcExpiresAt" TIMESTAMP(3),
    "qualifiedAt" TIMESTAMP(3),
    "yearsExperience" INTEGER,
    "specialty" VARCHAR(160),
    "bio" TEXT,
    "photoStorageKey" VARCHAR(400),
    "phoneEnc" TEXT,
    "status" "DoctorStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" VARCHAR(500),
    "approvedAt" TIMESTAMP(3),
    "approvedByAdminId" TEXT,
    "employmentType" "EmploymentType",
    "contractedHoursPerWeek" INTEGER,
    "hourlyRateMinor" INTEGER,
    "monthlySalaryMinor" INTEGER,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_documents" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "type" "DoctorDocumentType" NOT NULL,
    "storageKey" VARCHAR(400) NOT NULL,
    "mimeType" VARCHAR(120) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "verifiedByAdminId" TEXT,
    "note" VARCHAR(500),

    CONSTRAINT "doctor_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_languages" (
    "doctorId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "doctor_languages_pkey" PRIMARY KEY ("doctorId","languageId")
);

-- CreateTable
CREATE TABLE "doctor_signatures" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "signatureDataEnc" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedIpHash" VARCHAR(64),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "doctor_signatures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_subscriptions" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'GHS',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "graceEndsAt" TIMESTAMP(3),
    "renewedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctor_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_performance_events" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "type" "PerformanceEventType" NOT NULL,
    "consultationId" TEXT,
    "numericValue" DECIMAL(10,4),
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_performance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_quality_scores" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "score" DECIMAL(6,4) NOT NULL,
    "breakdown" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_quality_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_definitions" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "startsAt" VARCHAR(5) NOT NULL,
    "endsAt" VARCHAR(5) NOT NULL,
    "crossesMidnight" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_shift_assignments" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "shiftDefinitionId" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "status" "ShiftAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "assignedByAdminId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "minutesPlanned" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_service_hours" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "isoYear" INTEGER NOT NULL,
    "isoWeek" INTEGER NOT NULL,
    "minutesScheduled" INTEGER NOT NULL DEFAULT 0,
    "minutesServed" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctor_service_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_presence" (
    "doctorId" TEXT NOT NULL,
    "onlineSince" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "currentLoad" INTEGER NOT NULL DEFAULT 0,
    "maxLoad" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "doctor_presence_pkey" PRIMARY KEY ("doctorId")
);

-- CreateTable
CREATE TABLE "languages" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(12) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "subtitle" VARCHAR(80),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "languages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultations" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "doctorId" TEXT,
    "state" "ConsultationState" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "type" "ConsultationType",
    "languageId" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "netMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'GHS',
    "promotionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentDeadlineAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "patientJoinedAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3),
    "assignedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "clinicalSealedAt" TIMESTAMP(3),
    "outcome" "ConsultationOutcome",
    "hasPrescription" BOOLEAN NOT NULL DEFAULT false,
    "hasReferral" BOOLEAN NOT NULL DEFAULT false,
    "cancellationReason" VARCHAR(500),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consultations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultation_state_events" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "fromState" "ConsultationState",
    "toState" "ConsultationState" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "reason" VARCHAR(500),
    "accepted" BOOLEAN NOT NULL DEFAULT true,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultation_state_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultation_access_tokens" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "issuedByUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultation_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_sessions" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "fullNameEnc" TEXT,
    "age" INTEGER,
    "sex" "PatientSex",
    "phoneEnc" TEXT,
    "paymentPhoneEnc" TEXT,
    "deviceSessionTokenHash" VARCHAR(64),
    "deviceBoundAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultation_clinical_notes" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "notesEnc" TEXT,
    "diagnosisEnc" TEXT,
    "treatmentEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consultation_clinical_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultation_vitals" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "readingsEnc" TEXT NOT NULL,
    "recordedByUserId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultation_vitals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultation_tests" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "testCode" VARCHAR(60) NOT NULL,
    "testLabel" VARCHAR(160) NOT NULL,
    "resultEnc" TEXT NOT NULL,
    "recordedByUserId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultation_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_sessions" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "kind" "MediaSessionKind" NOT NULL,
    "providerRoomRef" VARCHAR(120),
    "providerCallRef" VARCHAR(120),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" VARCHAR(120),
    "recordingEnabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "media_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultation_queue_entries" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "languageId" TEXT NOT NULL,
    "state" "QueueEntryState" NOT NULL DEFAULT 'WAITING',
    "enqueuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "offerAttempts" INTEGER NOT NULL DEFAULT 0,
    "noMatchAlertedAt" TIMESTAMP(3),
    "delayAlertedAt" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "consultation_queue_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultation_assignments" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondByAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "missedAt" TIMESTAMP(3),
    "result" "AssignmentResult" NOT NULL DEFAULT 'PENDING',
    "score" DECIMAL(6,4),
    "scoreBreakdown" JSONB,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "consultation_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescriptions" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "verificationCode" VARCHAR(40) NOT NULL,
    "consultationId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "state" "PrescriptionState" NOT NULL DEFAULT 'DRAFT',
    "patientName" VARCHAR(160) NOT NULL,
    "patientAge" INTEGER NOT NULL,
    "patientSex" "PatientSex" NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "dispensedAt" TIMESTAMP(3),
    "dispensedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" VARCHAR(500),
    "revokedByDoctorId" TEXT,
    "signatureId" TEXT,
    "pdfStorageKey" VARCHAR(400),
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_items" (
    "id" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "medication" VARCHAR(200) NOT NULL,
    "strength" VARCHAR(80),
    "form" VARCHAR(80),
    "dose" VARCHAR(120) NOT NULL,
    "frequency" VARCHAR(120) NOT NULL,
    "durationText" VARCHAR(120) NOT NULL,
    "quantity" VARCHAR(80) NOT NULL,
    "instructions" VARCHAR(500),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "supersededByItemId" TEXT,

    CONSTRAINT "prescription_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_versions" (
    "id" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "state" "PrescriptionState" NOT NULL,
    "changedByType" "ActorType" NOT NULL,
    "changedById" TEXT,
    "reason" VARCHAR(500),
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prescription_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "substitution_requests" (
    "id" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "prescriptionItemId" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "proposedMedication" VARCHAR(200) NOT NULL,
    "proposedStrength" VARCHAR(80),
    "proposedForm" VARCHAR(80),
    "reason" VARCHAR(500) NOT NULL,
    "state" "SubstitutionState" NOT NULL DEFAULT 'PENDING',
    "decidedByDoctorId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "substitution_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "consultationId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "hospitalName" VARCHAR(200) NOT NULL,
    "department" VARCHAR(160) NOT NULL,
    "reasonText" TEXT NOT NULL,
    "urgency" VARCHAR(40),
    "patientName" VARCHAR(160) NOT NULL,
    "patientAge" INTEGER NOT NULL,
    "patientSex" "PatientSex" NOT NULL,
    "signatureId" TEXT,
    "pdfStorageKey" VARCHAR(400),
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "consultationId" TEXT,
    "doctorSubscriptionId" TEXT,
    "provider" VARCHAR(40) NOT NULL,
    "providerReference" VARCHAR(200) NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'GHS',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "channel" VARCHAR(60),
    "paidAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "idempotencyKey" VARCHAR(120) NOT NULL,
    "failureReason" VARCHAR(300),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "providerEventId" VARCHAR(200) NOT NULL,
    "eventType" VARCHAR(80) NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingResult" VARCHAR(80),
    "error" VARCHAR(500),

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_allocations" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "grossMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "netMinor" INTEGER NOT NULL,
    "pharmacySharePctBp" INTEGER NOT NULL,
    "pharmacyShareMinor" INTEGER NOT NULL,
    "neemShareMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'GHS',
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "revenue_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "consultationId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "requestedByType" "ActorType" NOT NULL,
    "requestedByRef" VARCHAR(64),
    "reason" VARCHAR(500) NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'GHS',
    "state" "RefundState" NOT NULL DEFAULT 'REQUESTED',
    "reviewedByAdminId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" VARCHAR(500),
    "providerRefundRef" VARCHAR(200),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_payouts" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "amountDueMinor" INTEGER NOT NULL,
    "amountPaidMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'GHS',
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "paymentReference" VARCHAR(200),
    "markedByAdminId" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "note" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pharmacy_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "type" "PromotionType" NOT NULL,
    "valueBp" INTEGER,
    "valueMinor" INTEGER,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "pharmacyId" TEXT,
    "campaign" VARCHAR(120),
    "minAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_redemptions" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "discountMinor" INTEGER NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "doctorRating" SMALLINT NOT NULL,
    "neemRating" SMALLINT NOT NULL,
    "category" "FeedbackCategory" NOT NULL,
    "commentEnc" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaint_categories" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "label" VARCHAR(160) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "complaint_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaints" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "feedbackId" TEXT,
    "consultationId" TEXT,
    "categoryId" TEXT NOT NULL,
    "descriptionEnc" TEXT NOT NULL,
    "state" "ComplaintState" NOT NULL DEFAULT 'OPEN',
    "assignedAdminId" TEXT,
    "resolutionNoteEnc" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,
    "valueType" VARCHAR(40) NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "category" VARCHAR(60) NOT NULL,
    "requiresConfirm" BOOLEAN NOT NULL DEFAULT false,
    "updatedByAdminId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "system_setting_history" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB NOT NULL,
    "adminId" TEXT,
    "reason" VARCHAR(500),
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_setting_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "locale" VARCHAR(12) NOT NULL DEFAULT 'en',
    "subject" VARCHAR(200),
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedByAdminId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "recipientType" "ActorType" NOT NULL,
    "recipientRef" VARCHAR(64) NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "templateCode" VARCHAR(80) NOT NULL,
    "renderedPayloadHash" VARCHAR(64) NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "providerRef" VARCHAR(200),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(500),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlationId" VARCHAR(64),
    "actorType" "ActorType" NOT NULL,
    "actorId" VARCHAR(64),
    "action" VARCHAR(80) NOT NULL,
    "entityType" VARCHAR(60),
    "entityId" VARCHAR(64),
    "ipHash" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "outcome" VARCHAR(20) NOT NULL DEFAULT 'SUCCESS',
    "metadata" JSONB,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_jobs" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "status" "RetentionJobStatus" NOT NULL DEFAULT 'SCHEDULED',
    "rowsPurged" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "error" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_record_access_log" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorRole" VARCHAR(40) NOT NULL,
    "authorisedByUserId" TEXT NOT NULL,
    "purpose" VARCHAR(60) NOT NULL,
    "reference" VARCHAR(200) NOT NULL,
    "recordsAccessed" JSONB NOT NULL,
    "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessEndedAt" TIMESTAMP(3),

    CONSTRAINT "clinical_record_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT,
    "subjectRef" VARCHAR(64),
    "purpose" VARCHAR(120) NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "grantedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disclosure_logs" (
    "id" TEXT NOT NULL,
    "entityType" VARCHAR(60) NOT NULL,
    "entityId" VARCHAR(64) NOT NULL,
    "recipientKind" VARCHAR(60) NOT NULL,
    "recipientRef" VARCHAR(200) NOT NULL,
    "consentId" TEXT,
    "lawfulBasis" VARCHAR(160),
    "disclosedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disclosedBy" VARCHAR(64),

    CONSTRAINT "disclosure_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultation_summaries" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "verificationCode" VARCHAR(40) NOT NULL,
    "consultationId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "patientName" VARCHAR(160) NOT NULL,
    "patientAge" INTEGER NOT NULL,
    "patientSex" "PatientSex" NOT NULL,
    "presentingComplaint" VARCHAR(500) NOT NULL,
    "assessment" TEXT NOT NULL,
    "advice" TEXT NOT NULL,
    "safetyNetting" TEXT NOT NULL,
    "signatureId" TEXT,
    "pdfStorageKey" VARCHAR(400),
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "consultation_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pilot_applications" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "role" "PilotApplicantRole" NOT NULL,
    "fullName" VARCHAR(160) NOT NULL,
    "phone" VARCHAR(24) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "specialty" VARCHAR(120),
    "yearsOfPractice" VARCHAR(40),
    "organisation" VARCHAR(200) NOT NULL,
    "location" VARCHAR(160) NOT NULL,
    "additionalInfo" TEXT,
    "status" "PilotApplicationStatus" NOT NULL DEFAULT 'NEW',
    "statusNote" VARCHAR(500),
    "consentAt" TIMESTAMP(3) NOT NULL,
    "sourceIp" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByAdmin" VARCHAR(64),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pilot_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_publicId_key" ON "users"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_challenges_challengeId_key" ON "two_factor_challenges"("challengeId");

-- CreateIndex
CREATE INDEX "two_factor_challenges_userId_idx" ON "two_factor_challenges"("userId");

-- CreateIndex
CREATE INDEX "two_factor_challenges_expiresAt_idx" ON "two_factor_challenges"("expiresAt");

-- CreateIndex
CREATE INDEX "two_factor_recovery_codes_userId_usedAt_idx" ON "two_factor_recovery_codes"("userId", "usedAt");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacies_publicId_key" ON "pharmacies"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacies_councilRegistrationNo_key" ON "pharmacies"("councilRegistrationNo");

-- CreateIndex
CREATE INDEX "pharmacies_status_idx" ON "pharmacies"("status");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_users_userId_key" ON "pharmacy_users"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_hours_pharmacyId_dayOfWeek_key" ON "pharmacy_hours"("pharmacyId", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_capabilities_pharmacyId_kind_code_key" ON "pharmacy_capabilities"("pharmacyId", "kind", "code");

-- CreateIndex
CREATE INDEX "pharmacy_documents_pharmacyId_idx" ON "pharmacy_documents"("pharmacyId");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_publicId_key" ON "doctors"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_userId_key" ON "doctors"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_mdcNumber_key" ON "doctors"("mdcNumber");

-- CreateIndex
CREATE INDEX "doctors_status_idx" ON "doctors"("status");

-- CreateIndex
CREATE INDEX "doctors_mdcExpiresAt_idx" ON "doctors"("mdcExpiresAt");

-- CreateIndex
CREATE INDEX "doctor_documents_doctorId_type_idx" ON "doctor_documents"("doctorId", "type");

-- CreateIndex
CREATE INDEX "doctor_languages_languageId_idx" ON "doctor_languages"("languageId");

-- CreateIndex
CREATE INDEX "doctor_signatures_doctorId_isActive_idx" ON "doctor_signatures"("doctorId", "isActive");

-- CreateIndex
CREATE INDEX "doctor_subscriptions_doctorId_status_idx" ON "doctor_subscriptions"("doctorId", "status");

-- CreateIndex
CREATE INDEX "doctor_subscriptions_periodEnd_idx" ON "doctor_subscriptions"("periodEnd");

-- CreateIndex
CREATE INDEX "doctor_performance_events_doctorId_type_occurredAt_idx" ON "doctor_performance_events"("doctorId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_quality_scores_doctorId_periodStart_periodEnd_key" ON "doctor_quality_scores"("doctorId", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "shift_definitions_code_key" ON "shift_definitions"("code");

-- CreateIndex
CREATE INDEX "doctor_shift_assignments_serviceDate_status_idx" ON "doctor_shift_assignments"("serviceDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_shift_assignments_doctorId_serviceDate_shiftDefiniti_key" ON "doctor_shift_assignments"("doctorId", "serviceDate", "shiftDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_service_hours_doctorId_isoYear_isoWeek_key" ON "doctor_service_hours"("doctorId", "isoYear", "isoWeek");

-- CreateIndex
CREATE INDEX "doctor_presence_lastHeartbeatAt_idx" ON "doctor_presence"("lastHeartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "languages_code_key" ON "languages"("code");

-- CreateIndex
CREATE UNIQUE INDEX "consultations_publicId_key" ON "consultations"("publicId");

-- CreateIndex
CREATE INDEX "consultations_pharmacyId_createdAt_idx" ON "consultations"("pharmacyId", "createdAt");

-- CreateIndex
CREATE INDEX "consultations_doctorId_createdAt_idx" ON "consultations"("doctorId", "createdAt");

-- CreateIndex
CREATE INDEX "consultations_state_idx" ON "consultations"("state");

-- CreateIndex
CREATE INDEX "consultations_completedAt_idx" ON "consultations"("completedAt");

-- CreateIndex
CREATE INDEX "consultation_state_events_consultationId_occurredAt_idx" ON "consultation_state_events"("consultationId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "consultation_access_tokens_tokenHash_key" ON "consultation_access_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "consultation_access_tokens_expiresAt_idx" ON "consultation_access_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "consultation_access_tokens_consultationId_sequence_key" ON "consultation_access_tokens"("consultationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "patient_sessions_consultationId_key" ON "patient_sessions"("consultationId");

-- CreateIndex
CREATE UNIQUE INDEX "patient_sessions_deviceSessionTokenHash_key" ON "patient_sessions"("deviceSessionTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "consultation_clinical_notes_consultationId_key" ON "consultation_clinical_notes"("consultationId");

-- CreateIndex
CREATE INDEX "consultation_vitals_consultationId_idx" ON "consultation_vitals"("consultationId");

-- CreateIndex
CREATE INDEX "consultation_tests_consultationId_idx" ON "consultation_tests"("consultationId");

-- CreateIndex
CREATE INDEX "media_sessions_consultationId_idx" ON "media_sessions"("consultationId");

-- CreateIndex
CREATE UNIQUE INDEX "consultation_queue_entries_consultationId_key" ON "consultation_queue_entries"("consultationId");

-- CreateIndex
CREATE INDEX "consultation_queue_entries_state_enqueuedAt_idx" ON "consultation_queue_entries"("state", "enqueuedAt");

-- CreateIndex
CREATE INDEX "consultation_assignments_doctorId_offeredAt_idx" ON "consultation_assignments"("doctorId", "offeredAt");

-- CreateIndex
CREATE INDEX "consultation_assignments_result_respondByAt_idx" ON "consultation_assignments"("result", "respondByAt");

-- CreateIndex
CREATE UNIQUE INDEX "consultation_assignments_consultationId_doctorId_attemptNum_key" ON "consultation_assignments"("consultationId", "doctorId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "prescriptions_publicId_key" ON "prescriptions"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "prescriptions_verificationCode_key" ON "prescriptions"("verificationCode");

-- CreateIndex
CREATE INDEX "prescriptions_pharmacyId_issuedAt_idx" ON "prescriptions"("pharmacyId", "issuedAt");

-- CreateIndex
CREATE INDEX "prescriptions_doctorId_issuedAt_idx" ON "prescriptions"("doctorId", "issuedAt");

-- CreateIndex
CREATE INDEX "prescriptions_state_idx" ON "prescriptions"("state");

-- CreateIndex
CREATE INDEX "prescription_items_prescriptionId_isActive_idx" ON "prescription_items"("prescriptionId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_versions_prescriptionId_version_key" ON "prescription_versions"("prescriptionId", "version");

-- CreateIndex
CREATE INDEX "substitution_requests_prescriptionId_state_idx" ON "substitution_requests"("prescriptionId", "state");

-- CreateIndex
CREATE INDEX "substitution_requests_state_createdAt_idx" ON "substitution_requests"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_publicId_key" ON "referrals"("publicId");

-- CreateIndex
CREATE INDEX "referrals_pharmacyId_issuedAt_idx" ON "referrals"("pharmacyId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_publicId_key" ON "payments"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_providerReference_key" ON "payments"("providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_status_paidAt_idx" ON "payments"("status", "paidAt");

-- CreateIndex
CREATE INDEX "payments_consultationId_idx" ON "payments"("consultationId");

-- CreateIndex
CREATE INDEX "payment_webhook_events_receivedAt_idx" ON "payment_webhook_events"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_webhook_events_provider_providerEventId_key" ON "payment_webhook_events"("provider", "providerEventId");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_allocations_consultationId_key" ON "revenue_allocations"("consultationId");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_allocations_paymentId_key" ON "revenue_allocations"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_publicId_key" ON "refunds"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_providerRefundRef_key" ON "refunds"("providerRefundRef");

-- CreateIndex
CREATE INDEX "refunds_state_createdAt_idx" ON "refunds"("state", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_payouts_publicId_key" ON "pharmacy_payouts"("publicId");

-- CreateIndex
CREATE INDEX "pharmacy_payouts_status_idx" ON "pharmacy_payouts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_payouts_pharmacyId_periodStart_periodEnd_key" ON "pharmacy_payouts"("pharmacyId", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "promotions_code_key" ON "promotions"("code");

-- CreateIndex
CREATE INDEX "promotions_isActive_startsAt_endsAt_idx" ON "promotions"("isActive", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_redemptions_consultationId_key" ON "promotion_redemptions"("consultationId");

-- CreateIndex
CREATE UNIQUE INDEX "feedback_consultationId_key" ON "feedback"("consultationId");

-- CreateIndex
CREATE UNIQUE INDEX "complaint_categories_code_key" ON "complaint_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "complaints_publicId_key" ON "complaints"("publicId");

-- CreateIndex
CREATE INDEX "complaints_state_createdAt_idx" ON "complaints"("state", "createdAt");

-- CreateIndex
CREATE INDEX "system_settings_category_idx" ON "system_settings"("category");

-- CreateIndex
CREATE INDEX "system_setting_history_key_changedAt_idx" ON "system_setting_history"("key", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_code_channel_locale_key" ON "notification_templates"("code", "channel", "locale");

-- CreateIndex
CREATE INDEX "notifications_recipientType_recipientRef_createdAt_idx" ON "notifications"("recipientType", "recipientRef", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_status_createdAt_idx" ON "notifications"("status", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_occurredAt_idx" ON "audit_logs"("occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_actorType_actorId_occurredAt_idx" ON "audit_logs"("actorType", "actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_occurredAt_idx" ON "audit_logs"("action", "occurredAt");

-- CreateIndex
CREATE INDEX "retention_jobs_status_scheduledFor_idx" ON "retention_jobs"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "clinical_record_access_log_consultationId_idx" ON "clinical_record_access_log"("consultationId");

-- CreateIndex
CREATE INDEX "clinical_record_access_log_accessedAt_idx" ON "clinical_record_access_log"("accessedAt");

-- CreateIndex
CREATE INDEX "consents_consultationId_idx" ON "consents"("consultationId");

-- CreateIndex
CREATE INDEX "disclosure_logs_entityType_entityId_idx" ON "disclosure_logs"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "consultation_summaries_publicId_key" ON "consultation_summaries"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "consultation_summaries_verificationCode_key" ON "consultation_summaries"("verificationCode");

-- CreateIndex
CREATE UNIQUE INDEX "consultation_summaries_consultationId_key" ON "consultation_summaries"("consultationId");

-- CreateIndex
CREATE INDEX "consultation_summaries_pharmacyId_issuedAt_idx" ON "consultation_summaries"("pharmacyId", "issuedAt");

-- CreateIndex
CREATE INDEX "consultation_summaries_doctorId_issuedAt_idx" ON "consultation_summaries"("doctorId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "pilot_applications_publicId_key" ON "pilot_applications"("publicId");

-- CreateIndex
CREATE INDEX "pilot_applications_status_createdAt_idx" ON "pilot_applications"("status", "createdAt");

-- CreateIndex
CREATE INDEX "pilot_applications_role_status_idx" ON "pilot_applications"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pilot_applications_email_role_key" ON "pilot_applications"("email", "role");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_recovery_codes" ADD CONSTRAINT "two_factor_recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admins" ADD CONSTRAINT "admins_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_users" ADD CONSTRAINT "pharmacy_users_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "pharmacies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_users" ADD CONSTRAINT "pharmacy_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_hours" ADD CONSTRAINT "pharmacy_hours_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "pharmacies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_capabilities" ADD CONSTRAINT "pharmacy_capabilities_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "pharmacies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_documents" ADD CONSTRAINT "pharmacy_documents_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "pharmacies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_payout_details" ADD CONSTRAINT "pharmacy_payout_details_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "pharmacies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_documents" ADD CONSTRAINT "doctor_documents_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_languages" ADD CONSTRAINT "doctor_languages_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_languages" ADD CONSTRAINT "doctor_languages_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "languages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_signatures" ADD CONSTRAINT "doctor_signatures_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_subscriptions" ADD CONSTRAINT "doctor_subscriptions_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_performance_events" ADD CONSTRAINT "doctor_performance_events_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_quality_scores" ADD CONSTRAINT "doctor_quality_scores_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_shift_assignments" ADD CONSTRAINT "doctor_shift_assignments_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_shift_assignments" ADD CONSTRAINT "doctor_shift_assignments_shiftDefinitionId_fkey" FOREIGN KEY ("shiftDefinitionId") REFERENCES "shift_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_service_hours" ADD CONSTRAINT "doctor_service_hours_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_presence" ADD CONSTRAINT "doctor_presence_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "pharmacies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "languages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_state_events" ADD CONSTRAINT "consultation_state_events_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_access_tokens" ADD CONSTRAINT "consultation_access_tokens_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_sessions" ADD CONSTRAINT "patient_sessions_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_clinical_notes" ADD CONSTRAINT "consultation_clinical_notes_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_vitals" ADD CONSTRAINT "consultation_vitals_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_tests" ADD CONSTRAINT "consultation_tests_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_sessions" ADD CONSTRAINT "media_sessions_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_queue_entries" ADD CONSTRAINT "consultation_queue_entries_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_queue_entries" ADD CONSTRAINT "consultation_queue_entries_languageId_fkey" FOREIGN KEY ("languageId") REFERENCES "languages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_assignments" ADD CONSTRAINT "consultation_assignments_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_assignments" ADD CONSTRAINT "consultation_assignments_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "pharmacies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "doctor_signatures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_versions" ADD CONSTRAINT "prescription_versions_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "substitution_requests" ADD CONSTRAINT "substitution_requests_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "substitution_requests" ADD CONSTRAINT "substitution_requests_prescriptionItemId_fkey" FOREIGN KEY ("prescriptionItemId") REFERENCES "prescription_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "substitution_requests" ADD CONSTRAINT "substitution_requests_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "pharmacies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "substitution_requests" ADD CONSTRAINT "substitution_requests_decidedByDoctorId_fkey" FOREIGN KEY ("decidedByDoctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "pharmacies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "doctor_signatures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_doctorSubscriptionId_fkey" FOREIGN KEY ("doctorSubscriptionId") REFERENCES "doctor_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_allocations" ADD CONSTRAINT "revenue_allocations_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_allocations" ADD CONSTRAINT "revenue_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_payouts" ADD CONSTRAINT "pharmacy_payouts_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "pharmacies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "pharmacies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "feedback"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "complaint_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_jobs" ADD CONSTRAINT "retention_jobs_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_record_access_log" ADD CONSTRAINT "clinical_record_access_log_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_summaries" ADD CONSTRAINT "consultation_summaries_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_summaries" ADD CONSTRAINT "consultation_summaries_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_summaries" ADD CONSTRAINT "consultation_summaries_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "pharmacies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_summaries" ADD CONSTRAINT "consultation_summaries_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "doctor_signatures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
