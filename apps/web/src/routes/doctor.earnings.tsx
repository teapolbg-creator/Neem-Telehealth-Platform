import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle, CalendarClock, Loader2, Stethoscope, Wallet } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { ApiError } from "@/lib/api-client";
import { formatMinor, useDoctorEarnings } from "@/features/finance/api";

export const Route = createFileRoute("/doctor/earnings")({
  component: DoctorEarnings,
});

/**
 * What this doctor is owed (spec §26, decision D28).
 *
 * Their own contract and the hours behind it. No other doctor's figures, and
 * deliberately no rating or quality score — a doctor never sees those, and the
 * route behind this screen does not return them (spec §24, §52).
 *
 * Neem calculates and does not pay. The screen says so, because a figure shown
 * without that caveat reads as a balance about to arrive.
 */
function DoctorEarnings() {
  const { data, isLoading, error } = useDoctorEarnings();

  return (
    <AppShell active="doctor">
      <div className="mx-auto w-full max-w-2xl">
        <p className="text-xs font-bold uppercase tracking-wider text-brand">Doctor</p>
        <h1 className="mt-1 text-3xl font-bold">Earnings</h1>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-slate-500">
          Your pay for this month, from your contracted hours.
        </p>

        {isLoading && (
          <div className="card-soft mt-6 grid place-items-center p-16">
            <Loader2 className="size-6 animate-spin text-brand" />
          </div>
        )}

        {error && (
          <div className="card-soft mt-6 flex items-start gap-3 border-red-200 bg-red-50 p-6">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-700">
              {error instanceof ApiError ? error.message : "Your earnings could not be loaded."}
            </p>
          </div>
        )}

        {data && (
          <>
            <section className="card-soft mt-6 p-6">
              <div className="flex items-center gap-2 text-slate-400">
                <Wallet className="size-4" />
                <span className="text-xs font-bold uppercase tracking-wider">This month</span>
              </div>

              {data.monthlyMinor === null ? (
                /*
                  Not zero. "We have not agreed your hours" and "you are owed
                  nothing" are different statements, and showing GH₵ 0.00 would
                  make the first look like the second.
                */
                <>
                  <p className="mt-2 text-lg font-bold">Not yet set</p>
                  <p className="mt-1 text-sm text-slate-500">
                    Your contracted hours have not been recorded, so your pay cannot be calculated.
                    Neem administration can set them.
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-2 text-3xl font-bold text-brand">
                    {formatMinor(data.monthlyMinor, data.currency)}
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    {data.contractedHoursPerWeek} hours a week
                    {data.employmentType && ` · ${data.employmentType.toLowerCase().replace(/_/g, " ")}`}
                  </p>
                </>
              )}
            </section>

            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Stat icon={CalendarClock} label="Scheduled" value={data.scheduledLabel} />
              <Stat icon={CalendarClock} label="Served" value={data.servedLabel} />
              <Stat
                icon={Stethoscope}
                label="Consultations"
                value={String(data.consultationsThisPeriod)}
              />
            </div>

            <p className="mt-6 rounded-2xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-600">
              Neem calculates this figure and does not transfer it — payment is made separately
              (spec §26). Your membership fee is not deducted from it; that is billed on its own,
              on your <Link to="/doctor/membership" className="font-semibold text-brand">membership</Link>{" "}
              page.
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
}) {
  return (
    <div className="card-soft p-5">
      <div className="flex items-center gap-2 text-slate-400">
        <Icon className="size-4" />
        <span className="text-xs font-bold uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-1.5 text-xl font-bold">{value}</p>
    </div>
  );
}
