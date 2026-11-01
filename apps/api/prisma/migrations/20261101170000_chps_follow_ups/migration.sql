-- CHPS slice 2b: follow-ups (D81). Additive only.


-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('DUE', 'DONE', 'MISSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "follow_ups" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "referralId" TEXT,
    "dueDate" DATE NOT NULL,
    "instructionsEnc" TEXT NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'DUE',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolutionNoteEnc" TEXT,
    "resolvedVisitId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "follow_ups_publicId_key" ON "follow_ups"("publicId");

-- CreateIndex
CREATE INDEX "follow_ups_facilityId_status_dueDate_idx" ON "follow_ups"("facilityId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "follow_ups_patientId_dueDate_idx" ON "follow_ups"("patientId", "dueDate");

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "patient_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_resolvedVisitId_fkey" FOREIGN KEY ("resolvedVisitId") REFERENCES "patient_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "chps_referrals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

