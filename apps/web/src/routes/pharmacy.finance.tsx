import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, Banknote, Loader2, TrendingUp, Wallet } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { formatMinor, usePharmacyFinance } from "@/features/finance/api";

export const Route = createFileRoute("/pharmacy/finance")({
  component: PharmacyFinance,
});

/**
 * What this pharmacy has earned (spec §40).
 *
 * Its own share, and nothing else. Neem's share and other pharmacies' figures
 * are not returned by the route behind this screen, so there is nothing here
 * to hide in the first place.
 *
 * These are real figures from the revenue allocations, unlike the placeholder
 * numbers still on the dashboard — which is why this is a separate screen
 * rather than an edit to one carrying invented data.
 */
function PharmacyFinance() {
  const { data, isLoading, error } = usePharmacyFinance();

  return (
    <AppShell active="pharmacy">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Pharmacy</p>
        <h1 className="text-3xl font-bold tracking-tight">Earnings</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Your share of every consultation hosted here. Refunded consultations are not counted.
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
            {error instanceof ApiError ? error.message : "Your earnings could not be loaded."}
          </p>
        </div>
      )}

      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat
              icon={Wallet}
              label="Awaiting payout"
              value={formatMinor(data.awaitingPayoutMinor, data.currency)}
              hint="Earned and not yet settled"
            />
            <Stat
              icon={TrendingUp}
              label="Last 30 days"
              value={formatMinor(data.last30DaysMinor, data.currency)}
              hint={`${data.consultations30Days} consultation${data.consultations30Days === 1 ? "" : "s"}`}
            />
            <Stat
              icon={Banknote}
              label="All time"
              value={formatMinor(data.allTimeMinor, data.currency)}
              hint="Your share, since you joined"
            />
          </div>

          <section className="card-soft p-6">
            <h2 className="font-bold">Payouts</h2>
            <p className="mt-1 text-xs text-slate-500">
              Neem settles these by transfer. Each one shows the reference it was sent with.
            </p>

            {data.payouts.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">
                No payout has been prepared yet. Earnings above are still accruing.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-border">
                {data.payouts.map((payout) => (
                  <li
                    key={payout.publicId}
                    className="flex flex-wrap items-baseline justify-between gap-3 py-3"
                  >
                    <div>
                      <p className="text-sm font-semibold">
                        {payout.periodStart} to {payout.periodEnd}
                      </p>
                      {payout.paymentReference && (
                        <p className="font-mono text-[11px] text-slate-500">
                          {payout.paymentReference}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-bold">
                        {formatMinor(
                          payout.status === "PENDING"
                            ? payout.amountDueMinor
                            : payout.amountPaidMinor,
                          payout.currency,
                        )}
                      </span>
                      <Chip tone={payout.status === "PENDING" ? "warning" : "muted"}>
                        {payout.status.toLowerCase()}
                      </Chip>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="card-soft p-6">
      <div className="flex items-center gap-2 text-slate-400">
        <Icon className="size-4" />
        <span className="text-xs font-bold uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-bold">{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
    </div>
  );
}
