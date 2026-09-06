/**
 * Notification channel abstraction (spec §58, §60, §91).
 *
 * SMTP is the only implemented provider, and no business logic knows
 * that. Two rules are built into the shape of this contract rather than left
 * to the implementations:
 *
 *  1. **A message carries a rendered body and nothing else.** There is no
 *     parameter for a consultation, a prescription, a diagnosis or a patient
 *     record. An adapter is given text that a template already produced, so
 *     there is no way for one to reach back for clinical detail it was not
 *     handed (spec §60).
 *
 *  2. **Sending is never asserted by the caller.** `send()` reports what the
 *     provider said. A provider that accepted a message has accepted it, not
 *     delivered it, and the two are different states in `notifications`.
 */

export type NotificationChannel = 'SMS' | 'EMAIL' | 'WHATSAPP';

export interface SendMessageInput {
  /**
   * Where it goes. A phone number for SMS and WhatsApp, an address for email.
   *
   * Passed in by the dispatcher, which resolved it from the recipient — an
   * adapter never looks a recipient up, so it cannot reach a contact detail
   * nobody intended it to have.
   */
  to: string;
  /** Email only; ignored elsewhere. */
  subject?: string;
  /** Already rendered. An adapter does no substitution of its own. */
  body: string;
  /** Our own notification id, for correlating a provider callback. */
  reference: string;
}

export interface SendMessageResult {
  /** The provider's handle, where it gives one. */
  providerRef?: string;
  /**
   * What the provider said, not what we hope.
   *
   * `ACCEPTED` means it took the message; delivery is a later fact that
   * arrives by callback, if the provider reports one at all.
   */
  status: 'ACCEPTED' | 'FAILED';
  failureReason?: string;
}

export interface NotificationProvider {
  readonly name: string;
  readonly channel: NotificationChannel;
  /** True for adapters that deliver nothing. Surfaced in health checks. */
  readonly isMock: boolean;

  send(input: SendMessageInput): Promise<SendMessageResult>;
}

/**
 * Raised when a message cannot be sent for a reason that will not improve.
 *
 * The retry job treats this as final: a malformed address does not become
 * valid by being tried again in a minute, and retrying it forever would bury
 * the failures that are worth looking at.
 */
export class PermanentDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentDeliveryError';
  }
}
