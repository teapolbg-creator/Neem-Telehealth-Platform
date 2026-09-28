-- D56: a consultation can produce more than one thing. A doctor who prescribes
-- and refers had to choose which of the two to record, and the one they did not
-- choose was simply lost.
--
-- Additive. `outcome` stays exactly as it is, as the primary outcome, so every
-- record written before today and every screen reading that column are
-- untouched.
ALTER TABLE "consultations" ADD COLUMN "outcomes" "ConsultationOutcome"[];

-- What each completed consultation already said, as a list of one. Nothing is
-- invented: a consultation with no outcome recorded keeps none.
UPDATE "consultations" SET "outcomes" = ARRAY["outcome"] WHERE "outcome" IS NOT NULL;
