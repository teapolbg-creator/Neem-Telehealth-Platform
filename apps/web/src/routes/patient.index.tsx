import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { PatientSessionView } from "@neem/contracts";
import {
  AlertCircle,
  Check,
  Loader2,
  Lock,
  Phone,
  PhoneOutgoing,
  Video,
} from "lucide-react";
import { NeemLogo } from "@/components/neem/Logo";
import { ApiError } from "@/lib/api-client";
import {
  usePatientLanguages,
  usePatientSession,
  useSelectLanguage,
  useSelectMode,
  useSubmitIdentity,
} from "@/features/consultation/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/patient/")({
  component: PatientPortal,
});

/**
 * The patient consultation portal (spec §71, §72).
 *
 * Phone-first, no account, as few fields as the clinical record needs. The
 * server decides which step comes next and returns it as `step`, so the client
 * cannot skip ahead — and a refresh resumes exactly where the patient was.
 *
 * Deliberately absent: queue position, waiting-list mechanics, doctor ratings
 * or scores. The patient sees their own status, never the platform's internals.
 */
function PatientPortal() {
  const { data: session, isLoading, error } = usePatientSession();

  if (isLoading) {
    return (
      <PhoneFrame>
        <div className="grid flex-1 place-items-center">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      </PhoneFrame>
    );
  }

  if (error || !session) {
    return (
      <PhoneFrame>
        <div className="flex flex-1 flex-col justify-center p-8 text-center">
          <AlertCircle className="mx-auto size-10 text-slate-300" />
          <h1 className="mt-4 text-xl font-bold">Session ended</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            {error instanceof ApiError
              ? error.message
              : "Please ask the pharmacy for a new consultation code."}
          </p>
        </div>
      </PhoneFrame>
    );
  }

  return (
    <PhoneFrame pharmacyName={session.pharmacyName}>
      {session.step === "IDENTITY" && <IdentityStep />}
      {session.step === "LANGUAGE" && <LanguageStep />}
      {session.step === "MODE" && <ModeStep />}
      {session.step === "WAITING" && <WaitingStep session={session} />}
      {session.step === "IN_CONSULTATION" && <InConsultationStep session={session} />}
      {session.step === "COMPLETE" && <CompleteStep />}
      {session.step === "CLOSED" && <ClosedStep session={session} />}
    </PhoneFrame>
  );
}

/**
 * The phone frame from the original prototype: full-screen on a phone, framed
 * on a desktop so the layout can be reviewed at its real proportions.
 */
function PhoneFrame({
  children,
  pharmacyName,
}: {
  children: React.ReactNode;
  pharmacyName?: string;
}) {
  return (
    <div className="grid min-h-dvh place-items-center bg-slate-950 p-0 sm:p-6">
      <div className="relative flex min-h-dvh w-full max-w-md flex-col overflow-hidden bg-white text-slate-900 sm:h-[820px] sm:min-h-0 sm:rounded-[3rem] sm:border-8 sm:border-slate-900 sm:shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-3 text-[10px] font-bold text-slate-500">
          <span className="truncate">{pharmacyName ?? "Neem"}</span>
          <span className="chip inline-flex items-center gap-1 bg-brand/10 text-brand">
            <Lock className="size-3" /> Secure
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

function IdentityStep() {
  const submit = useSubmitIdentity();
  const [form, setForm] = useState({
    fullName: "",
    age: "",
    sex: "" as "" | "FEMALE" | "MALE" | "OTHER",
    phone: "",
    paymentPhone: "",
  });
  const [differentPayer, setDifferentPayer] = useState(false);

  const fieldErrors = submit.error instanceof ApiError ? submit.error.fieldErrors : {};
  const complete = form.fullName && form.age && form.sex && form.phone;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate({
          fullName: form.fullName,
          age: Number(form.age),
          sex: form.sex as "FEMALE" | "MALE" | "OTHER",
          phone: form.phone,
          ...(differentPayer && form.paymentPhone ? { paymentPhone: form.paymentPhone } : {}),
        } as never);
      }}
      className="flex flex-1 flex-col overflow-y-auto p-6"
      noValidate
    >
      <NeemLogo className="mx-auto mt-2 text-lg" markClassName="size-8" />

      <h1 className="mt-6 text-2xl font-bold">Your details</h1>
      <p className="mt-1 text-sm leading-relaxed text-slate-500">
        The doctor needs these to advise you safely and to write a prescription if one is needed.
      </p>

      <div className="mt-6 space-y-4">
        <Field
          label="Full name"
          value={form.fullName}
          onChange={(value) => setForm({ ...form, fullName: value })}
          error={fieldErrors.fullName}
          autoComplete="name"
        />

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Age"
            type="number"
            inputMode="numeric"
            value={form.age}
            onChange={(value) => setForm({ ...form, age: value })}
            error={fieldErrors.age}
          />
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Sex</span>
            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
              {(["FEMALE", "MALE", "OTHER"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setForm({ ...form, sex: option })}
                  className={cn(
                    "rounded-xl border-2 py-2.5 text-xs font-bold transition-colors",
                    form.sex === option
                      ? "border-brand bg-brand-soft text-brand"
                      : "border-border text-slate-500",
                  )}
                >
                  {option === "FEMALE" ? "F" : option === "MALE" ? "M" : "Other"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <Field
          label="Your phone number"
          value={form.phone}
          onChange={(value) => setForm({ ...form, phone: value })}
          error={fieldErrors.phone}
          inputMode="tel"
          autoComplete="tel"
          help="For example 024 000 0000."
        />

        {/* Spec §36 — paying from another number is explicitly allowed. */}
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={differentPayer}
            onChange={(event) => setDifferentPayer(event.target.checked)}
            className="mt-0.5 size-4 accent-[var(--brand)]"
          />
          <span className="text-slate-600">Someone paid with a different number</span>
        </label>

        {differentPayer && (
          <Field
            label="Number used to pay"
            value={form.paymentPhone}
            onChange={(value) => setForm({ ...form, paymentPhone: value })}
            error={fieldErrors.paymentPhone}
            inputMode="tel"
          />
        )}
      </div>

      <ErrorNotice error={submit.error} />

      {/*
        The retention promise, in the patient's own words. This is the one
        place they learn what happens to what they just typed (spec §11).
      */}
      <p className="mt-5 rounded-2xl bg-brand-soft p-3 text-xs leading-relaxed text-brand/90">
        Your details and everything you discuss are deleted when the consultation ends. Only a
        prescription, if the doctor issues one, is kept.
      </p>

      <button
        type="submit"
        disabled={!complete || submit.isPending}
        className="mt-auto flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 pt-4 font-bold text-white shadow-lg shadow-brand/20 disabled:opacity-40"
      >
        {submit.isPending && <Loader2 className="size-4 animate-spin" />}
        Continue
      </button>
    </form>
  );
}

function LanguageStep() {
  const { data: languages } = usePatientLanguages();
  const select = useSelectLanguage();
  const [chosen, setChosen] = useState<string | null>(null);

  return (
    <div className="flex flex-1 flex-col p-6">
      <h1 className="mt-2 text-xl font-bold">Choose your language</h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">
        You will only be matched with a doctor who speaks it.
      </p>

      <div className="grid flex-1 content-start grid-cols-2 gap-3">
        {(languages ?? []).map((language) => (
          <button
            key={language.code}
            type="button"
            onClick={() => setChosen(language.code)}
            className={cn(
              "min-h-[76px] rounded-2xl border-2 p-4 text-left transition-colors",
              chosen === language.code
                ? "border-brand bg-brand-soft"
                : "border-border hover:border-slate-300",
            )}
          >
            <p className={cn("text-sm font-bold", chosen === language.code && "text-brand")}>
              {language.label}
            </p>
            {language.subtitle && (
              <p className="mt-0.5 text-[11px] text-slate-500">{language.subtitle}</p>
            )}
          </button>
        ))}
      </div>

      <ErrorNotice error={select.error} />

      <button
        type="button"
        disabled={!chosen || select.isPending}
        onClick={() => chosen && select.mutate({ languageCode: chosen })}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 font-bold text-white shadow-lg shadow-brand/20 disabled:opacity-40"
      >
        {select.isPending && <Loader2 className="size-4 animate-spin" />}
        Continue
      </button>
    </div>
  );
}

function ModeStep() {
  const select = useSelectMode();
  const [chosen, setChosen] = useState<"AUDIO" | "VIDEO" | "CALL_ME" | null>(null);

  const options = [
    { id: "VIDEO", icon: Video, title: "Video consultation", desc: "See and speak with the doctor." },
    { id: "AUDIO", icon: Phone, title: "Audio consultation", desc: "Voice only — uses less data." },
    {
      id: "CALL_ME",
      icon: PhoneOutgoing,
      title: "Call me",
      desc: "The doctor calls you through Neem. Best for a weak connection.",
    },
  ] as const;

  return (
    <div className="flex flex-1 flex-col p-6">
      <h1 className="mt-2 text-xl font-bold">How would you like to consult?</h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">Choose what works best for you.</p>

      <div className="flex-1 space-y-3">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setChosen(option.id)}
            className={cn(
              "flex w-full items-start gap-4 rounded-2xl border-2 p-5 text-left transition-colors",
              chosen === option.id
                ? "border-brand bg-brand-soft"
                : "border-border hover:border-slate-300",
            )}
          >
            <div
              className={cn(
                "grid size-11 shrink-0 place-items-center rounded-xl",
                chosen === option.id ? "bg-brand text-white" : "bg-slate-100 text-slate-500",
              )}
            >
              <option.icon className="size-5" />
            </div>
            <div>
              <p className="font-bold">{option.title}</p>
              <p className="mt-1 text-xs text-slate-500">{option.desc}</p>
            </div>
          </button>
        ))}
      </div>

      <ErrorNotice error={select.error} />

      <button
        type="button"
        disabled={!chosen || select.isPending}
        onClick={() => chosen && select.mutate({ type: chosen })}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 font-bold text-white shadow-lg shadow-brand/20 disabled:opacity-40"
      >
        {select.isPending && <Loader2 className="size-4 animate-spin" />}
        Enter waiting room
      </button>
    </div>
  );
}

function WaitingStep({ session }: { session: PatientSessionView }) {
  const minutes = Math.floor((session.waitingSinceSeconds ?? 0) / 60);
  const seconds = (session.waitingSinceSeconds ?? 0) % 60;

  return (
    <div className="flex flex-1 flex-col p-8 text-center">
      <div className="chip mx-auto bg-brand/10 text-brand">
        <span className="size-1.5 animate-pulse rounded-full bg-brand" />
        Finding a doctor
      </div>

      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="grid size-24 place-items-center rounded-full bg-brand/10">
          <Loader2 className="size-10 animate-spin text-brand" />
        </div>

        <h2 className="mt-6 text-2xl font-bold">Just a moment…</h2>
        <p className="mt-2 max-w-xs text-pretty text-slate-500">
          We are matching you with a doctor who speaks {session.language?.label ?? "your language"}.
        </p>

        {/*
          Elapsed time only. No queue position and no estimate: the patient is
          told their own status, not the platform's internals (spec §72), and an
          estimate we cannot honour is worse than none.
        */}
        <div className="mt-8 grid w-full grid-cols-2 gap-3">
          <div className="rounded-2xl border border-border bg-slate-50 p-3">
            <p className="text-[10px] font-bold uppercase text-slate-400">Waiting</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums">
              {minutes}:{String(seconds).padStart(2, "0")}
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-slate-50 p-3">
            <p className="text-[10px] font-bold uppercase text-slate-400">Consultation</p>
            <p className="mt-0.5 text-lg font-bold capitalize">
              {session.type?.replace("_", " ").toLowerCase() ?? "—"}
            </p>
          </div>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-slate-500">
        Please stay on this screen. You can put your phone down — it will update on its own.
      </p>
    </div>
  );
}

function InConsultationStep({ session }: { session: PatientSessionView }) {
  return (
    <div className="flex flex-1 flex-col p-8 text-center">
      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="grid size-20 place-items-center rounded-full bg-brand/10">
          <Check className="size-10 text-brand" />
        </div>
        <h2 className="mt-6 text-2xl font-bold">
          {session.doctor?.fullName ?? "Your doctor"} is ready
        </h2>
        <p className="mt-2 max-w-xs text-pretty text-slate-500">
          The audio and video connection is built in the next phase. Your consultation is otherwise
          ready to begin.
        </p>
      </div>
    </div>
  );
}

function CompleteStep() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <div className="grid size-20 place-items-center rounded-full bg-brand/10">
        <Check className="size-10 text-brand" />
      </div>
      <h1 className="mt-6 text-3xl font-bold">Consultation complete</h1>
      <p className="mt-3 max-w-xs text-pretty text-slate-500">
        Please return to the pharmacist. Get well soon.
      </p>
      <p className="mt-6 text-xs leading-relaxed text-slate-400">
        Your details and everything discussed have been deleted.
      </p>
    </div>
  );
}

function ClosedStep({ session }: { session: PatientSessionView }) {
  const reason =
    session.state === "CANCELLED"
      ? "This consultation was cancelled."
      : session.state === "EXPIRED"
        ? "This consultation expired before it began."
        : "This consultation has ended.";

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <AlertCircle className="size-10 text-slate-300" />
      <h1 className="mt-4 text-xl font-bold">{reason}</h1>
      <p className="mt-2 max-w-xs text-pretty text-sm text-slate-500">
        Please speak to the pharmacist if you still need to see a doctor.
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  help,
  error,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  help?: string;
  error?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const id = label.toLowerCase().replace(/\s+/g, "-");

  return (
    <label htmlFor={id} className="block">
      <span className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <input
        {...rest}
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        className={cn(
          "mt-1.5 w-full rounded-xl border bg-white px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-brand/30",
          error ? "border-red-300" : "border-border focus:border-brand",
        )}
      />
      {error ? (
        <span className="mt-1 block text-xs text-red-600">{error}</span>
      ) : help ? (
        <span className="mt-1 block text-xs text-slate-500">{help}</span>
      ) : null}
    </label>
  );
}

function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;

  return (
    <div
      role="alert"
      className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
      <p className="text-sm text-red-700">
        {error instanceof ApiError ? error.message : "Something went wrong. Please try again."}
      </p>
    </div>
  );
}
