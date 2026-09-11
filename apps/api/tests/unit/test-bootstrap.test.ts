import { describe, expect, it } from 'vitest';
import { getNotificationProvider } from '../../src/adapters/notification/index.ts';

/**
 * The suite must not be able to reach a real gateway.
 *
 * Two assertions that look redundant and are not, and the difference was found
 * by deleting the pin to see what caught it:
 *
 * - **The provider assertion passed without the pin.** Vitest never loads
 *   `.env` — only `src/server.ts` imports `load-dotenv` — so the variables are
 *   unset and fall through to a schema default that is already `mock`. It
 *   describes the end state and would not notice the pin disappearing.
 * - **The environment assertion is the one that failed.** It is the regression
 *   test.
 *
 * Keeping both is deliberate. The first says what must be true of the code the
 * tests reach; the second says the guarantee is stated rather than inherited
 * from a default nobody promised to keep.
 *
 * The run that can reach a live gateway is the e2e suite, which starts the
 * real server: see the `env` block in `playwright.config.ts`.
 */
describe('the test bootstrap', () => {
  it.each(['SMS', 'EMAIL', 'WHATSAPP'] as const)(
    'resolves a mock %s provider, never a live gateway',
    (channel) => {
      expect(getNotificationProvider(channel).isMock).toBe(true);
    },
  );

  it('keeps the mock pinned even when .env selects a real provider', () => {
    // The point of the pin: `.env` is the thing being defended against, so the
    // assignment in setup.ts must win over whatever a developer has configured.
    expect(process.env.SMS_PROVIDER).toBe('mock');
    expect(process.env.EMAIL_PROVIDER).toBe('mock');
    expect(process.env.WHATSAPP_PROVIDER).toBe('mock');
  });
});
