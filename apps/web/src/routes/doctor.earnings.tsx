import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, CalendarClock, Loader2, Stethoscope, Wallet } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { ApiError } from "@/lib/api-client";
import {
  formatMinor,
  useDoctorEarnings,
  useEarningStatement,
  type DoctorEarnings as Earnings,
  type EarningStatement,
} from "@/features/finance/api";

export const Route = createFileRoute("/doctor/earnings")({
  component: DoctorEarnings,
});

/**
 * What this professional is owed (spec §26, D28; v2).
 *
 * Two ways of being paid, and the screen shows the one that applies this month.
 * Doctors were salaried until the cut-over (2026-10-01) and earn a share of
 * each consultation from it; dietitians and trainers only ever earn a share.
 *
 * Their own figures only. No other professional's, and deliberately no rating
 * or quality score — the routes behind this screen do not return them (spec
 * §24, §52).
 *
 * Neem calculates and does not pay. The screen says so, because a figure shown
 * without that caveat reads as a balance about to arrive.
 */
function DoctorEarnings() {
  const { data, isLoading, error } = useDoctorEarnings();
  const statement = useEarningStatement();

  return (
    <AppShell active="doctor">
      <div className="mx-auto w-full max-w-2xl">
        <p className="text-xs font-bold uppercase tracking-wider text-brand">Doctor</p>
        <h1 className="mt-1 text-3xl font-bold">Earnings</h1>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-slate-500">
          {data?.paidBy === "SHARE"
            ? "Your share of each consultation you completed this month."
            : "Your pay for this month, from your contracted hours."}
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
            {data.paidBy === "SALARY" ? (
              <Salary earnings={data} />
            ) : (
              <Share statement={statement.data} loading={statement.isLoading} />
            )}

            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Stat icon={CalendarClock} label="Scheduled" value={data.scheduledLabel} />
              <Stat icon={CalendarClock} label="Served" value={data.servedLabel} />
              <Stat
                icon={Stethoscope}
                label="Consultations"
                value={String(data.consultationsThisPeriod)}
              />
            </div>

            {/*
              While a doctor is still salaried, anything they earn from a
              patient-direct booking is shown beneath the salary rather than
              hidden until the cut-over.
            */}
            {data.paidBy === "SALARY" && statement.data && statement.data.lines.length > 0 ? (
              <div className="mt-6">
                <Share statement={statement.data} loading={false} />
              </div>
            ) : null}

            <p className="mt-6 rounded-2xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-600">
              Neem calculates this figure and does not transfer it — payment is made separately,
              monthly, with a reference you can ask for.
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}

function Salary({ earnings }: { earnings: Earnings }) {
  return (
    <section className="card-soft mt-6 p-6">
      <div className="flex items-center gap-2 text-slate-400">
        <Wallet className="size-4" />
        <span className="text-xs font-bold uppercase tracking-wider">This month</span>
      </div>

      {earnings.monthlyMinor === null ? (
        /*
          Not zero. "We have not agreed your hours" and "you are owed nothing"
          are different statements, and showing GH₵ 0.00 would make the first
          look like the second.
        */
        <>
          <p className="mt-2 text-lg font-bold">Not yet set</p>
          <p className="mt-1 text-sm text-slate-500">
            Your contracted hours have not been recorded, so your pay cannot be calculated. Neem
            administration can set them.
          </p>
        </>
      ) : (
        <>
          <p className="mt-2 text-3xl font-bold text-brand">
            {formatMinor(earnings.monthlyMinor, earnings.currency)}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {earnings.contractedHoursPerWeek} hours a week
            {earnings.employmentType &&
              ` · ${earnings.employmentType.toLowerCase().replace(/_/g, " ")}`}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The share, line by line.
 *
 * Every line is shown, reversed ones included. A consultation that was refunded
 * earns nothing, and it says so beside the reference rather than vanishing —
 * somebody who remembers doing it should be able to see what happened to it.
 */
function Share({
  statement,
  loading,
}: {
  statement: EarningStatement | undefined;
  loading: boolean;
}) {
  if (loading || !statement) {
    return (
      <div className="card-soft mt-6 grid place-items-center p-16">
        <Loader2 className="size-6 animate-spin text-brand" />
      </div>
    );
  }

  return (
    <section className="card-soft mt-6 p-6">
      <div className="flex items-center gap-2 text-slate-400">
        <Wallet className="size-4" />
        <span className="text-xs font-bold uppercase tracking-wider">Your share this month</span>
      </div>

      <p className="mt-2 text-3xl font-bold text-brand">
        {formatMinor(statement.totalMinor, statement.currency)}
      </p>
      <p className="mt-1 text-sm text-slate-500">
        {statement.consultations === 1
          ? "From 1 consultation"
          : `From ${statement.consultations} consultations`}
      </p>

      {statement.lines.length > 0 ? (
        <div className="mt-5 divide-y divide-border border-t border-border">
          {statement.lines.map((line) => (
            <div key={line.consultationReference} className="py-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-xs text-slate-500">
                  {line.consultationReference}
                </span>
                <span
                  className={
                    line.reversed ? "font-semibold text-slate-400 line-through" : "font-semibold"
                  }
                >
                  {formatMinor(line.shareMinor, statement.currency)}
                </span>
              </div>
              {/*
                How the figure was reached, in the order it was worked out, so
                a professional can check it rather than take it on trust.
              */}
              <p className="mt-0.5 text-xs text-slate-400">
                {formatMinor(line.grossMinor, statement.currency)} paid
                {line.pharmacyShareMinor > 0
                  ? ` · pharmacy ${formatMinor(line.pharmacyShareMinor, statement.currency)}`
                  : ""}
                {line.feeMinor > 0
                  ? ` · fee ${formatMinor(line.feeMinor, statement.currency)}`
                  : ""}
                {` · ${line.sharePctBp / 100}% of ${formatMinor(line.netMinor, statement.currency)}`}
                {line.reversed ? " · refunded, not earned" : ""}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Wallet; label: string; value: string }) {
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
