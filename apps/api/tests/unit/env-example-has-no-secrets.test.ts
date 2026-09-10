import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `.env.example` must never hold a real credential.
 *
 * It is committed, and `.env` is not. That distinction is the whole reason the
 * two files exist — and it is invisible while you are editing, because they sit
 * next to each other, look identical, and differ by one character in the name.
 *
 * This was not hypothetical. A live Whereby API key was pasted into
 * `.env.example` and committed. It never left the machine, because the
 * repository had no remote yet — which is luck, not a control. A key committed
 * to a repository that later gains a remote is a key that has been published,
 * and no amount of deleting it afterwards changes that.
 *
 * So: every credential-shaped variable in this file must be empty, or hold a
 * value that is obviously a placeholder. The check is on shape rather than on a
 * list of names, because the next secret to be added will not be on any list
 * written today.
 */

const ENV_EXAMPLE = join(import.meta.dirname, '..', '..', '..', '..', '.env.example');

/** Variables whose value would be a credential if it were filled in. */
const SECRET_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|SID)$/;

/**
 * Values that are safe to ship because they announce themselves as fake.
 *
 * The development placeholders for the session, CSRF and encryption secrets are
 * deliberately present and deliberately unusable — the config loader refuses to
 * boot production with any of them, which is asserted separately.
 */
const OBVIOUSLY_A_PLACEHOLDER = /^(dev-only-|change-me|your-|xxx|placeholder|<)/i;

/**
 * Credentials that are *supposed* to be filled in here, each for a reason.
 *
 * An allowlist rather than a looser pattern, because the point of the check is
 * that adding a real secret should be uncomfortable. Two named exceptions
 * with stated reasons stays readable; a regex loose enough to admit them would
 * quietly admit the next one too.
 */
const DELIBERATELY_PRESENT = new Map<string, string>([
  [
    'POSTGRES_PASSWORD',
    'must match docker/docker-compose.yml, and reaches only a container on localhost',
  ],
  [
    'DEMO_ADMIN_PASSWORD',
    'the seed prints it and the config loader refuses demo data in production entirely (spec §76)',
  ],
]);

interface Entry {
  key: string;
  value: string;
  line: number;
}

function parse(): Entry[] {
  const entries: Entry[] = [];

  readFileSync(ENV_EXAMPLE, 'utf8')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;

      const eq = line.indexOf('=');
      if (eq === -1) return;

      entries.push({
        key: line.slice(0, eq).trim(),
        value: line
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, ''),
        line: index + 1,
      });
    });

  return entries;
}

describe('.env.example carries no live credential', () => {
  it('leaves every secret-shaped variable empty or obviously fake', () => {
    const filled = parse()
      .filter((entry) => SECRET_PATTERN.test(entry.key))
      .filter((entry) => entry.value.length > 0)
      .filter((entry) => !OBVIOUSLY_A_PLACEHOLDER.test(entry.value))
      .filter((entry) => !DELIBERATELY_PRESENT.has(entry.key))
      // Never the value itself: a test failure is printed, and printing a
      // secret to make the point that it leaked would leak it again.
      .map((entry) => `${entry.key} (line ${entry.line})`);

    expect(
      filled,
      'A credential-shaped variable in .env.example has a real-looking value.\n' +
        'That file is COMMITTED. Move the value to .env, which is not, and\n' +
        'rotate it — a secret that reached a commit must be treated as leaked.',
    ).toEqual([]);
  });

  it('keeps the allowlist honest — every entry still exists and is still filled', () => {
    /**
     * An allowlist that outlives what it excused becomes a hole.
     *
     * If one of these variables is renamed or emptied, its exemption must go
     * with it rather than sitting there ready to excuse a future variable that
     * happens to take the same name.
     */
    const filled = new Set(
      parse()
        .filter((entry) => entry.value.length > 0)
        .map((entry) => entry.key),
    );

    expect([...DELIBERATELY_PRESENT.keys()].filter((key) => !filled.has(key))).toEqual([]);
  });

  it('holds nothing that looks like a JWT', () => {
    /**
     * Shape, not name. The key that was committed was a JWT in
     * `WHEREBY_API_KEY`, which the rule above catches — but a provider that
     * calls its credential something else entirely would slip past a
     * name-based check, and a JWT is unmistakable.
     */
    const jwtish = parse()
      .filter((entry) => /^eyJ[A-Za-z0-9_-]{10,}\./.test(entry.value))
      .map((entry) => `${entry.key} (line ${entry.line})`);

    expect(jwtish, 'A JWT in .env.example. See the note above — rotate it.').toEqual([]);
  });

  it('still documents the variables it is meant to, so emptying is not deletion', () => {
    // A previous fix for this could have been "delete the line", which would
    // pass both checks above and lose the documentation the file exists for.
    const keys = parse().map((entry) => entry.key);

    expect(keys).toContain('WHEREBY_API_KEY');
    expect(keys).toContain('PAYSTACK_SECRET_KEY');
    expect(keys).toContain('SESSION_SECRET');
  });
});
