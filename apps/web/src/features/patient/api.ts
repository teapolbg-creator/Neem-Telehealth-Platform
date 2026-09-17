import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConsultationDocument } from "@neem/contracts";
import { api, API_BASE_URL } from "@/lib/api-client";
import type { Money } from "@/features/consultation/api";

/**
 * The patient's own journey (v2).
 *
 * A patient booking for themselves holds an account session — a cookie minted
 * from a one-time code sent to their email — and that is the only credential
 * these calls carry. Nothing here decides anything: the price comes from the
 * catalogue, payment is confirmed only by the server re-verifying with the
 * provider, and a booking reaches the queue because the server put it there
 * (spec §34, §92).
 */

export const accountQueryKey = ["patient", "account"] as const;

// ---------------------------------------------------------------------------
// What is on offer
// ---------------------------------------------------------------------------

export interface PatientService {
  code: string;
  name: string;
  description: string | null;
  clinic: string;
  discipline: string;
  price: Money;
  durationSeconds: number | null;
}

export interface PatientClinic {
  code: string;
  name: string;
  description: string;
  fromPrice: Money | null;
  services: PatientService[];
}

/**
 * Public, because a patient choosing what to book has no account yet.
 *
 * `enabled` is stated rather than inferred from an empty list: switched off
 * and nothing offered are different facts, and the screen says which.
 */
export function usePatientClinics() {
  return useQuery({
    queryKey: ["patient", "clinics"],
    queryFn: ({ signal }) =>
      api.get<{ enabled: boolean; clinics: PatientClinic[] }>("/patient/clinics", signal),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

export interface AccountConsultation {
  publicId: string;
  state: string;
  serviceName: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface PatientAccount {
  publicId: string;
  contactKind: "EMAIL" | "PHONE";
  consultations: AccountConsultation[];
}

/**
 * Whether this browser holds an account session, and what it can see.
 *
 * A 401 is the ordinary answer for somebody who has not signed in, so it is
 * not retried and not surfaced as an error — it simply means "signed out".
 */
export function usePatientAccount(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: accountQueryKey,
    queryFn: ({ signal }) => api.get<PatientAccount>("/patient/account", signal),
    enabled: options.enabled ?? true,
    retry: false,
    staleTime: 30_000,
  });
}

/**
 * The answer is the same whether or not the address is known to Neem, so this
 * screen must not imply otherwise either.
 */
export function useRequestSignInCode() {
  return useMutation({
    mutationFn: (contact: string) =>
      api.post<{ status: string }>("/patient/account/code", { contact }),
  });
}

export function useVerifySignInCode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { contact: string; code: string }) =>
      api.post<{ status: string; publicId: string }>("/patient/account/verify", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["patient"] }),
  });
}

export function useSignOutAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<{ signedOut: boolean }>("/patient/account/logout", {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["patient"] }),
  });
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

export interface BookingIntake {
  serviceCode: string;
  languageCode: string;
  type: "AUDIO" | "VIDEO";
  fullName: string;
  age: number;
  sex: "MALE" | "FEMALE" | "OTHER";
  phone: string;
  reason: string;
  acceptsRemoteConsultation: true;
  readEmergencyGuidance: true;
}

export interface ImmediateBooking {
  consultationReference: string;
  price: Money;
  paymentDeadlineAt: string;
}

export function useBookNow() {
  return useMutation({
    mutationFn: (input: BookingIntake) =>
      api.post<ImmediateBooking>("/patient/bookings/immediate", input),
  });
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  professional: { publicId: string; fullName: string };
}

export function useSlots(serviceCode: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["patient", "slots", serviceCode],
    queryFn: ({ signal }) =>
      api.get<Slot[]>(
        `/patient/appointments/slots?serviceCode=${encodeURIComponent(serviceCode)}&days=7`,
        signal,
      ),
    enabled: options.enabled ?? true,
    // Somebody else may take a slot at any moment, so a listing goes stale
    // quickly — and the booking is refused by the database if one does.
    staleTime: 15_000,
  });
}

export interface ReservedAppointment {
  appointmentReference: string;
  consultationReference: string;
  startsAt: string;
  endsAt: string;
  professional: { publicId: string; fullName: string };
  price: Money;
  reservationExpiresAt: string;
}

export function useReserveAppointment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: BookingIntake & { professionalPublicId: string; startsAt: string }) =>
      api.post<ReservedAppointment>("/patient/appointments", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["patient", "slots"] }),
  });
}

export interface AccountAppointment {
  reference: string;
  consultationReference: string;
  state: string;
  startsAt: string;
  endsAt: string;
  professional: { publicId: string; fullName: string };
  service: { code: string; name: string };
  consultationState: string;
}

export function useMyAppointments(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["patient", "appointments"],
    queryFn: ({ signal }) => api.get<AccountAppointment[]>("/patient/appointments", signal),
    enabled: options.enabled ?? true,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Paying
// ---------------------------------------------------------------------------

export function useStartBookingPayment() {
  return useMutation({
    mutationFn: (reference: string) =>
      api.post<{
        authorizationUrl: string | null;
        providerReference: string;
        isMockProvider: boolean;
      }>(`/patient/bookings/${reference}/payment`, {}),
  });
}

export interface BookingPaymentStatus {
  consultationReference: string;
  state: string;
  paymentStatus: string;
  secondsRemaining: number | null;
  isMockProvider: boolean;
  joinedQueue: boolean;
}

/**
 * The screen the patient watches while paying.
 *
 * Polled, and polled server-side: each call makes the API re-ask the provider
 * rather than believing anything the checkout tab reported. Two seconds is
 * frequent enough that a patient who has just approved a prompt does not sit
 * looking at a stale screen.
 */
export function useBookingPaymentStatus(reference: string | null, options: { watch: boolean }) {
  return useQuery({
    queryKey: ["patient", "booking-payment", reference],
    queryFn: ({ signal }) =>
      api.get<BookingPaymentStatus>(`/patient/bookings/${reference}/payment`, signal),
    enabled: Boolean(reference) && options.watch,
    refetchInterval: options.watch ? 2_000 : false,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Afterwards
// ---------------------------------------------------------------------------

export interface AccountDocumentGroup {
  consultationReference: string;
  documents: ConsultationDocument[];
}

export function useAccountDocuments(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["patient", "documents"],
    queryFn: ({ signal }) =>
      api.get<{ consultations: AccountDocumentGroup[] }>("/patient/account/documents", signal),
    enabled: options.enabled ?? true,
    retry: false,
  });
}

/** A PDF is fetched by the browser with the account cookie attached. */
export function accountDocumentUrl(kind: string, publicId: string): string {
  return `${API_BASE_URL}/api/v1/patient/account/documents/${kind}/${publicId}.pdf`;
}

export interface PatientLanguage {
  code: string;
  label: string;
  subtitle: string | null;
}

export function useBookingLanguages(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["patient", "languages"],
    queryFn: ({ signal }) => api.get<PatientLanguage[]>("/patient/languages", signal),
    enabled: options.enabled ?? true,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
