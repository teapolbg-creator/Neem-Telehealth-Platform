import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, Copy, Loader2, ShieldCheck } from "lucide-react";
import { NeemLogo } from "@/components/neem/Logo";
import { ApiError } from "@/lib/api-client";
import {
  useBeginTwoFactorEnrollment,
  useLogin,
  useSession,
  useVerifyTwoFactor,
  type TwoFactorEnrollment,
} from "@/features/auth/use-session";

export const Route = createFileRoute("/auth/login")({
  component: SignIn,
});

type Stage =
  | { name: "credentials" }
  | { name: "enroll"; challengeId: string; enrollment: TwoFactorEnrollment }
  | { name: "code"; challengeId: string; enrolling: boolean }
  | { name: "recovery"; codes: string[] };

const HOME_FOR_ROLE: Record<string, string> = {
  PHARMACY: "/pharmacy",
  DOCTOR: "/doctor",
  ADMIN: "/admin",
};

function SignIn() {
  const navigate = useNavigate();
  const { user } = useSession();
  const [stage, setStage] = useState<Stage>({ name: "credentials" });

  // Once /auth/me resolves to a principal, send them to their own portal.
  // Signing in never lands anyone on a portal their role cannot use.
  useEffect(() => {
    if (user && stage.name !== "recovery") {
      void navigate({ to: HOME_FOR_ROLE[user.role] ?? "/" });
    }
  }, [user, stage.name, navigate]);

  return (
    <div className="min-h-dvh bg-surface flex flex-col">
      <header className="px-6 py-5">
        <NeemLogo className="text-xl" markClassName="size-9" />
      </header>

      <main className="flex-1 flex items-start sm:items-center justify-center px-4 pb-16">
        <div className="w-full max-w-md">
          {stage.name === "credentials" && (
            <CredentialsStep
              onChallenge={(challengeId, enrollmentRequired) =>
                setStage({ name: "code", challengeId, enrolling: enrollmentRequired })
              }
            />
          )}

          {stage.name === "code" && (
            <CodeStep
              challengeId={stage.challengeId}
              enrolling={stage.enrolling}
              onEnrollmentReady={(enrollment) =>
                setStage({ name: "enroll", challengeId: stage.challengeId, enrollment })
              }
              onRecoveryCodes={(codes) => setStage({ name: "recovery", codes })}
            />
          )}

          {stage.name === "enroll" && (
            <EnrollStep
              enrollment={stage.enrollment}
              onRecoveryCodes={(codes) => setStage({ name: "recovery", codes })}
            />
          )}

          {stage.name === "recovery" && (
            <RecoveryCodesStep
              codes={stage.codes}
              onContinue={() => navigate({ to: HOME_FOR_ROLE[user?.role ?? ""] ?? "/" })}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function CredentialsStep({
  onChallenge,
}: {
  onChallenge: (challengeId: string, enrollmentRequired: boolean) => void;
}) {
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    login.mutate(
      { email, password },
      {
        onSuccess: (result) => {
          if (result.status === "TWO_FACTOR_REQUIRED") {
            onChallenge(result.challengeId, result.enrollmentRequired);
          }
          // On AUTHENTICATED the session query invalidates and the effect in
          // SignIn performs the redirect.
        },
      },
    );
  };

  return (
    <div className="card-soft p-8">
      <h1 className="text-2xl font-bold">Sign in to Neem</h1>
      <p className="text-sm text-slate-500 mt-1">
        For pharmacy, doctor and administrator accounts.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={setEmail}
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          required
        />

        <ErrorNotice error={login.error} />

        <button
          type="submit"
          disabled={login.isPending || !email || !password}
          className="w-full bg-brand text-white font-semibold py-3.5 rounded-xl hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {login.isPending && <Loader2 className="size-4 animate-spin" />}
          Sign in
        </button>
      </form>

      {/*
        The reset flow existed as two API routes with nothing linking to them,
        which made it unreachable — a forgotten password meant a locked
        account with no self-service path at all.
      */}
      <Link
        to="/auth/forgot"
        className="mt-4 inline-block text-sm font-semibold text-slate-500 hover:text-slate-900"
      >
        Forgot your password?
      </Link>

      <p className="mt-6 text-xs text-slate-500 leading-relaxed">
        Patients do not sign in. A consultation opens from the one-time QR code the pharmacy
        provides.
      </p>
    </div>
  );
}

function CodeStep({
  challengeId,
  enrolling,
  onEnrollmentReady,
  onRecoveryCodes,
}: {
  challengeId: string;
  enrolling: boolean;
  onEnrollmentReady: (enrollment: TwoFactorEnrollment) => void;
  onRecoveryCodes: (codes: string[]) => void;
}) {
  const beginEnrollment = useBeginTwoFactorEnrollment();
  const verify = useVerifyTwoFactor();
  const [code, setCode] = useState("");

  /**
   * An admin who has not enrolled cannot proceed to a code prompt — there is
   * nothing to generate a code from yet. Fetch the secret first (spec §9).
   *
   * Guarded by a ref, not by `isIdle`. The mutation is asynchronous, so
   * `isIdle` is still true when React re-runs this effect, and a second
   * enrolment call would mint a NEW secret server-side while the screen still
   * displays the first — leaving the admin typing codes that can never verify.
   */
  const enrolmentStarted = useRef(false);

  useEffect(() => {
    if (!enrolling || enrolmentStarted.current) return;

    enrolmentStarted.current = true;
    beginEnrollment.mutate(challengeId, { onSuccess: onEnrollmentReady });
  }, [enrolling, challengeId, beginEnrollment, onEnrollmentReady]);

  if (enrolling) {
    return (
      <div className="card-soft p-8 text-center">
        <Loader2 className="size-6 animate-spin text-brand mx-auto" />
        <p className="mt-4 text-sm text-slate-500">Preparing two-factor setup…</p>
        <ErrorNotice error={beginEnrollment.error} />
      </div>
    );
  }

  return (
    <div className="card-soft p-8">
      <div className="size-11 rounded-xl bg-medical/10 text-medical grid place-items-center">
        <ShieldCheck className="size-5" />
      </div>
      <h1 className="text-2xl font-bold mt-4">Two-factor code</h1>
      <p className="text-sm text-slate-500 mt-1">
        Enter the 6-digit code from your authenticator app, or one of your recovery codes.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          verify.mutate(
            { challengeId, code },
            {
              onSuccess: (result) => {
                if (result.recoveryCodes) onRecoveryCodes(result.recoveryCodes);
              },
            },
          );
        }}
        className="mt-6 space-y-4"
        noValidate
      >
        <Field
          id="code"
          label="Authentication code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={setCode}
          className="text-center text-lg tracking-[0.4em] font-mono"
          required
        />

        <ErrorNotice error={verify.error} />

        <button
          type="submit"
          disabled={verify.isPending || code.length < 6}
          className="w-full bg-brand text-white font-semibold py-3.5 rounded-xl hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {verify.isPending && <Loader2 className="size-4 animate-spin" />}
          Verify
        </button>
      </form>
    </div>
  );
}

function EnrollStep({
  enrollment,
  onRecoveryCodes,
}: {
  enrollment: TwoFactorEnrollment;
  onRecoveryCodes: (codes: string[]) => void;
}) {
  const verify = useVerifyTwoFactor();
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);

  return (
    <div className="card-soft p-8">
      <h1 className="text-2xl font-bold">Set up two-factor authentication</h1>
      <p className="text-sm text-slate-500 mt-1">
        Administrator accounts require an authenticator app. This step cannot be skipped.
      </p>

      <div className="mt-6 p-5 rounded-2xl bg-slate-50 border border-border flex flex-col items-center">
        <img
          src={enrollment.qrDataUrl}
          alt="Two-factor setup QR code"
          width={200}
          height={200}
          className="rounded-xl bg-white p-2"
        />
        <p className="mt-4 text-xs text-slate-500 text-center">
          Scan with Google Authenticator, 1Password, Authy, or any TOTP app.
        </p>

        <div className="mt-4 w-full">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">
            Or enter this key manually
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-white border border-border rounded-lg text-xs font-mono break-all">
              {enrollment.secret}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(enrollment.secret);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="p-2 rounded-lg border border-border hover:bg-white shrink-0"
              aria-label="Copy setup key"
            >
              <Copy className="size-4 text-slate-500" />
            </button>
          </div>
          {copied && <p className="mt-1 text-[11px] text-brand font-semibold">Copied</p>}
        </div>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          verify.mutate(
            { challengeId: enrollment.challengeId, code },
            {
              onSuccess: (result) => {
                if (result.recoveryCodes) onRecoveryCodes(result.recoveryCodes);
              },
            },
          );
        }}
        className="mt-6 space-y-4"
        noValidate
      >
        <Field
          id="enroll-code"
          label="Enter the 6-digit code to confirm"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={setCode}
          className="text-center text-lg tracking-[0.4em] font-mono"
          required
        />

        <ErrorNotice error={verify.error} />

        <button
          type="submit"
          disabled={verify.isPending || code.length < 6}
          className="w-full bg-brand text-white font-semibold py-3.5 rounded-xl hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {verify.isPending && <Loader2 className="size-4 animate-spin" />}
          Confirm and sign in
        </button>
      </form>
    </div>
  );
}

function RecoveryCodesStep({ codes, onContinue }: { codes: string[]; onContinue: () => void }) {
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div className="card-soft p-8">
      <h1 className="text-2xl font-bold">Save your recovery codes</h1>
      <p className="text-sm text-slate-500 mt-1">
        Each code works once, if you lose access to your authenticator. They are shown now and
        cannot be retrieved later.
      </p>

      <ul className="mt-6 grid grid-cols-2 gap-2">
        {codes.map((code) => (
          <li
            key={code}
            className="px-3 py-2.5 bg-slate-50 border border-border rounded-lg text-sm font-mono text-center"
          >
            {code}
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={() => void navigator.clipboard.writeText(codes.join("\n"))}
        className="mt-4 w-full py-2.5 rounded-xl border border-border text-sm font-semibold hover:bg-slate-50 flex items-center justify-center gap-2"
      >
        <Copy className="size-4" /> Copy all codes
      </button>

      <label className="mt-6 flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-0.5 size-4 accent-[var(--brand)]"
        />
        <span className="text-sm text-slate-600">I have saved these codes somewhere safe.</span>
      </label>

      <button
        type="button"
        onClick={onContinue}
        disabled={!acknowledged}
        className="mt-4 w-full bg-brand text-white font-semibold py-3.5 rounded-xl hover:brightness-110 disabled:opacity-40"
      >
        Continue to Neem
      </button>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  className,
  ...rest
}: {
  id: string;
  label: string;
  value: string;
  /** Receives the value, not the event — `value`/`onChange` are owned here. */
  onChange: (value: string) => void;
  type?: string;
  className?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-xs font-bold text-slate-500 uppercase tracking-wider"
      >
        {label}
      </label>
      <input
        {...rest}
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1.5 w-full px-4 py-3 bg-white border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand ${className ?? ""}`}
      />
    </div>
  );
}

/**
 * Errors are surfaced with the API's message, which is written to be safe to
 * show a pharmacist or an administrator — never a stack trace or an internal
 * detail (docs/api.md §1).
 */
function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;

  const message =
    error instanceof ApiError ? error.message : "Something went wrong. Please try again.";

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 p-3 rounded-xl bg-red-50 border border-red-200"
    >
      <AlertCircle className="size-4 text-red-500 shrink-0 mt-0.5" />
      <p className="text-sm text-red-700">{message}</p>
    </div>
  );
}
