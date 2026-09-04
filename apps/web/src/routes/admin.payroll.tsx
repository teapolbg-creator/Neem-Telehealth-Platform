import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, Loader2, Users } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { formatMinor, useAdminPayroll } from "@/features/finance/api";

export const Route = createFileRoute("/admin/payroll")({
  component: AdminPayroll,
});

/**
 * Doctor payroll (spec §26, decision D28).
 *
 * **Neem calculates and never pays.** There is no button on this screen that
 * transfers anything, and no route behind one — the figures go to whoever runs
 * payroll, who makes the transfer outside the system. That boundary is the
 * difference between a reporting feature and a payroll system.
 */
function AdminPayroll() {
  const { data, isLoading, error } = useAdminPayroll();

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Doctor payroll</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          What each doctor is owed for the current month, from their contracted hours. Neem does not
          transfer salaries — these figures are for whoever makes the payment.
        </p>
      </header>

      {isLoading && (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      )}

      {error && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {error instanceof ApiError ? error.message : "Payroll could not be calculated."}
          </p>
        </div>
      )}

      {data && (
        <>
          <div className="card-soft flex flex-wrap items-end justify-between gap-4 p-6">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Total for the period
              </p>
              <p className="mt-1 text-3xl font-bold text-brand">
                {formatMinor(data.totalMinor, data.currency)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                ISO weeks {data.period.fromIsoWeek}–{data.period.toIsoWeek} of {data.period.isoYear}
                {" · "}
                full week is {data.fullTimeHoursPerWeek} hours at{" "}
                {formatMinor(data.fullTimeMonthlyMinor, data.currency)} a month
              </p>
            </div>
            <p className="text-sm text-slate-500">
              {data.lines.length} doctor{data.lines.length === 1 ? "" : "s"}
            </p>
          </div>

          {/*
            Omitted doctors are surfaced rather than silently reducing the
            total. A missing contract is a gap in the record, not a doctor who
            is owed nothing.
          */}
          {data.doctorsWithoutContract > 0 && (
            <div className="card-soft flex items-start gap-3 border-amber-300/60 bg-amber-50 p-5">
              <AlertCircle className="mt-0.5 size-5 shrink-0 text-amber-600" />
              <p className="text-sm leading-relaxed text-amber-900">
                <strong className="font-bold">
                  {data.doctorsWithoutContract} doctor
                  {data.doctorsWithoutContract === 1 ? " has" : "s have"} no contracted hours
                  recorded
                </strong>{" "}
                and {data.doctorsWithoutContract === 1 ? "is" : "are"} not in this total. Their pay
                cannot be calculated until their contract is set.
              </p>
            </div>
          )}

          {data.lines.length === 0 ? (
            <div className="card-soft p-12 text-center">
              <Users className="mx-auto size-10 text-slate-300" />
              <p className="mt-3 text-sm text-slate-500">
                No doctor has contracted hours recorded yet.
              </p>
            </div>
          ) : (
            <div className="card-soft overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left">
                  <tr className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    <th className="px-5 py-3">Doctor</th>
                    <th className="px-5 py-3">Contract</th>
                    <th className="px-5 py-3">Scheduled</th>
                    <th className="px-5 py-3">Served</th>
                    <th className="px-5 py-3 text-right">Owed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.lines.map((line) => (
                    <tr key={line.doctorPublicId}>
                      <td className="px-5 py-3">
                        <span className="font-semibold">{line.fullName}</span>
                        {line.isFullTime && (
                          <Chip tone="muted" className="ml-2">
                            full time
                          </Chip>
                        )}
                      </td>
                      <td className="px-5 py-3 text-slate-600">
                        {line.contractedHoursPerWeek} h/week
                      </td>
                      <td className="px-5 py-3 text-slate-600">{line.scheduledLabel}</td>
                      <td className="px-5 py-3">
                        <span
                          className={line.shortOfContract ? "text-amber-700" : "text-slate-600"}
                        >
                          {line.servedLabel}
                        </span>
                        {/*
                          Flagged, never deducted. The formula pays the
                          contract (D28); a shortfall is a question for a
                          person, not an adjustment this screen makes.
                        */}
                        {line.shortOfContract && (
                          <span className="ml-2 text-xs font-semibold text-amber-700">
                            below contract
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right font-mono font-bold">
                        {formatMinor(line.monthlyMinor, line.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs leading-relaxed text-slate-500">
            Part-time pay is the full-time figure scaled by contracted hours over a full week
            (decision D28), rounded down to the pesewa. Neem never transfers doctor salary (spec
            §26).
          </p>
        </>
      )}
    </AppShell>
  );
}
