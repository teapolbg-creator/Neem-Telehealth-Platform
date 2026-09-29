import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CallMeResult, ConsultationTimer, MediaSessionView } from "@neem/contracts";
import { api, apiBeacon } from "@/lib/api-client";

/**
 * Media and timer queries (spec §15, §32, §33).
 *
 * There is deliberately no hook here for starting, stopping, or fetching a
 * recording. None exists on the server either (decision D8).
 */

// ---------------------------------------------------------------------------
// Patient
// ---------------------------------------------------------------------------

/**
 * Joins the media session.
 *
 * The patient's routes carry no consultation identifier — their session is
 * bound to one consultation, so there is nothing to tamper with (spec §102).
 */
export function useJoinPatientMedia() {
  return useMutation({
    mutationFn: () => api.post<MediaSessionView>("/patient/consultation/media/join"),
  });
}

export function useLeavePatientMedia() {
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/patient/consultation/media/leave"),
  });
}

/**
 * Tells the server the patient's browser is going away (D57).
 *
 * A closed tab is attendance, not an ending: this records that they left and
 * nothing else. What they paid for survives it, and they can come back to the
 * same consultation without paying again.
 */
export function patientLeftBeacon(): void {
  apiBeacon("/patient/consultation/media/leave");
}

export function usePatientTimer(enabled: boolean) {
  return useQuery({
    queryKey: ["patient", "timer"],
    queryFn: ({ signal }) =>
      api.get<ConsultationTimer | null>("/patient/consultation/timer", signal),
    enabled,
    // Once a second would be needlessly chatty on a Ghanaian mobile
    // connection; the client counts the seconds between polls itself.
    refetchInterval: enabled ? 15_000 : false,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

export function useJoinDoctorMedia(publicId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<MediaSessionView>(`/doctor/consultations/${publicId}/media/join`),
    // Joining starts the consultation, so its state is now stale.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["doctor", "consultation", publicId] }),
  });
}

export function useLeaveDoctorMedia(publicId: string) {
  return useMutation({
    mutationFn: () => api.post<{ ok: boolean }>(`/doctor/consultations/${publicId}/media/leave`),
  });
}

/** The doctor's own side of the same thing. */
export function doctorLeftBeacon(publicId: string): void {
  apiBeacon(`/doctor/consultations/${publicId}/media/leave`);
}

/**
 * The doctor records that the call broke and the consultation is unfinished (D57).
 *
 * Theirs to press, and deliberately not automatic: no timeout, no dropped
 * connection and no closed tab decides this. It completes nothing, refunds
 * nothing and pays nobody — it frees the doctor to see other patients while
 * leaving this one able to rejoin without paying again.
 */
export function useInterruptConsultation(publicId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (note?: string) =>
      api.post<{ state: string; rejoinableUntil: string }>(
        `/doctor/consultations/${publicId}/interrupt`,
        note ? { note } : undefined,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["doctor", "consultation", publicId] }),
  });
}

export function useDoctorTimer(publicId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["doctor", "timer", publicId],
    queryFn: ({ signal }) =>
      api.get<ConsultationTimer | null>(`/doctor/consultations/${publicId}/timer`, signal),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
    retry: false,
  });
}

/** Places the Call Me bridge. Returns no phone number (spec §33). */
export function usePlaceCall(publicId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<CallMeResult>(`/doctor/consultations/${publicId}/call`),
    // Placing the call starts the consultation, so its state is now stale —
    // without this the header still reads DOCTOR ACCEPTED after the bridge.
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["doctor", "consultation", publicId] }),
  });
}
