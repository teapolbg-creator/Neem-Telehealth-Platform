import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Calculator, Check, Loader2 } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { formatMinor } from "@/features/finance/api";
import {
  DISCIPLINE_LABEL,
  useCalculateProfessionalPayouts,
  useMarkProfessionalPayoutPaid,
  useProfessionalPayouts,
  useReconciliation,
  type ProfessionalPayout,
} from "@/features/professionals/api";

export const Route = createFileRoute("/admin/professional-payouts")({
  component: ProfessionalPay,
});

/** Last month, whole — the period a monthly payout is normally run for. */
function lastMonth(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/**
 * Paying doctors, dietitians and trainers their share (v2, D53).
 *
 * Monthly and by hand, as the pharmacies are paid. Neem works out what each
 * professional earned and records that somebody sent it. **Nothing here moves
 * money**, and the screen says so.
 *
 * The reconciliation sits above the list because it is what closes a month:
 * what patients paid, the provider's fees, what professionals earned, what
 * Neem kept, and what has actually been sent. They are separate records so
 * they can disagree, and this is where a disagreement shows.
 */
function ProfessionalPay() {
  const period = lastMonth();
  const [periodStart, setPeriodStart] = useState(period.start);
  const [periodEnd, setPeriodEnd] = useState(period.end);

  const payouts = useProfessionalPayouts();
  const calculate = useCalculateProfessionalPayouts();
  const reconciliation = useReconciliation({ periodStart, periodEnd });

  const inPeriod = (payouts.data ?? []).filter(
    (payout) => payout.periodStart === periodStart && payout.periodEnd === periodEnd,
  );

  return (
    <AppShell active="admin">
      <div className="mx-auto w-full max-w-4xl">
        <p className="text-xs font-bold uppercase tracking-wider text-brand">Neem Administration</p>
        <h1 className="mt-1 text-3xl font-bold">Professional pay</h1>
        <p className="mt-2 max-w-2xl text-pretty text-sm leading-relaxed text-slate-500">
          Each professional&rsquo;s share of the consultations they completed, paid monthly by
          transfer. Neem calculates and records; it does not send money.
        </p>

        <section className="card-soft mt-6 p-6">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-xs font-semibold text-slate-500">From</span>
              <input
                type="date"
                value={periodStart}
                onChange={(event) => setPeriodStart(event.target.value)}
                className="rounded-lg border border-border px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-xs font-semibold text-slate-500">To</span>
              <input
                type="date"
                value={periodEnd}
                onChange={(event) => setPeriodEnd(event.target.value)}
                className="rounded-lg border border-border px-3 py-2 text-sm"
              />
            </label>
            <button
              type="button"
              disabled={calculate.isPending}
              onClick={() => calculate.mutate({ periodStart, periodEnd })}
              className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
            >
              <Calculator className="size-4" />
              {calculate.isPending ? "Calculating…" : "Calculate payouts"}
            </button>
          </div>

          {calculate.data ? (
            <p className="mt-3 text-sm text-slate-600">
              {calculate.data.created} new, {calculate.data.updated} updated,{" "}
              {calculate.data.frozen} already paid and left as they were.
            </p>
          ) : null}
          {calculate.error ? (
            <p className="mt-3 text-sm text-red-600">
              {calculate.error instanceof ApiError ? calculate.error.message : "Not calculated."}
            </p>
          ) : null}

          {reconciliation.data ? (
            <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border pt-5 text-sm sm:grid-cols-3">
              <Figure label="Patients paid" value={reconciliation.data.collectedMinor} />
              <Figure label="Provider fees" value={reconciliation.data.feesMinor} />
              <Figure label="Professionals earned" value={reconciliation.data.earnedMinor} strong />
              <Figure label="Neem kept" value={reconciliation.data.neemMinor} />
              <Figure label="Sent" value={reconciliation.data.paidOutMinor} />
              <Figure
                label="Still to send"
                value={reconciliation.data.outstandingMinor}
                warn={reconciliation.data.outstandingMinor < 0}
              />
            </dl>
          ) : null}
        </section>

        <section className="mt-6 space-y-3">
          {payouts.isLoading ? (
            <div className="card-soft grid place-items-center p-12">
              <Loader2 className="size-6 animate-spin text-brand" />
            </div>
          ) : inPeriod.length === 0 ? (
            <p className="card-soft p-6 text-sm text-slate-500">
              No payouts for this period yet. Calculate them once the month has closed.
            </p>
          ) : (
            inPeriod.map((payout) => <PayoutCard key={payout.publicId} payout={payout} />)
          )}
        </section>
      </div>
    </AppShell>
  );
}

function Figure({
  label,
  value,
  strong,
  warn,
}: {
  label: string;
  value: number;
  strong?: boolean;
  warn?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd
        className={`tabular-nums ${strong ? "font-bold" : "font-semibold"} ${warn ? "text-red-600" : ""}`}
      >
        {formatMinor(value)}
      </dd>
    </div>
  );
}

/**
 * One professional's payout for the period.
 *
 * A reference is required to mark it paid: a payout marked paid with nothing to
 * trace it to cannot be told apart from one that was never sent. Once paid, the
 * figure is frozen and the API refuses to mark it paid again.
 */
function PayoutCard({ payout }: { payout: ProfessionalPayout }) {
  const markPaid = useMarkProfessionalPayoutPaid();
  const [reference, setReference] = useState("");
  const paid = payout.status !== "PENDING";

  return (
    <div className="card-soft p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-bold">{payout.professionalName}</p>
          <p className="text-xs text-slate-500">
            {DISCIPLINE_LABEL[payout.discipline] ?? payout.discipline} · {payout.periodStart} to{" "}
            {payout.periodEnd}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold tabular-nums">
            {formatMinor(payout.amountDueMinor, payout.currency)}
          </p>
          <Chip tone={paid ? "brand" : "warning"}>{paid ? "Paid" : "To send"}</Chip>
        </div>
      </div>

      {paid ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-slate-600">
          <Check className="size-4 text-medical" />
          Sent {formatMinor(payout.amountPaidMinor, payout.currency)}
          {payout.paymentReference ? `, reference ${payout.paymentReference}` : ""}
          {payout.paidAt ? ` on ${new Date(payout.paidAt).toLocaleDateString()}` : ""}.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold text-slate-500">
              Transfer reference
            </span>
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="e.g. MoMo transaction ID"
              className="w-64 rounded-lg border border-border px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            disabled={reference.trim().length < 3 || markPaid.isPending}
            onClick={() =>
              markPaid.mutate({ publicId: payout.publicId, paymentReference: reference.trim() })
            }
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            Mark as sent
          </button>
          {markPaid.error ? (
            <p className="flex items-center gap-1 pb-2 text-sm text-red-600">
              <AlertCircle className="size-4" />
              {markPaid.error instanceof ApiError ? markPaid.error.message : "Not saved."}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
