-- CHPS slice 1a: administrative geography, health facilities, facility staff.
-- See docs/v2-chps-plan.md and decision D73.
--
-- Additive only. Nothing that existed before reads any of it, so the pharmacy
-- and patient-direct channels are untouched. The two enum values cannot be
-- dropped again (Postgres has no DROP VALUE), but nothing writes them until
-- an administrator creates a facility account.

-- CreateEnum
CREATE TYPE "FacilityType" AS ENUM ('CHPS', 'HEALTH_CENTRE', 'DISTRICT_HOSPITAL', 'REGIONAL_HOSPITAL', 'TEACHING_HOSPITAL', 'OTHER');

-- CreateEnum
CREATE TYPE "FacilityStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "FacilityEquipmentStatus" AS ENUM ('NOT_INSTALLED', 'OPERATIONAL', 'FAULTY');

-- CreateEnum
CREATE TYPE "FacilityConnectivityStatus" AS ENUM ('UNKNOWN', 'GOOD', 'INTERMITTENT', 'POOR', 'NONE');

-- AlterEnum
ALTER TYPE "ActorType" ADD VALUE 'FACILITY';

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'FACILITY';

-- CreateTable
CREATE TABLE "regions" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "districts" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "districts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_districts" (
    "id" TEXT NOT NULL,
    "districtId" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sub_districts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facilities" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "type" "FacilityType" NOT NULL,
    "districtId" TEXT NOT NULL,
    "subDistrictId" TEXT,
    "community" VARCHAR(160) NOT NULL,
    "addressLine" VARCHAR(200),
    "ghanaPostGps" VARCHAR(20),
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "contactName" VARCHAR(160),
    "contactPhone" VARCHAR(24),
    "contactEmail" VARCHAR(255),
    "status" "FacilityStatus" NOT NULL DEFAULT 'INACTIVE',
    "statusReason" VARCHAR(500),
    "equipmentStatus" "FacilityEquipmentStatus" NOT NULL DEFAULT 'NOT_INSTALLED',
    "connectivityStatus" "FacilityConnectivityStatus" NOT NULL DEFAULT 'UNKNOWN',
    "connectivityReportedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "facilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facility_users" (
    "facilityId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" VARCHAR(160) NOT NULL,
    "title" VARCHAR(120),
    "phone" VARCHAR(24),
    "isFacilityAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facility_users_pkey" PRIMARY KEY ("facilityId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "regions_name_key" ON "regions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "districts_regionId_name_key" ON "districts"("regionId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sub_districts_districtId_name_key" ON "sub_districts"("districtId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "facilities_publicId_key" ON "facilities"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "facilities_code_key" ON "facilities"("code");

-- CreateIndex
CREATE INDEX "facilities_districtId_status_idx" ON "facilities"("districtId", "status");

-- CreateIndex
CREATE INDEX "facilities_type_status_idx" ON "facilities"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "facility_users_userId_key" ON "facility_users"("userId");

-- AddForeignKey
ALTER TABLE "districts" ADD CONSTRAINT "districts_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_districts" ADD CONSTRAINT "sub_districts_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_subDistrictId_fkey" FOREIGN KEY ("subDistrictId") REFERENCES "sub_districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facility_users" ADD CONSTRAINT "facility_users_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facility_users" ADD CONSTRAINT "facility_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The sixteen regions of Ghana, as reference data. Districts and
-- sub-districts are not seeded: they are entered from an official list
-- (docs/v2-chps-plan.md §4.6). Keep in step with GHANA_REGIONS in
-- prisma/seed/reference-data.ts; a unit test compares the two.
INSERT INTO "regions" ("id", "name") VALUES
    (gen_random_uuid()::text, 'Ahafo'),
    (gen_random_uuid()::text, 'Ashanti'),
    (gen_random_uuid()::text, 'Bono'),
    (gen_random_uuid()::text, 'Bono East'),
    (gen_random_uuid()::text, 'Central'),
    (gen_random_uuid()::text, 'Eastern'),
    (gen_random_uuid()::text, 'Greater Accra'),
    (gen_random_uuid()::text, 'North East'),
    (gen_random_uuid()::text, 'Northern'),
    (gen_random_uuid()::text, 'Oti'),
    (gen_random_uuid()::text, 'Savannah'),
    (gen_random_uuid()::text, 'Upper East'),
    (gen_random_uuid()::text, 'Upper West'),
    (gen_random_uuid()::text, 'Volta'),
    (gen_random_uuid()::text, 'Western'),
    (gen_random_uuid()::text, 'Western North')
ON CONFLICT ("name") DO NOTHING;
