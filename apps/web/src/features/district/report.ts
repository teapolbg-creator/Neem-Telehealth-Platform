import { useQuery } from "@tanstack/react-query";
import type { DistrictReport } from "@neem/contracts";
import { api } from "@/lib/api-client";
import { saveCsv, toCsv, totalsCsvRows } from "@/features/facility/report";

/** The district dashboard (slice 3b, D85). */

export interface DistrictFilters {
  districtId: string;
  subDistrictId: string;
  facility: string;
}

export const NO_FILTERS: DistrictFilters = { districtId: "", subDistrictId: "", facility: "" };

export function useDistrictReport(from: string, to: string, filters: DistrictFilters) {
  const params = new URLSearchParams({ from, to });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return useQuery({
    queryKey: ["district", "report", params.toString()],
    queryFn: ({ signal }) => api.get<DistrictReport>(`/district/report?${params}`, signal),
    enabled: Boolean(from && to),
  });
}

/**
 * The dashboard as CSV: the area and filter, the summed figures and days, then
 * one row per facility, so a spreadsheet gets the comparison too.
 */
export function districtCsv(report: DistrictReport): string {
  return toCsv([
    ["Area", report.scope.label],
    ["Filtered to", report.filteredTo ?? ""],
    ["From", report.from],
    ["To", report.to],
    ["Generated", report.generatedAt],
    ["Facilities", report.byFacility.length],
    [],
    ...totalsCsvRows(report.totals),
    [],
    [
      "Facility",
      "Code",
      "District",
      "Sub-district",
      "Visits",
      "New patients",
      "Triage red",
      "Emergencies",
      "Doctor requests",
      "Completed",
      "No doctor available",
      "Median wait (min)",
      "Referrals",
      "Follow-ups missed",
    ],
    ...report.byFacility.map((row) => [
      row.name,
      row.code,
      row.district,
      row.subDistrict,
      row.visits,
      row.newPatients,
      row.red,
      row.emergencies,
      row.consultationsRequested,
      row.consultationsCompleted,
      row.noDoctorAvailable,
      row.medianWaitMinutes,
      row.referrals,
      row.followUpsMissed,
    ]),
  ]);
}

export function downloadDistrictCsv(report: DistrictReport) {
  const area = (report.filteredTo ?? report.scope.label).replace(/[^A-Za-z0-9]+/g, "-");
  saveCsv(districtCsv(report), `neem-${area}-${report.from}-to-${report.to}.csv`);
}
