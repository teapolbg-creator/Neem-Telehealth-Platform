-- D57: a broken call must not cost the patient the consultation they paid for.
--
-- Additive. A new non-terminal state, the room's own addresses so a rejoin
-- survives a restart, an attendance trail kept apart from clinical status,
-- and the webhook ledger that makes a duplicate delivery harmless.

-- CreateEnum
CREATE TYPE "MediaParticipantRole" AS ENUM ('PATIENT', 'DOCTOR');

-- CreateEnum
CREATE TYPE "CallAttendanceKind" AS ENUM ('JOINED', 'LEFT', 'SESSION_ENDED');

-- CreateEnum
CREATE TYPE "CallAttendanceSource" AS ENUM ('CLIENT', 'WEBHOOK', 'SERVER');

-- AlterEnum
ALTER TYPE "ConsultationState" ADD VALUE 'INTERRUPTED';

-- AlterTable
ALTER TABLE "consultations" ADD COLUMN     "interruptedAt" TIMESTAMP(3),
ADD COLUMN     "interruptionNote" VARCHAR(500),
ADD COLUMN     "rejoinableUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "media_sessions" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "hostRoomUrlEnc" TEXT,
ADD COLUMN     "replacedSessionId" TEXT,
ADD COLUMN     "roomExpiresAt" TIMESTAMP(3),
ADD COLUMN     "roomUrlEnc" TEXT;

-- CreateTable
CREATE TABLE "call_attendance_events" (
    "id" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "mediaSessionId" TEXT,
    "participant" "MediaParticipantRole" NOT NULL,
    "event" "CallAttendanceKind" NOT NULL,
    "source" "CallAttendanceSource" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerSessionRef" VARCHAR(120),

    CONSTRAINT "call_attendance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "providerEventId" VARCHAR(200) NOT NULL,
    "eventType" VARCHAR(80) NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingResult" VARCHAR(80),
    "error" VARCHAR(500),

    CONSTRAINT "media_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "call_attendance_events_consultationId_occurredAt_idx" ON "call_attendance_events"("consultationId", "occurredAt");

-- CreateIndex
CREATE INDEX "media_webhook_events_receivedAt_idx" ON "media_webhook_events"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "media_webhook_events_provider_providerEventId_key" ON "media_webhook_events"("provider", "providerEventId");

-- AddForeignKey
ALTER TABLE "call_attendance_events" ADD CONSTRAINT "call_attendance_events_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "consultations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_attendance_events" ADD CONSTRAINT "call_attendance_events_mediaSessionId_fkey" FOREIGN KEY ("mediaSessionId") REFERENCES "media_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Older rows could leave several sessions open for one consultation, because
-- nothing closed them outside completion. Keep the newest and close the rest,
-- so the index below describes a state the data can actually be in.
UPDATE "media_sessions" AS m
SET "endedAt" = now(), "endReason" = 'superseded_before_recovery'
WHERE m."endedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "media_sessions" AS newer
    WHERE newer."consultationId" = m."consultationId"
      AND newer."endedAt" IS NULL
      AND (newer."startedAt" > m."startedAt"
           OR (newer."startedAt" = m."startedAt" AND newer."id" > m."id"))
  );

-- At most one open session per consultation, enforced by the database rather
-- than by whoever clicks first: two tabs rejoining at the same moment must
-- not produce two rooms.
CREATE UNIQUE INDEX "media_sessions_one_open_per_consultation" ON "media_sessions"("consultationId") WHERE "endedAt" IS NULL;
