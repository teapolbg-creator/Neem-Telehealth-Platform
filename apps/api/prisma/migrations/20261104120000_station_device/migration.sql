-- AlterTable
ALTER TABLE "facility_stations" ADD COLUMN     "deviceBatteryPercent" INTEGER,
ADD COLUMN     "deviceBrowser" VARCHAR(40),
ADD COLUMN     "deviceCharging" BOOLEAN,
ADD COLUMN     "deviceHasCamera" BOOLEAN,
ADD COLUMN     "deviceHasMicrophone" BOOLEAN;

