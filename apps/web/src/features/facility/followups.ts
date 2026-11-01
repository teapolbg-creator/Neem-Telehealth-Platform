import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FollowUpCreate, FollowUpListRow, FollowUpView } from "@neem/contracts";
import { api } from "@/lib/api-client";

/** Follow-ups (slice 2b, D81): set by the CHO, resolved by the CHO. */

export function useFollowUpList(view: "due" | "upcoming" | "all", enabled = true) {
  return useQuery({
    queryKey: ["facility", "follow-ups", view],
    queryFn: ({ signal }) =>
      api.get<FollowUpListRow[]>(`/facility/follow-ups?view=${view}`, signal),
    enabled,
  });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["facility"] });
}

export function useSetFollowUp(visitPublicId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: FollowUpCreate) =>
      api.post<FollowUpView>(`/facility/visits/${visitPublicId}/follow-ups`, input),
    onSuccess: invalidate,
  });
}

export function useResolveFollowUp(publicId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (
      input:
        | { action: "complete"; note?: string }
        | { action: "missed"; note: string }
        | { action: "cancel"; reason: string },
    ) => {
      const { action, ...body } = input;
      return api.post<FollowUpView>(`/facility/follow-ups/${publicId}/${action}`, body);
    },
    onSuccess: invalidate,
  });
}

/** Today, in the browser's calendar, as YYYY-MM-DD. */
export function todayIso(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function formatDue(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
