import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FacilityDaySummary,
  PatientRecord,
  PatientRegistration,
  PatientSummary,
  PatientUpdate,
  TriageCategory,
  TriageCreate,
  VisitConsultation,
  VisitStatus,
} from "@neem/contracts";
import { api } from "@/lib/api-client";

/**
 * CHPS patients, visits and triage (slice 1b, D75). The API scopes all of it
 * to the signed-in CHO's facility; nothing here chooses a facility.
 */

export function useFacilityDay(enabled: boolean) {
  return useQuery({
    queryKey: ["facility", "today"],
    queryFn: ({ signal }) => api.get<FacilityDaySummary>("/facility/today", signal),
    enabled,
    // The board is shared by everyone at the compound; keep it current.
    refetchInterval: 30_000,
  });
}

export interface PatientSearch {
  name?: string;
  phone?: string;
  nhisNumber?: string;
  patientNumber?: string;
}

export function usePatientSearch(search: PatientSearch) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value?.trim()) params.set(key, value.trim());
  }
  const query = params.toString();

  return useQuery({
    queryKey: ["facility", "patients", "search", query],
    queryFn: ({ signal }) => api.get<PatientSummary[]>(`/facility/patients?${query}`, signal),
    enabled: query.length > 0,
  });
}

export function usePatientRecord(patientNumber: string) {
  return useQuery({
    queryKey: ["facility", "patients", patientNumber],
    queryFn: ({ signal }) => api.get<PatientRecord>(`/facility/patients/${patientNumber}`, signal),
  });
}

function useInvalidateFacility() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["facility"] });
}

export function useRegisterPatient() {
  const invalidate = useInvalidateFacility();
  return useMutation({
    mutationFn: (input: PatientRegistration) =>
      api.post<{ patientNumber: string; visitPublicId: string }>("/facility/patients", input),
    onSuccess: invalidate,
  });
}

export function useUpdatePatient(patientNumber: string) {
  const invalidate = useInvalidateFacility();
  return useMutation({
    mutationFn: (input: PatientUpdate) =>
      api.patch<PatientRecord>(`/facility/patients/${patientNumber}`, input),
    onSuccess: invalidate,
  });
}

export function useOpenVisit(patientNumber: string) {
  const invalidate = useInvalidateFacility();
  return useMutation({
    mutationFn: (input: { presentingComplaint: string; clientRequestId: string }) =>
      api.post<{ visitPublicId: string }>(`/facility/patients/${patientNumber}/visits`, input),
    onSuccess: invalidate,
  });
}

export function useRecordTriage(visitPublicId: string) {
  const invalidate = useInvalidateFacility();
  return useMutation({
    mutationFn: (input: TriageCreate) =>
      api.post<{ status: VisitStatus; category: TriageCategory }>(
        `/facility/visits/${visitPublicId}/triage`,
        input,
      ),
    onSuccess: invalidate,
  });
}

export function useEscalateVisit(visitPublicId: string) {
  const invalidate = useInvalidateFacility();
  return useMutation({
    mutationFn: (note: string) =>
      api.post<{ status: VisitStatus }>(`/facility/visits/${visitPublicId}/escalate`, { note }),
    onSuccess: invalidate,
  });
}

export function useCloseVisit(visitPublicId: string) {
  const invalidate = useInvalidateFacility();
  return useMutation({
    mutationFn: (input: { outcome: "CLOSED" | "CANCELLED"; note: string }) =>
      api.post<{ status: VisitStatus }>(`/facility/visits/${visitPublicId}/close`, input),
    onSuccess: invalidate,
  });
}

export function useRequestDoctor(visitPublicId: string) {
  const invalidate = useInvalidateFacility();
  return useMutation({
    mutationFn: (input: { languageCode: string; type: "VIDEO" | "AUDIO"; note?: string }) =>
      api.post<VisitConsultation>(`/facility/visits/${visitPublicId}/consultation`, input),
    onSuccess: invalidate,
  });
}

export function useWithdrawRequest(visitPublicId: string) {
  const invalidate = useInvalidateFacility();
  return useMutation({
    mutationFn: (reason: string) =>
      api.post<VisitConsultation>(`/facility/visits/${visitPublicId}/consultation/cancel`, {
        reason,
      }),
    onSuccess: invalidate,
  });
}

/** States in which no doctor has accepted yet, so the facility may still withdraw. */
export const WAITING_FOR_DOCTOR_STATES = ["WAITING_FOR_DOCTOR", "ASSIGNED", "REASSIGNING"];

export function consultationTone(
  state: string,
): "brand" | "warning" | "danger" | "muted" | "medical" {
  if (WAITING_FOR_DOCTOR_STATES.includes(state)) return "warning";
  if (["DOCTOR_ACCEPTED", "IN_PROGRESS", "COMPLETING"].includes(state)) return "medical";
  if (state === "INTERRUPTED" || state === "EXPIRED") return "danger";
  return "muted";
}

/** "34 y", "7 m", or "34 y (est.)" for an estimated age. */
export function ageLabel(dateOfBirth: string, estimated = false): string {
  const born = new Date(`${dateOfBirth}T00:00:00Z`);
  const now = new Date();
  let months =
    (now.getUTCFullYear() - born.getUTCFullYear()) * 12 + (now.getUTCMonth() - born.getUTCMonth());
  if (now.getUTCDate() < born.getUTCDate()) months -= 1;
  const text = months < 24 ? `${Math.max(months, 0)} m` : `${Math.floor(months / 12)} y`;
  return estimated ? `${text} (est.)` : text;
}

export const SEX_LABEL = { FEMALE: "Female", MALE: "Male", OTHER: "Other" } as const;

/** Triage colours. The one place outside the brand palette, because the categories are colours. */
export const TRIAGE_STYLE: Record<TriageCategory, { badge: string; button: string }> = {
  RED: {
    badge: "bg-red-600 text-white",
    button: "border-red-600 text-red-700 data-[on=true]:bg-red-600 data-[on=true]:text-white",
  },
  ORANGE: {
    badge: "bg-orange-500 text-white",
    button:
      "border-orange-500 text-orange-700 data-[on=true]:bg-orange-500 data-[on=true]:text-white",
  },
  YELLOW: {
    badge: "bg-yellow-400 text-yellow-950",
    button:
      "border-yellow-400 text-yellow-800 data-[on=true]:bg-yellow-400 data-[on=true]:text-yellow-950",
  },
  GREEN: {
    badge: "bg-green-600 text-white",
    button: "border-green-600 text-green-700 data-[on=true]:bg-green-600 data-[on=true]:text-white",
  },
};

export const VISIT_STATUS_TONE: Record<VisitStatus, "brand" | "warning" | "danger" | "muted"> = {
  AWAITING_TRIAGE: "warning",
  TRIAGED: "brand",
  ESCALATED: "danger",
  CLOSED: "muted",
  CANCELLED: "muted",
};
