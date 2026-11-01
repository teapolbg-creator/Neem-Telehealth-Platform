-- Operations administrators and district health officers (CHPS slice 3a, D84).
-- Additive: every existing ADMIN keeps every permission, as super administrator.

-- CreateEnum
CREATE TYPE "GeoScopeLevel" AS ENUM ('REGION', 'DISTRICT', 'SUB_DISTRICT');

-- AlterEnum


ALTER TYPE "UserRole" ADD VALUE 'OPS_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'DISTRICT';

-- CreateTable
CREATE TABLE "district_officers" (
    "userId" TEXT NOT NULL,
    "fullName" VARCHAR(160) NOT NULL,
    "title" VARCHAR(120),
    "phone" VARCHAR(40),
    "scopeLevel" "GeoScopeLevel" NOT NULL,
    "regionId" TEXT NOT NULL,
    "districtId" TEXT,
    "subDistrictId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "district_officers_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "district_officers_regionId_idx" ON "district_officers"("regionId");

-- CreateIndex
CREATE INDEX "district_officers_districtId_idx" ON "district_officers"("districtId");

-- CreateIndex
CREATE INDEX "district_officers_subDistrictId_idx" ON "district_officers"("subDistrictId");

-- AddForeignKey
ALTER TABLE "district_officers" ADD CONSTRAINT "district_officers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "district_officers" ADD CONSTRAINT "district_officers_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "regions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "district_officers" ADD CONSTRAINT "district_officers_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "district_officers" ADD CONSTRAINT "district_officers_subDistrictId_fkey" FOREIGN KEY ("subDistrictId") REFERENCES "sub_districts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The scope's level decides which columns are set: a region officer has no
-- district, a district officer no sub-district, a sub-district officer all three.
ALTER TABLE "district_officers" ADD CONSTRAINT "district_officers_scope_matches_level" CHECK (
  ("scopeLevel" = 'REGION' AND "districtId" IS NULL AND "subDistrictId" IS NULL)
  OR ("scopeLevel" = 'DISTRICT' AND "districtId" IS NOT NULL AND "subDistrictId" IS NULL)
  OR ("scopeLevel" = 'SUB_DISTRICT' AND "districtId" IS NOT NULL AND "subDistrictId" IS NOT NULL)
);
