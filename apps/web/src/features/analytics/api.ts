import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * Admin analytics and configuration (spec §54, §96).
 *
 * Every figure crossing this boundary is operational — counts, durations,
 * money. Nothing here carries a diagnosis, a medication or a test result,
 * because no route behind it returns one.
 */

export interface ClinicalCoverage {
  consultationsInPeriod: number;
  recordsDestroyed: number;
  /** False once any record behind the period has been destroyed (D23). */
  complete: boolean;
}

export interface OperationalSummary {
  period: { from: string; to: string };
  consultations: {
    created: number;
    completed: number;
    cancelled: number;
    expired: number;
    abandoned: number;
    refunded: number;
    completionRate: number | null;
  };
  queue: {
    waitingNow: number;
    medianTimeToDoctorSeconds: number | null;
    noLanguageMatch: number;
    missedOffers: number;
  };
  consultationMinutes: { median: number | null; total: number };
  doctors: { active: number; onlineNow: number };
  pharmacies: { active: number; withConsultationsInPeriod: number };
}

export interface FinancialSummary {
  period: { from: string; to: string };
  currency: string;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  pharmacyShareMinor: number;
  neemShareMinor: number;
  refundedMinor: number;
  membershipMinor: number;
  paidConsultations: number;
  reversedAllocations: number;
}

export interface SatisfactionSummary {
  period: { from: string; to: string };
  responses: number;
  meanDoctorRating: number | null;
  meanNeemRating: number | null;
  compliments: number;
  suggestions: number;
  complaints: number;
  openComplaints: number;
  completedConsultations: number;
  responseRate: number | null;
}

export interface OutcomeMix {
  period: { from: string; to: string };
  outcomes: Array<{ outcome: string; count: number }>;
  unrecorded: number;
  coverage: ClinicalCoverage;
}

export function useOperationalSummary() {
  return useQuery({
    queryKey: ["admin", "analytics", "operational"],
    queryFn: ({ signal }) =>
      api.get<OperationalSummary>("/admin/analytics/operational", signal),
    refetchInterval: 30_000,
  });
}

export function useFinancialSummary() {
  return useQuery({
    queryKey: ["admin", "analytics", "financial"],
    queryFn: ({ signal }) => api.get<FinancialSummary>("/admin/analytics/financial", signal),
  });
}

export function useSatisfactionSummary() {
  return useQuery({
    queryKey: ["admin", "analytics", "satisfaction"],
    queryFn: ({ signal }) =>
      api.get<SatisfactionSummary>("/admin/analytics/satisfaction", signal),
  });
}

export function useOutcomeMix() {
  return useQuery({
    queryKey: ["admin", "analytics", "outcomes"],
    queryFn: ({ signal }) => api.get<OutcomeMix>("/admin/analytics/outcomes", signal),
  });
}

// ---------------------------------------------------------------------------
// Settings (spec §96)
// ---------------------------------------------------------------------------

export interface Setting {
  key: string;
  value: unknown;
  valueType: string;
  category: string;
  description: string | null;
  /** True when changing this requires a recorded reason. */
  requiresConfirm: boolean;
  updatedAt: string;
}

export const settingsKey = ["admin", "settings"] as const;

export function useSettings() {
  return useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => api.get<Setting[]>("/admin/settings", signal),
  });
}

export function useUpdateSetting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { key: string; value: unknown; reason?: string }) =>
      api.patch<{ key: string }>(`/admin/settings/${input.key}`, {
        value: input.value,
        reason: input.reason,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: settingsKey }),
  });
}

export interface SettingChange {
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  changedAt: string;
}

export function useSettingHistory(key: string, enabled: boolean) {
  return useQuery({
    queryKey: ["admin", "settings", key, "history"],
    queryFn: ({ signal }) =>
      api.get<SettingChange[]>(`/admin/settings/${key}/history`, signal),
    enabled,
  });
}

export interface NotificationTemplate {
  code: string;
  channel: string;
  locale: string;
  subject: string | null;
  body: string;
  isActive: boolean;
  updatedAt: string;
  /** What this notification is for — shown so an author is not guessing. */
  description: string | null;
  /** The only placeholders this notification can fill. */
  variables: string[];
  /** False once the wording has been changed from what Neem shipped. */
  isDefault: boolean;
}

const templatesKey = ['admin', 'notification-templates'];

/**
 * The notification catalogue (spec §58, §60, §96).
 *
 * Phase 8 built the templates, the allowed-variable lists and the validation
 * that stops one carrying clinical content. No screen ever imported any of
 * it, so the wording of every message Neem sends could only be changed in the
 * database.
 */
export function useNotificationTemplates() {
  return useQuery({
    queryKey: templatesKey,
    queryFn: ({ signal }) => api.get<NotificationTemplate[]>('/admin/notification-templates', signal),
  });
}

export function useUpdateNotificationTemplate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      code: string;
      channel: string;
      subject?: string | null;
      body?: string;
      isActive?: boolean;
    }) => {
      const { code, channel, ...changes } = input;
      return api.patch<NotificationTemplate>(
        `/admin/notification-templates/${code}/${channel}`,
        changes,
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: templatesKey }),
  });
}

export interface SystemHealth {
  status: "ready" | "degraded";
  environment: string;
  database: { status: "up" | "down"; latencyMs?: number };
  providers: Record<string, string>;
  mockedProviders: string[];
  /** True when any provider is mocked — this deployment cannot really take money. */
  demoMode: boolean;
}

/**
 * System health (spec §54).
 *
 * This lived on the unauthenticated `/health/ready` probe until Phase 10, and
 * nothing consumed it, so the dashboard never in fact showed demo mode — it
 * only had a comment saying it did. The probe now says whether the instance
 * can serve traffic and nothing else; the configuration is here, behind
 * authentication, and on the screen.
 */
export function useSystemHealth() {
  return useQuery({
    queryKey: ["admin", "system-health"],
    queryFn: ({ signal }) => api.get<SystemHealth>("/admin/system-health", signal),
    refetchInterval: 60_000,
  });
}
