import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ReferralContactMethod,
  ReferralCreate,
  ReferralDestination,
  ReferralRegisterRow,
  ReferralStatus,
  ReferralView,
} from "@neem/contracts";
import { api } from "@/lib/api-client";

/**
 * Tracked referrals (slice 2a, D80). The receiving facility never touches
 * these: everything after issue is what the CHO heard and recorded.
 */

export function useReferralDestinations(enabled = true) {
  return useQuery({
    queryKey: ["facility", "referral-destinations"],
    queryFn: ({ signal }) =>
      api.get<ReferralDestination[]>("/facility/referral-destinations", signal),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export interface ReferralFilters {
  status?: ReferralStatus;
  open?: boolean;
  from?: string;
  to?: string;
}

export function useReferralRegister(filters: ReferralFilters) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.open) params.set("open", "true");
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return useQuery({
    queryKey: ["facility", "referrals", filters],
    queryFn: ({ signal }) =>
      api.get<ReferralRegisterRow[]>(`/facility/referrals?${params}`, signal),
  });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["facility"] });
}

export function useCreateReferral(visitPublicId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: ReferralCreate) =>
      api.post<ReferralView>(`/facility/visits/${visitPublicId}/referrals`, input),
    onSuccess: invalidate,
  });
}

export function useAcknowledgeReferral(publicId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { via: ReferralContactMethod; contact?: string }) =>
      api.post<ReferralView>(`/facility/referrals/${publicId}/acknowledge`, input),
    onSuccess: invalidate,
  });
}

export function useReferralOutcome(publicId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: {
      outcome: "ATTENDED" | "DID_NOT_ARRIVE";
      via: ReferralContactMethod;
      feedback?: string;
    }) => api.post<ReferralView>(`/facility/referrals/${publicId}/outcome`, input),
    onSuccess: invalidate,
  });
}

export function useReferralFeedback(publicId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (feedback: string) =>
      api.post<ReferralView>(`/facility/referrals/${publicId}/feedback`, { feedback }),
    onSuccess: invalidate,
  });
}

export function useCancelReferral(publicId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (reason: string) =>
      api.post<ReferralView>(`/facility/referrals/${publicId}/cancel`, { reason }),
    onSuccess: invalidate,
  });
}

export const REFERRAL_STATUS_TONE: Record<
  ReferralStatus,
  "brand" | "warning" | "danger" | "muted" | "medical"
> = {
  ISSUED: "warning",
  ACKNOWLEDGED: "medical",
  ATTENDED: "brand",
  DID_NOT_ARRIVE: "danger",
  CANCELLED: "muted",
};
