import { useQuery } from "@tanstack/react-query";
import type { FacilityReport } from "@neem/contracts";
import { api } from "@/lib/api-client";

/** A CHPS facility's report for a date range (slice 2c, D82). */
export function useFacilityReport(from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: ["facility", "report", from, to],
    queryFn: ({ signal }) =>
      api.get<FacilityReport>(`/facility/report?from=${from}&to=${to}`, signal),
    enabled: enabled && Boolean(from && to),
  });
}

const iso = (date: Date) => date.toISOString().slice(0, 10);

/** The report's presets, in UTC days, which are Ghana's. */
export function presetRange(preset: "today" | "yesterday" | "thisMonth" | "lastMonth"): {
  from: string;
  to: string;
} {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (preset) {
    case "today":
      return { from: iso(now), to: iso(now) };
    case "yesterday": {
      const day = new Date(Date.UTC(y, m, d - 1));
      return { from: iso(day), to: iso(day) };
    }
    case "thisMonth":
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(now) };
    case "lastMonth":
      return {
        from: iso(new Date(Date.UTC(y, m - 1, 1))),
        to: iso(new Date(Date.UTC(y, m, 0))),
      };
  }
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The report as CSV: the summary figures, then a row per day. Built from
 * exactly what the screen shows, so the two cannot disagree (D82).
 */
export function reportCsv(report: FacilityReport): string {
  const rows: (string | number | null)[][] = [
    ["Facility", report.facility.name],
    ["Code", report.facility.code],
    ["From", report.from],
    ["To", report.to],
    ["Generated", report.generatedAt],
    [],
    ["Visits", report.attendance.visits],
    ["New patients", report.attendance.newPatients],
    ["Patients seen", report.attendance.patientsSeen],
    ["Emergencies", report.attendance.emergencies],
    ["Triage red", report.attendance.byTriage.RED],
    ["Triage orange", report.attendance.byTriage.ORANGE],
    ["Triage yellow", report.attendance.byTriage.YELLOW],
    ["Triage green", report.attendance.byTriage.GREEN],
    ["Not triaged", report.attendance.byTriage.NOT_TRIAGED],
    ["Consultations requested", report.consultations.requested],
    ["Consultations completed", report.consultations.completed],
    ["Requests withdrawn", report.consultations.withdrawn],
    ["No doctor available", report.consultations.noDoctorAvailable],
    ["Median wait for a doctor (min)", report.consultations.waitMinutes.median],
    ["Median consultation length (min)", report.consultations.medianDurationMinutes],
    ["Referrals issued", report.referrals.issued],
    ["Follow-ups due", report.followUps.due],
    ["Follow-ups seen", report.followUps.done],
    ["Follow-ups missed", report.followUps.missed],
    [],
    ["Date", "Visits", "New patients", "Consultations requested", "Completed", "Referrals"],
    ...report.days.map((day) => [
      day.date,
      day.visits,
      day.newPatients,
      day.consultationsRequested,
      day.consultationsCompleted,
      day.referrals,
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

export function downloadCsv(report: FacilityReport) {
  const blob = new Blob([reportCsv(report)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `neem-${report.facility.code}-${report.from}-to-${report.to}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
