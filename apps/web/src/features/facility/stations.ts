import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StationLink, StationPairing, StationSummary, VideoQuality } from "@neem/contracts";
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

/** The facility's lower-video-quality choice (slice 4b, D89). */
export function useVideoQuality(enabled = true) {
  return useQuery({
    queryKey: ["facility", "video-quality"],
    queryFn: ({ signal }) => api.get<VideoQuality>("/facility/video-quality", signal),
    enabled,
  });
}

export function useSetVideoQuality() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (lowData: boolean) => api.put<VideoQuality>("/facility/video-quality", { lowData }),
    onSuccess: invalidate,
  });
}

const mbps = (kbps: number) =>
  kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${kbps} kbit/s`;

/** "0.9 Mbit/s down · 240 kbit/s up · 410 ms", as the station measured it (D89). */
export function linkLabel(link: StationLink): string {
  return `${mbps(link.downKbps)} down · ${mbps(link.upKbps)} up · ${link.rttMs} ms`;
}

/** The most recent measurement among the facility's stations. */
export function latestLink(stations: StationSummary[] | undefined): StationLink | null {
  return (
    (stations ?? [])
      .map((station) => station.link)
      .filter((link): link is StationLink => link !== null)
      .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))[0] ?? null
  );
}
