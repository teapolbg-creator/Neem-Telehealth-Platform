import '../src/config/load-dotenv.ts';
import { PrismaClient } from '@prisma/client';

/**
 * Takes the weight-loss clinic out of service, without deleting anything (D69).
 *
 *   npm run withdraw:clinic -- --env .env.production.local            # report
 *   npm run withdraw:clinic -- --env .env.production.local --apply    # do it
 *
 * Read-only unless `--apply` is passed, like every other operational script
 * here. Run the report first: it prints exactly what it would change.
 *
 * **Nothing is deleted.** Three services are deactivated and any dietitian or
 * trainer account is disabled. Both are reversible with a single UPDATE, and
 * both leave every consultation, appointment, payment and clinical record
 * exactly where it was — which matters because `Appointment` and `Consultation`
 * reference `Service`, and because a professional's past work is their record
 * as much as Neem's.
 *
 * It is idempotent. Running it twice reports nothing to do the second time.
 */

const WITHDRAWN_SERVICES = ['WEIGHT_LOSS_DOCTOR', 'WEIGHT_LOSS_DIETITIAN', 'WEIGHT_LOSS_TRAINER'];
const WITHDRAWN_DISCIPLINES = ['DIETITIAN', 'TRAINER'] as const;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

/**
 * A flag's value, or undefined — not `args[0]`.
 *
 * `indexOf` returns -1 for a flag that was not passed, and `args[-1 + 1]` is
 * the first argument, so the naive version silently reads something else.
 */
function flagValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const envFile = flagValue('--env');
  if (envFile) {
    const { config } = await import('dotenv');
    config({ path: envFile, override: true });
  }

  if (!process.env.DATABASE_URL) {
    console.error('No DATABASE_URL. Pass --env <file> naming the environment to act on.');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  // The host and database only — never the credential (D69, and the habit the
  // rest of these scripts keep).
  const url = new URL(process.env.DATABASE_URL);
  console.log(`\n${APPLY ? 'APPLY' : 'REPORT'}   ${url.hostname}${url.pathname}`);
  console.log(APPLY ? 'Mode      WRITING\n' : 'Mode      READ-ONLY — nothing is changed\n');

  const services = await prisma.service.findMany({
    where: { code: { in: WITHDRAWN_SERVICES } },
    select: { code: true, name: true, isActive: true },
    orderBy: { code: 'asc' },
  });

  const professionals = await prisma.doctor.findMany({
    where: { discipline: { in: [...WITHDRAWN_DISCIPLINES] } },
    select: { publicId: true, discipline: true, status: true },
    orderBy: { publicId: 'asc' },
  });

  /*
   * What would be stranded. A consultation against a withdrawn service keeps
   * working — deactivating a service stops it being booked, not being used —
   * but anything still open is a person waiting, and the operator should know
   * before, not after.
   */
  const openConsultations = await prisma.consultation.count({
    where: {
      service: { code: { in: WITHDRAWN_SERVICES } },
      state: {
        notIn: ['COMPLETED', 'EXPIRED', 'CANCELLED', 'ABANDONED', 'REFUNDED', 'PAYMENT_FAILED'],
      },
    },
  });

  const openAppointments = await prisma.appointment.count({
    where: {
      service: { code: { in: WITHDRAWN_SERVICES } },
      state: { in: ['RESERVED', 'CONFIRMED', 'OPENED'] },
    },
  });

  console.log('Services');
  if (services.length === 0) console.log('  (none of the three exist here)');
  for (const service of services) {
    console.log(
      `  ${service.isActive ? 'active  → deactivate' : 'already inactive    '}  ${service.code}`,
    );
  }

  console.log('\nProfessionals');
  if (professionals.length === 0) console.log('  (none)');
  for (const professional of professionals) {
    const already = professional.status === 'DISABLED';
    console.log(
      `  ${already ? 'already disabled    ' : `${professional.status} → DISABLED`}  ${professional.discipline}  ${professional.publicId}`,
    );
  }

  console.log(
    `\nStill open against these services: ${openConsultations} consultation(s), ${openAppointments} appointment(s)`,
  );
  if (openConsultations > 0 || openAppointments > 0) {
    console.log('  These patients need contacting. Deactivating a service does not end them.');
  }

  if (!APPLY) {
    console.log('\nNothing was changed. Re-run with --apply to make these changes.\n');
    await prisma.$disconnect();
    return;
  }

  const deactivated = await prisma.service.updateMany({
    where: { code: { in: WITHDRAWN_SERVICES }, isActive: true },
    data: { isActive: false },
  });

  const disabled = await prisma.doctor.updateMany({
    where: { discipline: { in: [...WITHDRAWN_DISCIPLINES] }, status: { not: 'DISABLED' } },
    data: { status: 'DISABLED' },
  });

  console.log(
    `\nDeactivated ${deactivated.count} service(s), disabled ${disabled.count} professional(s).`,
  );
  console.log('Reverse with: isActive = true on those codes, and the previous status.\n');

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
