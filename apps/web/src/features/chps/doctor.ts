import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChpsConsultationContext, EncounterContent, EncounterView } from "@neem/contracts";
import { api } from "@/lib/api-client";

/**
 * The doctor's side of a CHPS consultation (slice 1e, D78). Every fetch of the
 * context is logged against the patient on the server (D74), so it is fetched
 * once and refreshed only when something the doctor did changes it.
 */

const contextKey = (publicId: string) => ["doctor", "chps", publicId] as const;

export function useChpsContext(publicId: string, enabled: boolean) {
  return useQuery({
    queryKey: contextKey(publicId),
    queryFn: ({ signal }) =>
      api.get<ChpsConsultationContext>(`/doctor/consultations/${publicId}/chps`, signal),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useSaveEncounter(publicId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { content: EncounterContent; amendmentReason?: string }) =>
      api.put<EncounterView>(`/doctor/consultations/${publicId}/encounter`, input),
    onSuccess: (encounter) =>
      queryClient.setQueryData<ChpsConsultationContext>(contextKey(publicId), (current) =>
        current ? { ...current, encounter } : current,
      ),
  });
}
