import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DoctorRegistration,
  DoctorSummary,
  PharmacyRegistration,
  PharmacySummary,
} from '@neem/contracts';
import { api, API_BASE_URL } from '@/lib/api-client';

/**
 * Onboarding, verification and scheduling queries.
 *
 * These decide what the UI renders. Every rule they appear to apply —
 * eligibility, state transitions, the 40-hour ceiling — is enforced again by
 * the API, which is the actual boundary (spec §92).
 */

export interface LanguageOption {
  code: string;
  label: string;
  subtitle: string | null;
}

export function useLanguages() {
  return useQuery({
    queryKey: ['onboarding', 'languages'],
    queryFn: ({ signal }) => api.get<LanguageOption[]>('/onboarding/languages', signal),
    staleTime: 5 * 60_000,
  });
}

export interface CapabilityOption {
  code: string;
  label: string;
}

export function useCapabilities() {
  return useQuery({
    queryKey: ['onboarding', 'capabilities'],
    queryFn: ({ signal }) =>
      api.get<{ tests: CapabilityOption[]; equipment: CapabilityOption[] }>(
        '/onboarding/capabilities',
        signal,
      ),
    staleTime: 5 * 60_000,
  });
}

export interface RegistrationResult {
  publicId: string;
  status: string;
  message: string;
}

export function useRegisterPharmacy() {
  return useMutation({
    mutationFn: (input: PharmacyRegistration) =>
      api.post<RegistrationResult>('/onboarding/pharmacy', input),
  });
}

export function useRegisterDoctor() {
  return useMutation({
    mutationFn: (input: DoctorRegistration) =>
      api.post<RegistrationResult>('/onboarding/doctor', input),
  });
}

// ---------------------------------------------------------------------------
// Doctor self-service
// ---------------------------------------------------------------------------

export interface DoctorDocument {
  id: string;
  type: string;
  uploadedAt: string;
  verified: boolean;
  note: string | null;
  sizeBytes: number;
}

export interface ServiceHours {
  isoYear: number;
  isoWeek: number;
  minutesScheduled: number;
  minutesServed: number;
  limitMinutes: number;
  remainingMinutes: number;
}

export interface DoctorProfile {
  publicId: string;
  fullName: string;
  mdcNumber: string;
  mdcExpiresAt: string | null;
  specialty: string | null;
  bio: string | null;
  yearsExperience: number | null;
  status: string;
  statusReason: string | null;
  languages: Array<{ code: string; label: string; isPrimary: boolean }>;
  employmentType: string | null;
  contractedHoursPerWeek: number | null;
  documents: DoctorDocument[];
  signatureCapturedAt: string | null;
  subscription: {
    status: string;
    periodStart: string;
    periodEnd: string;
    amountMinor: number;
    currency: string;
  } | null;
  serviceHours: ServiceHours;
}

export const doctorProfileKey = ['doctor', 'profile'] as const;

export function useDoctorProfile() {
  return useQuery({
    queryKey: doctorProfileKey,
    queryFn: ({ signal }) => api.get<DoctorProfile>('/doctor/profile', signal),
  });
}

/**
 * Uploads a credential document.
 *
 * Uses fetch directly rather than the JSON client because the body is
 * multipart; the CSRF header is still attached, as it is for any mutation.
 */
export function useUploadDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { file: File; documentType: string }) => {
      const form = new FormData();
      form.append('documentType', input.documentType);
      form.append('file', input.file);

      const csrf = document.cookie.match(/(?:^|;\s*)neem_csrf=([^;]*)/)?.[1];

      const response = await fetch(`${API_BASE_URL}/api/v1/doctor/documents`, {
        method: 'POST',
        credentials: 'include',
        headers: csrf ? { 'x-neem-csrf': decodeURIComponent(csrf) } : {},
        body: form,
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? 'Upload failed.');
      }
      return payload.data as { id: string; uploadedAt: string };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: doctorProfileKey }),
  });
}

export function useCaptureSignature() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (signatureDataUrl: string) =>
      api.post<{ capturedAt: string }>('/doctor/signature', { signatureDataUrl }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: doctorProfileKey }),
  });
}

export interface DoctorShift {
  id: string;
  serviceDate: string;
  status: string;
  minutesPlanned: number;
  confirmedAt: string | null;
  shift: { code: string; label: string; startsAt: string; endsAt: string };
}

export function useDoctorShifts() {
  return useQuery({
    queryKey: ['doctor', 'shifts'],
    queryFn: ({ signal }) =>
      api.get<{ serviceHours: ServiceHours; shifts: DoctorShift[] }>('/doctor/shifts', signal),
  });
}

export function useConfirmShift() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.post(`/doctor/shifts/${id}/confirm`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['doctor', 'shifts'] }),
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface DirectoryFilters {
  awaitingReview?: boolean;
  status?: string;
  search?: string;
}

function directoryParams(filters: DirectoryFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.awaitingReview) params.set('awaitingReview', 'true');
  if (filters.status) params.set('status', filters.status);
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  return params;
}

export function useAdminDoctors(filters: DirectoryFilters = {}) {
  return useQuery({
    queryKey: ['admin', 'doctors', filters],
    queryFn: ({ signal }) =>
      api.get<DoctorSummary[]>(`/admin/doctors?${directoryParams(filters)}`, signal),
    // Keeps the previous list on screen while a search refines, instead of
    // flashing an empty state on every keystroke.
    placeholderData: (previous) => previous,
  });
}

export function useAdminPharmacies(filters: DirectoryFilters = {}) {
  return useQuery({
    queryKey: ['admin', 'pharmacies', filters],
    queryFn: ({ signal }) =>
      api.get<PharmacySummary[]>(`/admin/pharmacies?${directoryParams(filters)}`, signal),
    placeholderData: (previous) => previous,
  });
}

export function useAdminDoctorDetail(publicId: string | null) {
  return useQuery({
    queryKey: ['admin', 'doctor', publicId],
    queryFn: ({ signal }) => api.get<Record<string, unknown>>(`/doctors/${publicId}`, signal),
    enabled: Boolean(publicId),
  });
}

/** The transitions the state machine currently permits, so the UI offers only those. */
export function useAllowedTransitions(kind: 'doctors' | 'pharmacies', publicId: string | null) {
  return useQuery({
    queryKey: ['admin', kind, publicId, 'transitions'],
    queryFn: ({ signal }) =>
      api.get<{ current: string; allowed: string[] }>(
        `/admin/${kind}/${publicId}/transitions`,
        signal,
      ),
    enabled: Boolean(publicId),
  });
}

export function useChangeStatus(kind: 'doctors' | 'pharmacies') {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { publicId: string; status: string; reason?: string }) =>
      api.post(`/admin/${kind}/${input.publicId}/status`, {
        status: input.status,
        reason: input.reason,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useVerifyDocument(kind: 'doctors' | 'pharmacies') {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; verified: boolean; note?: string }) =>
      api.post(`/admin/${kind}/documents/${input.id}/verify`, {
        verified: input.verified,
        note: input.note,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export interface ShiftDefinition {
  code: string;
  label: string;
  startsAt: string;
  endsAt: string;
  crossesMidnight: boolean;
  isActive: boolean;
}

export function useShiftDefinitions() {
  return useQuery({
    queryKey: ['admin', 'shift-definitions'],
    queryFn: ({ signal }) => api.get<ShiftDefinition[]>('/admin/shifts/definitions', signal),
    staleTime: 5 * 60_000,
  });
}

export function useAssignShift() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { doctorPublicId: string; shiftCode: string; serviceDate: string }) =>
      api.post<{
        id: string;
        weeklyMinutesScheduled: number;
        weeklyLimitMinutes: number;
      }>('/admin/shifts', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useExpiringLicences() {
  return useQuery({
    queryKey: ['admin', 'licences', 'expiring'],
    queryFn: ({ signal }) =>
      api.get<
        Array<{
          publicId: string;
          fullName: string;
          mdcNumber: string;
          mdcExpiresAt: string;
          daysRemaining: number;
        }>
      >('/admin/doctors/licences/expiring', signal),
  });
}
