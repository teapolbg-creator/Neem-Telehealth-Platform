-- CHPS slice 1e: the doctor's encounter record and its versions (D78). Additive only.


-- CreateTable
CREATE TABLE "encounter_records" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "chpsPatientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "contentEnc" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "finalisedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "encounter_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter_record_versions" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentEnc" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "reason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encounter_record_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "encounter_records_consultationId_key" ON "encounter_records"("consultationId");

-- CreateIndex
CREATE INDEX "encounter_records_chpsPatientId_createdAt_idx" ON "encounter_records"("chpsPatientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_record_versions_encounterId_version_key" ON "encounter_record_versions"("encounterId", "version");

-- AddForeignKey
ALTER TABLE "encounter_records" ADD CONSTRAINT "encounter_records_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_records" ADD CONSTRAINT "encounter_records_chpsPatientId_fkey" FOREIGN KEY ("chpsPatientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_record_versions" ADD CONSTRAINT "encounter_record_versions_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "encounter_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

