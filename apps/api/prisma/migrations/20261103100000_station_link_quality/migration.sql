-- AlterTable
ALTER TABLE "facilities" ADD COLUMN     "lowDataVideo" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "facility_stations" ADD COLUMN     "linkDownKbps" INTEGER,
ADD COLUMN     "linkMeasuredAt" TIMESTAMP(3),
ADD COLUMN     "linkRttMs" INTEGER,
ADD COLUMN     "linkUpKbps" INTEGER;

