-- CHPS slice 1d: consultation stations (D77). Additive only.


-- CreateTable
CREATE TABLE "facility_stations" (
    "id" TEXT NOT NULL,
    "publicId" VARCHAR(32) NOT NULL,
    "facilityId" TEXT NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "tokenHash" VARCHAR(64),
    "pairingCodeHash" VARCHAR(64),
    "pairingExpiresAt" TIMESTAMP(3),
    "pairedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "consultationId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "assignedByUserId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "facility_stations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "facility_stations_publicId_key" ON "facility_stations"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "facility_stations_tokenHash_key" ON "facility_stations"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "facility_stations_pairingCodeHash_key" ON "facility_stations"("pairingCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "facility_stations_consultationId_key" ON "facility_stations"("consultationId");

-- CreateIndex
CREATE INDEX "facility_stations_facilityId_idx" ON "facility_stations"("facilityId");

-- AddForeignKey
ALTER TABLE "facility_stations" ADD CONSTRAINT "facility_stations_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facility_stations" ADD CONSTRAINT "facility_stations_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

