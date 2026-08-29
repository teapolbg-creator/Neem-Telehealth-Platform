import 'dotenv/config';
import { buildApp } from './app.ts';
import { getEnv } from './config/env.ts';
import { getLogger } from './lib/logger.ts';
import { disconnectPrisma } from './db/prisma.ts';

/**
 * Process entry point.
 *
 * Configuration is validated before anything else, so a misconfigured
 * production deployment fails loudly at boot rather than at the first payment
 * (spec §7).
 */
async function main(): Promise<void> {
  let env;
  try {
    env = getEnv();
  } catch (error) {
    // The logger itself depends on config, so this one goes to stderr.
    console.error(`\nNeem API failed to start.\n\n${(error as Error).message}\n`);
    process.exit(1);
  }

  const log = getLogger();
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await disconnectPrisma();
      process.exit(0);
    } catch (error) {
      log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'unhandled rejection');
    process.exit(1);
  });

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  log.info(
    { port: env.API_PORT, env: env.NODE_ENV },
    `Neem API listening on http://localhost:${env.API_PORT}`,
  );
}

void main();
