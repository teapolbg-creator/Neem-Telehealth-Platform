-- CreateEnum
CREATE TYPE "ProfessionalDiscipline" AS ENUM ('DOCTOR', 'DIETITIAN', 'TRAINER');

-- CreateEnum
CREATE TYPE "ServiceClinic" AS ENUM ('GENERAL', 'WEIGHT_LOSS');

-- AlterTable
ALTER TABLE "consultations" ADD COLUMN     "serviceId" TEXT;

-- CreateTable
CREATE TABLE "services" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "clinic" "ServiceClinic" NOT NULL DEFAULT 'GENERAL',
    "discipline" "ProfessionalDiscipline" NOT NULL DEFAULT 'DOCTOR',
    "priceMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'GHS',
    "durationSeconds" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "services_code_key" ON "services"("code");

-- CreateIndex
CREATE INDEX "services_isActive_clinic_sortOrder_idx" ON "services"("isActive", "clinic", "sortOrder");

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
