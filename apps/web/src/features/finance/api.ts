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

// ---------------------------------------------------------------------------
// Doctor membership (spec §27)
// ---------------------------------------------------------------------------

export interface Membership {
  status: "NONE" | "PENDING" | "ACTIVE" | "GRACE" | "EXPIRED" | "CANCELLED";
  periodStart: string | null;
  periodEnd: string | null;
  graceEndsAt: string | null;
  amountMinor: number;
  currency: string;
  daysRemaining: number | null;
  renewalDue: boolean;
  doctorStatus: string;
  suspendedForNonPayment: boolean;
}

export const membershipKey = ["doctor", "membership"] as const;

export function useMembership() {
  return useQuery({
    queryKey: membershipKey,
    queryFn: ({ signal }) => api.get<Membership>("/doctor/membership", signal),
  });
}

export interface MembershipPayment {
  paymentPublicId: string;
  providerReference: string;
  authorizationUrl: string | null;
  amountMinor: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  isMockProvider: boolean;
}

/**
 * Starts a membership payment.
 *
 * Succeeding means a checkout was opened, never that the fee was paid. The
 * membership activates only when the provider confirms it server-side, which
 * is what `useMembershipPaymentStatus` waits for.
 */
export function useStartMembershipPayment() {
  return useMutation({
    mutationFn: () => api.post<MembershipPayment>("/doctor/membership/payment"),
  });
}

/**
 * Polls the provider through our own server.
 *
 * Only while a payment is outstanding — a doctor with an active membership
 * has nothing to wait for, and polling a provider on their behalf for ever
 * would be a request per interval for no reason.
 */
export function useMembershipPaymentStatus(enabled: boolean) {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ["doctor", "membership", "payment-status"],
    queryFn: async ({ signal }) => {
      const result = await api.get<{ status: string; membership: Membership }>(
        "/doctor/membership/payment/status",
        signal,
      );
      queryClient.setQueryData(membershipKey, result.membership);
      return result;
    },
    enabled,
    refetchInterval: enabled ? 4000 : false,
  });
}

// ---------------------------------------------------------------------------
// Doctor earnings and payroll (spec §26, decision D28)
// ---------------------------------------------------------------------------

export interface DoctorEarnings {
  period: { isoYear: number; fromIsoWeek: number; toIsoWeek: number };
  contractedHoursPerWeek: number | null;
  employmentType: string | null;
  /** Null when no contract is recorded — not the same as being owed nothing. */
  monthlyMinor: number | null;
  currency: string;
  scheduledLabel: string;
  servedLabel: string;
  consultationsThisPeriod: number;
}

export function useDoctorEarnings() {
  return useQuery({
    queryKey: ["doctor", "earnings"],
    queryFn: ({ signal }) => api.get<DoctorEarnings>("/doctor/earnings", signal),
  });
}

export interface PayrollLine {
  doctorPublicId: string;
  fullName: string;
  employmentType: string | null;
  contractedHoursPerWeek: number | null;
  monthlyMinor: number;
  currency: string;
  fraction: number;
  isFullTime: boolean;
  scheduledLabel: string;
  servedLabel: string;
  shortOfContract: boolean;
  remainderNumerator: number;
}

export interface Payroll {
  period: { isoYear: number; fromIsoWeek: number; toIsoWeek: number };
  fullTimeMonthlyMinor: number;
  fullTimeHoursPerWeek: number;
  currency: string;
  totalMinor: number;
  lines: PayrollLine[];
  doctorsWithoutContract: number;
}

export function useAdminPayroll() {
  return useQuery({
    queryKey: ["admin", "payroll"],
    queryFn: ({ signal }) => api.get<Payroll>("/admin/payroll", signal),
  });
}

// ---------------------------------------------------------------------------
// Promotions (spec §42)
// ---------------------------------------------------------------------------

export interface Promotion {
  code: string;
  type: "PERCENT" | "FIXED";
  valueBp: number | null;
  valueMinor: number | null;
  startsAt: string;
  endsAt: string;
  maxUses: number | null;
  usedCount: number;
  minAmountMinor: number;
  campaign: string | null;
  pharmacyName: string | null;
  isActive: boolean;
  redeemable: boolean;
  discountedMinor: number;
}

export const adminPromotionsKey = ["admin", "promotions"] as const;

export function useAdminPromotions(activeOnly = false) {
  return useQuery({
    queryKey: [...adminPromotionsKey, activeOnly],
    queryFn: ({ signal }) =>
      api.get<Promotion[]>(`/admin/promotions?activeOnly=${activeOnly}`, signal),
  });
}

export interface CreatePromotionInput {
  code: string;
  type: "PERCENT" | "FIXED";
  valueBp?: number;
  valueMinor?: number;
  startsAt: string;
  endsAt: string;
  maxUses?: number;
  campaign?: string;
  minAmountMinor?: number;
}

export function useCreatePromotion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreatePromotionInput) =>
      api.post<{ code: string }>("/admin/promotions", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminPromotionsKey }),
  });
}

/** Withdraws a code. Deactivates rather than deletes — redemptions stay explainable. */
export function useDeactivatePromotion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (code: string) =>
      api.post<{ code: string; isActive: boolean }>(`/admin/promotions/${code}/deactivate`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminPromotionsKey }),
  });
}
