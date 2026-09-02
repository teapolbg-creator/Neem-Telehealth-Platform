import { getEnv } from '../../config/env.ts';
import type { PaymentProvider } from './payment.provider.ts';
import { MockPaymentProvider } from './mock-payment.provider.ts';
import { PaystackPaymentProvider } from './paystack-payment.provider.ts';

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
        provider = new PaystackPaymentProvider();
        break;
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
export { PaystackPaymentProvider } from './paystack-payment.provider.ts';
