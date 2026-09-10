import type { PrismaClient } from '@prisma/client';
import type { PilotApplication, PilotApplicantRole, PilotApplicationStatus } from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { generatePublicId } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { notify } from '../notification/notification.service.ts';
import { getLogger } from '../../lib/logger.ts';

/**
 * Pilot expressions of interest (marketing site → Neem).
 *
 * A row here is a lead. It creates no user, holds no password, and grants no
 * capability — which is what makes an unauthenticated write endpoint safe. The
 * worst a flood can do is fill a table an admin can filter, and the rate limit
 * on the route is what keeps that from being tedious.
 *
 * Real onboarding is a separate, heavier path in `doctor.service.ts` and
 * `pharmacy.service.ts`. Nothing here shortcuts it.
 */

export interface SubmitContext {
  ip?: string;
  correlationId?: string;
}

/**
 * Records an expression of interest.
 *
 * Resubmission by the same person in the same role **updates** their row
 * rather than adding a second one. People submit twice — they mistype an
 * email, or the page looks like it did nothing on a slow connection — and two
 * rows means somebody gets called twice, or the newer details are missed
 * because the older row was the one that got worked.
 *
 * A row that an admin has already resolved is not silently dragged back to
 * NEW; the status is preserved and the note records that they wrote in again,
 * so a DECLINED applicant reappearing is visible rather than quietly reset.
 */
export async function submitPilotApplication(
  input: PilotApplication,
  context: SubmitContext,
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ reference: string }> {
  const now = clock.now();

  const existing = await db.pilotApplication.findUnique({
    where: { email_role: { email: input.email, role: input.role } },
    select: { id: true, publicId: true, status: true },
  });

  const fields = {
    fullName: input.fullName,
    phone: input.phone,
    specialty: input.specialty ?? null,
    yearsOfPractice: input.yearsOfPractice ?? null,
    organisation: input.organisation,
    location: input.location,
    additionalInfo: input.additionalInfo ?? null,
    consentAt: now,
    sourceIp: context.ip ?? null,
  };

  const row = existing
    ? await db.pilotApplication.update({
        where: { id: existing.id },
        data: {
          ...fields,
          // NEW and CONTACTED mean "still being worked", so the newer details
          // simply replace the older ones. A resolved row keeps its status and
          // says why it is being looked at again.
          ...(existing.status === 'NEW' || existing.status === 'CONTACTED'
            ? {}
            : { statusNote: 'Submitted the pilot form again after this was resolved.' }),
        },
      })
    : await db.pilotApplication.create({
        data: {
          publicId: generatePublicId('pil'),
          role: input.role,
          email: input.email,
          status: 'NEW',
          ...fields,
        },
      });

  await recordAudit(
    {
      action: existing
        ? AUDIT_ACTIONS.PILOT_APPLICATION_UPDATED
        : AUDIT_ACTIONS.PILOT_APPLICATION_RECEIVED,
      actorType: 'SYSTEM',
      entityType: 'pilot-application',
      entityId: row.id,
      correlationId: context.correlationId,
      // Deliberately no name, phone or email: the audit log records that a
      // thing happened, not a second copy of the applicant's details.
      metadata: { role: row.role, resubmission: Boolean(existing) },
    },
    db,
  );

  // Telling the team is the whole point of collecting the lead. A failure here
  // must not lose the application that has already been written, so it is
  // logged rather than thrown.
  try {
    await notify(
      {
        templateCode: 'admin.pilot.application-received',
        recipient: { type: 'ADMIN' },
        variables: { role: labelForRole(row.role), reference: row.publicId },
        correlationId: context.correlationId,
      },
      db,
      clock,
    );
  } catch (error) {
    getLogger().error(
      { err: error, reference: row.publicId },
      'pilot application saved but the team notification failed',
    );
  }

  return { reference: row.publicId };
}

function labelForRole(role: PilotApplicantRole): string {
  return role === 'DOCTOR' ? 'doctor' : 'pharmacy';
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface PilotListFilters {
  role?: PilotApplicantRole;
  status?: PilotApplicationStatus;
  search?: string;
  limit: number;
  cursor?: string;
}

export async function listPilotApplications(filters: PilotListFilters, db: Db = getPrisma()) {
  const rows = await db.pilotApplication.findMany({
    where: {
      ...(filters.role ? { role: filters.role } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.search
        ? {
            /*
             * `mode: 'insensitive'` is not decoration.
             *
             * MySQL's default collation matched regardless of case, so this
             * search worked without asking. PostgreSQL compares case-sensitively
             * (decision D43), and without this an administrator typing "korle"
             * finds nothing while "Korle" finds the row — a search that fails by
             * returning an empty list, which reads exactly like "no such
             * doctor".
             */
            OR: [
              { fullName: { contains: filters.search, mode: 'insensitive' } },
              { organisation: { contains: filters.search, mode: 'insensitive' } },
              { location: { contains: filters.search, mode: 'insensitive' } },
              { email: { contains: filters.search, mode: 'insensitive' } },
              { phone: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(filters.cursor ? { publicId: { gt: filters.cursor } } : {}),
    },
    orderBy: { publicId: 'asc' },
    take: filters.limit + 1,
  });

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;

  return {
    items: page.map(summarise),
    nextCursor: hasMore ? page.at(-1)?.publicId : undefined,
    hasMore,
  };
}

/**
 * The list view.
 *
 * `sourceIp` is deliberately absent. It exists to spot a flood, and a list
 * screen is not where anyone needs it.
 */
function summarise(row: {
  publicId: string;
  role: PilotApplicantRole;
  fullName: string;
  phone: string;
  email: string;
  specialty: string | null;
  yearsOfPractice: string | null;
  organisation: string;
  location: string;
  additionalInfo: string | null;
  status: PilotApplicationStatus;
  statusNote: string | null;
  consentAt: Date;
  createdAt: Date;
  reviewedAt: Date | null;
  isDemo: boolean;
}) {
  return {
    publicId: row.publicId,
    role: row.role,
    fullName: row.fullName,
    phone: row.phone,
    email: row.email,
    specialty: row.specialty,
    yearsOfPractice: row.yearsOfPractice,
    organisation: row.organisation,
    location: row.location,
    additionalInfo: row.additionalInfo,
    status: row.status,
    statusNote: row.statusNote,
    consentAt: row.consentAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    isDemo: row.isDemo,
  };
}

export async function getPilotApplication(publicId: string, db: Db = getPrisma()) {
  const row = await db.pilotApplication.findUnique({ where: { publicId } });
  if (!row) throw errors.notFound('That pilot application does not exist.');
  return summarise(row);
}

export async function setPilotApplicationStatus(
  publicId: string,
  input: { status: PilotApplicationStatus; note?: string },
  context: { adminId: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
) {
  const existing = await db.pilotApplication.findUnique({
    where: { publicId },
    select: { id: true, status: true },
  });
  if (!existing) throw errors.notFound('That pilot application does not exist.');

  const row = await db.pilotApplication.update({
    where: { id: existing.id },
    data: {
      status: input.status,
      statusNote: input.note ?? null,
      reviewedAt: clock.now(),
      reviewedByAdmin: context.adminId,
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PILOT_APPLICATION_STATUS_CHANGED,
      actorType: 'ADMIN',
      actorId: context.adminId,
      entityType: 'pilot-application',
      entityId: row.id,
      correlationId: context.correlationId,
      metadata: { from: existing.status, to: row.status },
    },
    db,
  );

  return summarise(row);
}

/**
 * Everything, as CSV.
 *
 * Whoever runs the pilot will want this in a spreadsheet on day one, and the
 * alternative is somebody being given database access to get it.
 */
export async function exportPilotApplications(
  filters: { role?: PilotApplicantRole; status?: PilotApplicationStatus },
  db: Db = getPrisma(),
): Promise<string> {
  const rows = await db.pilotApplication.findMany({
    where: {
      ...(filters.role ? { role: filters.role } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });

  const header = [
    'reference',
    'role',
    'status',
    'full_name',
    'phone',
    'email',
    'specialty',
    'years_of_practice',
    'organisation',
    'location',
    'additional_info',
    'status_note',
    'consented_at',
    'received_at',
  ];

  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.publicId,
        row.role,
        row.status,
        row.fullName,
        row.phone,
        row.email,
        row.specialty ?? '',
        row.yearsOfPractice ?? '',
        row.organisation,
        row.location,
        row.additionalInfo ?? '',
        row.statusNote ?? '',
        row.consentAt.toISOString(),
        row.createdAt.toISOString(),
      ]
        .map(csvCell)
        .join(','),
    );
  }

  return lines.join('\r\n');
}

/**
 * One CSV cell.
 *
 * The leading apostrophe on a cell starting with `=`, `+`, `-` or `@` is not
 * decoration: Excel and Sheets treat those as formulas, so a free-text field
 * is a way to run something on the machine of whoever opens the export. Phone
 * numbers beginning `+233` are exactly the shape that triggers it.
 */
function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}
