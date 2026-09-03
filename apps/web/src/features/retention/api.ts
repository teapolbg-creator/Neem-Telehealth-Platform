import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * Archived consultation retrieval and retention health (decisions D23, D27).
 *
 * This is the mechanism counsel required in the G7c answer: a clinical record
 * is sealed at completion and reachable through no ordinary product surface,
 * but must remain retrievable for a small set of named purposes, with every
 * access recorded.
 *
 * The retrieval **result is never cached**. It is a one-time read of a sealed
 * record for a stated purpose, not a document to keep in the browser — so the
 * mutation returns it, the screen shows it, and closing the retrieval is the
 * end of it.
 */

export const RETRIEVAL_PURPOSES = [
  "LEGAL_OR_REGULATORY_PROCEEDING",
  "PATIENT_DATA_ACCESS_REQUEST",
  "AUTHORISED_CLINICAL_RECORD_REQUEST",
  "QUALITY_OR_SAFETY_INVESTIGATION",
  "INTERNAL_INVESTIGATION_OR_AUDIT",
] as const;

export type RetrievalPurpose = (typeof RETRIEVAL_PURPOSES)[number];

export const PURPOSE_LABEL: Record<RetrievalPurpose, string> = {
  LEGAL_OR_REGULATORY_PROCEEDING: "Legal or regulatory proceeding",
  PATIENT_DATA_ACCESS_REQUEST: "Patient data access request",
  AUTHORISED_CLINICAL_RECORD_REQUEST: "Authorised clinical record request",
  QUALITY_OR_SAFETY_INVESTIGATION: "Quality or safety investigation",
  INTERNAL_INVESTIGATION_OR_AUDIT: "Internal investigation or audit",
};

export interface ArchivedConsultation {
  consultationPublicId: string;
  sealedAt: string;
  destroyAt: string | null;
  encounter: {
    date: string;
    pharmacyName: string;
    doctorName: string | null;
    type: string | null;
    language: string | null;
    durationSeconds: number | null;
    outcome: string | null;
  };
  patient: {
    fullName: string;
    age: number | null;
    sex: string | null;
    phone: string | null;
  } | null;
  clinical: {
    notes: string | null;
    diagnosis: string | null;
    treatment: string | null;
    vitals: Record<string, unknown> | null;
    tests: Array<{ code: string; label: string; result: string }>;
  };
  accessLogId: string;
}

export interface RetrievalInput {
  consultationPublicId: string;
  purpose: RetrievalPurpose;
  reference: string;
  authorisedByUserPublicId: string;
}

export function useRetrieveArchived() {
  return useMutation({
    mutationFn: (input: RetrievalInput) =>
      api.post<ArchivedConsultation>("/admin/archived-consultations/retrieve", input),
  });
}

export const retrievalsKey = ["admin", "retrievals"] as const;

export interface RetrievalLogEntry {
  id: string;
  consultationPublicId: string;
  actorUserId: string;
  actorRole: string;
  authorisedByUserId: string | null;
  purpose: string;
  reference: string;
  /** What was opened — a scope, never the content. */
  recordsAccessed: string | null;
  accessedAt: string;
  /** Null while the access is still open. */
  accessEndedAt: string | null;
}

export function useRetrievals(consultationPublicId?: string) {
  return useQuery({
    queryKey: [...retrievalsKey, consultationPublicId ?? "all"],
    queryFn: ({ signal }) =>
      api.get<RetrievalLogEntry[]>(
        consultationPublicId
          ? `/admin/archived-consultations/retrievals?consultationPublicId=${encodeURIComponent(consultationPublicId)}`
          : "/admin/archived-consultations/retrievals",
        signal,
      ),
  });
}

/**
 * Closes an open retrieval.
 *
 * Counsel's specification requires the time access *ended*, not only when it
 * began — an access left open indefinitely is not an audited access.
 */
export function useEndRetrieval() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ id: string }>(`/admin/archived-consultations/retrievals/${id}/end`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: retrievalsKey }),
  });
}

// ---------------------------------------------------------------------------
// Retention health
// ---------------------------------------------------------------------------

export interface RetentionHealth {
  overdueDestructions: number;
}

export function useRetentionHealth() {
  return useQuery({
    queryKey: ["admin", "retention", "health"],
    queryFn: ({ signal }) => api.get<RetentionHealth>("/admin/retention/health", signal),
    // A destruction job failing silently is exactly what nobody notices.
    refetchInterval: 60_000,
  });
}
