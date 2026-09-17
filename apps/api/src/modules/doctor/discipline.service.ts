import { disciplineMayPrescribe } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';

/**
 * What a professional may issue, asked of the database (v2).
 *
 * The route guards already refuse a dietitian or a trainer the prescribing
 * permissions, and that is the check a request normally meets. This is the
 * second one, and it exists because the first is made of session state: it
 * answers from the `doctors` row itself, so an internal caller, a background
 * job, or a future route that forgets its guard cannot produce a prescription
 * signed by somebody who is not a prescriber.
 *
 * Two checks for one rule is deliberate. A prescription carries a name, and
 * whose name it carries is not a thing to get wrong once.
 */

const ISSUE_LABEL = {
  prescription: 'prescribe',
  referral: 'issue a referral',
} as const;

export async function assertMayIssue(
  doctorId: string,
  document: keyof typeof ISSUE_LABEL,
  db: Db = getPrisma(),
): Promise<void> {
  const professional = await db.doctor.findUnique({
    where: { id: doctorId },
    select: { discipline: true },
  });

  if (!professional) throw errors.notFound('Professional not found.');
  if (disciplineMayPrescribe(professional.discipline)) return;

  throw errors.forbidden(
    `A ${professional.discipline.toLowerCase()} cannot ${ISSUE_LABEL[document]}. ` +
      'Refer the patient to a doctor on the platform instead.',
    { discipline: professional.discipline, document },
  );
}
