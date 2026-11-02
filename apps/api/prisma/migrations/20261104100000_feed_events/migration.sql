-- AlterTable
ALTER TABLE "users" ADD COLUMN     "feedReadAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "feed_events" (
    "id" TEXT NOT NULL,
    "audience" VARCHAR(64) NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "reference" VARCHAR(64) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feed_events_audience_occurredAt_idx" ON "feed_events"("audience", "occurredAt");

-- CreateIndex
CREATE INDEX "feed_events_occurredAt_idx" ON "feed_events"("occurredAt");

