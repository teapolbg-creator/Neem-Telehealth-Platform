-- CHPS slice 2a: tracked referrals (D80). Additive only.


-- CreateEnum
CREATE TYPE "ReferralUrgency" AS ENUM ('ROUTINE', 'URGENT', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('ISSUED', 'ACKNOWLEDGED', 'ATTENDED', 'DID_NOT_ARRIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReferralContactMethod" AS ENUM ('PHONE', 'IN_PERSON', 'OTHER');

-- AlterEnum
ALTER TYPE "VisitStatus" ADD VALUE 'REFERRED';

-- CreateTable
CREATE TABLE "chps_referrals" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(16) NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "consultationId" TEXT,
    "destinationFacilityId" TEXT,
    "destinationName" VARCHAR(200) NOT NULL,
    "destinationDepartment" VARCHAR(160),
    "urgency" "ReferralUrgency" NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'ISSUED',
    "reasonEnc" TEXT NOT NULL,
    "clinicalSummaryEnc" TEXT,
    "transportEnc" TEXT,
    "issuedByUserId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" TEXT,
    "acknowledgedVia" "ReferralContactMethod",
    "acknowledgedContact" VARCHAR(160),
    "outcomeAt" TIMESTAMP(3),
    "outcomeByUserId" TEXT,
    "feedbackEnc" TEXT,
    "feedbackAt" TIMESTAMP(3),
    "feedbackByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chps_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chps_referrals_publicId_key" ON "chps_referrals"("publicId");

-- CreateIndex
CREATE INDEX "chps_referrals_facilityId_issuedAt_idx" ON "chps_referrals"("facilityId", "issuedAt");

-- CreateIndex
CREATE INDEX "chps_referrals_facilityId_status_idx" ON "chps_referrals"("facilityId", "status");

-- CreateIndex
CREATE INDEX "chps_referrals_patientId_issuedAt_idx" ON "chps_referrals"("patientId", "issuedAt");

-- AddForeignKey
ALTER TABLE "chps_referrals" ADD CONSTRAINT "chps_referrals_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chps_referrals" ADD CONSTRAINT "chps_referrals_destinationFacilityId_fkey" FOREIGN KEY ("destinationFacilityId") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chps_referrals" ADD CONSTRAINT "chps_referrals_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chps_referrals" ADD CONSTRAINT "chps_referrals_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "patient_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chps_referrals" ADD CONSTRAINT "chps_referrals_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

