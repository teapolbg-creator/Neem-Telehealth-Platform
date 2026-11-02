import type { PrismaClient, TriageCategory } from '@prisma/client';
import { subDays } from 'date-fns';
import { fixedClock } from '../../src/lib/clock.ts';
import { generatePublicId, hashPassword } from '../../src/lib/crypto.ts';
import {
  closeVisit,
  escalateVisit,
  recordTriage,
  registerPatient,
  type StaffContext,
} from '../../src/modules/facility/patient.service.ts';
import { requestConsultation } from '../../src/modules/facility/chps-consultation.service.ts';
import {
  acknowledgeReferral,
  createReferral,
  recordReferralOutcome,
} from '../../src/modules/facility/referral.service.ts';
import { createFollowUp } from '../../src/modules/facility/followup.service.ts';
import { acceptOffer, offerNextDoctor } from '../../src/modules/queue/allocation.service.ts';
import { goOffline, goOnline } from '../../src/modules/queue/presence.service.ts';
import { transition } from '../../src/modules/consultation/consultation.service.ts';
import { saveEncounter } from '../../src/modules/clinical/chps-encounter.service.ts';
import { completeConsultation } from '../../src/modules/clinical/clinical.service.ts';

/**
 * CHPS demo data, for showing the V2 screens (slice 5e, D95).
 *
 * Produced rather than inserted, as `demo-consultations.ts` explains: visits,
 * consultations, referrals and follow-ups are walked through the real services, so
 * every dashboard counts something that happened. Facilities and patients are
 * fictional, marked "(demo)", and no real compound or person is implied.
 *
 * **No triage protocol rules.** Those come only from an approved document (D93), so
 * none are seeded. Readings and notes here illustrate the screens and are not
 * clinical guidance.
 */

const DEMO_REGION = 'Volta';
const FAR_REGION = 'Ashanti';

const PATIENTS: Array<{ fullName: string; sex: 'FEMALE' | 'MALE'; ageYears: number }> = [
  { fullName: 'Abena Konadu', sex: 'FEMALE', ageYears: 34 },
  { fullName: 'Kwame Agbeko', sex: 'MALE', ageYears: 52 },
  { fullName: 'Esi Dzifa', sex: 'FEMALE', ageYears: 27 },
  { fullName: 'Yao Mensah', sex: 'MALE', ageYears: 61 },
  { fullName: 'Akosua Tetteh', sex: 'FEMALE', ageYears: 45 },
  { fullName: 'Kofi Amedzo', sex: 'MALE', ageYears: 8 },
  { fullName: 'Efua Sena', sex: 'FEMALE', ageYears: 19 },
  { fullName: 'Selorm Kpodo', sex: 'MALE', ageYears: 38 },
  { fullName: 'Adzo Fiagbe', sex: 'FEMALE', ageYears: 70 },
  { fullName: 'Edem Gbeho', sex: 'MALE', ageYears: 29 },
  { fullName: 'Mawuli Dotse', sex: 'MALE', ageYears: 44 },
  { fullName: 'Dzidzor Ahiable', sex: 'FEMALE', ageYears: 31 },
];

const SURNAMES = [
  'Konadu',
  'Agbeko',
  'Dzifa',
  'Mensah',
  'Tetteh',
  'Amedzo',
  'Sena',
  'Kpodo',
  'Fiagbe',
  'Gbeho',
  'Dotse',
  'Ahiable',
  'Kumah',
  'Adzaho',
  'Nyamekye',
  'Lartey',
  'Ofori',
];

const COMPLAINTS = [
  'Fever and headache for two days',
  'Cough for a week',
  'Stomach pain since yesterday',
  'Painful joints, worse in the morning',
  'Dizziness when standing',
  'Skin rash on both arms',
  'Follow-up of raised blood pressure',
];

const ADVICE = {
  clinicalAssessment: 'Illustrative demo note: assessment recorded by the remote doctor.',
  treatmentPlan: 'Illustrative demo note: plan for the CHO to carry out at the compound.',
};

export interface ChpsDemoResult {
  visits: number;
  consultationsCompleted: number;
  referrals: number;
  followUps: number;
  accounts: Array<{ role: string; email: string; password: string; note: string }>;
}

export async function seedChpsDemo(
  prisma: PrismaClient,
  options: { password: string; adminUserId: string; doctorIds: string[] },
): Promise<ChpsDemoResult | null> {
  if (await prisma.facility.findUnique({ where: { code: 'DEMO-AKOR' } })) return null;

  const passwordHash = await hashPassword(options.password);
  const volta = await prisma.region.findUniqueOrThrow({
    where: { name: DEMO_REGION },
    include: { districts: { orderBy: { name: 'asc' }, take: 1 } },
  });
  const ashanti = await prisma.region.findUniqueOrThrow({
    where: { name: FAR_REGION },
    include: { districts: { orderBy: { name: 'asc' }, take: 1 } },
  });
  const district = volta.districts[0]!;

  const facility = (
    code: string,
    name: string,
    type: 'CHPS' | 'HEALTH_CENTRE' | 'DISTRICT_HOSPITAL',
    districtId: string,
  ) =>
    prisma.facility.create({
      data: {
        publicId: generatePublicId('fac'),
        code,
        name,
        type,
        districtId,
        community: name.replace(/ (CHPS|Health Centre|District Hospital) \(demo\)$/, ''),
        status: 'ACTIVE',
        equipmentStatus: type === 'CHPS' ? 'OPERATIONAL' : 'NOT_INSTALLED',
        createdByUserId: options.adminUserId,
        isDemo: true,
      },
    });

  const akorley = await facility('DEMO-AKOR', 'Akorley CHPS (demo)', 'CHPS', district.id);
  const dzogbe = await facility('DEMO-DZOG', 'Dzogbe CHPS (demo)', 'CHPS', district.id);
  const faraway = await facility(
    'DEMO-NKWA',
    'Nkwanta Ase CHPS (demo)',
    'CHPS',
    ashanti.districts[0]!.id,
  );
  const hospital = await facility(
    'DEMO-HOSP',
    'Demo District Hospital (demo)',
    'DISTRICT_HOSPITAL',
    district.id,
  );
  await facility('DEMO-HLTH', 'Demo Health Centre (demo)', 'HEALTH_CENTRE', district.id);

  const staffMember = async (facilityId: string, email: string, fullName: string) => {
    const user = await prisma.user.create({
      data: {
        publicId: generatePublicId('usr'),
        email,
        passwordHash,
        role: 'FACILITY',
        status: 'ACTIVE',
        isDemo: true,
      },
    });
    await prisma.facilityUser.create({
      data: { facilityId, userId: user.id, fullName, title: 'Community Health Officer' },
    });
    return { userId: user.id, facilityId } satisfies StaffContext;
  };

  const staff = [
    await staffMember(akorley.id, 'cho@chps.demo', 'Afi Dogbe'),
    await staffMember(dzogbe.id, 'cho2@chps.demo', 'Senyo Klutse'),
    await staffMember(faraway.id, 'cho3@chps.demo', 'Yaa Boateng'),
  ];

  const officer = await prisma.user.create({
    data: {
      publicId: generatePublicId('usr'),
      email: 'district@officer.demo',
      passwordHash,
      role: 'DISTRICT',
      status: 'ACTIVE',
      isDemo: true,
    },
  });
  await prisma.districtOfficer.create({
    data: {
      userId: officer.id,
      fullName: 'Demo District Officer',
      title: 'District health officer (demo)',
      scopeLevel: 'DISTRICT',
      regionId: volta.id,
      districtId: district.id,
      createdByUserId: options.adminUserId,
    },
  });
  const operations = await prisma.user.create({
    data: {
      publicId: generatePublicId('usr'),
      email: 'operations@neem.demo',
      passwordHash,
      role: 'OPS_ADMIN',
      status: 'ACTIVE',
      isDemo: true,
    },
  });
  await prisma.admin.create({
    data: { userId: operations.id, fullName: 'Demo Operations', title: 'Operations (demo)' },
  });

  // ---- doctors on the days the history falls on ---------------------------
  const now = new Date();
  const morning = await prisma.shiftDefinition.findUniqueOrThrow({ where: { code: 'MORNING' } });
  const doctorUserIds = new Map(
    (
      await prisma.doctor.findMany({
        where: { id: { in: options.doctorIds } },
        select: { id: true, userId: true },
      })
    ).map((doctor) => [doctor.id, doctor.userId]),
  );

  const result: ChpsDemoResult = {
    visits: 0,
    consultationsCompleted: 0,
    referrals: 0,
    followUps: 0,
    accounts: [
      {
        role: 'CHO',
        email: 'cho@chps.demo',
        password: options.password,
        note: 'Akorley CHPS (demo): start here to show a walk-in',
      },
      {
        role: 'CHO',
        email: 'cho2@chps.demo',
        password: options.password,
        note: 'Dzogbe CHPS (demo), same district',
      },
      {
        role: 'CHO',
        email: 'cho3@chps.demo',
        password: options.password,
        note: 'Nkwanta Ase CHPS (demo), outside the demo officer’s district',
      },
      {
        role: 'DISTRICT',
        email: 'district@officer.demo',
        password: options.password,
        note: 'Sees Akorley and Dzogbe, in figures only',
      },
      {
        role: 'OPS_ADMIN',
        email: 'operations@neem.demo',
        password: options.password,
        note: 'Must enrol TOTP two-factor on first sign-in',
      },
    ],
  };

  /** One person's visit, through the services, at a time in the past. */
  const walk = async (index: number, daysAgo: number) => {
    const ctx = staff[index % staff.length]!;
    const person = PATIENTS[index % PATIENTS.length]!;
    const at = (minutes: number) => {
      const day = subDays(now, daysAgo);
      return fixedClock(
        new Date(
          Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 9, minutes + index),
        ),
      );
    };

    const registered = await registerPatient(
      ctx,
      {
        // Enough combinations that the month does not repeat anyone.
        fullName: `${person.fullName.split(' ')[0]} ${SURNAMES[(index * 5) % SURNAMES.length]}`,
        sex: person.sex,
        ageYears: person.ageYears,
        community: 'Demo village',
        nhisStatus: 'UNKNOWN',
        presentingComplaint: COMPLAINTS[index % COMPLAINTS.length]!,
        consentGivenBy: 'PATIENT',
      } as Parameters<typeof registerPatient>[1],
      prisma,
      at(0),
    );
    const visit = registered.visitPublicId;
    result.visits += 1;

    const category: TriageCategory =
      index % 15 === 7 ? 'RED' : index % 5 === 0 ? 'ORANGE' : index % 2 === 0 ? 'YELLOW' : 'GREEN';
    await recordTriage(
      ctx,
      visit,
      { category, vitals: { temperatureC: 37, pulseBpm: 80 } },
      prisma,
      at(10),
    );

    if (category === 'RED') {
      await escalateVisit(
        ctx,
        visit,
        'Demo note: called for transport and travelled with the patient.',
        prisma,
        at(12),
      );
      const referral = await createReferral(
        ctx,
        visit,
        {
          destinationFacilityPublicId: hospital.publicId,
          urgency: 'EMERGENCY',
          reason: 'Demo note: needs care the compound cannot give.',
          transport: 'Demo note: ambulance called',
        },
        prisma,
        at(14),
      );
      result.referrals += 1;
      await acknowledgeReferral(
        ctx,
        referral.publicId,
        { via: 'PHONE', contact: 'Demo nurse' },
        prisma,
        at(30),
      );
      await closeVisit(
        ctx,
        visit,
        { outcome: 'REFERRED', note: 'Demo note: sent on.' },
        prisma,
        at(32),
      );
      return;
    }

    // Some are cared for at the compound, with no doctor involved.
    if (index % 6 === 5) {
      await closeVisit(
        ctx,
        visit,
        { outcome: 'CLOSED', note: 'Demo note: treated at the compound.' },
        prisma,
        at(25),
      );
      return;
    }

    const doctorId = options.doctorIds[index % options.doctorIds.length]!;
    const serviceDate = new Date(
      Date.UTC(
        subDays(now, daysAgo).getUTCFullYear(),
        subDays(now, daysAgo).getUTCMonth(),
        subDays(now, daysAgo).getUTCDate(),
      ),
    );
    await prisma.doctorShiftAssignment.upsert({
      where: {
        doctorId_serviceDate_shiftDefinitionId: {
          doctorId,
          shiftDefinitionId: morning.id,
          serviceDate,
        },
      },
      update: { status: 'CONFIRMED' },
      create: {
        doctorId,
        shiftDefinitionId: morning.id,
        serviceDate,
        status: 'CONFIRMED',
        minutesPlanned: 240,
      },
    });
    await requestConsultation(
      ctx,
      visit,
      {
        languageCode: 'en',
        type: index % 4 === 3 ? 'AUDIO' : 'VIDEO',
        priority: index % 5 === 0 ? 'URGENT' : 'ROUTINE',
      },
      prisma,
      at(15),
    );

    // The doctor comes free a few minutes later, so the waits vary as they would.
    // Only this doctor is present, so the queue has one candidate.
    const waited = 16 + (index % 9);
    await goOnline(doctorId, prisma, at(waited));
    const requested = await prisma.consultation.findFirstOrThrow({
      where: { visit: { publicId: visit } },
      select: { id: true },
    });
    await offerNextDoctor(requested.id, prisma, at(waited));
    const consultation = await prisma.consultation.findUniqueOrThrow({
      where: { id: requested.id },
      select: { id: true, publicId: true, doctorId: true },
    });
    if (consultation.doctorId !== doctorId) {
      throw new Error(
        `The demo consultation ${consultation.publicId} was not offered as expected.`,
      );
    }
    const accepted = await acceptOffer(consultation.publicId, doctorId, prisma, at(waited));
    if (!accepted.accepted) throw new Error(accepted.reason ?? 'The demo offer was not accepted.');
    await transition(
      consultation.id,
      'IN_PROGRESS',
      { actorType: 'DOCTOR', actorId: doctorId, reason: 'media_session_joined' },
      prisma,
      at(26),
    );
    await saveEncounter(
      consultation.publicId,
      { doctorId, userId: doctorUserIds.get(doctorId)! },
      {
        content: {
          ...ADVICE,
          presentingComplaint: COMPLAINTS[index % COMPLAINTS.length]!,
        } as never,
      },
      prisma,
      at(32),
    );
    await completeConsultation(
      consultation.id,
      doctorId,
      { outcomes: ['ADVICE_ONLY'] },
      prisma,
      at(38),
    );
    result.consultationsCompleted += 1;
    await goOffline(doctorId, prisma);

    if (index % 7 === 2) {
      const referral = await createReferral(
        ctx,
        visit,
        {
          destinationFacilityPublicId: hospital.publicId,
          urgency: 'URGENT',
          reason: 'Demo note: the doctor asked for a test the compound does not have.',
        },
        prisma,
        at(45),
      );
      result.referrals += 1;
      await acknowledgeReferral(
        ctx,
        referral.publicId,
        { via: 'PHONE', contact: 'Demo nurse' },
        prisma,
        at(60),
      );
      // The most recent stay open, so the register has something waiting for news.
      if (daysAgo > 3) {
        await recordReferralOutcome(
          ctx,
          referral.publicId,
          { outcome: 'ATTENDED', via: 'PHONE', feedback: 'Demo note: seen and sent home.' },
          prisma,
          at(90),
        );
      }
      await closeVisit(
        ctx,
        visit,
        { outcome: 'REFERRED', note: 'Demo note: sent on.' },
        prisma,
        at(62),
      );
      return;
    }

    if (index % 4 === 1) {
      await createFollowUp(
        ctx,
        visit,
        {
          dueDate: subDays(now, daysAgo - 7)
            .toISOString()
            .slice(0, 10),
          instructions: 'Demo note: come back to the compound for review.',
        },
        prisma,
        at(40),
      );
      result.followUps += 1;
    }

    await closeVisit(
      ctx,
      visit,
      { outcome: 'CLOSED', note: 'Demo note: advice given.' },
      prisma,
      at(42),
    );
  };

  // A month, thinner at the weekends a compound is quieter on.
  let index = 0;
  for (let daysAgo = 28; daysAgo >= 1; daysAgo -= 1) {
    const perDay = daysAgo % 7 < 2 ? 1 : 2;
    for (let i = 0; i < perDay; i += 1) {
      await walk(index, daysAgo);
      index += 1;
    }
  }

  // Today's board: people the presenter can pick up live. Nobody is left in the
  // doctors' queue, where the sweep would expire them before the meeting.
  const open = await registerPatient(
    staff[0]!,
    {
      fullName: 'Mansa Ahiaku',
      sex: 'FEMALE',
      ageYears: 41,
      community: 'Demo village',
      nhisStatus: 'UNKNOWN',
      presentingComplaint: 'Fever and body aches since last night',
      consentGivenBy: 'PATIENT',
    } as Parameters<typeof registerPatient>[1],
    prisma,
  );
  await recordTriage(
    staff[0]!,
    open.visitPublicId,
    { category: 'YELLOW', vitals: { temperatureC: 38, pulseBpm: 92 } },
    prisma,
  );
  await registerPatient(
    staff[0]!,
    {
      fullName: 'Fiifi Agbenu',
      sex: 'MALE',
      ageYears: 23,
      community: 'Demo village',
      nhisStatus: 'UNKNOWN',
      presentingComplaint: 'Cut on the left hand',
      consentGivenBy: 'PATIENT',
    } as Parameters<typeof registerPatient>[1],
    prisma,
  );
  result.visits += 2;

  return result;
}
