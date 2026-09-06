import { describe, expect, it } from 'vitest';
import { toGhanaMsisdn } from '../../src/adapters/notification/ghana-msisdn.ts';

/**
 * The application's number normaliser and the scripts' copy must agree.
 *
 * `scripts/ghana-msisdn.mjs` is a deliberate duplicate: the operational scripts
 * are plain `.mjs` and must run with no build step, so they cannot import the
 * application's TypeScript. A duplicate that drifts is worse than no duplicate
 * — a check would report a number as sendable that the adapter then refuses,
 * or, far worse, the reverse.
 *
 * This is what makes the comment in each file claiming they are kept in step
 * true rather than aspirational.
 */
describe('the scripts’ number normaliser matches the application’s', () => {
  it('agrees on every case, including the ones that must be refused', async () => {
    // @ts-expect-error — a plain .mjs with no declarations, deliberately.
    const script = await import('../../../../scripts/ghana-msisdn.mjs');
    const scriptNormalise = script.toGhanaMsisdn as typeof toGhanaMsisdn;

    const cases = [
      '0244123456',
      '233244123456',
      '+233 24 412 3456',
      '+233-244-123-456',
      '244123456',
      // The one that was a real bug: nine digits with a trunk zero.
      '024412345',
      '02441234567',
      '4412 3456',
      '00233244123456',
      '+44 7700 900123',
      'not-a-number',
      '0244123abc',
      '',
      '   ',
    ];

    for (const value of cases) {
      expect(scriptNormalise(value), `disagreed on ${JSON.stringify(value)}`).toBe(
        toGhanaMsisdn(value),
      );
    }
  });
});
