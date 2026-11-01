-- AlterTable
ALTER TABLE "facility_users" ADD COLUMN     "offlineKeyEnc" TEXT;

-- AlterTable
ALTER TABLE "patient_visits" ADD COLUMN     "syncedAt" TIMESTAMP(3);

