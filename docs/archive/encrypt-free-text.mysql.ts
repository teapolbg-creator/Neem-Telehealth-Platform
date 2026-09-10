/**
 * Backfill: encrypt patient-authored free text.
 *
 * Runs between the two migrations that move `feedback.comment`,
 * `complaints.description` and `complaints.resolutionNote` under field
 * encryption. SQL cannot encrypt, so this is the step in the middle.
 *
 *   npx prisma migrate deploy      # phase one adds the *Enc columns
 *   npm run db:backfill:encrypt-free-text
 *   npx prisma migrate deploy      # phase two drops the plaintext columns
 *
 * Idempotent: a row whose encrypted column is already populated is skipped,
 * so running it twice is harmless and running it after a partial failure
 * finishes the job. It reads the plaintext columns with raw SQL because the
 * generated Prisma client no longer knows they exist.
 */
import '../../src/config/load-dotenv.ts';
import { PrismaClient } from '@prisma/client';
import { encryptField } from '../../src/lib/crypto.ts';

interface FeedbackRow {
  id: string;
  comment: string | null;
}

interface ComplaintRow {
  id: string;
  description: string | null;
  resolutionNote: string | null;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const feedback = await prisma.$queryRawUnsafe<FeedbackRow[]>(
      'SELECT id, comment FROM feedback WHERE comment IS NOT NULL AND commentEnc IS NULL',
    );

    for (const row of feedback) {
      await prisma.$executeRawUnsafe(
        'UPDATE feedback SET commentEnc = ? WHERE id = ?',
        encryptField(row.comment!),
        row.id,
      );
    }

    const complaints = await prisma.$queryRawUnsafe<ComplaintRow[]>(
      `SELECT id, description, resolutionNote FROM complaints
       WHERE descriptionEnc IS NULL OR (resolutionNote IS NOT NULL AND resolutionNoteEnc IS NULL)`,
    );

    for (const row of complaints) {
      // A complaint with no description should not exist, but a NULL here
      // would fail phase two's NOT NULL rather than being silently dropped,
      // so it is given a truthful placeholder instead of a guess.
      await prisma.$executeRawUnsafe(
        'UPDATE complaints SET descriptionEnc = ?, resolutionNoteEnc = ? WHERE id = ?',
        encryptField(row.description ?? 'No description was recorded.'),
        row.resolutionNote === null ? null : encryptField(row.resolutionNote),
        row.id,
      );
    }

    // Verify before reporting success. Phase two is destructive, and the only
    // thing standing between it and lost text is this count being zero.
    const [remaining] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT
         (SELECT COUNT(*) FROM feedback WHERE comment IS NOT NULL AND commentEnc IS NULL)
       + (SELECT COUNT(*) FROM complaints WHERE descriptionEnc IS NULL)
       + (SELECT COUNT(*) FROM complaints WHERE resolutionNote IS NOT NULL AND resolutionNoteEnc IS NULL)
       AS n`,
    );

    if (Number(remaining?.n ?? 0) > 0) {
      throw new Error(
        `${remaining!.n} rows still hold un-encrypted free text. Do not run the ` +
          'phase-two migration; investigate first.',
      );
    }

    console.log(
      `backfill complete: ${feedback.length} feedback comments and ` +
        `${complaints.length} complaints encrypted. Safe to apply the ` +
        'phase-two migration.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
