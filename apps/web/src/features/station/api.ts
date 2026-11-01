import { useMutation, useQuery } from "@tanstack/react-query";
import { STATION_HEADER, type MediaSessionView, type StationState } from "@neem/contracts";
import { ApiError, apiRequest } from "@/lib/api-client";

/**
 * The station screen's own calls (slice 1d, D77). It has no user session:
 * its credential is the httpOnly cookie set by pairing, and every request that
 * changes anything carries the station header the API insists on.
 */

const stationPost = <T>(path: string, body: unknown = {}) =>
  apiRequest<T>(path, { method: "POST", body, headers: { [STATION_HEADER]: "1" } });

export const stationStateKey = ["station", "state"] as const;

export function useStationState() {
  return useQuery({
    queryKey: stationStateKey,
    queryFn: ({ signal }) => apiRequest<StationState>("/station/state", { signal }),
    // Often enough that a doctor accepting shows within seconds; the screen
    // is the only thing the station does. Not while unpaired: a refetch with
    // no data resets the query to pending, which would wipe a half-typed code.
    refetchInterval: (query) =>
      query.state.error instanceof ApiError && query.state.error.status === 401 ? false : 4_000,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: true,
    retry: false,
  });
}

export function usePairStation() {
  return useMutation({
    mutationFn: (code: string) => stationPost<{ paired: boolean }>("/station/pair", { code }),
  });
}

export function useStationJoin() {
  return useMutation({
    mutationFn: () => stationPost<MediaSessionView>("/station/join"),
  });
}

export function useStationLeave() {
  return useMutation({
    mutationFn: () => stationPost<{ ok: boolean }>("/station/leave"),
  });
}
