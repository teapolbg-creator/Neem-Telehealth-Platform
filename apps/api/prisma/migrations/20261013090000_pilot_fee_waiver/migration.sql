-- Free consultations during the pilot (D69).
--
-- Two additive columns and nothing else. No backfill: every existing row is a
-- paid consultation, which is exactly what the defaults say.
--
-- Reversing this is `DROP COLUMN` on each. Nothing that existed before this
-- migration reads either column, so dropping them restores the previous schema
-- exactly — which is the reason the waiver reuses `PaymentStatus.SUCCESS`
-- rather than adding a value to that enum. Postgres cannot drop an enum value.

-- Why no money was asked for, when none was. NULL means a fee was charged.
ALTER TABLE "consultations" ADD COLUMN "feeWaivedReason" VARCHAR(40);

-- Marks the zero-amount payment row that stands for a waived fee, so that
-- everything which talks to the payment provider can skip it: there is no
-- transaction at Paystack to verify or refund.
ALTER TABLE "payments" ADD COLUMN "isWaived" BOOLEAN NOT NULL DEFAULT false;
