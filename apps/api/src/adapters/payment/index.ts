import { getEnv } from '../../config/env.ts';
import type { PaymentProvider } from './payment.provider.ts';
import { MockPaymentProvider } from './mock-payment.provider.ts';

/**
 * Payment provider selection.
 *
 * Business logic asks for `getPaymentProvider()` and never learns which one it
 * got. Swapping Paystack in is a new file here, not a change anywhere else
 * (spec §91).
 */
let provider: PaymentProvider | undefined;

export function getPaymentProvider(): PaymentProvider {
  if (!provider) {
    const env = getEnv();

    switch (env.PAYMENT_PROVIDER) {
      case 'mock':
        provider = new MockPaymentProvider();
        break;
      case 'paystack':
        // Phase 7. Failing loudly beats silently falling back to a mock, which
        // would report payments that never happened (spec §93).
        throw new Error(
          'PAYMENT_PROVIDER=paystack is selected but the Paystack adapter is not implemented yet (Phase 7).',
        );
      default:
        throw new Error(`Unknown PAYMENT_PROVIDER: ${env.PAYMENT_PROVIDER}`);
    }
  }
  return provider;
}

export function setPaymentProviderForTesting(next: PaymentProvider | undefined): void {
  provider = next;
}

export * from './payment.provider.ts';
export { MockPaymentProvider } from './mock-payment.provider.ts';
