-- CreateEnum
CREATE TYPE "PatientContactKind" AS ENUM ('EMAIL', 'PHONE');

-- AlterTable
ALTER TABLE "consultations" ADD COLUMN     "patientAccountId" TEXT;

-- CreateTable
CREATE TABLE "patient_accounts" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "contactKind" "PatientContactKind" NOT NULL,
    "contactHash" VARCHAR(64) NOT NULL,
    "contactEnc" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patient_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_auth_codes" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_auth_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_account_sessions" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ipHash" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_account_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patient_accounts_publicId_key" ON "patient_accounts"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "patient_accounts_contactHash_key" ON "patient_accounts"("contactHash");

-- CreateIndex
CREATE INDEX "patient_auth_codes_accountId_createdAt_idx" ON "patient_auth_codes"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "patient_account_sessions_tokenHash_key" ON "patient_account_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "patient_account_sessions_accountId_idx" ON "patient_account_sessions"("accountId");

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_patientAccountId_fkey" FOREIGN KEY ("patientAccountId") REFERENCES "patient_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_auth_codes" ADD CONSTRAINT "patient_auth_codes_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "patient_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_account_sessions" ADD CONSTRAINT "patient_account_sessions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "patient_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
