import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { decryptField, decryptNullable, encryptField } from '../../lib/crypto.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';

/**
 * Complaints (spec §51, §55).
 *
 * A complaint is opened by a patient marking their feedback as one, and worked
 * by an administrator. Two properties matter more than the workflow itself:
 *
 *  1. **A complaint is never deleted.** It is resolved or dismissed, both of
 *     which require a written outcome. A complaints queue an administrator can
 *     empty by deleting things is not a complaints process.
 *
 *  2. **Working a complaint does not open the clinical record.** What is
 *     available is what the patient wrote, the consultation's operational
 *     context, and the doctor involved. A complaint that genuinely needs the
 *     clinical record goes through archived retrieval (D27), where it is
 *     logged as an access — deliberately a separate, audited act rather than a
 *     side effect of opening a complaint.
 */

export interface ComplaintListItem {
  publicId: string;
  state: string;
  description: string;
  categoryCode: string;
  categoryLabel: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  consultationReference: string | null;
  pharmacyName: string | null;
  doctorName: string | null;
  /** The ratings that came with it, where feedback was the source. */
  doctorRating: number | null;
  neemRating: number | null;
}

export async function listComplaints(
  filter: { openOnly?: boolean; limit?: number },
  db: Db = getPrisma(),
): Promise<ComplaintListItem[]> {
  const complaints = await db.complaint.findMany({
    where: filter.openOnly ? { state: { in: ['OPEN', 'UNDER_REVIEW'] } } : {},
    include: {
      category: { select: { code: true, label: true } },
      feedback: { select: { doctorRating: true, neemRating: true } },
      consultation: {
        select: {
          publicId: true,
          pharmacy: { select: { name: true } },
          doctor: { select: { fullName: true } },
        },
      },
    },
    orderBy: [{ state: 'asc' }, { createdAt: 'asc' }],
    take: filter.limit ?? 100,
  });

  return complaints.map((complaint) => ({
    publicId: complaint.publicId,
    state: complaint.state,
    description: decryptField(complaint.descriptionEnc),
    categoryCode: complaint.category.code,
    categoryLabel: complaint.category.label,
    createdAt: complaint.createdAt.toISOString(),
    resolvedAt: complaint.resolvedAt?.toISOString() ?? null,
    resolutionNote: decryptNullable(complaint.resolutionNoteEnc),
    consultationReference: complaint.consultation?.publicId ?? null,
    pharmacyName: complaint.consultation?.pharmacy.name ?? null,
    // Named because a complaint about a consultation is usually about the
    // clinician. Their quality score is elsewhere and is not shown to them
    // (spec §24, §52).
    doctorName: complaint.consultation?.doctor?.fullName ?? null,
    doctorRating: complaint.feedback?.doctorRating ?? null,
    neemRating: complaint.feedback?.neemRating ?? null,
  }));
}

/**
 * Moves a complaint along.
 *
 * `RESOLVED` and `DISMISSED` both require a written outcome. A complaint
 * closed with no explanation cannot be answered to the person who raised it,
 * and "dismissed" without a reason is indistinguishable from ignored.
 */
export async function decideComplaint(
  publicId: string,
  adminId: string,
  input: { state: 'UNDER_REVIEW' | 'RESOLVED' | 'DISMISSED'; note?: string },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ publicId: string; state: string }> {
  const complaint = await db.complaint.findUnique({ where: { publicId } });
  if (!complaint) throw errors.notFound('Complaint not found.');

  if (complaint.state === 'RESOLVED' || complaint.state === 'DISMISSED') {
    throw errors.conflict(`This complaint is already ${complaint.state.toLowerCase()}.`);
  }

  const closing = input.state === 'RESOLVED' || input.state === 'DISMISSED';
  if (closing && !input.note?.trim()) {
    throw errors.businessRule(
      'A complaint cannot be closed without saying what was decided and why.',
    );
  }

  const updated = await db.complaint.update({
    where: { id: complaint.id },
    data: {
      state: input.state,
      assignedAdminId: adminId,
      resolutionNoteEnc: input.note?.trim()
        ? encryptField(input.note.trim())
        : complaint.resolutionNoteEnc,
      resolvedAt: closing ? clock.now() : null,
    },
  });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.COMPLAINT_DECIDED,
      actorType: 'ADMIN',
      actorId: adminId,
      entityType: 'complaint',
      entityId: complaint.id,
      // The decision and its category. Not the patient's words, and not
      // anything clinical — an audit log that carried either would be the
      // shadow record spec §61 forbids.
      metadata: { state: input.state, from: complaint.state },
    },
    db,
  );

  return { publicId: updated.publicId, state: updated.state };
}

export interface DoctorQualityRow {
  doctorPublicId: string;
  fullName: string;
  status: string;
  score: number | null;
  /** The weighted components behind the score, for explainability. */
  breakdown: unknown;
  computedAt: string | null;
  /** True when the doctor has too little history for the score to mean much. */
  provisional: boolean;
  consultations90Days: number;
  openComplaints: number;
}

/**
 * The quality board (spec §52).
 *
 * Admin-facing, and only admin-facing. A doctor never sees their own score or
 * the ratings behind it, and no route returns either to a doctor principal —
 * a score a clinician can watch becomes a target they optimise rather than a
 * signal about care.
 *
 * The breakdown travels with the score because a number nobody can explain is
 * one nobody should act on.
 */
export async function qualityBoard(db: Db = getPrisma(), clock: Clock = systemClock) {
  const since = new Date(clock.now().getTime() - 90 * 86_400_000);

  const doctors = await db.doctor.findMany({
    where: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
    select: {
      id: true,
      publicId: true,
      fullName: true,
      status: true,
      qualityScores: { orderBy: { computedAt: 'desc' }, take: 1 },
      _count: { select: { consultations: { where: { createdAt: { gte: since } } } } },
    },
    orderBy: { fullName: 'asc' },
  });

  const openComplaints = await db.complaint.findMany({
    where: { state: { in: ['OPEN', 'UNDER_REVIEW'] }, consultation: { doctorId: { not: null } } },
    select: { consultation: { select: { doctorId: true } } },
  });

  const complaintsByDoctor = new Map<string, number>();
  for (const complaint of openComplaints) {
    const doctorId = complaint.consultation?.doctorId;
    if (!doctorId) continue;
    complaintsByDoctor.set(doctorId, (complaintsByDoctor.get(doctorId) ?? 0) + 1);
  }

  return doctors.map((doctor): DoctorQualityRow => {
    const latest = doctor.qualityScores[0];
    const breakdown = latest?.breakdown as { provisional?: boolean } | undefined;

    return {
      doctorPublicId: doctor.publicId,
      fullName: doctor.fullName,
      status: doctor.status,
      score: latest ? Number(latest.score) : null,
      breakdown: latest?.breakdown ?? null,
      computedAt: latest?.computedAt.toISOString() ?? null,
      // Surfaced rather than hidden: a score computed from three consultations
      // should not be read the same way as one from three hundred.
      provisional: breakdown?.provisional === true,
      consultations90Days: doctor._count.consultations,
      openComplaints: complaintsByDoctor.get(doctor.id) ?? 0,
    };
  });
}
