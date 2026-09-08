import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL, api } from "@/lib/api-client";

/**
 * Pilot expressions of interest, submitted from the public marketing site.
 *
 * These are leads, not accounts. Nothing on this screen creates a doctor or a
 * pharmacy — onboarding is a separate, heavier path with credential checks,
 * and marking a row ONBOARDED records that it happened rather than doing it.
 */

export type PilotRole = "DOCTOR" | "PHARMACY";
export type PilotStatus = "NEW" | "CONTACTED" | "ONBOARDED" | "DECLINED" | "SPAM";

export interface PilotApplication {
  publicId: string;
  role: PilotRole;
  fullName: string;
  phone: string;
  email: string;
  specialty: string | null;
  yearsOfPractice: string | null;
  organisation: string;
  location: string;
  additionalInfo: string | null;
  status: PilotStatus;
  statusNote: string | null;
  consentAt: string;
  createdAt: string;
  reviewedAt: string | null;
  isDemo: boolean;
}

export const pilotApplicationsKey = ["admin", "pilot-applications"] as const;

export interface PilotFilters {
  role?: PilotRole;
  status?: PilotStatus;
  search?: string;
}

function queryString(filters: PilotFilters): string {
  const params = new URLSearchParams();
  if (filters.role) params.set("role", filters.role);
  if (filters.status) params.set("status", filters.status);
  if (filters.search) params.set("search", filters.search);
  params.set("limit", "100");
  return params.toString();
}

export function usePilotApplications(filters: PilotFilters) {
  return useQuery({
    queryKey: [...pilotApplicationsKey, filters],
    queryFn: ({ signal }) =>
      api.get<PilotApplication[]>(`/admin/pilot-applications?${queryString(filters)}`, signal),
  });
}

export function useSetPilotStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { publicId: string; status: PilotStatus; note?: string }) =>
      api.patch<PilotApplication>(`/admin/pilot-applications/${input.publicId}/status`, {
        status: input.status,
        note: input.note || undefined,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: pilotApplicationsKey }),
  });
}

/**
 * The CSV export URL.
 *
 * A plain link rather than a fetch: the browser's own download handling is
 * what puts the file somewhere the person can find it, and the session cookie
 * travels with the request the same way it does for every other API call.
 */
export function pilotExportUrl(filters: PilotFilters): string {
  const params = new URLSearchParams();
  if (filters.role) params.set("role", filters.role);
  if (filters.status) params.set("status", filters.status);

  const query = params.toString();
  return `${API_BASE_URL}/api/v1/admin/pilot-applications/export.csv${query ? `?${query}` : ""}`;
}
