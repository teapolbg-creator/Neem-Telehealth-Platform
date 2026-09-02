import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * Money (spec §38–§41, §98).
 *
 * Every amount crossing this boundary is an integer number of pesewas. Nothing
 * here divides by 100 except `formatMinor`, at the very edge, for display.
 *
 * Deliberately absent: anything that refunds, pays out, or adjusts revenue
 * without an administrator's decision behind it. There is no route for it.
 */

export function formatMinor(amountMinor: number, currency = "GHS"): string {
  return new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amountMinor / 100);
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export interface AdminRefund {
  publicId: string;
  state: "REQUESTED" | "APPROVED" | "REJECTED" | "PROCESSING" | "COMPLETED" | "FAILED";
  reason: string;
  amountMinor: number;
  currency: string;
  requestedByType: string;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  consultationReference: string;
  consultationState: string;
  pharmacyName: string;
}

export const adminRefundsKey = ["admin", "refunds"] as const;

export function useAdminRefunds(openOnly = true) {
  return useQuery({
    queryKey: [...adminRefundsKey, openOnly],
    queryFn: ({ signal }) =>
      api.get<AdminRefund[]>(`/admin/refunds?openOnly=${openOnly}`, signal),
    // Someone is waiting on their money.
    refetchInterval: 30_000,
  });
}

export function useDecideRefund() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { publicId: string; approve: boolean; note: string }) =>
      api.post<{ state: string; consultationState: string }>(
        `/admin/refunds/${input.publicId}/decide`,
        { approve: input.approve, note: input.note },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminRefundsKey }),
  });
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

export interface Payout {
  publicId: string;
  pharmacyName: string;
  pharmacyPublicId: string;
  periodStart: string;
  periodEnd: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  currency: string;
  status: "PENDING" | "PROCESSING" | "PAID" | "FAILED" | "RECONCILED";
  paidAt: string | null;
  paymentReference: string | null;
  note: string | null;
}

export const adminPayoutsKey = ["admin", "payouts"] as const;

export function useAdminPayouts(pendingOnly = true) {
  return useQuery({
    queryKey: [...adminPayoutsKey, pendingOnly],
    queryFn: ({ signal }) => api.get<Payout[]>(`/admin/payouts?pendingOnly=${pendingOnly}`, signal),
  });
}

export function useCalculatePayouts() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { periodStart: string; periodEnd: string }) =>
      api.post<{ created: number; updated: number; frozen: number }>(
        "/admin/payouts/calculate",
        input,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminPayoutsKey }),
  });
}

/**
 * Records a transfer that already happened.
 *
 * Neem does not move the money (spec §40) — this is a bookkeeping entry, and
 * the reference is what makes it traceable to the real transfer.
 */
export function useMarkPayoutPaid() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { publicId: string; paymentReference: string; note?: string }) =>
      api.post<{ publicId: string; status: string }>(
        `/admin/payouts/${input.publicId}/mark-paid`,
        { paymentReference: input.paymentReference, note: input.note },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminPayoutsKey }),
  });
}

// ---------------------------------------------------------------------------
// A pharmacy's own earnings
// ---------------------------------------------------------------------------

export interface PharmacyFinance {
  currency: string;
  allTimeMinor: number;
  last30DaysMinor: number;
  consultations30Days: number;
  awaitingPayoutMinor: number;
  payouts: Payout[];
}

export function usePharmacyFinance() {
  return useQuery({
    queryKey: ["pharmacy", "finance"],
    queryFn: ({ signal }) => api.get<PharmacyFinance>("/pharmacy/finance", signal),
  });
}
