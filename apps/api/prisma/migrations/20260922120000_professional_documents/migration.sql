-- v2: what a dietitian and a trainer upload instead of a doctor's documents.
-- Additive only. Postgres 12+ allows ADD VALUE inside a transaction as long as
-- the new values are not used in the same one, and nothing here uses them.
ALTER TYPE "DoctorDocumentType" ADD VALUE 'CV';
ALTER TYPE "DoctorDocumentType" ADD VALUE 'AHPC_LICENCE';
ALTER TYPE "DoctorDocumentType" ADD VALUE 'PORTFOLIO';
