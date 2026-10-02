import type { Prisma } from '@prisma/client';
import { CONSENT_PURPOSES } from '@neem/contracts';
import {
  encryptField,
  generateConsultationReference,
  hashIp,
  hashToken,
} from '../../lib/crypto.ts';

/**
 * The consultation a patient books for themselves (v2).
 *
 * Its own file because two journeys create one — now, and at a time next week
 * — and each imports the other's module for other reasons. Shared here, it is
 * one definition that neither of them owns.
 */

export interface DirectIntake {
  type: 'AUDIO' | 'VIDEO';
  fullName: string;
  age: number;
  sex: 'MALE' | 'FEMALE' | 'OTHER';
  phone: string;
  /** Required on a prescription by s.103 of Act 857 (D60). */
  address: string;
  reason: string;
  /** The privacy notice the patient agreed to, recorded as evidence (D60). */
  privacyNoticeVersion: string;
}

/**
 * The consultation, the patient's session and their consents (v2).
 *
 * Shared by the two ways a patient books — now, and for a time next week —
 * because the only difference between them is when the professional appears.
 * Everything a consultation needs to exist is identical, and a second copy of
 * it is a second place for the consent records to be forgotten.
 *
 * Runs inside the caller's transaction: a booking with no session is a
 * consultation nobody can reach.
 */
export async function createDirectConsultation(
  tx: Prisma.TransactionClient,
  input: {
    service: { id: string; code: string; priceMinor: number; currency: string };
    accountId: string;
    languageId: string;
    intake: DirectIntake;
    paymentDeadlineAt: Date;
    sessionToken: string;
    sessionExpiresAt: Date;
    now: Date;
    ip?: string;
  },
) {
  const created = await tx.consultation.create({
    data: {
      publicId: generateConsultationReference(),
      channel: 'DIRECT',
      serviceId: input.service.id,
      patientAccountId: input.accountId,
      languageId: input.languageId,
      type: input.intake.type,
      state: 'PENDING_PAYMENT',
      // The price the patient was shown, kept here so a later change to the
      // service cannot rewrite what they were charged.
      priceMinor: input.service.priceMinor,
      netMinor: input.service.priceMinor,
      currency: input.service.currency,
      paymentDeadlineAt: input.paymentDeadlineAt,
    },
  });

  await tx.consultationStateEvent.create({
    data: {
      consultationId: created.id,
      fromState: null,
      toState: 'PENDING_PAYMENT',
      actorType: 'PATIENT',
      accepted: true,
    },
  });

  /*
   * The same row the QR exchange writes, so the patient's screen, the call
   * and the documents all work without knowing which service booked it.
   */
  await tx.patientSession.create({
    data: {
      consultationId: created.id,
      fullNameEnc: encryptField(input.intake.fullName),
      age: input.intake.age,
      sex: input.intake.sex,
      phoneEnc: encryptField(input.intake.phone),
      // Required on a prescription by s.103 of Act 857 (D60).
      addressEnc: encryptField(input.intake.address),
      reasonEnc: encryptField(input.intake.reason),
      deviceSessionTokenHash: hashToken(input.sessionToken),
      deviceBoundAt: input.now,
      expiresAt: input.sessionExpiresAt,
    },
  });

  /*
   * What they agreed to, recorded rather than assumed. Two separate records
   * because they are two separate claims: that they accepted a remote
   * consultation, and that they were told what to do in an emergency.
   */
  for (const purpose of [
    CONSENT_PURPOSES.REMOTE_CONSULTATION,
    CONSENT_PURPOSES.EMERGENCY_GUIDANCE,
    // Explicit consent to the processing of health information (D60). The
    // counter records the same purpose from its own screen.
    CONSENT_PURPOSES.DATA_PROCESSING,
  ]) {
    await tx.consent.create({
      data: {
        consultationId: created.id,
        purpose,
        granted: true,
        grantedAt: input.now,
        evidence: {
          channel: 'DIRECT',
          ipHash: hashIp(input.ip),
          // Which text they agreed to, so the evidence names it rather than
          // implying whatever the notice says today.
          noticeVersion: input.intake.privacyNoticeVersion,
        },
      },
    });
  }

  return created;
}
