import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PatientIdentity, PatientSessionView } from "@neem/contracts";
import { api } from "@/lib/api-client";

/**
 * Consultation queries for the pharmacy and patient portals.
 *
 * Payment status is polled rather than trusted from a callback: only the
 * server's verification with the provider decides whether a consultation is
 * paid (spec §34).
 */

export interface Money {
  amountMinor: number;
  currency: string;
}

export function formatMoney(value: Money | undefined): string {
  if (!value) return "—";
  return new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: 2,
  }).format(value.amountMinor / 100);
}

// ---------------------------------------------------------------------------
// Pharmacy
// ---------------------------------------------------------------------------

export interface CreatedConsultation {
  publicId: string;
  state: string;
  price: Money;
  discount: Money;
  net: Money;
  paymentDeadlineAt: string | null;
  secondsRemaining: number | null;
}

export function useCreateConsultation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { promotionCode?: string } = {}) =>
      api.post<CreatedConsultation>("/pharmacy/consultations", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pharmacy", "consultations"] }),
  });
}

export interface PaymentView {
  consultationPublicId: string;
  consultationState: string;
  paymentStatus: string;
  amount: Money;
  secondsRemaining: number | null;
  isMockProvider: boolean;
  canRetry: boolean;
}

export function useInitiatePayment() {
  return useMutation({
    mutationFn: (input: { publicId: string; payerPhone?: string }) =>
      api.post<{
        providerReference: string;
        authorizationUrl: string | null;
        isMockProvider: boolean;
        note?: string;
      }>(`/pharmacy/consultations/${input.publicId}/payment`, { payerPhone: input.payerPhone }),
  });
}

/**
 * Polls the authoritative payment status.
 *
 * Each call makes the server re-verify with the provider, so a payment
 * completed out-of-band is picked up even if a webhook is delayed.
 */
export function usePaymentStatus(publicId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["pharmacy", "payment", publicId],
    queryFn: ({ signal }) =>
      api.get<PaymentView>(`/pharmacy/consultations/${publicId}/payment`, signal),
    enabled: Boolean(publicId) && enabled,
    refetchInterval: enabled ? 3000 : false,
  });
}

/** Development only — drives the mock provider, never asserts money moved. */
export function useSimulatePayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { publicId: string; outcome: "SUCCESS" | "FAILED" }) =>
      api.post(`/pharmacy/consultations/${input.publicId}/payment/simulate`, {
        outcome: input.outcome,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pharmacy"] }),
  });
}

export interface ConsultationQr {
  qrDataUrl: string;
  url: string;
  expiresAt: string;
  sequence: number;
}

/**
 * Mints the QR code.
 *
 * Each call issues a NEW single-use token and revokes the previous one — only
 * a hash is stored, so a code can be rendered exactly once. The UI therefore
 * requests it deliberately, and warns before replacing a live code.
 */
export function useIssueQr() {
  return useMutation({
    mutationFn: (publicId: string) =>
      api.post<ConsultationQr>(`/pharmacy/consultations/${publicId}/qr`),
  });
}

export interface PharmacyConsultation {
  publicId: string;
  state: string;
  type: string | null;
  language: { code: string; label: string } | null;
  price: Money;
  discount: Money;
  net: Money;
  createdAt: string;
  paymentDeadlineAt: string | null;
  secondsRemaining: number | null;
  activatedAt: string | null;
  patientJoinedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  outcome: string | null;
  hasPrescription: boolean;
  hasReferral: boolean;
  doctor: { publicId: string; fullName: string } | null;
  paymentStatus: string;
  /** The four fields the pharmacy may see, and only while live (spec §18). */
  patient: { fullName: string; age: number; sex: string; phone: string } | null;
  isDemo: boolean;
}

export function useConsultation(publicId: string | null, poll = false) {
  return useQuery({
    queryKey: ["pharmacy", "consultation", publicId],
    queryFn: ({ signal }) =>
      api.get<PharmacyConsultation>(`/pharmacy/consultations/${publicId}`, signal),
    enabled: Boolean(publicId),
    refetchInterval: poll ? 4000 : false,
  });
}

export function usePharmacyConsultations(activeOnly = true) {
  return useQuery({
    queryKey: ["pharmacy", "consultations", { activeOnly }],
    queryFn: ({ signal }) =>
      api.get<PharmacyConsultation[]>(
        `/pharmacy/consultations?activeOnly=${activeOnly}&limit=25`,
        signal,
      ),
    refetchInterval: 10_000,
  });
}

export function useCancelConsultation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { publicId: string; reason: string }) =>
      api.post<{ state: string; refundOwed: boolean; message: string }>(
        `/pharmacy/consultations/${input.publicId}/cancel`,
        { reason: input.reason },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["pharmacy"] }),
  });
}

// ---------------------------------------------------------------------------
// Patient
// ---------------------------------------------------------------------------

export const patientSessionKey = ["patient", "session"] as const;

/**
 * Exchanges the QR token for a session.
 *
 * POST, not GET: a GET would be prefetched by link previews and scanners,
 * silently consuming a single-use token before the patient arrived.
 */
export function useExchangeToken() {
  return useMutation({
    mutationFn: (token: string) =>
      api.post<{ consultationPublicId: string }>("/s/exchange", { token }),
  });
}

export function usePatientSession(enabled = true) {
  return useQuery({
    queryKey: patientSessionKey,
    queryFn: ({ signal }) => api.get<PatientSessionView>("/patient/session", signal),
    enabled,
    // Keeps the waiting room current without the patient refreshing. Replaced
    // by a socket subscription in Phase 4.
    refetchInterval: (query) =>
      query.state.data?.step === "WAITING" || query.state.data?.step === "IN_CONSULTATION"
        ? 5000
        : false,
    retry: false,
  });
}

export function usePatientLanguages(enabled = true) {
  return useQuery({
    queryKey: ["patient", "languages"],
    queryFn: ({ signal }) =>
      api.get<Array<{ code: string; label: string; subtitle: string | null }>>(
        "/patient/languages",
        signal,
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** What a complaint may be about — only needed once the form is open. */
export function usePatientComplaintCategories(enabled = false) {
  return useQuery({
    queryKey: ["patient", "complaint-categories"],
    queryFn: ({ signal }) =>
      api.get<Array<{ code: string; label: string }>>("/patient/complaint-categories", signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export interface PatientFeedbackInput {
  doctorRating: number;
  neemRating: number;
  category: "COMPLAINT" | "COMPLIMENT" | "SUGGESTION";
  complaintCategoryCode?: string;
  comment?: string;
}

/**
 * The patient's rating of the consultation (spec §51).
 *
 * Refetches the session rather than trusting the mutation's own result,
 * because `feedbackSubmitted` on the session view is what decides whether the
 * form is shown again.
 */
export function useSubmitFeedback() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: PatientFeedbackInput) =>
      api.post<{ submitted: boolean }>("/patient/feedback", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: patientSessionKey }),
  });
}

/**
 * Asking for a refund (spec §41).
 *
 * Recorded, never granted. The mutation succeeding means an administrator has
 * the request, not that money is coming back — the screen says so, because a
 * patient told "refund on its way" by a system that has decided nothing would
 * be being misled.
 */
export function useRequestRefund() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (reason: string) =>
      api.post<{ publicId: string; state: string }>("/patient/refund-request", { reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: patientSessionKey }),
  });
}

/**
 * The patient finishing with the phone.
 *
 * `POST /patient/session/leave` existed from Phase 3 and **nothing called
 * it** — the portal's only "Leave" was the call's, which ends the video and
 * lets the patient rejoin. So a patient handing the handset back across the
 * counter had no way to end their session at all; it sat valid until it
 * expired, on a device now in someone else's hands.
 *
 * The route clears the cookie *and* ends the session on the server (D34), so
 * a token already copied off the device stops working too. Clearing the cache
 * here matters for the same reason the server-side half does: leaving the
 * consultation reference sitting in memory for the next person to see would
 * undo most of the point.
 */
export function useEndPatientSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<{ state: string; message: string }>("/patient/session/leave", {}),
    onSuccess: () => queryClient.removeQueries({ queryKey: patientSessionKey }),
  });
}

function usePatientStep<TInput>(path: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: TInput) => api.post<PatientSessionView>(path, input),
    onSuccess: (view) => queryClient.setQueryData(patientSessionKey, view),
  });
}

export const useSubmitIdentity = () => usePatientStep<PatientIdentity>("/patient/session/identity");
export const useSelectLanguage = () =>
  usePatientStep<{ languageCode: string }>("/patient/session/language");
export const useSelectMode = () =>
  usePatientStep<{ type: "AUDIO" | "VIDEO" | "CALL_ME" }>("/patient/session/mode");
