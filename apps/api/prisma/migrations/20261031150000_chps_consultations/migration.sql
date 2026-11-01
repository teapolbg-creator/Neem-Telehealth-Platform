-- CHPS slice 1c: consultations requested by a CHPS compound (D76). Additive only.

-- AlterEnum
ALTER TYPE "ConsultationChannel" ADD VALUE 'CHPS';

-- AlterTable
ALTER TABLE "consultations" ADD COLUMN     "chpsPatientId" TEXT,
ADD COLUMN     "facilityId" TEXT,
ADD COLUMN     "visitId" TEXT;

-- CreateIndex
CREATE INDEX "consultations_facilityId_createdAt_idx" ON "consultations"("facilityId", "createdAt");

-- CreateIndex
CREATE INDEX "consultations_visitId_idx" ON "consultations"("visitId");

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_chpsPatientId_fkey" FOREIGN KEY ("chpsPatientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "patient_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A CHPS consultation names its facility, patient and visit together, or a
-- consultation names none of them. Enforced here as well as in the service,
-- because a half-linked consultation would be a patient nobody can find.
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_chps_links_together" CHECK (
    ("facilityId" IS NULL) = ("chpsPatientId" IS NULL)
    AND ("facilityId" IS NULL) = ("visitId" IS NULL)
);
