-- CreateTable
CREATE TABLE "professional_earnings" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "grossMinor" INTEGER NOT NULL,
    "professionalSharePctBp" INTEGER NOT NULL,
    "professionalShareMinor" INTEGER NOT NULL,
    "neemShareMinor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'GHS',
    "discipline" "ProfessionalDiscipline" NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "professional_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_payouts" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "doctorId" TEXT NOT NULL,
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

    CONSTRAINT "professional_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professional_payout_details" (
    "doctorId" TEXT NOT NULL,
    "method" VARCHAR(40) NOT NULL,
    "accountNameEnc" TEXT NOT NULL,
    "accountNumberEnc" TEXT NOT NULL,
    "bankOrNetwork" VARCHAR(120) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "professional_payout_details_pkey" PRIMARY KEY ("doctorId")
);

-- CreateIndex
CREATE UNIQUE INDEX "professional_earnings_consultationId_key" ON "professional_earnings"("consultationId");

-- CreateIndex
CREATE UNIQUE INDEX "professional_earnings_paymentId_key" ON "professional_earnings"("paymentId");

-- CreateIndex
CREATE INDEX "professional_earnings_doctorId_calculatedAt_idx" ON "professional_earnings"("doctorId", "calculatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "professional_payouts_publicId_key" ON "professional_payouts"("publicId");

-- CreateIndex
CREATE INDEX "professional_payouts_status_idx" ON "professional_payouts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "professional_payouts_doctorId_periodStart_periodEnd_key" ON "professional_payouts"("doctorId", "periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "professional_earnings" ADD CONSTRAINT "professional_earnings_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_earnings" ADD CONSTRAINT "professional_earnings_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_earnings" ADD CONSTRAINT "professional_earnings_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_payouts" ADD CONSTRAINT "professional_payouts_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professional_payout_details" ADD CONSTRAINT "professional_payout_details_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

