import type { PrismaClient } from '@prisma/client';
import { fixedClock } from '../../src/lib/clock.ts';
import {
  MockPaymentProvider,
  getPaymentProvider,
  setPaymentProviderForTesting,
} from '../../src/adapters/payment/index.ts';
import { createConsultation, transition } from '../../src/modules/consultation/consultation.service.ts';
import { initiatePayment, verifyAndSettle } from '../../src/modules/payment/payment.service.ts';
import { issueAccessToken, exchangeAccessToken } from '../../src/modules/consultation/access-token.service.ts';
import {
  captureIdentity,
  selectLanguage,
  selectModeAndEnterQueue,
  submitFeedback,
} from '../../src/modules/consultation/patient-session.service.ts';
import { recordVitals, recordTest, saveClinicalNotes } from '../../src/modules/retention/clinical-record.service.ts';
import { completeConsultation } from '../../src/modules/clinical/clinical.service.ts';
import {
  createDraft,
  dispensePrescription,
  issuePrescription,
  proposeSubstitution,
  revokePrescription,
} from '../../src/modules/prescription/prescription.service.ts';
import { requestRefund } from '../../src/modules/payment/refund.service.ts';
import { issueSummary } from '../../src/modules/documents/document.service.ts';

/**
 * Demo consultations, produced rather than fabricated.
 *
 * The Phase 1 seed created accounts and stopped, with a note explaining why:
 * "seeding a prescription before the prescription engine exists would be
 * fabricating data the system cannot yet produce." The engines now exist, so
 * this drives them — `createConsultation`, `initiatePayment`,
 * `exchangeAccessToken`, `acceptOffer`, `completeConsultation` — instead of
 * inserting rows.
 *
 * That distinction is the whole point. Driving the services produces the state
 * events, audit entries, revenue allocations, sealed records and retention
 * jobs that a real consultation produces, so the admin analytics, the payout
 * calculation and the audit log all describe something that actually happened.
 * Inserted rows would look right on three screens and be wrong everywhere
 * else — which is exactly the placeholder-data problem Phase 9 removed.
 *
 * **Nothing is left stuck.** Every consultation here reaches a terminal state
 * except the two the demonstration needs live, because a demo database full of
 * consultations that can never end is what Phase 10 spent an afternoon
 * clearing: each one holds a doctor at capacity and a clinical record outside
 * the retention machinery.
 */

/** A stable cast, so the demonstration script can name people. */
const PATIENTS = [
  { fullName: 'Adwoa Mensah', age: 34, sex: 'FEMALE' as const, phone: '0245551001' },
  { fullName: 'Kojo Antwi', age: 51, sex: 'MALE' as const, phone: '0245551002' },
  { fullName: 'Abena Owusu', age: 27, sex: 'FEMALE' as const, phone: '0245551003' },
  { fullName: 'Yaw Darko', age: 43, sex: 'MALE' as const, phone: '0245551004' },
  { fullName: 'Akua Boakye', age: 62, sex: 'FEMALE' as const, phone: '0245551005' },
  { fullName: 'Kofi Asare', age: 19, sex: 'MALE' as const, phone: '0245551006' },
  { fullName: 'Ama Serwaa', age: 38, sex: 'FEMALE' as const, phone: '0245551007' },
  { fullName: 'Kwabena Osei', age: 45, sex: 'MALE' as const, phone: '0245551008' },
];

const PRESCRIPTIONS = [
  {
    medication: 'Amoxicillin',
    strength: '500mg',
    form: 'Capsule',
    dose: '1 capsule',
    frequency: 'Three times daily',
    durationText: '5 days',
    quantity: '15 capsules',
  },
  {
    medication: 'Paracetamol',
    strength: '1g',
    form: 'Tablet',
    dose: '1 tablet',
    frequency: 'Every 6 hours as needed',
    durationText: '3 days',
    quantity: '12 tablets',
  },
  {
    medication: 'Artemether/Lumefantrine',
    strength: '20/120mg',
    form: 'Tablet',
    dose: '4 tablets',
    frequency: 'Twice daily',
    durationText: '3 days',
    quantity: '24 tablets',
  },
];

interface Cast {
  pharmacyId: string;
  pharmacyUserId: string;
  secondPharmacyId: string;
  secondPharmacyUserId: string;
  doctorIds: string[];
  englishId: string;
}

/**
 * One consultation, walked from the counter to wherever it should stop.
 *
 * `stopAt` is the point the story ends. Everything before it runs through the
 * real service, at a timestamp `daysAgo` in the past so the analytics period
 * has a shape rather than a spike.
 */
async function walkConsultation(
  prisma: PrismaClient,
  cast: Cast,
  options: {
    patient: (typeof PATIENTS)[number];
    doctorId: string;
    daysAgo: number;
    stopAt: 'UNPAID' | 'WAITING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
    outcome?: 'PRESCRIPTION' | 'ADVICE_ONLY' | 'REFERRAL';
    prescription?: (typeof PRESCRIPTIONS)[number];
    withVitals?: boolean;
  },
): Promise<{
  consultationId: string;
  publicId: string;
  prescriptionId?: string;
  patientSessionId?: string;
}> {
  const at = new Date(Date.now() - options.daysAgo * 24 * 60 * 60 * 1000);
  const clock = fixedClock(at);

  const consultation = await createConsultation(
    { pharmacyId: cast.pharmacyId },
    { actorId: cast.pharmacyUserId },
    prisma,
    clock,
  );

  if (options.stopAt === 'UNPAID') {
    return { consultationId: consultation.id, publicId: consultation.publicId };
  }

  // --- payment, through the provider ---------------------------------------
  const initiated = await initiatePayment(
    consultation.publicId,
    { pharmacyId: cast.pharmacyId, payerPhone: options.patient.phone },
    { actorId: cast.pharmacyUserId },
    prisma,
    clock,
  );

  const provider = getPaymentProvider();
  if (provider instanceof MockPaymentProvider) {
    provider.settle(initiated.providerReference, 'SUCCESS');
  }
  await verifyAndSettle(
    initiated.providerReference,
    { actorType: 'PHARMACY', actorId: cast.pharmacyUserId },
    prisma,
    clock,
  );

  if (options.stopAt === 'CANCELLED') {
    await transition(consultation.id, 'CANCELLED', {
      actorType: 'PHARMACY',
      actorId: cast.pharmacyUserId,
      reason: 'The patient could not wait.',
    }, prisma, clock);
    return { consultationId: consultation.id, publicId: consultation.publicId };
  }

  // --- the patient's phone --------------------------------------------------
  const issued = await issueAccessToken(
    consultation.id,
    { issuedByUserId: cast.pharmacyUserId },
    prisma,
    clock,
  );
  await exchangeAccessToken(issued.token, {}, prisma, clock);

  // The grant returns the token, not the row — the id is never handed out. A
  // patient's own requests resolve it from the cookie; a seed reads it back.
  const session = await prisma.patientSession.findUniqueOrThrow({
    where: { consultationId: consultation.id },
    select: { id: true },
  });

  const principal = {
    patientSessionId: session.id,
    consultationId: consultation.id,
    consultationPublicId: consultation.publicId,
    consultationState: 'WAITING_FOR_PATIENT' as const,
  };

  await captureIdentity(principal, options.patient, prisma, clock);
  await selectLanguage(principal, 'en', prisma);
  await selectModeAndEnterQueue(principal, 'VIDEO', prisma, clock);

  if (options.stopAt === 'WAITING') {
    return {
      consultationId: consultation.id,
      publicId: consultation.publicId,
      patientSessionId: session.id,
    };
  }

  // --- the doctor -----------------------------------------------------------
  // Assigned directly rather than through the queue engine: the engine picks
  // by live presence and shift, which a seed has no business simulating, and
  // the demonstration needs a known doctor on a known consultation.
  await prisma.consultation.update({
    where: { id: consultation.id },
    data: { doctorId: options.doctorId },
  });
  for (const state of ['ASSIGNED', 'DOCTOR_ACCEPTED', 'IN_PROGRESS'] as const) {
    await transition(consultation.id, state, { actorType: 'SYSTEM', reason: 'demo seed' }, prisma, clock);
  }

  if (options.withVitals) {
    await recordVitals(
      consultation.id,
      { temperatureC: 38.2, bpSystolic: 128, bpDiastolic: 82, pulseBpm: 92 },
      cast.pharmacyUserId,
      prisma,
      clock,
    );
    await recordTest(
      consultation.id,
      { code: 'MALARIA_RDT', label: 'Malaria RDT', result: 'Positive' },
      cast.pharmacyUserId,
      prisma,
      clock,
    );
  }

  await saveClinicalNotes(
    consultation.id,
    {
      notes: 'Fever and headache for two days. No rash. Eating and drinking normally.',
      diagnosis: 'Uncomplicated malaria, clinically suspected and confirmed by RDT.',
      treatment: 'Artemisinin combination therapy. Advised to return if symptoms worsen.',
    },
    prisma,
    clock,
  );

  /**
   * An advice-only consultation must leave the patient with a summary (D25).
   * The engine refuses to complete without one — which is how this seed found
   * out it was fabricating an outcome the product does not allow.
   */
  if ((options.outcome ?? 'PRESCRIPTION') === 'ADVICE_ONLY') {
    await issueSummary(
      consultation.id,
      options.doctorId,
      {
        presentingComplaint: 'Sore throat and mild fever for three days.',
        assessment: 'Viral upper respiratory infection. No red flags on history.',
        advice: 'Rest, fluids, and paracetamol for discomfort. No antibiotic is needed.',
        safetyNetting: 'Return to the pharmacy or seek care if breathing becomes difficult, if the fever passes three days, or if you cannot swallow fluids.',
      },
      prisma,
      clock,
    );
  }

  let prescriptionId: string | undefined;
  if (options.prescription) {
    const draft = await createDraft(consultation.id, options.doctorId, [options.prescription], prisma, clock);
    const issuedRx = await issuePrescription(draft.id, options.doctorId, prisma, clock);
    prescriptionId = issuedRx.id;
  }

  if (options.stopAt === 'IN_PROGRESS') {
    return {
      consultationId: consultation.id,
      publicId: consultation.publicId,
      prescriptionId,
      patientSessionId: session.id,
    };
  }

  await completeConsultation(
    consultation.id,
    options.doctorId,
    { outcome: options.outcome ?? 'PRESCRIPTION' },
    prisma,
    clock,
  );

  return {
    consultationId: consultation.id,
    publicId: consultation.publicId,
    prescriptionId,
    patientSessionId: session.id,
  };
}

export interface DemoConsultationSummary {
  created: number;
  completed: number;
  prescriptionsIssued: number;
  dispensed: number;
  awaitingSubstitution: number;
  refundRequests: number;
  feedback: number;
  live: number;
}

export async function seedDemoConsultations(
  prisma: PrismaClient,
  cast: Cast,
): Promise<DemoConsultationSummary | null> {
  // Re-running the seed must not double the history. Reference data upserts;
  // a consultation cannot, so this stops rather than duplicating.
  const existing = await prisma.consultation.count({ where: { isDemo: true } });
  if (existing > 0) return null;

  // The demo runs on the mock provider whatever the environment selects, so a
  // seeded payment is settled the same way every time and never reaches a real
  // provider. Restored afterwards.
  const previousProvider = getPaymentProvider();
  setPaymentProviderForTesting(new MockPaymentProvider());

  try {
    const summary: DemoConsultationSummary = {
      created: 0,
      completed: 0,
      prescriptionsIssued: 0,
      dispensed: 0,
      awaitingSubstitution: 0,
      refundRequests: 0,
      feedback: 0,
      live: 0,
    };

    const doctor = (index: number) => cast.doctorIds[index % cast.doctorIds.length]!;

    // --- history: completed consultations across three weeks ---------------
    const completed: Array<{
      consultationId: string;
      prescriptionId?: string;
      patientSessionId?: string;
      doctorId: string;
    }> = [];

    for (let index = 0; index < 12; index += 1) {
      const result = await walkConsultation(prisma, cast, {
        patient: PATIENTS[index % PATIENTS.length]!,
        doctorId: doctor(index),
        daysAgo: 1 + index * 2,
        stopAt: 'COMPLETED',
        outcome: index % 4 === 3 ? 'ADVICE_ONLY' : 'PRESCRIPTION',
        prescription: index % 4 === 3 ? undefined : PRESCRIPTIONS[index % PRESCRIPTIONS.length],
        withVitals: index % 3 === 0,
      });

      summary.created += 1;
      summary.completed += 1;
      if (result.prescriptionId) summary.prescriptionsIssued += 1;

      completed.push({
        consultationId: result.consultationId,
        prescriptionId: result.prescriptionId,
        patientSessionId: result.patientSessionId,
        doctorId: doctor(index),
      });

      /**
       * Feedback, on some of them.
       *
       * Not all: it is skippable in the product, and a demonstration where
       * every patient rated their consultation would misrepresent how much
       * of a doctor's quality score actually rests on data.
       *
       * One is a complaint, because the complaints queue and the quality
       * board are both screens an administrator is shown, and an empty one
       * demonstrates nothing. The complaint carries the patient's own words,
       * which is why that column is encrypted.
       */
      if (result.patientSessionId && index % 3 !== 2) {
        const isComplaint = index === 4;

        await submitFeedback(
          {
            patientSessionId: result.patientSessionId,
            consultationId: result.consultationId,
            consultationPublicId: result.publicId,
            consultationState: 'COMPLETED',
          },
          isComplaint
            ? {
                doctorRating: 2,
                neemRating: 3,
                category: 'COMPLAINT',
                complaintCategoryCode: 'WAIT_TIME',
                comment: 'I waited a long time before the doctor joined.',
              }
            : {
                doctorRating: index % 5 === 0 ? 4 : 5,
                neemRating: 5,
                category: index % 4 === 1 ? 'SUGGESTION' : 'COMPLIMENT',
                comment: index % 4 === 1 ? 'It would help to know how long the wait will be.' : undefined,
              },
          prisma,
        );
        summary.feedback += 1;
      }
    }

    // --- prescriptions in each state a pharmacy actually sees ---------------
    for (const [index, entry] of completed.entries()) {
      if (!entry.prescriptionId) continue;

      if (index < 4) {
        await dispensePrescription(entry.prescriptionId, cast.pharmacyId, cast.pharmacyUserId, prisma);
        summary.dispensed += 1;
      } else if (index === 4) {
        // One awaiting a doctor's decision, so the substitution inbox is not
        // an empty screen in the demonstration.
        const items = await prisma.prescriptionItem.findMany({
          where: { prescriptionId: entry.prescriptionId },
          take: 1,
        });
        if (items[0]) {
          await proposeSubstitution(
            entry.prescriptionId,
            items[0].id,
            cast.pharmacyId,
            cast.pharmacyUserId,
            {
              medication: 'Ampicillin',
              strength: '500mg',
              form: 'Capsule',
              reason: 'Amoxicillin is out of stock; equivalent available.',
            },
            prisma,
          );
          summary.awaitingSubstitution += 1;
        }
      } else if (index === 5) {
        // The doctor who issued it, not any doctor: the service scopes by
        // doctorId and answers 404 otherwise, which is the cross-doctor
        // isolation of §102 refusing a seed that got it wrong.
        await revokePrescription(
          entry.prescriptionId,
          entry.doctorId,
          'Reissued with a corrected dose.',
          prisma,
        );
      }
    }

    // --- money that did not go to plan --------------------------------------
    const cancelled = await walkConsultation(prisma, cast, {
      patient: PATIENTS[2]!,
      doctorId: doctor(0),
      daysAgo: 4,
      stopAt: 'CANCELLED',
    });
    summary.created += 1;

    await requestRefund(
      cancelled.consultationId,
      {
        requestedByType: 'PHARMACY',
        requestedByRef: cast.pharmacyUserId,
        reason: 'No doctor was available and the patient left.',
      },
      prisma,
    );
    summary.refundRequests += 1;

    // --- one unpaid, so the counter has something waiting on payment --------
    await walkConsultation(prisma, cast, {
      patient: PATIENTS[5]!,
      doctorId: doctor(1),
      daysAgo: 0,
      stopAt: 'UNPAID',
    });
    summary.created += 1;
    summary.live += 1;

    /*
     * There is deliberately **no consultation left waiting for a doctor**.
     *
     * One would make the admin queue screen non-empty, which is a real
     * demonstration benefit — and it costs the entire clinical and media test
     * coverage. A doctor cannot decline an offer (spec §30), so the moment any
     * doctor comes online the sweep hands them whatever is queued and commits
     * them to it. A single seeded row was enough to make nine end-to-end tests
     * skip with "the engine offered it to nobody", because the doctor they had
     * just brought online was already holding somebody else's consultation.
     *
     * This is the same contention Phase 10 spent an afternoon clearing out of
     * this database, reintroduced by seeding one row. The demonstration script
     * creates a live consultation in its first three steps anyway, so the
     * queue is populated by the walkthrough rather than by the seed — which is
     * a better demonstration in any case, because the presenter can watch it
     * arrive.
     */

    return summary;
  } finally {
    setPaymentProviderForTesting(previousProvider as never);
  }
}
