/**
 * Validates the current .env as if it were production, and reports what would
 * refuse to boot.
 *
 * Run before a deploy: `npx tsx scripts/check-production-config.ts`. It reads
 * the same file the API reads and applies the production rules to it, so a
 * development configuration that has been copied to a server is caught here
 * rather than by a crash on start.
 */
import '../src/config/load-dotenv.ts';
import { loadEnv } from '../src/config/env.ts';

try {
  loadEnv({ ...process.env, NODE_ENV: 'production' });
  console.log('This configuration would be accepted in production.');
} catch (error) {
  console.log((error as Error).message);
  process.exitCode = 1;
}
