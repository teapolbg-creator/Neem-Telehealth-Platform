import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AlertCircle, Download, Loader2, MapPin } from "lucide-react";
import type { DistrictOverview, DistrictReport, FacilitySummary } from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { CONNECTIVITY_LABEL, EQUIPMENT_LABEL, STATUS_LABEL } from "@/features/facility/api";
import { inputClass } from "@/features/facility/form";
import { formatRange, minutes, useReportRange } from "@/features/facility/report";
import { RangePicker, ReportBody, Section } from "@/features/facility/ReportView";
import {
  NO_FILTERS,
  downloadDistrictCsv,
  useDistrictReport,
  type DistrictFilters,
} from "@/features/district/report";
import { useDistrictOverview } from "@/features/staff/api";

export const Route = createFileRoute("/district/")({
  component: DistrictHome,
});

/**
 * A district health officer's dashboard (CHPS slices 3a and 3b, D84, D85):
 * the facility report summed over their area, facility by facility, and the
 * compounds' state. Read-only. The area comes from their account on the
 * server, so no filter on this page can widen it.
 */
function DistrictHome() {
  const overview = useDistrictOverview();

  return (
    <AppShell active="district">
      {overview.isLoading ? (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      ) : null}

      {overview.error ? (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {overview.error instanceof ApiError
              ? overview.error.message
              : "Your district could not be loaded."}
          </p>
        </div>
      ) : null}

      {overview.data ? (
        <>
          <header>
            <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-brand">
              <MapPin className="size-4" /> {overview.data.scope.label}
            </p>
            <h1 className="text-3xl font-bold tracking-tight">District dashboard</h1>
            <p className="mt-2 text-sm text-slate-500">
              {overview.data.officer.fullName}
              {overview.data.officer.title ? `, ${overview.data.officer.title}` : ""}. Counted from
              the records of the CHPS compounds using Neem in your area. Nothing here can be
              changed.
            </p>
          </header>

          {overview.data.facilities.length > 0 ? <Dashboard overview={overview.data} /> : null}

          <h2 className="pt-2 text-lg font-bold">Facilities</h2>
          {overview.data.facilities.length === 0 ? (
            <div className="card-soft p-6 text-sm text-slate-500">
              No CHPS compound in {overview.data.scope.label} uses Neem yet.
            </div>
          ) : (
            <FacilityTable overview={overview.data} />
          )}
        </>
      ) : null}
    </AppShell>
  );
}

/** Unique by id, in the order first seen (the overview is sorted by district, then name). */
function unique<T extends { id: string }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()];
}

function Dashboard({ overview }: { overview: DistrictOverview }) {
  const rangeState = useReportRange("thisMonth");
  const { range } = rangeState;
  const [filters, setFilters] = useState<DistrictFilters>(NO_FILTERS);
  const report = useDistrictReport(range.from, range.to, filters);

  // The choices come from the facilities the officer can already see, so a
  // filter offers nothing outside the area (and the API refuses it anyway).
  const options = useMemo(() => {
    const all = overview.facilities;
    const inDistrict = all.filter(
      (f) => !filters.districtId || f.location.district.id === filters.districtId,
    );
    const inSub = inDistrict.filter(
      (f) => !filters.subDistrictId || f.location.subDistrict?.id === filters.subDistrictId,
    );
    return {
      districts: unique(all.map((f) => f.location.district)),
      subDistricts: unique(
        inDistrict.flatMap((f) => (f.location.subDistrict ? [f.location.subDistrict] : [])),
      ),
      facilities: inSub,
    };
  }, [overview.facilities, filters.districtId, filters.subDistrictId]);

  return (
    <>
      <div className="card-soft flex flex-wrap items-end gap-3 p-4">
        <RangePicker state={rangeState} />
        {overview.scope.level === "REGION" && options.districts.length > 1 ? (
          <select
            aria-label="District"
            value={filters.districtId}
            onChange={(event) =>
              setFilters({ districtId: event.target.value, subDistrictId: "", facility: "" })
            }
            className={`${inputClass} max-w-56`}
          >
            <option value="">All districts</option>
            {options.districts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        ) : null}
        {overview.scope.level !== "SUB_DISTRICT" && options.subDistricts.length > 0 ? (
          <select
            aria-label="Sub-district"
            value={filters.subDistrictId}
            onChange={(event) =>
              setFilters({ ...filters, subDistrictId: event.target.value, facility: "" })
            }
            className={`${inputClass} max-w-56`}
          >
            <option value="">All sub-districts</option>
            {options.subDistricts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        ) : null}
        <select
          aria-label="Facility"
          value={filters.facility}
          onChange={(event) => setFilters({ ...filters, facility: event.target.value })}
          className={`${inputClass} max-w-56`}
        >
          <option value="">All facilities</option>
          {options.facilities.map((f) => (
            <option key={f.publicId} value={f.publicId}>
              {f.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!report.data}
          onClick={() => report.data && downloadDistrictCsv(report.data)}
          className="ml-auto inline-flex items-center gap-2 rounded-lg border border-border bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
        >
          <Download className="size-4" /> Download CSV
        </button>
      </div>

      {report.isLoading ? (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      ) : null}
      {report.error ? (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {report.error instanceof ApiError
              ? report.error.message
              : "The dashboard could not be produced."}
          </p>
        </div>
      ) : null}
      {report.data ? (
        <>
          <p className="text-sm text-slate-500">
            {report.data.filteredTo ?? report.data.scope.label} ·{" "}
            {formatRange(report.data.from, report.data.to)} · {report.data.byFacility.length}{" "}
            {report.data.byFacility.length === 1 ? "facility" : "facilities"}
          </p>
          <ReportBody report={report.data.totals} />
          {report.data.byFacility.length > 1 ? <Comparison report={report.data} /> : null}
        </>
      ) : null}
    </>
  );
}

const COMPARISON_HEADS = [
  "Visits",
  "New",
  "Red",
  "Emergencies",
  "Doctor requests",
  "Completed",
  "No doctor",
  "Median wait",
  "Referrals",
  "Missed follow-ups",
];

/**
 * Facility by facility, for the same period: a table, because the reader
 * compares across several measures at once. Sorted by visits so the busiest
 * compounds come first; a compound with none is still listed.
 */
function Comparison({ report }: { report: DistrictReport }) {
  const rows = [...report.byFacility].sort(
    (a, b) => b.visits - a.visits || a.name.localeCompare(b.name),
  );
  return (
    <Section title="Facility by facility">
      <div className="-mx-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs text-slate-500">
            <tr>
              <th className="px-5 py-2 font-semibold">Facility</th>
              {COMPARISON_HEADS.map((head) => (
                <th key={head} className="px-3 py-2 text-right font-semibold">
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.publicId}>
                <td className="px-5 py-2">
                  <p className="font-semibold">{row.name}</p>
                  <p className="text-xs text-slate-500">
                    {[row.subDistrict, report.scope.level === "REGION" ? row.district : null]
                      .filter(Boolean)
                      .join(", ") || row.code}
                  </p>
                </td>
                {[
                  row.visits,
                  row.newPatients,
                  row.red,
                  row.emergencies,
                  row.consultationsRequested,
                  row.consultationsCompleted,
                  row.noDoctorAvailable,
                  minutes(row.medianWaitMinutes),
                  row.referrals,
                  row.followUpsMissed,
                ].map((value, index) => (
                  <td key={COMPARISON_HEADS[index]} className="px-3 py-2 text-right tabular-nums">
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function FacilityTable({ overview }: { overview: DistrictOverview }) {
  const showDistrict = overview.scope.level === "REGION";
  return (
    <div className="card-soft overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-slate-500">
          <tr>
            <th className="px-4 py-3 font-semibold">Facility</th>
            {showDistrict ? <th className="px-4 py-3 font-semibold">District</th> : null}
            <th className="px-4 py-3 font-semibold">Community</th>
            <th className="px-4 py-3 font-semibold">Status</th>
            <th className="px-4 py-3 font-semibold">Equipment</th>
            <th className="px-4 py-3 font-semibold">Connectivity</th>
            <th className="px-4 py-3 text-right font-semibold">Staff</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {overview.facilities.map((facility) => (
            <FacilityRow key={facility.publicId} facility={facility} showDistrict={showDistrict} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FacilityRow({
  facility,
  showDistrict,
}: {
  facility: FacilitySummary;
  showDistrict: boolean;
}) {
  return (
    <tr>
      <td className="px-4 py-3">
        <p className="font-semibold">{facility.name}</p>
        <p className="text-xs text-slate-500">{facility.code}</p>
      </td>
      {showDistrict ? <td className="px-4 py-3">{facility.location.district.name}</td> : null}
      <td className="px-4 py-3">{facility.location.community}</td>
      <td className="px-4 py-3">
        <Chip tone={facility.status === "ACTIVE" ? "brand" : "muted"}>
          {STATUS_LABEL[facility.status]}
        </Chip>
      </td>
      <td className="px-4 py-3">{EQUIPMENT_LABEL[facility.equipmentStatus]}</td>
      <td className="px-4 py-3">{CONNECTIVITY_LABEL[facility.connectivityStatus]}</td>
      <td className="px-4 py-3 text-right tabular-nums">{facility.staffCount}</td>
    </tr>
  );
}
