/**
 * Every notification template in the catalogue is either sent by something, or
 * listed below as knowingly unsent.
 *
 * Found in Phase 11: of 21 templates, 4 had a producer. The other 17 were
 * complete — subject, body, channels, variables, an admin screen to reword them
 * on — and nothing anywhere called `notify()` with their code. An administrator
 * could carefully word a message that would never reach anyone, and nothing in
 * the product said so. All 17 have since been wired, and the register is empty.
 *
 * This test is what keeps it empty. It is not a record of the fix.
 *
 * This is the same shape as the drift test over `docs/api.md` and the public
 * route list in `security.test.ts`: a claim the build re-checks rather than a
 * claim someone made once. The list below is a debt register, not permission.
 * Wiring a producer means deleting its entry, and adding a template without one
 * means writing an entry and a reason — which is a harder thing to do quietly
 * than leaving a gap.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOTIFICATION_TEMPLATES,
  TEMPLATES_WITHOUT_PRODUCER,
} from '../../src/modules/notification/templates.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

async function sourceText(): Promise<string> {
  const chunks: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts')) chunks.push(await readFile(full, 'utf8'));
    }
  }

  await walk(SRC);
  return chunks.join('\n');
}

/** Codes passed to `notify()` anywhere in the application. */
function producedCodes(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/templateCode:\s*'([a-z0-9.-]+)'/g)) {
    found.add(match[1]!);
  }
  return found;
}

describe('notification templates and their producers', () => {
  it('sends every template that is not on the unwired list', async () => {
    const produced = producedCodes(await sourceText());

    const silent = NOTIFICATION_TEMPLATES.map((template) => template.code)
      .filter((code) => !produced.has(code))
      .filter((code) => !TEMPLATES_WITHOUT_PRODUCER.has(code));

    expect(
      silent,
      'These templates have no producer and are not on the unwired list. Either ' +
        'call notify() with the code, or add an entry saying who is not told what.',
    ).toEqual([]);
  });

  it('has no stale entries on the unwired list', async () => {
    const produced = producedCodes(await sourceText());

    const nowWired = [...TEMPLATES_WITHOUT_PRODUCER.keys()].filter((code) => produced.has(code));

    expect(
      nowWired,
      'These are listed as unwired but something now sends them. Delete their ' +
        'entries — a debt register that overstates the debt stops being read.',
    ).toEqual([]);
  });

  it('says, for every unwired template, who is not told what', () => {
    const missing = [...TEMPLATES_WITHOUT_PRODUCER]
      .filter(([, consequence]) => !consequence?.trim())
      .map(([code]) => code);

    expect(
      missing,
      'An entry on the register with no stated consequence. Write who does not ' +
        'learn what, or the register becomes a list nobody can triage.',
    ).toEqual([]);
  });

  it('lists only codes that exist in the catalogue', () => {
    const catalogue = new Set(NOTIFICATION_TEMPLATES.map((template) => template.code));
    const unknown = [...TEMPLATES_WITHOUT_PRODUCER.keys()].filter((code) => !catalogue.has(code));

    expect(unknown, 'The unwired list names templates the catalogue does not have.').toEqual([]);
  });

  it('records how much of the catalogue is actually connected', async () => {
    const produced = producedCodes(await sourceText());
    const codes = NOTIFICATION_TEMPLATES.map((template) => template.code);
    const wired = codes.filter((code) => produced.has(code));

    // Not an assertion about a good number — an assertion that the number is
    // known. It was 4 of 21 when this test was written, and is 21 of 21 now
    // that the seventeen silent templates have producers. The register is
    // empty, so this asserts that every template is accounted for either way.
    expect(wired.length + TEMPLATES_WITHOUT_PRODUCER.size).toBe(codes.length);
  });
});
