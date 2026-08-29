import '../src/config/load-dotenv.ts';
import { PrismaClient } from '@prisma/client';
import { getEnv } from '../src/config/env.ts';

/**
 * Clears TOTP enrolment for DEMO administrator accounts.
 *
 * Once an admin enrols, the secret is encrypted at rest and cannot be read
 * back — which is the point. That also means an automated end-to-end run
 * cannot sign in as an already-enrolled admin, because it has no authenticator.
 * This resets the demo admin so the E2E suite can enrol afresh and prove the
 * whole 2FA journey rather than skipping it.
 *
 * Guards, because this weakens an account's security:
 *   - refuses to run when NODE_ENV=production
 *   - only touches users flagged isDemo
 */
async function main(): Promise<void> {
  const env = getEnv();

  if (env.NODE_ENV === 'production') {
    console.error('Refusing to reset two-factor enrolment in production.');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    const demoAdmins = await prisma.user.findMany({
      where: { role: 'ADMIN', isDemo: true },
      select: { id: true, email: true },
    });

    if (demoAdmins.length === 0) {
      console.log('No demo administrator accounts found. Nothing to reset.');
      return;
    }

    const ids = demoAdmins.map((admin) => admin.id);

    await prisma.$transaction([
      prisma.user.updateMany({
        where: { id: { in: ids } },
        data: { twoFactorSecretEnc: null, twoFactorEnabledAt: null },
      }),
      prisma.twoFactorRecoveryCode.deleteMany({ where: { userId: { in: ids } } }),
      // Any live session would outlive the second factor it was granted under.
      prisma.session.updateMany({
        where: { userId: { in: ids }, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'two_factor_reset' },
      }),
    ]);

    for (const admin of demoAdmins) {
      console.log(`Reset two-factor enrolment for ${admin.email}`);
    }
    console.log('\nThese accounts must enrol again on their next sign-in.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
