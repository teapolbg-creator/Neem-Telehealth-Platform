import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FacilityConnectivityStatus,
  FacilityCreate,
  FacilityDetail,
  FacilityEquipmentStatus,
  FacilityStaffCreate,
  FacilityStaffMember,
  FacilityStaffSetup,
  FacilityStatus,
  FacilitySummary,
  FacilityType,
  FacilityUpdate,
  GeographyRegion,
} from "@neem/contracts";
import { api } from "@/lib/api-client";

/**
 * Health facilities and CHPS staff accounts (CHPS slice 1a, D73).
 *
 * Every rule behind these screens is the API's: a facility starts inactive,
 * a sub-district must sit in its district, only a CHPS compound has staff, and
 * deactivating needs a reason — whatever these screens let a person click.
 */

export const EQUIPMENT_LABEL: Record<FacilityEquipmentStatus, string> = {
  NOT_INSTALLED: "Not installed",
  OPERATIONAL: "Working",
  FAULTY: "Faulty",
};

export const CONNECTIVITY_LABEL: Record<FacilityConnectivityStatus, string> = {
  UNKNOWN: "Not reported",
  GOOD: "Good",
  INTERMITTENT: "Intermittent",
  POOR: "Poor",
  NONE: "None",
};

export const STATUS_LABEL: Record<FacilityStatus, string> = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
};

export function useGeography() {
  return useQuery({
    queryKey: ["admin", "geography"],
    queryFn: ({ signal }) => api.get<GeographyRegion[]>("/admin/geography", signal),
    staleTime: 5 * 60_000,
  });
}

export function useCreateDistrict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { regionId: string; name: string }) =>
      api.post<{ id: string; name: string }>("/admin/geography/districts", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "geography"] }),
  });
}

export function useCreateSubDistrict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { districtId: string; name: string }) =>
      api.post<{ id: string; name: string }>("/admin/geography/sub-districts", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "geography"] }),
  });
}

export interface FacilityFilters {
  status?: FacilityStatus;
  type?: FacilityType;
  regionId?: string;
  districtId?: string;
  search?: string;
}

/** The page size the directory asks for; the API's ceiling. */
export const FACILITY_PAGE_SIZE = 100;

export function useFacilities(filters: FacilityFilters) {
  const params = new URLSearchParams({ limit: String(FACILITY_PAGE_SIZE) });
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }

  return useQuery({
    queryKey: ["admin", "facilities", filters],
    queryFn: ({ signal }) => api.get<FacilitySummary[]>(`/admin/facilities?${params}`, signal),
  });
}

export function useFacility(publicId: string) {
  return useQuery({
    queryKey: ["admin", "facilities", "detail", publicId],
    queryFn: ({ signal }) => api.get<FacilityDetail>(`/admin/facilities/${publicId}`, signal),
  });
}

export function useCreateFacility() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FacilityCreate) => api.post<FacilitySummary>("/admin/facilities", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "facilities"] }),
  });
}

export function useUpdateFacility(publicId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FacilityUpdate) =>
      api.patch<FacilityDetail>(`/admin/facilities/${publicId}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "facilities"] }),
  });
}

export function useCreateStaff(publicId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FacilityStaffCreate) =>
      api.post<FacilityStaffSetup>(`/admin/facilities/${publicId}/staff`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "facilities"] }),
  });
}

export function useSetStaffStatus(publicId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userPublicId: string; status: "ACTIVE" | "SUSPENDED" }) =>
      api.post<FacilityStaffMember>(
        `/admin/facilities/${publicId}/staff/${input.userPublicId}/status`,
        { status: input.status },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "facilities"] }),
  });
}

export function useReissueSetupLink(publicId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userPublicId: string) =>
      api.post<FacilityStaffSetup>(
        `/admin/facilities/${publicId}/staff/${userPublicId}/setup-link`,
        {},
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "facilities"] }),
  });
}

/** The signed-in CHO's own facility. */
export function useOwnFacility(enabled: boolean) {
  return useQuery({
    queryKey: ["facility", "profile"],
    queryFn: ({ signal }) => api.get<FacilityDetail>("/facility/profile", signal),
    enabled,
  });
}
