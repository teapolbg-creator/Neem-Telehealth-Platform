import { describe, expect, it } from 'vitest';
import { demoDataRefusal } from '../../prisma/seed/demo-guard.ts';

/**
 * Demo data is only ever seeded into a database on this machine (D52).
 *
 * The flags that decide demo seeding come from the local `.env`, so a
 * production `DATABASE_URL` with a forgotten `SEED_DEMO_DATA=false` would have
 * put demo accounts with published passwords into the live database. These pin
 * down what "local" means, since that is the whole of the guard.
 */

const LOCAL = 'postgresql://neem:neem@localhost:5433/neem';
const POOLER =
  'postgresql://postgres.abcdefghijklmnop:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true';

describe('demo data guard', () => {
  it('allows the development database from .env.example', () => {
    expect(demoDataRefusal({ DATABASE_URL: LOCAL, DIRECT_DATABASE_URL: LOCAL })).toBeNull();
  });

  it('allows either spelling of loopback', () => {
    expect(demoDataRefusal({ DATABASE_URL: 'postgresql://neem@127.0.0.1:5433/neem' })).toBeNull();
    expect(demoDataRefusal({ DATABASE_URL: 'postgresql://neem@[::1]:5433/neem' })).toBeNull();
  });

  it('refuses the Supabase pooler, and says which variable', () => {
    expect(demoDataRefusal({ DATABASE_URL: POOLER })).toMatch(
      /^DATABASE_URL points at aws-0-eu-central-1\.pooler\.supabase\.com/,
    );
  });

  it('refuses a direct Supabase host', () => {
    expect(
      demoDataRefusal({
        DATABASE_URL: 'postgresql://postgres@db.abcdefghijklmnop.supabase.co:5432/postgres',
      }),
    ).not.toBeNull();
  });

  it('refuses when only one of the two URLs is remote', () => {
    expect(demoDataRefusal({ DATABASE_URL: LOCAL, DIRECT_DATABASE_URL: POOLER })).toMatch(
      /^DIRECT_DATABASE_URL/,
    );
  });

  it('is not fooled by a hostname that only contains "localhost"', () => {
    expect(
      demoDataRefusal({ DATABASE_URL: 'postgresql://neem@localhost.example.com/neem' }),
    ).not.toBeNull();
    expect(demoDataRefusal({ DATABASE_URL: 'postgresql://neem@notlocalhost/neem' })).not.toBeNull();
  });

  it('refuses a URL it cannot read, because it cannot be shown to be local', () => {
    expect(demoDataRefusal({ DATABASE_URL: 'not a url' })).toMatch(/could not be read/);
  });

  it('ignores a variable that is not set', () => {
    expect(demoDataRefusal({ DATABASE_URL: LOCAL, DIRECT_DATABASE_URL: undefined })).toBeNull();
  });
});
