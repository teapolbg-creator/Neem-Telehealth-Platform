import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { Money } from "@/features/consultation/api";

/**
 * The professional side of v2: what someone is, when they can be booked, what
 * the services cost, and what they are paid.
 *
 * Every rule behind these screens is enforced by the API. A dietitian cannot
 * be given a doctor's service, a week cannot hold overlapping windows, a price
 * change is audited, and a payout already sent cannot be marked paid twice —
 * whatever these screens let a person click (spec §92).
 */

export type Discipline = "DOCTOR" | "DIETITIAN" | "TRAINER";

export const DISCIPLINE_LABEL: Record<Discipline, string> = {
  DOCTOR: "Doctor",
  DIETITIAN: "Dietitian",
  TRAINER: "Personal trainer",
};

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export interface AdminService {
  code: string;
  name: string;
  description: string | null;
  clinic: string;
  discipline: Discipline;
  price: Money;
  durationSeconds: number | null;
  isActive: boolean;
}

export function useAdminServices() {
  return useQuery({
    queryKey: ["admin", "services"],
    queryFn: ({ signal }) => api.get<AdminService[]>("/admin/services", signal),
  });
}

export function useUpdateService() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      code: string;
      priceMinor?: number;
      isActive?: boolean;
      durationSeconds?: number | null;
    }) => {
      const { code, ...patch } = input;
      return api.patch<AdminService>(`/admin/services/${encodeURIComponent(code)}`, patch);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "services"] }),
  });
}

// ---------------------------------------------------------------------------
// What a professional is
// ---------------------------------------------------------------------------

export function useSetProfession(publicId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      discipline: Discipline;
      credentialType?: string | null;
      credentialNumber?: string | null;
      serviceCodes: string[];
    }) =>
      api.patch<{ discipline: Discipline; credential: string | null; services: string[] }>(
        `/admin/doctors/${publicId}/profession`,
        input,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin"] }),
  });
}

// ---------------------------------------------------------------------------
// When a professional can be booked
// ---------------------------------------------------------------------------

export interface AvailabilityWindow {
  /** 0 = Sunday. */
  weekday: number;
  startsAt: string;
  endsAt: string;
}

export function useMyAvailability() {
  return useQuery({
    queryKey: ["doctor", "availability"],
    queryFn: ({ signal }) => api.get<AvailabilityWindow[]>("/doctor/availability", signal),
  });
}

export function useSetAvailability() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (windows: AvailabilityWindow[]) =>
      api.put<AvailabilityWindow[]>("/doctor/availability", { windows }),
    onSuccess: (saved) => queryClient.setQueryData(["doctor", "availability"], saved),
  });
}

// ---------------------------------------------------------------------------
// Paying professionals
// ---------------------------------------------------------------------------

export interface ProfessionalPayout {
  publicId: string;
  professionalName: string;
  professionalPublicId: string;
  discipline: Discipline;
  periodStart: string;
  periodEnd: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  currency: string;
  status: string;
  paidAt: string | null;
  paymentReference: string | null;
  note: string | null;
}

export function useProfessionalPayouts() {
  return useQuery({
    queryKey: ["admin", "professional-payouts"],
    queryFn: ({ signal }) => api.get<ProfessionalPayout[]>("/admin/professional-payouts", signal),
  });
}

export function useCalculateProfessionalPayouts() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (period: { periodStart: string; periodEnd: string }) =>
      api.post<{ created: number; updated: number; frozen: number }>(
        "/admin/professional-payouts/calculate",
        period,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "professional-payouts"] }),
  });
}

export function useMarkProfessionalPayoutPaid() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { publicId: string; paymentReference: string; note?: string }) =>
      api.post<{ publicId: string; status: string }>(
        `/admin/professional-payouts/${input.publicId}/mark-paid`,
        { paymentReference: input.paymentReference, note: input.note },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "professional-payouts"] }),
  });
}

export interface Reconciliation {
  periodStart: string;
  periodEnd: string;
  currency: string;
  collectedMinor: number;
  feesMinor: number;
  earnedMinor: number;
  reversedMinor: number;
  neemMinor: number;
  paidOutMinor: number;
  outstandingMinor: number;
}

export function useReconciliation(period: { periodStart: string; periodEnd: string }) {
  return useQuery({
    queryKey: ["admin", "professional-payouts", "reconciliation", period],
    queryFn: ({ signal }) =>
      api.get<Reconciliation>(
        `/admin/professional-payouts/reconciliation?periodStart=${period.periodStart}&periodEnd=${period.periodEnd}`,
        signal,
      ),
  });
}
