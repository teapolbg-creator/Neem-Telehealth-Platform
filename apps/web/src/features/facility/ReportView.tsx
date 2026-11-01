import { useState } from "react";
import {
  REFERRAL_STATUS_LABELS,
  REFERRAL_URGENCY_LABELS,
  TRIAGE_CATEGORIES,
  TRIAGE_CATEGORY_INFO,
  type ReferralStatus,
  type ReferralUrgency,
  type ReportDay,
  type ReportTotals,
} from "@neem/contracts";
import { inputClass } from "@/features/facility/form";
import { TriageBadge } from "@/features/facility/TriageBadge";
import { PRESETS, minutes, type useReportRange } from "@/features/facility/report";

/**
 * What a report looks like on screen: the facility's (slice 2c, D82) and the
 * district's (slice 3b, D85) share every section but their own.
 */

export function RangePicker({ state }: { state: ReturnType<typeof useReportRange> }) {
  const { preset, setPreset, custom, setCustom } = state;
  return (
    <>
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
    </>
  );
}

export function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number;
  note?: string;
}) {
  return (
    <div className="card-soft p-4">
      <p className="text-3xl font-bold tabular-nums">{value}</p>
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      {note ? <p className="mt-1 text-xs text-slate-400">{note}</p> : null}
    </div>
  );
}

/** The figures every report shares, facility or district (D82, D85). */
export function ReportBody({ report }: { report: ReportTotals }) {
  const { attendance, consultations, referrals, followUps } = report;

  return (
    <div className="space-y-4">
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

      {report.days.length > 1 ? <AttendanceChart days={report.days} /> : null}

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
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
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
function AttendanceChart({ days }: { days: ReportDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((day) => day.visits));
  const shown = hover !== null ? days[hover]! : null;

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
            : `Most in a day: ${max === 1 && days.every((d) => d.visits === 0) ? 0 : max}`}
        </p>
      </div>
      <div
        className="mt-4 flex h-40 items-end gap-[2px] border-b border-slate-200"
        onMouseLeave={() => setHover(null)}
      >
        {days.map((day, index) => (
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
        <span>{days[0]!.date}</span>
        <span>{days[days.length - 1]!.date}</span>
      </div>
    </section>
  );
}
