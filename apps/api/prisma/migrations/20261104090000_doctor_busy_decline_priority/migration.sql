-- CreateEnum
CREATE TYPE "ConsultationPriority" AS ENUM ('ROUTINE', 'URGENT');

-- AlterEnum
ALTER TYPE "AssignmentResult" ADD VALUE 'DECLINED';

-- AlterTable
ALTER TABLE "consultations" ADD COLUMN     "priority" "ConsultationPriority" NOT NULL DEFAULT 'ROUTINE';

-- AlterTable
ALTER TABLE "doctor_presence" ADD COLUMN     "busySince" TIMESTAMP(3);

