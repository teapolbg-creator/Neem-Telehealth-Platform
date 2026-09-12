import '../src/config/load-dotenv.ts';
import { createInterface } from 'node:readline';
import { PrismaClient } from '@prisma/client';
import { emailSchema, passwordSchema } from '@neem/contracts';
import { generatePublicId, hashPassword } from '../src/lib/crypto.ts';
import { AUDIT_ACTIONS, recordAudit } from '../src/modules/audit/audit.service.ts';

/**
 * Creates the first administrator.
 *
 *   npm run admin:create -- --email you@example.com --name "Your Name"
 *
 * This exists because nothing else could. `role: 'ADMIN'` was assigned in
 * exactly two places in the codebase, both inside the demo seed, and demo data
 * is refused in production by two independent guards (spec §76). There is no
 * admin-creation route either — guarded or otherwise. So a freshly deployed
 * production API had reference data, a working database, and nobody who could
 * sign in to configure or monitor any of it.
 *
 * **No two-factor secret is set here, deliberately.** The account is created
 * with `twoFactorEnabledAt` null, which is what forces TOTP enrolment on first
 * sign-in: `login` answers TWO_FACTOR_REQUIRED with `enrollmentRequired`, and
 * `resolveSession` refuses to issue a principal for an unenrolled admin (spec
 * §9). Creating the row is genuinely all that was missing — the operator
 * enrols their own authenticator and this script never holds a secret.
 *
 * **The password is prompted, never passed as an argument.** A command-line
 * password lands in shell history, in `ps` output, and in any CI log that
 * echoes the command. It is read with terminal echo disabled and is not
 * printed back at any point.
 *
 * **It refuses when an administrator already exists**, unless `--additional`
 * is passed. That guard is what keeps a bootstrap tool from becoming a way to
 * mint privileged accounts on a running system; the flag makes the second one
 * a deliberate act rather than an accident.
 */

interface Args {
  email: string;
  name: string;
  title?: string;
  additional: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };

  const email = get('--email');
  const name = get('--name');

  if (!email || !name) {
    console.error(
      'Usage:\n' +
        '  npm run admin:create -- --email you@example.com --name "Your Name" [--title "Role"]\n\n' +
        'The password is prompted for; it is never taken as an argument, because an\n' +
        'argument is recorded in shell history and visible in the process list.',
    );
    process.exit(1);
  }

  return { email, name, title: get('--title'), additional: argv.includes('--additional') };
}

/** Reads a line from the terminal without echoing it. */
async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);

  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  return new Promise((resolve) => {
    let value = '';

    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        // Enter, or EOF when stdin is piped rather than a terminal.
        if (byte === 0x0d || byte === 0x0a || byte === 0x04) {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        // Ctrl-C: leave the terminal as we found it rather than trapping it.
        if (byte === 0x03) {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        // Backspace / delete.
        if (byte === 0x7f || byte === 0x08) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };

    const cleanup = () => {
      process.stdin.off('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    };

    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  /*
   * A terminal, or nothing.
   *
   * Piped input was quietly broken — the whole pipe arrives in one chunk, the
   * first prompt consumed it and discarded the rest, the second prompt then
   * waited on a closed stream, and the process exited 0 having created
   * nothing. A credential tool that reports success by saying nothing is worse
   * than one that refuses.
   *
   * Refusing rather than fixing the piping is the deliberate choice: a
   * password on a pipe is a password in a file, in shell history, or in a CI
   * log, which is the thing prompting for it exists to avoid.
   */
  if (!process.stdin.isTTY) {
    console.error(
      'This needs a terminal, because it prompts for the password.\n\n' +
        'Standard input is not a TTY here — piped or redirected input is refused\n' +
        'rather than read: a password on a pipe is a password in a file or in shell\n' +
        'history. Run it directly in a terminal.',
    );
    process.exit(1);
  }

  const email = emailSchema.safeParse(args.email);
  if (!email.success) {
    console.error(`"${args.email}" is not a usable email address.`);
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    /*
     * Two separate refusals, because they are two different mistakes.
     *
     * An existing administrator means this is no longer a bootstrap, and
     * minting privileged accounts should not be a thing a script does quietly.
     * An existing account on this email means something is already there —
     * possibly a doctor or a pharmacy — and silently upgrading its role would
     * be the worst possible outcome.
     */
    const existingAdmins = await prisma.user.count({ where: { role: 'ADMIN' } });
    if (existingAdmins > 0 && !args.additional) {
      console.error(
        `${existingAdmins} administrator account(s) already exist, so this is not a bootstrap.\n\n` +
          'Pass --additional to create another one deliberately. Creating privileged\n' +
          'accounts is not something this should do by default on a running system.',
      );
      process.exit(1);
    }

    const clash = await prisma.user.findUnique({
      where: { email: email.data },
      select: { role: true },
    });
    if (clash) {
      console.error(
        `An account already exists for ${email.data}, with role ${clash.role}.\n` +
          'This will not change an existing account. Use a different address.',
      );
      process.exit(1);
    }

    const password = await promptHidden(`Password for ${email.data} (not echoed): `);
    const confirmation = await promptHidden('Repeat it: ');

    if (password !== confirmation) {
      console.error('\nThose did not match. Nothing was created.');
      process.exit(1);
    }

    const checked = passwordSchema.safeParse(password);
    if (!checked.success) {
      console.error(`\n${checked.error.issues[0]?.message ?? 'That password is not acceptable.'}`);
      process.exit(1);
    }

    const passwordHash = await hashPassword(checked.data);

    const created = await prisma.user.create({
      data: {
        publicId: generatePublicId('usr'),
        email: email.data,
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
        // Never a demo account: `db:reset-2fa` clears enrolment for isDemo
        // admins, and a real administrator must not be reachable that way.
        isDemo: false,
        // twoFactorEnabledAt stays null — enrolment happens at first sign-in.
        admin: { create: { fullName: args.name, title: args.title ?? null } },
      },
      select: { id: true, publicId: true, email: true },
    });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.ADMIN_CREATED,
        actorType: 'SYSTEM',
        entityType: 'user',
        entityId: created.id,
        // No name, no address: the audit log records that it happened, not who
        // to contact. The metadata sanitiser would drop clinical content; this
        // simply has nothing worth keeping.
        metadata: { via: 'admin:create' },
      },
      prisma,
    );

    console.log(`\n  ✓ administrator created — ${created.email} (${created.publicId})`);
    console.log('');
    console.log('Sign in with that address and password. Two-factor enrolment is not');
    console.log('optional and happens on the first sign-in: the server offers a QR code,');
    console.log('and nothing is committed to the account until a code from your');
    console.log('authenticator proves it works. Keep the recovery codes it gives you —');
    console.log('the secret is encrypted at rest and cannot be read back afterwards.');
  } finally {
    await prisma.$disconnect();
  }
}

await main();
