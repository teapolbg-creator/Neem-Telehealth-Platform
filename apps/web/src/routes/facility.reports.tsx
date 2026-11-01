import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import type { FacilityReport } from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { ApiError } from "@/lib/api-client";
import { useSession } from "@/features/auth/use-session";
import {
  downloadCsv,
  formatRange,
  useFacilityReport,
  useReportRange,
} from "@/features/facility/report";
import { RangePicker, ReportBody, Section } from "@/features/facility/ReportView";

export const Route = createFileRoute("/facility/reports")({
  component: ReportsPage,
});

/**
 * The facility's daily and monthly report (slice 2c, brief §A8, D82).
 * Every number is counted from the facility's own records.
 */
function ReportsPage() {
  const { user } = useSession();
  const rangeState = useReportRange();
  const { range } = rangeState;
  const report = useFacilityReport(range.from, range.to, user?.role === "FACILITY");

  return (
    <AppShell active="facility">
      <div className="mx-auto w-full max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-brand">Reports</p>
            <h1 className="mt-1 text-3xl font-bold">Facility report</h1>
            <p className="mt-1 text-sm text-slate-500">
              {report.data
                ? `${report.data.facility.name} · ${formatRange(report.data.from, report.data.to)}`
                : "Counted from this facility's records."}
            </p>
          </div>
          <button
            type="button"
            disabled={!report.data}
            onClick={() => report.data && downloadCsv(report.data)}
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <Download className="size-4" /> Download CSV
          </button>
        </div>

        <div className="card-soft mt-6 flex flex-wrap items-end gap-3 p-4">
          <RangePicker state={rangeState} />
        </div>

        {report.isLoading ? (
          <div className="card-soft mt-4 grid place-items-center p-16">
            <Loader2 className="size-6 animate-spin text-brand" />
          </div>
        ) : null}
        {report.error ? (
          <div className="card-soft mt-4 flex items-start gap-3 border-red-200 bg-red-50 p-6">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-700">
              {report.error instanceof ApiError
                ? report.error.message
                : "The report could not be produced."}
            </p>
          </div>
        ) : null}
        {report.data ? <Report report={report.data} /> : null}
      </div>
    </AppShell>
  );
}

function Report({ report }: { report: FacilityReport }) {
  return (
    <div className="mt-4 space-y-4">
      <ReportBody report={report} />
      <Section title="Presenting complaints, as written">
        {report.complaints.length === 0 ? (
          <p className="text-sm text-slate-500">No visits in this period.</p>
        ) : (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto text-sm">
            {report.complaints.map((complaint, index) => (
              <li key={index} className="flex gap-3 py-1.5">
                <span className="w-24 shrink-0 tabular-nums text-slate-400">{complaint.date}</span>
                <span>{complaint.text}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-slate-400">
          Listed, not counted by type: complaints are free text, so grouping them would be
          guesswork.
        </p>
      </Section>
    </div>
  );
}
