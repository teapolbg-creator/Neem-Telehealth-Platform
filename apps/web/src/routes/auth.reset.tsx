import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { AlertCircle, Check, KeyRound, Loader2 } from "lucide-react";
import { PASSWORD_MIN_LENGTH } from "@neem/contracts";
import { NeemLogo } from "@/components/neem/Logo";
import { ApiError } from "@/lib/api-client";
import { useConfirmPasswordReset } from "@/features/auth/use-session";

export const Route = createFileRoute("/auth/reset")({
  // The token arrives in the link. Validated here so a malformed or missing
  // one produces a readable screen rather than a failed request.
  validateSearch: z.object({ token: z.string().optional() }),
  component: ResetPassword,
});

/**
 * Setting a new password from a reset link (spec §93).
 *
 * The API route this posts to has existed since Phase 1 with nothing calling
 * it, so a reset could be requested and never completed. This is the other
 * half.
 *
 * The token is read from the query string and never displayed, echoed into a
 * form field the browser might remember, or logged.
 */
function ResetPassword() {
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  const confirm = useConfirmPasswordReset();

  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");

  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const mismatch = repeat.length > 0 && repeat !== password;
  const ready = password.length >= PASSWORD_MIN_LENGTH && repeat === password && Boolean(token);

  return (
    <div className="grid min-h-dvh place-items-center bg-surface p-6">
      <div className="w-full max-w-md">
        <NeemLogo className="mx-auto text-xl" markClassName="size-9" />

        <div className="card-soft mt-6 p-8">
          {!token ? (
            <div className="text-center">
              <AlertCircle className="mx-auto size-10 text-slate-300" />
              <h1 className="mt-4 text-xl font-bold">This link is incomplete</h1>
              <p className="mt-2 text-pretty text-sm leading-relaxed text-slate-500">
                Open the reset link exactly as it was given to you, or request a new one.
              </p>
            </div>
          ) : confirm.isSuccess ? (
            <div className="text-center">
              <div className="mx-auto grid size-14 place-items-center rounded-full bg-brand/10">
                <Check className="size-7 text-brand" />
              </div>
              <h1 className="mt-5 text-xl font-bold">Password changed</h1>
              {/*
                The API clears every session cookie on a successful reset, so
                any other device that was signed in is now signed out. Worth
                saying: that is the point of resetting a password one suspects
                is known to somebody else.
              */}
              <p className="mt-2 text-pretty text-sm leading-relaxed text-slate-500">
                You have been signed out everywhere. Sign in with your new password.
              </p>
              <button
                type="button"
                onClick={() => void navigate({ to: "/auth/login" })}
                className="mt-6 w-full rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:brightness-110"
              >
                Go to sign in
              </button>
            </div>
          ) : (
            <>
              <div className="grid size-12 place-items-center rounded-full bg-brand/10">
                <KeyRound className="size-6 text-brand" />
              </div>
              <h1 className="mt-4 text-2xl font-bold">Set a new password</h1>
              <p className="mt-2 text-sm text-slate-500">
                At least {PASSWORD_MIN_LENGTH} characters.
              </p>

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (ready) confirm.mutate({ token, password });
                }}
                className="mt-6 space-y-4"
              >
                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    New password
                  </span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-border px-3 py-2.5 text-sm"
                  />
                  {tooShort && (
                    <span className="mt-1 block text-xs text-red-600">
                      Must be at least {PASSWORD_MIN_LENGTH} characters.
                    </span>
                  )}
                </label>

                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    Repeat it
                  </span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={repeat}
                    onChange={(event) => setRepeat(event.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-border px-3 py-2.5 text-sm"
                  />
                  {mismatch && (
                    <span className="mt-1 block text-xs text-red-600">
                      These do not match.
                    </span>
                  )}
                </label>

                {confirm.error && (
                  <p className="flex items-start gap-2 text-sm text-red-600">
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    {confirm.error instanceof ApiError
                      ? confirm.error.message
                      : "The password could not be changed."}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={!ready || confirm.isPending}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
                >
                  {confirm.isPending && <Loader2 className="size-4 animate-spin" />}
                  Change my password
                </button>
              </form>
            </>
          )}
        </div>

        <Link
          to="/auth/forgot"
          className="mt-6 inline-block text-sm font-semibold text-slate-500 hover:text-slate-900"
        >
          Request a new link
        </Link>
      </div>
    </div>
  );
}
