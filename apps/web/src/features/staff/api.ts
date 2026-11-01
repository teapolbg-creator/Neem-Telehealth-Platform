import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DistrictOverview,
  GeoScopeLevel,
  StaffAccount,
  StaffAccountCreate,
  StaffAccountSetup,
} from "@neem/contracts";
import { api } from "@/lib/api-client";

/**
 * Operations administrators and district officers (CHPS slice 3a, D84).
 *
 * The super administrator's screens. The API refuses all of it to anyone
 * else, whatever is rendered.
 */

export const ROLE_LABEL: Record<StaffAccount["role"], string> = {
  ADMIN: "Super administrator",
  OPS_ADMIN: "Operations",
  DISTRICT: "District officer",
};

export const SCOPE_LEVEL_LABEL: Record<GeoScopeLevel, string> = {
  REGION: "A whole region",
  DISTRICT: "One district",
  SUB_DISTRICT: "One sub-district",
};

const KEY = ["admin", "staff"] as const;

export function useStaffAccounts() {
  return useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api.get<StaffAccount[]>("/admin/staff", signal),
  });
}

export function useCreateStaffAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StaffAccountCreate) => api.post<StaffAccountSetup>("/admin/staff", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSetStaffAccountStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userPublicId: string; status: "ACTIVE" | "SUSPENDED" }) =>
      api.post<StaffAccount>(`/admin/staff/${input.userPublicId}/status`, {
        status: input.status,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useReissueStaffSetupLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userPublicId: string) =>
      api.post<StaffAccountSetup>(`/admin/staff/${userPublicId}/setup-link`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

/** A district officer's own page. */
export function useDistrictOverview() {
  return useQuery({
    queryKey: ["district", "overview"],
    queryFn: ({ signal }) => api.get<DistrictOverview>("/district/overview", signal),
  });
}
