-- AlterTable
ALTER TABLE "triage_records" ADD COLUMN     "protocolFlagsEnc" TEXT;

-- CreateTable
CREATE TABLE "triage_protocol_rules" (
    "id" TEXT NOT NULL,
    "reading" VARCHAR(40) NOT NULL,
    "comparison" VARCHAR(8) NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "suggestedCategory" "TriageCategory",
    "message" VARCHAR(300) NOT NULL,
    "source" VARCHAR(200) NOT NULL,
    "approvedBy" VARCHAR(160) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    "retiredByUserId" TEXT,

    CONSTRAINT "triage_protocol_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "triage_protocol_rules_retiredAt_idx" ON "triage_protocol_rules"("retiredAt");

