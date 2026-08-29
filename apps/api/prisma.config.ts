import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration.
 *
 * The Prisma CLI runs with `apps/api` as its working directory, but the
 * monorepo keeps a single `.env` at the repository root — one file, one place
 * secrets live, no duplication between workspaces. So load it explicitly here
 * before Prisma resolves `env("DATABASE_URL")`.
 *
 * This file also replaces the deprecated `package.json#prisma` block, which
 * Prisma 7 removes.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, '../../.env') });

export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    seed: 'tsx prisma/seed/index.ts',
  },
});
