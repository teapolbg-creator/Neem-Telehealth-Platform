-- CHPS slice 2d: dispensing at the facility, and visit attachments (D83). Additive only.


-- AlterTable
ALTER TABLE "prescriptions" ADD COLUMN     "dispensedFacilityId" TEXT;

-- CreateTable
CREATE TABLE "visit_attachments" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "label" VARCHAR(160) NOT NULL,
    "contentType" VARCHAR(80) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" VARCHAR(400) NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visit_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "visit_attachments_publicId_key" ON "visit_attachments"("publicId");

-- CreateIndex
CREATE INDEX "visit_attachments_visitId_createdAt_idx" ON "visit_attachments"("visitId", "createdAt");

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_dispensedFacilityId_fkey" FOREIGN KEY ("dispensedFacilityId") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_attachments" ADD CONSTRAINT "visit_attachments_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_attachments" ADD CONSTRAINT "visit_attachments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_attachments" ADD CONSTRAINT "visit_attachments_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "patient_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

