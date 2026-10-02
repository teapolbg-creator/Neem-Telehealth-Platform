/**
 * What the patient is told before they type anything about themselves (D60).
 *
 * Counsel's answer to Q9: the fact that a pharmacy starts the consultation does
 * not reduce the patient's rights, the patient-information screen had no
 * lawful-basis notice at all, and health data is special personal data under
 * s.37 of Act 843. Section 27 of that Act lists what the data subject must be
 * made aware of; the eight points below are those, in the order a person reads
 * rather than the order the statute lists them.
 *
 * **It lives here, not in the screen.** Two screens collect patient
 * information — the pharmacy counter and a patient booking from home — and a
 * notice that differed between them would be two different legal positions.
 * The server records which version a patient agreed to, so this file is also
 * the evidence of what they were shown.
 *
 * **The version is bumped whenever the words change.** Consent is to a specific
 * text. If the wording changes and the version does not, the stored evidence
 * says a patient agreed to something they never saw.
 *
 * Deliberately not stated here: how long records are kept. Counsel could not
 * give retention periods without the MDC and Pharmacy Council record-keeping
 * requirements, and answered Q8 by saying the present "permanent" approach
 * needs a specific legal justification. So the notice describes what happens to
 * a record mechanically — sealed, unreadable afterwards, destroyed when its
 * period ends — and claims no period. The sentence naming one goes in when
 * counsel supplies it, with the version bumped.
 */

export const PRIVACY_NOTICE_VERSION = '2026-10-02.1';

export interface PrivacyNoticePoint {
  /** The s.27 matter this answers, for the compliance record. */
  heading: string;
  body: string;
}

export const PRIVACY_NOTICE: readonly PrivacyNoticePoint[] = [
  {
    heading: 'Who holds your information',
    body:
      'Neem holds it, and decides how it is used. The pharmacy you are standing in, if any, ' +
      'helps you start the consultation and does not keep your health information itself.',
  },
  {
    heading: 'Who you are seeing',
    body:
      'A professional registered to practise in Ghana, working remotely. They are not an ' +
      'employee of the pharmacy.',
  },
  {
    heading: 'What we collect',
    body:
      'Your name, age, sex, telephone number and address, what you say is wrong, and whatever ' +
      'the professional records during the consultation. Your address is collected because the ' +
      'law requires it on a prescription.',
  },
  {
    heading: 'Why we collect it',
    body:
      'To provide the consultation, to produce a prescription or referral if you need one, to ' +
      'take payment, and to keep the records that Ghanaian law requires of a professional.',
  },
  {
    heading: 'Whether you have to give it',
    body:
      'Yes, for the consultation to go ahead. A professional cannot assess or prescribe for ' +
      'someone whose name, age and sex they do not know. If you would rather not, say so and no ' +
      'consultation is started.',
  },
  {
    heading: 'Who else sees it',
    body:
      'The professional you consult. The pharmacy, if one dispenses a prescription for you, ' +
      'sees that prescription and nothing else. The companies that carry the video call, the ' +
      'text messages and the payment handle only what they need for that, under contract. ' +
      'Nobody else, and your information is never sold.',
  },
  {
    heading: 'What happens to it afterwards',
    body:
      'Your consultation record is sealed when the consultation ends: no professional and no ' +
      'pharmacy can open it again, at this visit or a future one. It is kept for the period ' +
      'Ghanaian record-keeping law requires of a professional and then destroyed. A prescription ' +
      'is kept as a separate document, because it is a legal record of what you were given.',
  },
  {
    heading: 'Your rights',
    body:
      'You may ask what is held about you, ask for it to be corrected, object to how it is ' +
      'used, and complain to the Data Protection Commission. Ask the pharmacy, or contact Neem, ' +
      'and bring your consultation reference.',
  },
];

/**
 * The consents a patient gives, each recorded as its own row.
 *
 * Separate because they are separate claims, and a patient may later dispute
 * one without disputing the others. `data.processing` is the one counsel's Q9
 * is about: explicit consent to the processing of health information, which
 * counsel recommended as the default operational basis under s.37 of Act 843.
 */
export const CONSENT_PURPOSES = {
  DATA_PROCESSING: 'data.processing',
  REMOTE_CONSULTATION: 'consultation.remote',
  EMERGENCY_GUIDANCE: 'consultation.emergency-guidance',
} as const;

export type ConsentPurpose = (typeof CONSENT_PURPOSES)[keyof typeof CONSENT_PURPOSES];
