import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Banknote, Calculator, Check, Loader2 } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  formatMinor,
  useAdminPayouts,
  useCalculatePayouts,
  useMarkPayoutPaid,
  type Payout,
} from "@/features/finance/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/payouts")({
  component: AdminPayouts,
});

/** The first day of the current month, and today, as `yyyy-mm-dd`. */
function defaultPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: start.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) };
}

/**
 * Pharmacy payouts (spec §40).
 *
 * Neem calculates what each pharmacy is owed and records that someone sent it.
 * **It does not transfer money.** Nothing on this screen moves funds, and the
 * copy says so — a "Mark as paid" button that quietly initiated a transfer
 * would be the worst possible thing for it to do.
 */
function AdminPayouts() {
  const period = defaultPeriod();
  const [pendingOnly, setPendingOnly] = useState(true);
  const [periodStart, setPeriodStart] = useState(period.start);
  const [periodEnd, setPeriodEnd] = useState(period.end);

  const { data: payouts, isLoading, error } = useAdminPayouts(pendingOnly);
  const calculate = useCalculatePayouts();

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Pharmacy payouts</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Each pharmacy's share of the consultations it hosted. Refunded consultations are excluded
          rather than netted off, so every figure traces back to the consultations behind it.
        </p>
      </header>

      <section className="card-soft p-6">
        <h2 className="flex items-center gap-2 font-bold">
          <Calculator className="size-4 text-brand" /> Work out a period
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Safe to re-run: a pending payout is updated as late consultations and refunds land. One
          already marked paid is left exactly as it was.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">From</span>
            <input
              type="date"
              value={periodStart}
              onChange={(event) => setPeriodStart(event.target.value)}
              className="mt-1 block rounded-xl border border-border px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              To (inclusive)
            </span>
            <input
              type="date"
              value={periodEnd}
              onChange={(event) => setPeriodEnd(event.target.value)}
              className="mt-1 block rounded-xl border border-border px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            disabled={calculate.isPending}
            onClick={() => calculate.mutate({ periodStart, periodEnd })}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
          >
            {calculate.isPending && <Loader2 className="size-4 animate-spin" />}
            Calculate
          </button>
        </div>

        {calculate.error && (
          <p className="mt-3 text-sm text-red-600">
            {calculate.error instanceof ApiError
              ? calculate.error.message
              : "The calculation failed."}
          </p>
        )}

        {calculate.isSuccess && (
          <p className="mt-3 text-sm text-slate-600">
            {calculate.data.created} created, {calculate.data.updated} updated,{" "}
            {calculate.data.frozen} left alone because they were already paid.
          </p>
        )}
      </section>

      <div className="flex w-fit gap-1 rounded-xl bg-slate-100 p-1">
        {[
          { key: true, label: "Owed" },
          { key: false, label: "All" },
        ].map((option) => (
          <button
            key={String(option.key)}
            type="button"
            onClick={() => setPendingOnly(option.key)}
            className={cn(
              "rounded-lg px-4 py-2 text-xs font-semibold transition-colors",
              pendingOnly === option.key
                ? "bg-white text-brand shadow-sm"
                : "text-slate-500 hover:bg-white/60",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      )}

      {error && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {error instanceof ApiError ? error.message : "Payouts could not be loaded."}
          </p>
        </div>
      )}

      {payouts?.length === 0 && (
        <div className="card-soft p-12 text-center">
          <Banknote className="mx-auto size-10 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">
            {pendingOnly ? "Nothing is owed right now." : "No payouts have been calculated yet."}
          </p>
        </div>
      )}

      <div className="space-y-4">
        {payouts?.map((payout) => <PayoutCard key={payout.publicId} payout={payout} />)}
      </div>
    </AppShell>
  );
}

function PayoutCard({ payout }: { payout: Payout }) {
  const markPaid = useMarkPayoutPaid();
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  const short = payout.status !== "PENDING" && payout.amountPaidMinor !== payout.amountDueMinor;

  return (
    <section className="card-soft p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold">{payout.pharmacyName}</h2>
          <p className="text-sm text-slate-500">
            {payout.periodStart} to {payout.periodEnd}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-brand">
            {formatMinor(payout.amountDueMinor, payout.currency)}
          </p>
          <Chip tone={payout.status === "PENDING" ? "warning" : "muted"}>
            {payout.status.toLowerCase()}
          </Chip>
        </div>
      </div>

      {payout.status !== "PENDING" && (
        <dl className="mt-4 space-y-2 rounded-2xl bg-slate-50 p-4 text-sm">
          <Row label="Paid" value={formatMinor(payout.amountPaidMinor, payout.currency)} />
          {short && (
            <p className="text-xs font-semibold text-amber-700">
              This is less than the amount due. The difference is still owed.
            </p>
          )}
          <Row label="Reference" value={payout.paymentReference ?? "—"} mono />
          <Row
            label="Sent"
            value={payout.paidAt ? new Date(payout.paidAt).toLocaleDateString() : "—"}
          />
          {payout.note && <Row label="Note" value={payout.note} />}
        </dl>
      )}

      {payout.status === "PENDING" && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Transfer reference
              </span>
              <input
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                maxLength={200}
                placeholder="MoMo transaction id"
                className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Note (optional)
              </span>
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
                className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
              />
            </label>
          </div>

          {markPaid.error && (
            <p className="mt-3 text-sm text-red-600">
              {markPaid.error instanceof ApiError
                ? markPaid.error.message
                : "This could not be recorded."}
            </p>
          )}

          <button
            type="button"
            disabled={reference.trim().length < 3 || markPaid.isPending}
            onClick={() =>
              markPaid.mutate({
                publicId: payout.publicId,
                paymentReference: reference.trim(),
                note: note.trim() || undefined,
              })
            }
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
          >
            {markPaid.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            Record this as sent
          </button>

          {/*
            Stated because the button could otherwise be read as initiating the
            transfer. It does not: Neem never moves money to a pharmacy.
          */}
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            This records a transfer you have already made. Neem does not send the money.
          </p>
        </>
      )}
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : "font-semibold"}>{value}</dd>
    </div>
  );
}
