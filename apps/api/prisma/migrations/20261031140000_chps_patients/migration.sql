-- CHPS slice 1b: patients, walk-in visits, triage, and the record-access log.
-- See docs/v2-chps-plan.md, D74 and D75. Additive only.

-- CreateEnum
CREATE TYPE "NhisStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'NOT_MEMBER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ConsentGivenBy" AS ENUM ('PATIENT', 'GUARDIAN');

-- CreateEnum
CREATE TYPE "VisitStatus" AS ENUM ('AWAITING_TRIAGE', 'TRIAGED', 'ESCALATED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TriageCategory" AS ENUM ('RED', 'ORANGE', 'YELLOW', 'GREEN');

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "patientNumber" VARCHAR(16) NOT NULL,
    "facilityId" TEXT NOT NULL,
    "fullNameEnc" TEXT NOT NULL,
    "nameTokens" VARCHAR(64)[],
    "sex" "PatientSex" NOT NULL,
    "dateOfBirth" DATE NOT NULL,
    "dobIsEstimated" BOOLEAN NOT NULL DEFAULT false,
    "phoneEnc" TEXT,
    "phoneHash" VARCHAR(64),
    "community" VARCHAR(160) NOT NULL,
    "nhisStatus" "NhisStatus" NOT NULL DEFAULT 'UNKNOWN',
    "nhisNumberEnc" TEXT,
    "nhisNumberHash" VARCHAR(64),
    "emergencyContactEnc" TEXT,
    "representativeEnc" TEXT,
    "allergiesEnc" TEXT,
    "medicationsEnc" TEXT,
    "medicalHistoryEnc" TEXT,
    "consentGivenBy" "ConsentGivenBy" NOT NULL,
    "consentVersion" VARCHAR(20) NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "consentRecordedByUserId" TEXT NOT NULL,
    "registeredByUserId" TEXT NOT NULL,
    "clientRequestId" VARCHAR(64),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_visits" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "patientId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "status" "VisitStatus" NOT NULL DEFAULT 'AWAITING_TRIAGE',
    "presentingComplaintEnc" TEXT NOT NULL,
    "arrivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "escalatedAt" TIMESTAMP(3),
    "escalationNoteEnc" TEXT,
    "closedAt" TIMESTAMP(3),
    "closingNoteEnc" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "closedByUserId" TEXT,
    "clientRequestId" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triage_records" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "category" "TriageCategory" NOT NULL,
    "vitalsEnc" TEXT NOT NULL,
    "symptomsEnc" TEXT,
    "observationsEnc" TEXT,
    "recordedByUserId" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "triage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_record_access" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorRole" VARCHAR(40) NOT NULL,
    "facilityId" TEXT,
    "purpose" VARCHAR(60) NOT NULL,
    "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_record_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patients_publicId_key" ON "patients"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "patients_patientNumber_key" ON "patients"("patientNumber");

-- CreateIndex
CREATE UNIQUE INDEX "patients_clientRequestId_key" ON "patients"("clientRequestId");

-- CreateIndex
CREATE INDEX "patients_facilityId_createdAt_idx" ON "patients"("facilityId", "createdAt");

-- CreateIndex
CREATE INDEX "patients_facilityId_phoneHash_idx" ON "patients"("facilityId", "phoneHash");

-- CreateIndex
CREATE INDEX "patients_facilityId_nhisNumberHash_idx" ON "patients"("facilityId", "nhisNumberHash");

-- CreateIndex
CREATE INDEX "patients_nameTokens_idx" ON "patients" USING GIN ("nameTokens");

-- CreateIndex
CREATE UNIQUE INDEX "patient_visits_publicId_key" ON "patient_visits"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "patient_visits_clientRequestId_key" ON "patient_visits"("clientRequestId");

-- CreateIndex
CREATE INDEX "patient_visits_facilityId_arrivedAt_idx" ON "patient_visits"("facilityId", "arrivedAt");

-- CreateIndex
CREATE INDEX "patient_visits_facilityId_status_idx" ON "patient_visits"("facilityId", "status");

-- CreateIndex
CREATE INDEX "patient_visits_patientId_arrivedAt_idx" ON "patient_visits"("patientId", "arrivedAt");

-- CreateIndex
CREATE INDEX "triage_records_visitId_recordedAt_idx" ON "triage_records"("visitId", "recordedAt");

-- CreateIndex
CREATE INDEX "patient_record_access_patientId_accessedAt_idx" ON "patient_record_access"("patientId", "accessedAt");

-- CreateIndex
CREATE INDEX "patient_record_access_actorUserId_accessedAt_idx" ON "patient_record_access"("actorUserId", "accessedAt");

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_visits" ADD CONSTRAINT "patient_visits_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_visits" ADD CONSTRAINT "patient_visits_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triage_records" ADD CONSTRAINT "triage_records_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "patient_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_record_access" ADD CONSTRAINT "patient_record_access_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

