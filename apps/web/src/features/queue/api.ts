import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * Doctor queue and presence.
 *
 * The countdown rendered from this data is presentation only. The response
 * window is enforced by a server-side sweep (spec §30), so a paused tab or a
 * tampered clock changes nothing about whether an offer lapses.
 */

export interface OccupyingConsultation {
  consultationPublicId: string;
  state: string;
  since: string | null;
}

export interface PresenceView {
  online: boolean;
  onlineSince: string | null;
  currentLoad: number;
  maxLoad: number;
  /** Why this doctor is not receiving consultations right now. */
  blockedBy: string | null;
  /** The consultations holding this doctor's slot, when they are at capacity (D66). */
  occupying: OccupyingConsultation[];
}

export const presenceKey = ["doctor", "presence"] as const;
export const queueKey = ["doctor", "queue"] as const;

export function usePresence() {
  return useQuery({
    queryKey: presenceKey,
    queryFn: ({ signal }) => api.get<PresenceView>("/doctor/presence", signal),
    refetchInterval: 20_000,
  });
}

export function useGoOnline() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post("/doctor/presence/online"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: presenceKey }),
  });
}

export function useGoOffline() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post("/doctor/presence/offline"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: presenceKey }),
  });
}

/**
 * Keeps the doctor's presence alive while the tab is open.
 *
 * A heartbeat rather than a flag: closing the laptop stops the beat and the
 * doctor drops out of allocation, instead of consultations being offered to an
 * empty chair.
 */
export function useHeartbeat(enabled: boolean, intervalMs = 30_000): void {
  useEffect(() => {
    if (!enabled) return;

    const send = () => {
      void api.post("/doctor/presence/heartbeat").catch(() => undefined);
    };

    send();
    const timer = setInterval(send, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
}

export interface QueueOffer {
  consultationPublicId: string;
  type: string | null;
  language: { code: string; label: string } | null;
  /** Null for a patient who booked on Neem themselves (v2). */
  pharmacy: { name: string; city: string } | null;
  offeredAt: string;
  respondByAt: string;
  secondsRemaining: number;
}

/**
 * Where a consultation came from, as the doctor is told it. A patient who
 * booked online has no pharmacy, and saying so is the answer, not a blank.
 */
export function consultationOrigin(pharmacy: { name: string; city: string } | null): string {
  return pharmacy ? `${pharmacy.name}, ${pharmacy.city}` : "Booked online by the patient";
}

/**
 * Which kind of consultation this is, said plainly.
 *
 * It changes what the professional can do: a pharmacy is standing by to
 * dispense and may propose a substitution, and an online patient keeps what
 * is issued and takes it wherever they choose.
 */
export function channelLabel(pharmacy: { name: string; city: string } | null): string {
  return pharmacy ? "At a pharmacy" : "Online patient";
}

export function useQueue(enabled: boolean) {
  return useQuery({
    queryKey: queueKey,
    queryFn: ({ signal }) =>
      api.get<{ offer: QueueOffer | null; windowSeconds: number }>("/doctor/queue", signal),
    enabled,
    // Polled while online. Replaced by the socket subscription where one is
    // connected; polling remains the fallback.
    refetchInterval: enabled ? 3000 : false,
  });
}

export function useAcceptOffer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (publicId: string) => api.post(`/doctor/consultations/${publicId}/accept`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queueKey });
      void queryClient.invalidateQueries({ queryKey: presenceKey });
    },
  });
}

/**
 * A locally-ticking countdown, seeded from the server's `respondByAt`.
 *
 * Recomputed from the absolute deadline on every tick rather than decremented,
 * so a throttled background tab does not drift into showing time the doctor
 * does not have.
 */
export function useCountdown(respondByAt: string | null): number {
  const [remaining, setRemaining] = useState(0);
  const deadline = useRef<number | null>(null);

  useEffect(() => {
    deadline.current = respondByAt ? new Date(respondByAt).getTime() : null;

    const tick = () => {
      if (!deadline.current) {
        setRemaining(0);
        return;
      }
      setRemaining(Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000)));
    };

    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [respondByAt]);

  return remaining;
}

// ---------------------------------------------------------------------------
// Admin oversight
// ---------------------------------------------------------------------------

export interface AdminQueueEntry {
  consultationPublicId: string;
  state: string;
  queueState: string;
  language: { code: string; label: string };
  pharmacyName: string;
  waitingSeconds: number;
  offerAttempts: number;
  noLanguageMatch: boolean;
  delayed: boolean;
  /** Admins see the routing score — this is the fairness audit trail. */
  lastOfferScore: number | null;
}

export function useAdminQueue() {
  return useQuery({
    queryKey: ["admin", "queue"],
    queryFn: ({ signal }) => api.get<AdminQueueEntry[]>("/admin/queue", signal),
    refetchInterval: 5000,
  });
}

export function useReallocate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (publicId: string) =>
      api.post<{ offered: boolean; languageStarved: boolean; message: string }>(
        `/admin/queue/${publicId}/reallocate`,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "queue"] }),
  });
}

// ---------------------------------------------------------------------------
// The accepted consultation
// ---------------------------------------------------------------------------

/**
 * The doctor's clinical context for one consultation (spec §24).
 *
 * There is no history here and no patient phone number: past clinical data no
 * longer exists, and Call Me exists so the doctor never learns the number
 * (spec §13, §33).
 */
export interface DoctorConsultation {
  publicId: string;
  state: string;
  type: "AUDIO" | "VIDEO" | "CALL_ME" | null;
  language: { code: string; label: string } | null;
  /** Null for a patient who booked on Neem themselves (v2). */
  pharmacy: { name: string; city: string } | null;
  patient: { fullName: string; age: number; sex: string } | null;
  vitals: Record<string, unknown> | null;
  tests: Array<{ code: string; label: string; result: string; recordedAt: string }>;
  startedAt: string | null;
  /**
   * True once the consultation is terminal and the clinical record is sealed
   * (D23). `vitals` and `tests` then come back empty — not because nothing was
   * recorded, but because it can no longer be read. The screen must say which.
   */
  clinicalSealed: boolean;
  outcome: string | null;
  /** Everything it produced, for records written since D56. */
  outcomes?: string[];
  /** How long an interrupted consultation may still be rejoined for (D57). */
  rejoinableUntil?: string | null;
  durationSeconds: number;
}

export interface AwaitingReturn {
  consultationPublicId: string;
  waitingSeconds: number;
  rejoinableUntil: string | null;
  language: string | null;
}

export const awaitingReturnKey = ["doctor", "awaiting-return"] as const;

/**
 * Patients who came back and are waiting for this professional (D64).
 *
 * Polled rather than left to the socket. The socket event is the fast path and
 * the part that fails: a professional who was offline, on another page, or
 * whose connection dropped would never see it, and the patient would wait for
 * somebody who was never told. This asks the server, which holds the durable
 * record.
 *
 * Thirty seconds, because the recovery window is fifteen minutes — frequent
 * enough that a doctor is not the reason a patient runs out of time, rare
 * enough to be unremarkable on a mobile connection.
 */
export function useAwaitingReturn(enabled = true) {
  return useQuery({
    queryKey: awaitingReturnKey,
    queryFn: ({ signal }) =>
      api.get<AwaitingReturn[]>("/doctor/consultations/awaiting-return", signal),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
    retry: false,
  });
}

export const doctorConsultationKey = (publicId: string) =>
  ["doctor", "consultation", publicId] as const;

export function useDoctorConsultation(publicId: string) {
  return useQuery({
    queryKey: doctorConsultationKey(publicId),
    queryFn: ({ signal }) =>
      api.get<DoctorConsultation>(`/doctor/consultations/${publicId}`, signal),
    retry: false,
  });
}
