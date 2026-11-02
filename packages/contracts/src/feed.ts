/**
 * The in-app notification feed (slice 5b, brief §9, D92).
 *
 * Stored as a type, a reference and a time, with no text, because a stored
 * message would be a second copy of the record (D32). What each entry says is
 * fixed here, and any name comes from the live record when the feed is read.
 */

export const FEED_EVENT_LABELS = {
  CONSULTATION_OFFERED: 'New consultation request',
  DOCTOR_ACCEPTED: 'A doctor accepted',
  CONSULTATION_COMPLETED: 'Consultation completed',
  CONSULTATION_INTERRUPTED: 'Call interrupted',
  CONSULTATION_EXPIRED: 'No doctor was available',
  REFERRAL_ISSUED: 'Referral recorded',
  REFERRAL_FEEDBACK: 'Referral news recorded',
  FOLLOW_UP_SET: 'Follow-up set',
  DOCTOR_AVAILABLE: 'Doctor available',
  DOCTOR_BUSY: 'Doctor busy',
  DOCTOR_ON_BREAK: 'Doctor on a break',
} as const;
export type FeedEventType = keyof typeof FEED_EVENT_LABELS;

export interface FeedItem {
  id: string;
  type: FeedEventType;
  label: string;
  /** The patient, the facility or the doctor it concerns, as they stand now. */
  detail: string | null;
  /** Where it leads in this person's own portal, if anywhere. */
  href: string | null;
  occurredAt: string;
}

export interface Feed {
  unread: number;
  items: FeedItem[];
}
