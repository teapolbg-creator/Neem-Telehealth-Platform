import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, ArrowLeft, Loader2, MailQuestion } from "lucide-react";
import { NeemLogo } from "@/components/neem/Logo";
import { ApiError } from "@/lib/api-client";
import { useRequestPasswordReset } from "@/features/auth/use-session";

export const Route = createFileRoute("/auth/forgot")({
  component: ForgotPassword,
});

/**
 * Requesting a password reset (spec §93).
 *
 * Until this existed there was no way to ask for one from anywhere in the
 * product — the route was live and nothing linked to it, so a pharmacist or
 * doctor who forgot their password was simply locked out.
 *
 * The confirmation deliberately does not say whether the address has an
 * account. It does say whether Neem can send anything at all, because that is
 * a fact about the deployment rather than about the account, and pretending a
 * message is on its way when no email adapter exists would be the sort of
 * claim spec §93 forbids.
 */
function ForgotPassword() {
  const request = useRequestPasswordReset();
  const [email, setEmail] = useState("");

  return (
    <div className="grid min-h-dvh place-items-center bg-surface p-6">
      <div className="w-full max-w-md">
        <NeemLogo className="mx-auto text-xl" markClassName="size-9" />

        <div className="card-soft mt-6 p-8">
          {request.isSuccess ? (
            <Requested deliveryConfigured={request.data.deliveryConfigured} />
          ) : (
            <>
              <h1 className="text-2xl font-bold">Reset your password</h1>
              <p className="mt-2 text-pretty text-sm leading-relaxed text-slate-500">
                Enter the address you sign in with and we will send you a link to set a new
                password.
              </p>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  request.mutate(email.trim());
                }}
                className="mt-6"
              >
                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Email
                  </span>
                  <input
                    type="email"
                    required
                    autoComplete="username"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-border px-3 py-2.5 text-sm"
                  />
                </label>

                {request.error && (
                  <p className="mt-3 flex items-start gap-2 text-sm text-red-600">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    {request.error instanceof ApiError
                      ? request.error.message
                      : "The request could not be sent."}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={request.isPending || email.trim() === ""}
                  className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
                >
                  {request.isPending && <Loader2 className="size-4 animate-spin" />}
                  Send the reset link
                </button>
              </form>
            </>
          )}
        </div>

        <Link
          to="/auth/login"
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft className="size-4" /> Back to sign in
        </Link>
      </div>
    </div>
  );
}

function Requested({ deliveryConfigured }: { deliveryConfigured: boolean }) {
  return (
    <div className="text-center">
      <div className="mx-auto grid size-14 place-items-center rounded-full bg-brand/10">
        <MailQuestion className="size-7 text-brand" />
      </div>
      <h1 className="mt-5 text-xl font-bold">Request received</h1>

      {deliveryConfigured ? (
        <p className="mt-2 text-pretty text-sm leading-relaxed text-slate-500">
          If that address has a Neem account, a link to set a new password is on its way. It expires
          shortly, so use it soon.
        </p>
      ) : (
        <>
          <p className="mt-2 text-pretty text-sm leading-relaxed text-slate-500">
            If that address has a Neem account, a reset has been prepared for it.
          </p>
          {/*
            Said plainly rather than hidden. A locked-out pharmacist who is
            told to check their email will refresh an inbox that will never
            receive anything; told the truth, they pick up the phone.
          */}
          <p className="mt-4 rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-left text-xs leading-relaxed text-amber-900">
            <strong className="font-bold">No email has been sent.</strong> Automatic delivery is not
            switched on in this build, so nothing will arrive in your inbox. Contact your Neem
            administrator, who can give you the reset link directly.
          </p>
        </>
      )}
    </div>
  );
}
