import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Download, Loader2 } from "lucide-react";
import {
  REFERRAL_STATUS_LABELS,
  REFERRAL_URGENCY_LABELS,
  TRIAGE_CATEGORIES,
  TRIAGE_CATEGORY_INFO,
  type FacilityReport,
  type ReferralStatus,
  type ReferralUrgency,
} from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { ApiError } from "@/lib/api-client";
import { useSession } from "@/features/auth/use-session";
import { inputClass } from "@/features/facility/form";
import { TriageBadge } from "@/features/facility/TriageBadge";
import { downloadCsv, presetRange, useFacilityReport } from "@/features/facility/report";

export const Route = createFileRoute("/facility/reports")({
  component: ReportsPage,
});

type Preset = "today" | "yesterday" | "thisMonth" | "lastMonth" | "custom";

const PRESETS: [Preset, string][] = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["thisMonth", "This month"],
  ["lastMonth", "Last month"],
  ["custom", "Choose dates"],
];

/**
 * The facility's daily and monthly report (slice 2c, brief §A8, D82).
 * Every number is counted from the facility's own records.
 */
function ReportsPage() {
  const { user } = useSession();
  const [preset, setPreset] = useState<Preset>("today");
  const [custom, setCustom] = useState(() => presetRange("thisMonth"));
  const range = preset === "custom" ? custom : presetRange(preset);
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
          <div className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1 text-sm font-semibold">
            {PRESETS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                data-on={preset === value}
                onClick={() => setPreset(value)}
                className="rounded-md px-3 py-1.5 text-slate-600 data-[on=true]:bg-white data-[on=true]:text-brand data-[on=true]:shadow-sm"
              >
                {label}
              </button>
            ))}
          </div>
          {preset === "custom" ? (
            <>
              <input
                type="date"
                aria-label="From"
                value={custom.from}
                onChange={(event) => setCustom({ ...custom, from: event.target.value })}
                className={`${inputClass} max-w-44`}
              />
              <input
                type="date"
                aria-label="To"
                value={custom.to}
                onChange={(event) => setCustom({ ...custom, to: event.target.value })}
                className={`${inputClass} max-w-44`}
              />
            </>
          ) : null}
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

function formatRange(from: string, to: string) {
  const format = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  return from === to ? format(from) : `${format(from)} – ${format(to)}`;
}

function Tile({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="card-soft p-4">
      <p className="text-3xl font-bold tabular-nums">{value}</p>
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      {note ? <p className="mt-1 text-xs text-slate-400">{note}</p> : null}
    </div>
  );
}

const minutes = (value: number | null) => (value === null ? "—" : `${value} min`);

function Report({ report }: { report: FacilityReport }) {
  const { attendance, consultations, referrals, followUps } = report;

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Visits" value={attendance.visits} />
        <Tile label="New patients" value={attendance.newPatients} />
        <Tile label="Emergencies" value={attendance.emergencies} />
        <Tile label="Doctor requests" value={consultations.requested} />
        <Tile
          label="Wait for a doctor"
          value={minutes(consultations.waitMinutes.median)}
          note="median, request to acceptance"
        />
        <Tile label="Referrals" value={referrals.issued} />
      </div>

      {report.days.length > 1 ? <AttendanceChart report={report} /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Attendance">
          <Rows
            rows={[
              ["Patients seen", attendance.patientsSeen],
              ["Completed at the facility", attendance.outcomes.CLOSED],
              ["Referred on", attendance.outcomes.REFERRED],
              ["Cancelled", attendance.outcomes.CANCELLED],
              ["Not yet ended", attendance.outcomes.OPEN],
            ]}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {TRIAGE_CATEGORIES.map((category) => (
              <span key={category} className="inline-flex items-center gap-1.5 text-sm">
                <TriageBadge category={category} />
                <span className="tabular-nums">{attendance.byTriage[category]}</span>
                <span className="sr-only">{TRIAGE_CATEGORY_INFO[category].label}</span>
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5 text-sm text-slate-500">
              Not triaged <span className="tabular-nums">{attendance.byTriage.NOT_TRIAGED}</span>
            </span>
          </div>
        </Section>

        <Section title="Neem doctors">
          <Rows
            rows={[
              ["Requested", consultations.requested],
              ["Completed", consultations.completed],
              ["Withdrawn by the facility", consultations.withdrawn],
              ["No doctor was available", consultations.noDoctorAvailable],
              ["Still open", consultations.inProgress],
              ["Wait, median", minutes(consultations.waitMinutes.median)],
              ["Wait, longest", minutes(consultations.waitMinutes.longest)],
              ["Consultation length, median", minutes(consultations.medianDurationMinutes)],
            ]}
          />
          {report.doctors.length > 0 ? (
            <table className="mt-3 w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="py-1 font-semibold">Doctor</th>
                  <th className="py-1 text-right font-semibold">Completed</th>
                  <th className="py-1 text-right font-semibold">Median length</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.doctors.map((doctor) => (
                  <tr key={doctor.name}>
                    <td className="py-1.5">{doctor.name}</td>
                    <td className="py-1.5 text-right tabular-nums">{doctor.completed}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {minutes(doctor.medianDurationMinutes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Section>

        <Section title="Referrals">
          <Rows
            rows={[
              ...(Object.entries(referrals.byUrgency) as [ReferralUrgency, number][]).map(
                ([key, count]) => [REFERRAL_URGENCY_LABELS[key], count] as [string, number],
              ),
              ...(Object.entries(referrals.byStatus) as [ReferralStatus, number][])
                .filter(([, count]) => count > 0)
                .map(([key, count]) => [REFERRAL_STATUS_LABELS[key], count] as [string, number]),
            ]}
          />
          {referrals.destinations.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Where to
              </p>
              <Rows rows={referrals.destinations.map((d) => [d.name, d.count])} />
            </div>
          ) : null}
        </Section>

        <Section title="Follow-ups due in this period">
          <Rows
            rows={[
              ["Due", followUps.due],
              ["Seen", followUps.done],
              ["Missed", followUps.missed],
              ["No longer needed", followUps.cancelled],
              ["Still due", followUps.stillDue],
            ]}
          />
        </Section>
      </div>

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card-soft p-5">
      <h2 className="mb-2 font-bold">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, string | number][] }) {
  return (
    <dl className="divide-y divide-border text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 py-1.5">
          <dt className="text-slate-600">{label}</dt>
          <dd className="font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Visits per day: one series, one colour, so no legend. Thin bars with
 * rounded tops anchored to the baseline, a 2px gap between them, and a hover
 * readout; the CSV is its table view.
 */
function AttendanceChart({ report }: { report: FacilityReport }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...report.days.map((day) => day.visits));
  const shown = hover !== null ? report.days[hover]! : null;

  return (
    <section className="card-soft p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-bold">Visits per day</h2>
        <p className="text-sm tabular-nums text-slate-500" aria-live="polite">
          {shown
            ? `${new Date(`${shown.date}T00:00:00Z`).toLocaleDateString(undefined, {
                weekday: "short",
                day: "numeric",
                month: "short",
                timeZone: "UTC",
              })}: ${shown.visits} visit${shown.visits === 1 ? "" : "s"}, ${shown.consultationsRequested} doctor request${shown.consultationsRequested === 1 ? "" : "s"}`
            : `Most in a day: ${max === 1 && report.days.every((d) => d.visits === 0) ? 0 : max}`}
        </p>
      </div>
      <div
        className="mt-4 flex h-40 items-end gap-[2px] border-b border-slate-200"
        onMouseLeave={() => setHover(null)}
      >
        {report.days.map((day, index) => (
          <button
            key={day.date}
            type="button"
            aria-label={`${day.date}: ${day.visits} visits`}
            onMouseEnter={() => setHover(index)}
            onFocus={() => setHover(index)}
            className="group flex h-full flex-1 items-end"
          >
            <span
              className={`block w-full rounded-t-[4px] ${hover === index ? "bg-brand" : "bg-brand/70"}`}
              style={{ height: day.visits ? `${(day.visits / max) * 100}%` : "2px" }}
            />
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs tabular-nums text-slate-400">
        <span>{report.days[0]!.date}</span>
        <span>{report.days[report.days.length - 1]!.date}</span>
      </div>
    </section>
  );
}
