import type { FastifyInstance } from 'fastify';
import { doctorRegistrationSchema, pharmacyRegistrationSchema } from '@neem/contracts';
import { getEnv } from '../../config/env.ts';
import { getPrisma } from '../../db/prisma.ts';
import { requestContext } from '../../middleware/context.ts';
import { registerPharmacy } from '../pharmacy/pharmacy.service.ts';
import { registerDoctor } from '../doctor/doctor.service.ts';

/**
 * Public onboarding routes (spec §20, §21).
 *
 * Unauthenticated by design — this is how a pharmacy or doctor applies. Both
 * create accounts in a PENDING state that can do nothing until an admin
 * approves them, so an open endpoint grants no capability.
 *
 * Rate-limited more tightly than the global default, since account creation is
 * the classic target for automated abuse.
 */

/**
 * Account creation is a classic target for automated abuse, so it is limited
 * more tightly than the global default. Configurable rather than hard-coded,
 * for the same reason as the auth limits.
 */
function registrationLimit() {
  const env = getEnv();
  return { max: env.RATE_LIMIT_ONBOARDING_MAX, timeWindow: env.RATE_LIMIT_ONBOARDING_WINDOW };
}

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  /** Languages a doctor can select during registration. */
  app.get('/onboarding/languages', async (request, reply) => {
    const languages = await getPrisma().language.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, label: true, subtitle: true },
    });

    return reply.send({ data: languages, meta: { requestId: request.correlationId } });
  });

  /** Point-of-care capabilities a pharmacy can declare (spec §50). */
  app.get('/onboarding/capabilities', async (request, reply) => {
    return reply.send({
      data: {
        tests: [
          { code: 'MALARIA_RDT', label: 'Malaria RDT' },
          { code: 'RBS', label: 'Random blood sugar' },
          { code: 'URINE_DIPSTICK', label: 'Urine dipstick' },
          { code: 'PREGNANCY', label: 'Pregnancy test' },
        ],
        equipment: [
          { code: 'BP_MONITOR', label: 'Blood pressure monitor' },
          { code: 'THERMOMETER', label: 'Thermometer' },
          { code: 'PULSE_OXIMETER', label: 'Pulse oximeter' },
          { code: 'WEIGHING_SCALE', label: 'Weighing scale' },
        ],
      },
      meta: { requestId: request.correlationId },
    });
  });

  app.post(
    '/onboarding/pharmacy',
    { config: { rateLimit: registrationLimit() } },
    async (request, reply) => {
      const input = pharmacyRegistrationSchema.parse(request.body);
      const result = await registerPharmacy(input, requestContext(request));

      return reply.status(201).send({
        data: {
          publicId: result.publicId,
          status: result.status,
          message:
            'Application received. A Neem administrator will verify your Pharmacy Council registration before your account is activated.',
        },
        meta: { requestId: request.correlationId },
      });
    },
  );

  app.post(
    '/onboarding/doctor',
    { config: { rateLimit: registrationLimit() } },
    async (request, reply) => {
      const input = doctorRegistrationSchema.parse(request.body);
      const result = await registerDoctor(input, requestContext(request));

      return reply.status(201).send({
        data: {
          publicId: result.publicId,
          status: result.status,
          message:
            'Application received. Sign in to upload your credentials and capture your signature. A Neem administrator will review them before your account is activated.',
        },
        meta: { requestId: request.correlationId },
      });
    },
  );
}
