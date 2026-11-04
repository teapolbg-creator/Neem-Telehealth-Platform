import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readGhanaDistricts } from '../../prisma/seed/reference-data.ts';

/**
 * The hospitals a compound can refer to (D98) are inserted by a migration, and
 * the migration joins on region and district names, so a name that matches
 * nothing would drop a hospital without a word. These tests catch that.
 */
interface Hospital {
  code: string;
  name: string;
  type: string;
  region: string;
  district: string;
  town: string;
}

const { hospitals } = JSON.parse(readFileSync('prisma/seed/data/ghana-hospitals.json', 'utf8')) as {
  hospitals: Hospital[];
};

describe('Ghana referral hospitals (D98)', () => {
  it('are the 189 in the document, with no name twice', () => {
    expect(hospitals).toHaveLength(189);
    expect(new Set(hospitals.map((h) => h.name)).size).toBe(189);
    expect(new Set(hospitals.map((h) => h.code)).size).toBe(189);
  });

  it('are each in a district that exists', () => {
    const districts = readGhanaDistricts();
    const lost = hospitals.filter((h) => !districts[h.region]?.includes(h.district));
    expect(lost).toEqual([]);
  });

  it('are the same in the migration and the data file', () => {
    const sql = readFileSync(
      'prisma/migrations/20261104130000_referral_hospitals/migration.sql',
      'utf8',
    );
    const inserted = [...sql.matchAll(/^ {4}\('(HEFRA-\d+)', '((?:[^']|'')+)'/gm)].map(
      (match) => `${match[1]}|${match[2]!.replace(/''/g, "'")}`,
    );
    expect(inserted).toEqual(hospitals.map((h) => `${h.code}|${h.name}`));
  });
});
