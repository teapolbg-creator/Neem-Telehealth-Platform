import { describe, expect, it } from 'vitest';
import {
  addressFor,
  smtpTransportOptions,
} from '../../src/adapters/notification/smtp-notification.provider.ts';

/**
 * Where an email goes (spec §58, §93).
 *
 * `EMAIL_PROVIDER=mailhog` promises a local catcher. It used to deliver to
 * SMTP_HOST instead, so a development `.env` that also held a real mailbox's
 * credentials sent a real email during testing while every line of its
 * configuration said otherwise. These pin the promise to the code.
 */

/** A development `.env` of exactly the kind that caused it. */
const DEV_ENV_WITH_REAL_MAILBOX = {
  SMTP_HOST: 'mail.privateemail.com',
  SMTP_PORT: 465,
  SMTP_USER: 'hello@neemtelehealth.com',
  SMTP_PASSWORD: 'a-real-mailbox-password',
  MAILHOG_HOST: 'localhost',
  MAILHOG_SMTP_PORT: 1025,
};

describe('mailhog mode', () => {
  it('delivers to the local catcher, whatever SMTP_HOST says', () => {
    const options = smtpTransportOptions('mailhog', DEV_ENV_WITH_REAL_MAILBOX);

    expect(options.host).toBe('localhost');
    expect(options.port).toBe(1025);
  });

  it('never presents the real mailbox credentials', () => {
    const options = smtpTransportOptions('mailhog', DEV_ENV_WITH_REAL_MAILBOX);

    expect(options).not.toHaveProperty('auth');
    expect(JSON.stringify(options)).not.toContain('a-real-mailbox-password');
  });

  it('follows MAILHOG_HOST when the catcher runs elsewhere, as it does in a container', () => {
    const options = smtpTransportOptions('mailhog', {
      ...DEV_ENV_WITH_REAL_MAILBOX,
      MAILHOG_HOST: 'mailhog',
    });

    expect(options.host).toBe('mailhog');
  });
});

describe('smtp mode', () => {
  it('uses the configured relay and its credentials', () => {
    const options = smtpTransportOptions('smtp', DEV_ENV_WITH_REAL_MAILBOX);

    expect(options.host).toBe('mail.privateemail.com');
    expect(options.secure).toBe(true);
    expect(options).toHaveProperty('auth.user', 'hello@neemtelehealth.com');
  });

  it('negotiates STARTTLS rather than implicit TLS off port 465', () => {
    const options = smtpTransportOptions('smtp', { ...DEV_ENV_WITH_REAL_MAILBOX, SMTP_PORT: 587 });

    expect(options.secure).toBe(false);
  });
});

describe('staging email', () => {
  it('goes to the one internal inbox, and says who it was for', () => {
    const addressed = addressFor(
      { to: 'real.doctor@hospital.example', subject: 'A consultation is waiting' },
      'staging-inbox@neem.example',
    );

    expect(addressed.to).toBe('staging-inbox@neem.example');
    expect(addressed.subject).toBe(
      '[staging → real.doctor@hospital.example] A consultation is waiting',
    );
  });

  it('is left alone anywhere the redirect is not set', () => {
    expect(addressFor({ to: 'someone@example.test', subject: 'Hello' }, undefined)).toEqual({
      to: 'someone@example.test',
      subject: 'Hello',
    });
  });
});
