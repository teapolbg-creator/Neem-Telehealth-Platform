import type { PrismaClient } from '@prisma/client';
import { hashPassword, generatePublicId, encryptField } from '../../src/lib/crypto.ts';
import { POINT_OF_CARE_TESTS, VITAL_EQUIPMENT } from './reference-data.ts';
import { seedDemoConsultations, type DemoConsultationSummary } from './demo-consultations.ts';

/**
 * Demo data.
 *
 * Every row created here carries `isDemo: true` and a `.demo` email domain, so
 * demo and production data can never be confused (spec §76). The seed refuses
 * to run when NODE_ENV=production, and the config loader independently rejects
 * SEED_DEMO_DATA=true in production.
 *
 * Phase 1 seeded the accounts and organisations needed to demonstrate
 * authentication, RBAC and 2FA, and stopped there on the grounds that
 * "seeding a prescription before the prescription engine exists would be
 * fabricating data the system cannot yet produce".
 *
 * Those engines exist now, so Phase 11 adds the history — in
 * `demo-consultations.ts`, and by **driving the engines** rather than
 * inserting rows. The original reasoning still holds and is the reason that
 * file looks the way it does: data the system did not produce is data that
 * disagrees with the system.
 */

const DEMO_PASSWORD = 'NeemDemo!2026';

export interface DemoSeedResult {
  adminEmail: string;
  accounts: Array<{ role: string; email: string; password: string; note: string }>;
  /** Null when a history already existed and this run left it alone. */
  history: DemoConsultationSummary | null;
}

export async function seedDemoData(
  prisma: PrismaClient,
  options: { adminEmail: string; adminPassword: string },
): Promise<DemoSeedResult> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const adminHash = await hashPassword(options.adminPassword);

  const english = await prisma.language.findUniqueOrThrow({ where: { code: 'en' } });
  const twi = await prisma.language.findUniqueOrThrow({ where: { code: 'tw' } });
  const ga = await prisma.language.findUniqueOrThrow({ where: { code: 'ga' } });

  // --- Admin --------------------------------------------------------------
  // Created WITHOUT twoFactorEnabledAt. The admin must complete TOTP enrolment
  // on first sign-in; there is no way to skip it, because resolveSession()
  // refuses to issue a principal for an unenrolled admin (spec §9).
  const adminUser = await prisma.user.upsert({
    where: { email: options.adminEmail },
    update: {},
    create: {
      publicId: generatePublicId('usr'),
      email: options.adminEmail,
      passwordHash: adminHash,
      role: 'ADMIN',
      status: 'ACTIVE',
      isDemo: true,
      admin: { create: { fullName: 'Neem Demo Administrator', title: 'Platform Administrator' } },
    },
  });

  // --- Pharmacies ---------------------------------------------------------
  const pharmacySpecs = [
    {
      email: 'akosua@pharmacy.demo',
      name: 'Akosua Pharmacy',
      reg: 'PCG-DEMO-00121',
      owner: 'Nana Akosua Danso',
      pharmacist: 'Nana Akosua Danso',
      address: '14 Kojo Thompson Road',
      city: 'Accra',
      region: 'Greater Accra',
      lat: 5.5641,
      lng: -0.2074,
      phone: '+233240000101',
      status: 'ACTIVE' as const,
    },
    {
      email: 'healthfirst@pharmacy.demo',
      name: 'HealthFirst Pharmacy',
      reg: 'PCG-DEMO-00204',
      owner: 'Kwabena Asante',
      pharmacist: 'Adjoa Mensimah',
      address: '7 Boundary Road, East Legon',
      city: 'Accra',
      region: 'Greater Accra',
      lat: 5.6353,
      lng: -0.1613,
      phone: '+233240000102',
      status: 'ACTIVE' as const,
    },
    {
      email: 'kumasi@pharmacy.demo',
      name: 'Kumasi Central Chemist',
      reg: 'PCG-DEMO-00318',
      owner: 'Yaa Serwaa',
      pharmacist: 'Yaa Serwaa',
      address: '22 Prempeh II Street',
      city: 'Kumasi',
      region: 'Ashanti',
      lat: 6.6885,
      lng: -1.6244,
      phone: '+233240000103',
      status: 'ACTIVE' as const,
    },
    {
      // Deliberately left pending so the admin verification queue has real
      // work to demonstrate, and so "only ACTIVE pharmacies may initiate a
      // consultation" (spec §84) is demonstrable rather than theoretical.
      email: 'tamale@pharmacy.demo',
      name: 'Tamale Care Pharmacy',
      reg: 'PCG-DEMO-00422',
      owner: 'Abdul-Rahman Iddrisu',
      pharmacist: 'Fatima Alhassan',
      address: '3 Hospital Road',
      city: 'Tamale',
      region: 'Northern',
      lat: 9.4008,
      lng: -0.8393,
      phone: '+233240000104',
      status: 'PENDING' as const,
    },
  ];

  for (const spec of pharmacySpecs) {
    const existing = await prisma.pharmacy.findUnique({
      where: { councilRegistrationNo: spec.reg },
    });
    if (existing) continue;

    const pharmacy = await prisma.pharmacy.create({
      data: {
        publicId: generatePublicId('phm'),
        name: spec.name,
        councilRegistrationNo: spec.reg,
        ownerName: spec.owner,
        responsiblePharmacistName: spec.pharmacist,
        addressLine1: spec.address,
        city: spec.city,
        region: spec.region,
        latitude: spec.lat,
        longitude: spec.lng,
        phone: spec.phone,
        email: spec.email,
        status: spec.status,
        approvedAt: spec.status === 'ACTIVE' ? new Date() : null,
        isDemo: true,
        hours: {
          create: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
            dayOfWeek,
            opensAt: '08:00',
            closesAt: '20:00',
          })),
        },
        capabilities: {
          create: [
            ...POINT_OF_CARE_TESTS.map((t) => ({
              kind: 'TEST' as const,
              code: t.code,
              label: t.label,
            })),
            ...VITAL_EQUIPMENT.map((e) => ({
              kind: 'EQUIPMENT' as const,
              code: e.code,
              label: e.label,
            })),
          ],
        },
        payoutDetails: {
          create: {
            method: 'MOBILE_MONEY',
            accountNameEnc: encryptField(spec.owner),
            accountNumberEnc: encryptField(spec.phone),
            bankOrNetwork: 'MTN MoMo',
          },
        },
      },
    });

    const user = await prisma.user.create({
      data: {
        publicId: generatePublicId('usr'),
        email: spec.email,
        passwordHash,
        role: 'PHARMACY',
        status: 'ACTIVE',
        isDemo: true,
      },
    });

    await prisma.pharmacyUser.create({
      data: { pharmacyId: pharmacy.id, userId: user.id },
    });
  }

  // --- Doctors ------------------------------------------------------------
  const doctorSpecs = [
    {
      email: 'ama@doctor.demo',
      name: 'Dr. Ama Boateng',
      mdc: 'MDC-DEMO-44291',
      specialty: 'General Practice & Infectious Diseases',
      years: 9,
      status: 'ACTIVE' as const,
      languages: [english.id, twi.id, ga.id],
      employment: 'FULL_TIME' as const,
      contractedHours: 40,
      monthlySalaryMinor: 800_000,
    },
    {
      email: 'kwame@doctor.demo',
      name: 'Dr. Kwame Owusu',
      mdc: 'MDC-DEMO-88291',
      specialty: 'General Practitioner',
      years: 6,
      status: 'ACTIVE' as const,
      languages: [english.id, twi.id],
      employment: 'PART_TIME' as const,
      contractedHours: 20,
      // Part-time compensation is deliberately NOT set — the formula is
      // undecided and must not be invented (spec §26).
      monthlySalaryMinor: null,
    },
    {
      email: 'efua@doctor.demo',
      name: 'Dr. Efua Sackey',
      mdc: 'MDC-DEMO-51772',
      specialty: 'Family Medicine',
      years: 4,
      // Pending, so the admin credential-verification workflow has real work,
      // and so "only ACTIVE doctors receive consultations" is demonstrable.
      status: 'PENDING' as const,
      languages: [english.id, ga.id],
      employment: 'PART_TIME' as const,
      contractedHours: 18,
      monthlySalaryMinor: null,
    },
  ];

  for (const spec of doctorSpecs) {
    const existing = await prisma.doctor.findUnique({ where: { mdcNumber: spec.mdc } });
    if (existing) continue;

    const user = await prisma.user.create({
      data: {
        publicId: generatePublicId('usr'),
        email: spec.email,
        passwordHash,
        role: 'DOCTOR',
        status: 'ACTIVE',
        isDemo: true,
      },
    });

    const licenceExpiry = new Date();
    licenceExpiry.setFullYear(licenceExpiry.getFullYear() + 1);

    const doctor = await prisma.doctor.create({
      data: {
        publicId: generatePublicId('doc'),
        userId: user.id,
        fullName: spec.name,
        mdcNumber: spec.mdc,
        mdcExpiresAt: licenceExpiry,
        yearsExperience: spec.years,
        specialty: spec.specialty,
        status: spec.status,
        approvedAt: spec.status === 'ACTIVE' ? new Date() : null,
        employmentType: spec.employment,
        contractedHoursPerWeek: spec.contractedHours,
        monthlySalaryMinor: spec.monthlySalaryMinor,
        isDemo: true,
        languages: {
          create: spec.languages.map((languageId, index) => ({
            languageId,
            isPrimary: index === 0,
          })),
        },
        presence: { create: { currentLoad: 0, maxLoad: 1 } },
      },
    });

    if (spec.status === 'ACTIVE') {
      // A placeholder signature so prescription generation has something to
      // bind to in Phase 6. Real doctors draw theirs during onboarding
      // (spec §23) — this is demo data, and it is encrypted like the real thing.
      await prisma.doctorSignature.create({
        data: {
          doctorId: doctor.id,
          signatureDataEnc: encryptField(`DEMO-SIGNATURE:${spec.name}`),
        },
      });

      const periodStart = new Date();
      const periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + 6);

      await prisma.doctorSubscription.create({
        data: {
          doctorId: doctor.id,
          periodStart,
          periodEnd,
          amountMinor: 50_000,
          status: 'ACTIVE',
        },
      });
    }
  }

  /**
   * The history, built through the engines.
   *
   * After the accounts, because it needs them: a consultation belongs to a
   * pharmacy and is conducted by a doctor, and both have to be ACTIVE before
   * any of the services will accept one.
   */
  const activePharmacy = await prisma.pharmacy.findFirstOrThrow({
    where: { email: 'akosua@pharmacy.demo' },
    include: { users: { take: 1 } },
  });
  const secondPharmacy = await prisma.pharmacy.findFirstOrThrow({
    where: { email: 'healthfirst@pharmacy.demo' },
    include: { users: { take: 1 } },
  });
  const activeDoctors = await prisma.doctor.findMany({
    where: { status: 'ACTIVE', isDemo: true },
    select: { id: true },
  });
  const history = await seedDemoConsultations(prisma, {
    adminUserId: adminUser.id,
    pharmacyId: activePharmacy.id,
    pharmacyUserId: activePharmacy.users[0]!.userId,
    secondPharmacyId: secondPharmacy.id,
    secondPharmacyUserId: secondPharmacy.users[0]!.userId,
    doctorIds: activeDoctors.map((doctor) => doctor.id),
    englishId: english.id,
  });

  // --- Pilot applications -------------------------------------------------
  //
  // Written directly rather than through the endpoint, because the endpoint is
  // rate-limited and seeding is not a submission. Every row is `isDemo` and
  // carries an `.demo` address, like everything else here.
  //
  // Four rows, not one: the screen's default filter shows what is still
  // waiting, so a seed of only NEW rows would hide the filters and a seed of
  // none would leave a new installation looking broken.
  const pilotApplicants = [
    {
      role: 'DOCTOR' as const,
      fullName: 'Dr. Yaa Boateng',
      phone: '+233201110001',
      email: 'yaa@applicant.demo',
      specialty: 'Family medicine',
      yearsOfPractice: '11',
      organisation: 'Ridge Hospital',
      location: 'Accra',
      additionalInfo: 'Interested in evening sessions during the pilot.',
      status: 'NEW' as const,
      statusNote: null,
    },
    {
      role: 'PHARMACY' as const,
      fullName: 'Kofi Adjei',
      phone: '+233241110002',
      email: 'kofi@applicant.demo',
      specialty: null,
      yearsOfPractice: null,
      organisation: 'Adjei Chemists',
      location: 'Osu, Accra',
      additionalInfo: 'Two branches. We already have a private corner at the counter.',
      status: 'NEW' as const,
      statusNote: null,
    },
    {
      role: 'DOCTOR' as const,
      fullName: 'Dr. Nii Armah',
      phone: '+233551110003',
      email: 'nii@applicant.demo',
      specialty: 'General practice',
      yearsOfPractice: '6',
      organisation: 'Independent',
      location: 'Kumasi',
      additionalInfo: null,
      status: 'CONTACTED' as const,
      statusNote: 'Spoke on the phone; sending onboarding details this week.',
    },
    {
      role: 'PHARMACY' as const,
      fullName: 'Abena Sarpong',
      phone: '+233261110004',
      email: 'abena@applicant.demo',
      specialty: null,
      yearsOfPractice: null,
      organisation: 'Sarpong Pharmacy',
      location: 'Tamale',
      additionalInfo: null,
      status: 'ONBOARDED' as const,
      statusNote: 'Registered and verified.',
    },
  ];

  for (const applicant of pilotApplicants) {
    await prisma.pilotApplication.upsert({
      where: { email_role: { email: applicant.email, role: applicant.role } },
      update: {},
      create: {
        publicId: generatePublicId('pil'),
        ...applicant,
        consentAt: new Date(),
        isDemo: true,
      },
    });
  }

  return {
    adminEmail: options.adminEmail,
    history,
    accounts: [
      {
        role: 'ADMIN',
        email: options.adminEmail,
        password: options.adminPassword,
        note: 'Must enrol TOTP two-factor on first sign-in — it cannot be skipped',
      },
      {
        role: 'PHARMACY',
        email: 'akosua@pharmacy.demo',
        password: DEMO_PASSWORD,
        note: 'ACTIVE — can initiate consultations',
      },
      {
        role: 'PHARMACY',
        email: 'healthfirst@pharmacy.demo',
        password: DEMO_PASSWORD,
        note: 'ACTIVE — second pharmacy, for cross-tenant isolation tests',
      },
      { role: 'PHARMACY', email: 'kumasi@pharmacy.demo', password: DEMO_PASSWORD, note: 'ACTIVE' },
      {
        role: 'PHARMACY',
        email: 'tamale@pharmacy.demo',
        password: DEMO_PASSWORD,
        note: 'PENDING — awaiting admin approval',
      },
      {
        role: 'DOCTOR',
        email: 'ama@doctor.demo',
        password: DEMO_PASSWORD,
        note: 'ACTIVE — English, Twi, Ga',
      },
      {
        role: 'DOCTOR',
        email: 'kwame@doctor.demo',
        password: DEMO_PASSWORD,
        note: 'ACTIVE — English, Twi',
      },
      {
        role: 'DOCTOR',
        email: 'efua@doctor.demo',
        password: DEMO_PASSWORD,
        note: 'PENDING — awaiting credential verification',
      },
    ],
  };
}
