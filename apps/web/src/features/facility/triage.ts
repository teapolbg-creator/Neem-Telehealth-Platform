import { useQuery } from "@tanstack/react-query";
import type { TriageCategory, TriageCreate, TriageRule, VitalSigns } from "@neem/contracts";
import { api } from "@/lib/api-client";

/**
 * The approved protocol's rules, if any have been entered (D93). Kept once
 * fetched, so flags still appear on a walk-in triaged with no connection.
 */
export function useTriageProtocol() {
  return useQuery({
    queryKey: ["facility", "triage-protocol"],
    queryFn: ({ signal }) => api.get<TriageRule[]>("/facility/triage-protocol", signal),
    gcTime: Infinity,
    retry: false,
  });
}

/** The readings a CHO may record, in the order they are taken (D75). */
export const VITAL_FIELDS: { key: keyof VitalSigns; label: string; unit: string; step?: string }[] =
  [
    { key: "bpSystolic", label: "BP systolic", unit: "mmHg" },
    { key: "bpDiastolic", label: "BP diastolic", unit: "mmHg" },
    { key: "temperatureC", label: "Temperature", unit: "°C", step: "0.1" },
    { key: "pulseBpm", label: "Pulse", unit: "/min" },
    { key: "respiratoryRate", label: "Respiratory rate", unit: "/min" },
    { key: "spo2Percent", label: "Oxygen saturation", unit: "%" },
    { key: "weightKg", label: "Weight", unit: "kg", step: "0.1" },
    { key: "heightCm", label: "Height", unit: "cm", step: "0.1" },
    { key: "glucoseMmolL", label: "Blood glucose", unit: "mmol/L", step: "0.1" },
  ];

export function formatVitals(vitals: VitalSigns): string[] {
  const parts: string[] = [];
  if (vitals.bpSystolic && vitals.bpDiastolic) {
    parts.push(`BP ${vitals.bpSystolic}/${vitals.bpDiastolic}`);
  }
  for (const field of VITAL_FIELDS.slice(2)) {
    const value = vitals[field.key];
    if (value !== null && value !== undefined) parts.push(`${field.label} ${value} ${field.unit}`);
  }
  return parts;
}

/** A triage form as typed, before it is a request. */
export interface TriageDraft {
  category: TriageCategory | null;
  values: Record<string, string>;
  symptoms: string;
  observations: string;
}

export const EMPTY_TRIAGE: TriageDraft = {
  category: null,
  values: {},
  symptoms: "",
  observations: "",
};

/** The request, or null until a category is chosen. */
export function toTriage(draft: TriageDraft): TriageCreate | null {
  if (!draft.category) return null;
  const vitals: Record<string, number> = {};
  for (const [field, raw] of Object.entries(draft.values)) {
    if (raw.trim() !== "") vitals[field] = Number(raw);
  }
  return {
    category: draft.category,
    vitals,
    symptoms: draft.symptoms,
    observations: draft.observations,
  };
}
