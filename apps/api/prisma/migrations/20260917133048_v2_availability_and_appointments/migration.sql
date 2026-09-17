-- CreateEnum
CREATE TYPE "AppointmentState" AS ENUM ('RESERVED', 'CONFIRMED', 'OPENED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "professional_availability" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "startsAt" VARCHAR(5) NOT NULL,
    "endsAt" VARCHAR(5) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "professional_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "doctorId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "patientAccountId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "slotKey" VARCHAR(40),
    "state" "AppointmentState" NOT NULL DEFAULT 'RESERVED',
    "reservationExpiresAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releasedReason" VARCHAR(120),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "professional_availability_doctorId_isActive_idx" ON "professional_availability"("doctorId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "professional_availability_doctorId_weekday_startsAt_key" ON "professional_availability"("doctorId", "weekday", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_publicId_key" ON "appointments"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_consultationId_key" ON "appointments"("consultationId");

-- CreateIndex
CREATE INDEX "appointments_state_startsAt_idx" ON "appointments"("state", "startsAt");

-- CreateIndex
CREATE INDEX "appointments_patientAccountId_startsAt_idx" ON "appointments"("patientAccountId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_doctorId_slotKey_key" ON "appointments"("doctorId", "slotKey");

-- AddForeignKey
ALTER TABLE "professional_availability" ADD CONSTRAINT "professional_availability_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patientAccountId_fkey" FOREIGN KEY ("patientAccountId") REFERENCES "patient_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

