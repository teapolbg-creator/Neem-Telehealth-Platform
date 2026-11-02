import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Feed } from "@neem/contracts";
import { api } from "@/lib/api-client";

const feedKey = ["notifications", "feed"] as const;

/** Polled gently: it is a pointer to the work, and the line may be thin (D92). */
export function useFeed(enabled: boolean) {
  return useQuery({
    queryKey: feedKey,
    queryFn: ({ signal }) => api.get<Feed>("/notifications/feed", signal),
    enabled,
    refetchInterval: 30_000,
    retry: false,
  });
}

export function useMarkFeedRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/notifications/feed/read"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: feedKey }),
  });
}
