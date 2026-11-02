#!/usr/bin/env node
/**
 * The presentation build, from one command: `npm run demo` (slice 5e, D95).
 *
 * Starts the databases, brings them up to date, adds the demo data and runs the
 * app with every outside service mocked, whatever `.env` says, so it needs no
 * subscriptions and nothing it does can reach a real phone, payment or video room.
 * It needs the internet only once, the first time, to fetch packages and images.
 *
 * Safe to run again: migrations and demo data that are already there are left alone.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = {
  ...process.env,
  NODE_ENV: 'development',
  DEPLOY_ENV: 'development',
  SEED_DEMO_DATA: 'true',
  PAYMENT_PROVIDER: 'mock',
  VIDEO_PROVIDER: 'mock',
  VOICE_PROVIDER: 'none',
  SMS_PROVIDER: 'mock',
  EMAIL_PROVIDER: 'mock',
  WHATSAPP_PROVIDER: 'mock',
};

function step(title, command, args, cwd = root) {
  console.log(`\n▸ ${title}`);
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`\n✗ ${title} failed. Nothing has been started.`);
    if (command === 'docker' || args.includes('docker:up')) {
      console.error('  Is Docker Desktop running? Start it, then run npm run demo again.');
    }
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(path.join(root, '.env'))) {
  console.log('▸ No .env yet: copying .env.example');
  copyFileSync(path.join(root, '.env.example'), path.join(root, '.env'));
}
if (!existsSync(path.join(root, 'node_modules'))) {
  step('Installing packages (first time only)', 'npm', ['install']);
}

step('Starting the databases', 'npm', ['run', 'docker:up']);
step(
  'Bringing the database up to date',
  'npx',
  ['prisma', 'migrate', 'deploy'],
  path.join(root, 'apps/api'),
);
step('Setting up the audit account', 'npm', ['run', 'db:grants']);
step('Adding the demo data', 'npm', ['run', 'db:seed']);

console.log(`
────────────────────────────────────────────────────────────────────
  Neem, local presentation build

  Open http://localhost:8080 and sign in with an account listed above.
  The consultation station is at http://localhost:8080/station
  Presentation script: docs/presentation-script.md

  Video, SMS, email and payments are simulated, and every screen that
  would use them says so. Press Ctrl+C to stop.
────────────────────────────────────────────────────────────────────
`);

const app = spawn('npm', ['run', 'dev'], { cwd: root, env, stdio: 'inherit', shell: true });
app.on('exit', (code) => process.exit(code ?? 0));
