import '../src/config/load-dotenv.ts';
import { PrismaClient } from '@prisma/client';
import { AUDIT_ACTIONS, recordAudit } from '../src/modules/audit/audit.service.ts';

/**
 * Gives every professional a free membership period, before the fee is switched on.
 *
 *   npm run membership:grant -- --until 2026-10-31 [--dry-run]
 *
 * Membership was dropped (D53) and is being reinstated at GH₵5 per six months
 * (operator's decision, 2026-09-24). Switching it on with nothing else done
 * would suspend, the same evening, every professional whose old membership had
 * lapsed while the fee did not exist — people who did nothing wrong and were
 * told nothing was owed. So they are given cover to a date, free, and the
 * first thing they are asked to pay is a renewal.
 *
 * What it does, and does not do:
 *
 *  - It writes an ACTIVE subscription of **zero** for anyone whose cover ends
 *    before that date. No payment row is created, because no money moved, and
 *    an invented payment would appear in the day's takings.
 *  - It skips anyone already covered beyond the date, so running it twice
 *    changes nothing the second time.
 *  - It touches no account's status. A professional suspended for a lapsed
 *    membership is reinstated by an administrator, deliberately, as any other
 *    suspension is.
 *  - It does not switch the fee on. That is a setting, and a separate decision.
 *
 * Every grant is written to the audit log as a grant, so a free period can
 * never be mistaken later for a period somebody paid for.
 */

function parseArgs(argv: string[]): { until: Date; dryRun: boolean } {
  const at = argv.indexOf('--until');
  const raw = at === -1 ? undefined : argv[at + 1];

  // The end of next month, which is what "nobody is blocked overnight" means
  // in practice: this month is nearly over for somebody, always.
  const now = new Date();
  const fallback = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0, 23, 59, 59, 999),
  );

  if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    console.error('Usage: npm run membership:grant -- --until YYYY-MM-DD [--dry-run]');
    process.exit(1);
  }

  const until = raw ? new Date(`${raw}T23:59:59.999Z`) : fallback;

  if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) {
    console.error('The --until date must be a real date in the future.');
    process.exit(1);
  }

  return { until, dryRun: argv.includes('--dry-run') };
}

async function main(): Promise<void> {
  const { until, dryRun } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const professionals = await prisma.doctor.findMany({
      // A rejected application is not somebody Neem has any relationship with.
      where: { status: { not: 'REJECTED' } },
      select: {
        id: true,
        publicId: true,
        fullName: true,
        discipline: true,
        status: true,
        subscriptions: { orderBy: { periodEnd: 'desc' }, take: 1 },
      },
      orderBy: { fullName: 'asc' },
    });

    const now = new Date();
    const needing = professionals.filter((professional) => {
      const current = professional.subscriptions[0];
      return !current || current.periodEnd < until || current.status !== 'ACTIVE';
    });

    console.log(
      `${professionals.length} professionals, ${needing.length} to be given cover until ` +
        `${until.toISOString().slice(0, 10)}${dryRun ? ' (dry run — nothing written)' : ''}.`,
    );

    for (const professional of needing) {
      const current = professional.subscriptions[0];
      console.log(
        `  ${professional.fullName} (${professional.discipline.toLowerCase()}, ` +
          `${professional.status.toLowerCase()}) — ` +
          (current
            ? `cover ends ${current.periodEnd.toISOString().slice(0, 10)}, ${current.status.toLowerCase()}`
            : 'no membership on file'),
      );

      if (dryRun) continue;

      const subscription = await prisma.doctorSubscription.create({
        data: {
          doctorId: professional.id,
          // From today, not from the end of a lapsed period: this is a grant,
          // not a backdated purchase.
          periodStart: now,
          periodEnd: until,
          amountMinor: 0,
          status: 'ACTIVE',
          renewedFromId: current?.id ?? null,
        },
      });

      await recordAudit(
        {
          action: AUDIT_ACTIONS.SUBSCRIPTION_CREATED,
          actorType: 'SYSTEM',
          actorId: null,
          entityType: 'doctor_subscription',
          entityId: subscription.id,
          metadata: {
            doctorId: professional.id,
            granted: true,
            reason: 'free period before the membership fee was reinstated',
            amountMinor: 0,
            periodEnd: until.toISOString(),
          },
        },
        prisma,
      );
    }

    if (!dryRun && needing.length > 0) {
      console.log(
        `\nDone. Nobody is charged until ${until.toISOString().slice(0, 10)}.\n` +
          'Set doctor.membershipFeeMinor to 500 before switching doctor.membershipRequired on.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();
