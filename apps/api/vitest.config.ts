import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Integration tests share one PostgreSQL database and truncate it between
    // cases, so two files running concurrently would wipe each other's
    // fixtures mid-test. `fileParallelism: false` is what actually enforces
    // this — a `poolOptions.threads` setting is ignored under Vitest's default
    // `forks` pool, which is exactly the trap this comment exists to prevent.
    fileParallelism: false,

    // Integration cases build real fixtures — argon2 password hashing is
    // deliberately slow, and a case that creates two doctors plus a full
    // consultation comfortably exceeds the 5s default. Raised so a slow
    // machine reports a real failure rather than a timeout that hides one.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/api',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/**/*.test.ts'],
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@neem/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
});
