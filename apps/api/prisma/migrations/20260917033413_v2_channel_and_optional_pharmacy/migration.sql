-- CreateEnum
CREATE TYPE "ConsultationChannel" AS ENUM ('COUNTER', 'DIRECT');

-- AlterTable
ALTER TABLE "consultations" ADD COLUMN     "channel" "ConsultationChannel" NOT NULL DEFAULT 'COUNTER',
ALTER COLUMN "pharmacyId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "prescriptions" ALTER COLUMN "pharmacyId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "referrals" ALTER COLUMN "pharmacyId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "consultation_summaries" ALTER COLUMN "pharmacyId" DROP NOT NULL;
