import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { VisitAttachmentView, VisitPrescription } from "@neem/contracts";
import { API_BASE_URL, api, readCsrfToken } from "@/lib/api-client";

/**
 * Prescriptions given at the facility, and files kept with a visit (slice 2d,
 * D83).
 */

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["facility"] });
}

export function useDispenseHere(publicId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () =>
      api.post<VisitPrescription>(`/facility/prescriptions/${publicId}/dispense`, {}),
    onSuccess: invalidate,
  });
}

/** Multipart, so through fetch directly, with the CSRF header like any mutation. */
export function useAddAttachment(visitPublicId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: { file: File; label: string }) => {
      const form = new FormData();
      form.append("label", input.label);
      form.append("file", input.file);
      const csrf = readCsrfToken();
      const response = await fetch(
        `${API_BASE_URL}/api/v1/facility/visits/${visitPublicId}/attachments`,
        {
          method: "POST",
          credentials: "include",
          headers: csrf ? { "x-neem-csrf": csrf } : {},
          body: form,
        },
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "Upload failed.");
      return payload.data as VisitAttachmentView;
    },
    onSuccess: invalidate,
  });
}

/** Where a file is opened from; the browser sends the session cookie. */
export function attachmentUrl(publicId: string) {
  return `${API_BASE_URL}/api/v1/facility/attachments/${publicId}`;
}

export function doctorAttachmentUrl(consultationPublicId: string, publicId: string) {
  return `${API_BASE_URL}/api/v1/doctor/consultations/${consultationPublicId}/attachments/${publicId}`;
}

export function prescriptionPdfUrl(publicId: string) {
  return `${API_BASE_URL}/api/v1/documents/prescriptions/${publicId}.pdf`;
}

export function formatSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
