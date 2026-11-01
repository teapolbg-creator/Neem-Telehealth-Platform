import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StationPairing, StationSummary } from "@neem/contracts";
import { api } from "@/lib/api-client";

/**
 * The facility's consultation stations, as the CHO manages them (slice 1d,
 * D77). The station screen itself uses features/station.
 */

export function useStations(enabled = true) {
  return useQuery({
    queryKey: ["facility", "stations"],
    queryFn: ({ signal }) => api.get<StationSummary[]>("/facility/stations", signal),
    enabled,
    refetchInterval: 15_000,
  });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["facility"] });
}

export function useCreateStation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (label: string) => api.post<StationPairing>("/facility/stations", { label }),
    onSuccess: invalidate,
  });
}

export function useRepairStation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (publicId: string) =>
      api.post<StationPairing>(`/facility/stations/${publicId}/pairing-code`, {}),
    onSuccess: invalidate,
  });
}

export function useRevokeStation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (publicId: string) =>
      api.post<StationSummary>(`/facility/stations/${publicId}/revoke`, {}),
    onSuccess: invalidate,
  });
}

export function useClearStation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (publicId: string) =>
      api.post<StationSummary>(`/facility/stations/${publicId}/clear`, {}),
    onSuccess: invalidate,
  });
}

export function useSendToStation(visitPublicId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (stationPublicId: string) =>
      api.post<StationSummary>(`/facility/visits/${visitPublicId}/station`, { stationPublicId }),
    onSuccess: invalidate,
  });
}
