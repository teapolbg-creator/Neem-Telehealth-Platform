-- AlterTable
ALTER TABLE "doctors" ADD COLUMN     "credentialNumber" VARCHAR(60),
ADD COLUMN     "credentialType" VARCHAR(120),
ADD COLUMN     "discipline" "ProfessionalDiscipline" NOT NULL DEFAULT 'DOCTOR',
ALTER COLUMN "mdcNumber" DROP NOT NULL;

-- CreateTable
CREATE TABLE "professional_services" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "professional_services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "professional_services_serviceId_isActive_idx" ON "professional_services"("serviceId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "professional_services_doctorId_serviceId_key" ON "professional_services"("doctorId", "serviceId");

-- CreateIndex
CREATE INDEX "doctors_discipline_status_idx" ON "doctors"("discipline", "status");

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

