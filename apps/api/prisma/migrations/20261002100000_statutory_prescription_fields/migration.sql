-- AlterTable
ALTER TABLE "doctors" ADD COLUMN     "practiceAddress" VARCHAR(300),
ADD COLUMN     "qualification" VARCHAR(160);

-- AlterTable
ALTER TABLE "patient_sessions" ADD COLUMN     "addressEnc" TEXT;

-- AlterTable
ALTER TABLE "prescriptions" ADD COLUMN     "patientAddress" VARCHAR(300),
ADD COLUMN     "prescriberAddress" VARCHAR(300),
ADD COLUMN     "prescriberQualification" VARCHAR(160);

