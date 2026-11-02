import { useInfiniteQuery } from "@tanstack/react-query";
import type { DoctorHistory } from "@neem/contracts";
import { api } from "@/lib/api-client";

export interface HistoryFilters {
  patient: string;
  facility: string;
  from: string;
  to: string;
}

/** A doctor's own consultations, 30 at a time (slice 5a, brief §B5, D91). */
export function useDoctorHistory(filters: HistoryFilters) {
  return useInfiniteQuery({
    queryKey: ["doctor", "history", filters],
    initialPageParam: null as string | null,
    getNextPageParam: (last: DoctorHistory) => last.nextCursor,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value.trim()) params.set(key, value.trim());
      }
      if (pageParam) params.set("cursor", pageParam);
      return api.get<DoctorHistory>(`/doctor/consultations/history?${params}`, signal);
    },
  });
}
