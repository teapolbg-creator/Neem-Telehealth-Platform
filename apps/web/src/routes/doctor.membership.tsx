import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, BadgeCheck, ExternalLink, Loader2, ShieldAlert } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  formatMinor,
  useMembership,
  useMembershipPaymentStatus,
  useStartMembershipPayment,
  type Membership,
} from "@/features/finance/api";

export const Route = createFileRoute("/doctor/membership")({
  component: DoctorMembership,
});

/**
 * The doctor's membership (spec §27).
 *
 * A recurring fee that keeps an approved doctor active. Letting it lapse
 * suspends the account, so this screen exists to make that visible before it
 * happens rather than after.
 *
 * Nothing here activates a membership. Paying opens a provider checkout; the
 * period becomes active when the provider confirms the money server-side, and
 * the screen waits for that rather than assuming it (spec §34).
 */
function DoctorMembership() {
  const { data, isLoading, error } = useMembership();
  const start = useStartMembershipPayment();

  // Only while something is actually outstanding.
  const awaiting = start.isSuccess && data?.status !== "ACTIVE";
  useMembershipPaymentStatus(awaiting);

  return (
    <AppShell active="doctor">
      <div className="mx-auto w-full max-w-2xl">
        <p className="text-xs font-bold uppercase tracking-wider text-brand">Doctor</p>
        <h1 className="mt-1 text-3xl font-bold">Membership</h1>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-slate-500">
          Your membership keeps your account active on Neem. It is separate from what you earn —
          Neem does not deduct it from your pay.
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
              {error instanceof ApiError ? error.message : "Your membership could not be loaded."}
            </p>
          </div>
        )}

        {data && (
          <>
            {data.suspendedForNonPayment && (
              <div className="card-soft mt-6 flex items-start gap-3 border-red-200 bg-red-50 p-6">
                <ShieldAlert className="mt-0.5 size-5 shrink-0 text-red-500" />
                <div className="text-sm text-red-700">
                  <p className="font-bold">Your account is suspended for an unpaid membership.</p>
                  <p className="mt-1 leading-relaxed">
                    You will not be offered consultations until it is renewed. Paying below restores
                    your account straight away.
                  </p>
                </div>
              </div>
            )}

            <Summary membership={data} />

            {data.renewalDue && (
              <section className="card-soft mt-6 p-6">
                <h2 className="font-bold">
                  {data.status === "ACTIVE" ? "Renew early" : "Pay your membership"}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {formatMinor(data.amountMinor, data.currency)}
                  {data.status === "ACTIVE" &&
                    " — renewing early does not lose the time you have left; the new period starts when this one ends."}
                </p>

                {start.error && (
                  <p className="mt-3 text-sm text-red-600">
                    {start.error instanceof ApiError
                      ? start.error.message
                      : "The payment could not be started."}
                  </p>
                )}

                {start.isSuccess ? (
                  <PaymentStarted payment={start.data} />
                ) : (
                  <button
                    type="button"
                    disabled={start.isPending}
                    onClick={() => start.mutate()}
                    className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
                  >
                    {start.isPending && <Loader2 className="size-4 animate-spin" />}
                    Pay {formatMinor(data.amountMinor, data.currency)}
                  </button>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

const STATUS_TONE: Record<string, "brand" | "medical" | "warning" | "muted" | "danger"> = {
  ACTIVE: "medical",
  GRACE: "warning",
  PENDING: "warning",
  EXPIRED: "danger",
  CANCELLED: "muted",
  NONE: "muted",
};

function Summary({ membership }: { membership: Membership }) {
  const { daysRemaining } = membership;

  return (
    <section className="card-soft mt-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <BadgeCheck
              className={membership.status === "ACTIVE" ? "size-5 text-brand" : "size-5 text-slate-300"}
            />
            <h2 className="text-lg font-bold">
              {membership.status === "NONE" ? "No membership yet" : "Your membership"}
            </h2>
          </div>
          {membership.periodEnd && (
            <p className="mt-1 text-sm text-slate-500">
              {membership.status === "ACTIVE" || membership.status === "GRACE"
                ? `Runs until ${new Date(membership.periodEnd).toLocaleDateString()}`
                : `Ended ${new Date(membership.periodEnd).toLocaleDateString()}`}
            </p>
          )}
        </div>
        <Chip tone={STATUS_TONE[membership.status] ?? "muted"}>
          {membership.status.toLowerCase()}
        </Chip>
      </div>

      {/*
        The countdown is the point of the screen. A doctor who does not know
        their membership is ending finds out by being suspended, which is the
        worst possible way to learn it.
      */}
      {daysRemaining !== null && membership.status !== "EXPIRED" && (
        <p className="mt-4 text-sm font-semibold">
          {daysRemaining > 0
            ? `${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining`
            : "Your membership period has ended"}
        </p>
      )}

      {membership.graceEndsAt && membership.status === "GRACE" && (
        <p className="mt-2 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900">
          You are in a grace period until{" "}
          <strong className="font-bold">
            {new Date(membership.graceEndsAt).toLocaleDateString()}
          </strong>
          . Your account is suspended after that until the fee is paid.
        </p>
      )}
    </section>
  );
}

function PaymentStarted({
  payment,
}: {
  payment: { authorizationUrl: string | null; isMockProvider: boolean };
}) {
  const [opened, setOpened] = useState(false);

  return (
    <div className="mt-4 rounded-2xl bg-slate-50 p-4">
      {payment.isMockProvider ? (
        /*
          Said plainly. A development build must never look like it took money
          (spec §93), and a doctor testing the flow should be in no doubt.
        */
        <p className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
          <strong className="font-bold">No payment was actually taken.</strong> Payments are
          simulated in this build, so nothing has been charged.
        </p>
      ) : payment.authorizationUrl ? (
        <a
          href={payment.authorizationUrl}
          target="_blank"
          rel="noreferrer"
          onClick={() => setOpened(true)}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110"
        >
          <ExternalLink className="size-4" /> Continue to payment
        </a>
      ) : (
        <p className="text-sm text-slate-600">
          A payment is already in progress. Complete it on your phone, or come back shortly.
        </p>
      )}

      <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
        <Loader2 className="size-3.5 animate-spin" />
        {opened
          ? "Waiting for the payment to be confirmed…"
          : "This page updates on its own once the payment is confirmed."}
      </p>
    </div>
  );
}
