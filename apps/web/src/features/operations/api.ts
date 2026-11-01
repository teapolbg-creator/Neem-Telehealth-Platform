import { useQuery } from "@tanstack/react-query";
import type { ChpsOperationsOverview } from "@neem/contracts";
import { api } from "@/lib/api-client";

/**
 * Neem operations' live view of CHPS (slice 3c, D86). Refreshed every 30
 * seconds while open, because it is watched rather than read once.
 */
export function useChpsOperations(days: number) {
  return useQuery({
    queryKey: ["admin", "chps", "overview", days],
    queryFn: ({ signal }) =>
      api.get<ChpsOperationsOverview>(`/admin/chps/overview?days=${days}`, signal),
    refetchInterval: 30_000,
  });
}

/** "4 min ago", "3 h ago", "2 days ago"; "Never" when there is no time. */
export function sinceLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return "Never";
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
