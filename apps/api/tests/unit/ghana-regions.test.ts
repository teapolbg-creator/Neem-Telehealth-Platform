import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GHANA_REGIONS, readGhanaDistricts } from '../../prisma/seed/reference-data.ts';

/**
 * The regions are written twice (D73): by the migration, because production
 * runs migrations and not seeds, and by the reference seed, because the test
 * database is truncated and reseeded between suites. This keeps them one list.
 */
describe('Ghana regions', () => {
  it('are the same in the migration and the reference seed', () => {
    const sql = readFileSync(
      'prisma/migrations/20261031120000_chps_facilities/migration.sql',
      'utf8',
    );
    const inserted = [...sql.matchAll(/\(gen_random_uuid\(\)::text, '([^']+)'\)/g)].map(
      (match) => match[1],
    );

    expect(inserted).toEqual([...GHANA_REGIONS]);
  });

  it('are sixteen', () => {
    expect(new Set(GHANA_REGIONS).size).toBe(16);
  });
});

describe('Ghana districts (D74)', () => {
  const districts = readGhanaDistricts();

  it('are the 261 assemblies, in the sixteen regions', () => {
    expect(Object.keys(districts).sort()).toEqual([...GHANA_REGIONS].sort());
    expect(Object.values(districts).flat()).toHaveLength(261);
  });

  it('are the same in the migration and the data file', () => {
    const sql = readFileSync(
      'prisma/migrations/20261031130000_ghana_districts/migration.sql',
      'utf8',
    );
    const inserted = [...sql.matchAll(/^ {4}\('((?:[^']|'')+)', '((?:[^']|'')+)'\)/gm)].map(
      (match) => `${match[1]}|${match[2]!.replace(/''/g, "'")}`,
    );
    const expected = Object.entries(districts).flatMap(([region, names]) =>
      names.map((name) => `${region}|${name}`),
    );

    expect(inserted).toEqual(expected);
  });
});
