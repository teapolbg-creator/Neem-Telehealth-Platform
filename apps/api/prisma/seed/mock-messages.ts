/**
 * Seeding sends nothing to anyone (D95).
 *
 * The demo history drives the real services, which notify doctors and carry
 * realistic Ghanaian phone numbers, and the local `.env` may name a real SMS
 * provider. Imported first, because `.env` does not override what is already set.
 * Not in production, where the loader refuses mocks and demo data is refused anyway.
 */
if (process.env.NODE_ENV !== 'production') {
  process.env.SMS_PROVIDER = 'mock';
  process.env.EMAIL_PROVIDER = 'mock';
  process.env.WHATSAPP_PROVIDER = 'mock';
  process.env.VIDEO_PROVIDER = 'mock';
  process.env.PAYMENT_PROVIDER = 'mock';
}

export {};
