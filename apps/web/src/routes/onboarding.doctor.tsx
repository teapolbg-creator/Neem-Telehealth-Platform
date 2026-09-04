import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, ArrowLeft, Check, Loader2 } from "lucide-react";
import { DOCTOR_MIN_YEARS_EXPERIENCE } from "@neem/contracts";
import { NeemLogo } from "@/components/neem/Logo";
import { ApiError } from "@/lib/api-client";
import { useLanguages, useRegisterDoctor } from "@/features/onboarding/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/onboarding/doctor")({
  component: DoctorApplication,
});

/**
 * Doctor application (spec §21).
 *
 * Creates a PENDING account. Credentials and the digital signature are
 * uploaded after signing in; a Neem administrator verifies them by hand before
 * the account becomes active.
 */
function DoctorApplication() {
  const { data: languages } = useLanguages();
  const register = useRegisterDoctor();

  const [form, setForm] = useState({
    fullName: "",
    email: "",
    password: "",
    mdcNumber: "",
    mdcExpiresAt: "",
    qualifiedAt: "",
    yearsExperience: "",
    specialty: "",
    phone: "",
  });
  const [selectedLanguages, setSelectedLanguages] = useState<string[]>([]);

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const toggleLanguage = (code: string) =>
    setSelectedLanguages((current) =>
      current.includes(code) ? current.filter((entry) => entry !== code) : [...current, code],
    );

  if (register.isSuccess) {
    return (
      <Shell>
        <div className="card-soft p-8 text-center">
          <div className="mx-auto grid size-16 place-items-center rounded-full bg-brand/10">
            <Check className="size-8 text-brand" />
          </div>
          <h1 className="mt-5 text-2xl font-bold">Application received</h1>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-slate-600">
            {register.data.message}
          </p>
          <Link
            to="/auth/login"
            className="mt-8 inline-block rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:brightness-110"
          >
            Sign in to continue
          </Link>
        </div>
      </Shell>
    );
  }

  const fieldErrors = register.error instanceof ApiError ? register.error.fieldErrors : {};

  return (
    <Shell>
      <Link
        to="/"
        className="mb-6 inline-flex items-center gap-2 text-sm text-slate-500 hover:text-brand"
      >
        <ArrowLeft className="size-4" /> Back
      </Link>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          register.mutate({
            email: form.email,
            password: form.password,
            fullName: form.fullName,
            mdcNumber: form.mdcNumber,
            mdcExpiresAt: form.mdcExpiresAt,
            qualifiedAt: form.qualifiedAt,
            yearsExperience: Number(form.yearsExperience),
            specialty: form.specialty || undefined,
            phone: form.phone,
            languageCodes: selectedLanguages,
          } as never);
        }}
        className="card-soft space-y-6 p-8"
        noValidate
      >
        <div>
          <h1 className="text-2xl font-bold">Apply to practise on Neem</h1>
          <p className="mt-1 text-sm text-slate-500">
            Neem requires a minimum of {DOCTOR_MIN_YEARS_EXPERIENCE} years of post-qualification
            clinical experience and a valid MDC licence.
          </p>
        </div>

        <Section title="About you">
          <Field
            label="Full name"
            value={form.fullName}
            onChange={set("fullName")}
            error={fieldErrors.fullName}
            required
          />
          <Field
            label="Email"
            type="email"
            value={form.email}
            onChange={set("email")}
            error={fieldErrors.email}
            required
          />
          <Field
            label="Password"
            type="password"
            value={form.password}
            onChange={set("password")}
            error={fieldErrors.password}
            help="At least 12 characters."
            required
          />
          <Field
            label="Phone"
            value={form.phone}
            onChange={set("phone")}
            error={fieldErrors.phone}
            help="For example 024 000 0000."
            required
          />
        </Section>

        <Section title="Credentials">
          <Field
            label="MDC number"
            value={form.mdcNumber}
            onChange={set("mdcNumber")}
            error={fieldErrors.mdcNumber}
            required
          />
          <Field
            label="Licence expires"
            type="date"
            value={form.mdcExpiresAt}
            onChange={set("mdcExpiresAt")}
            error={fieldErrors.mdcExpiresAt}
            required
          />
          <Field
            label="Date qualified"
            type="date"
            value={form.qualifiedAt}
            onChange={set("qualifiedAt")}
            error={fieldErrors.qualifiedAt}
            required
          />
          <Field
            label="Years of experience"
            type="number"
            value={form.yearsExperience}
            onChange={set("yearsExperience")}
            error={fieldErrors.yearsExperience}
            required
          />
          <Field
            label="Specialty"
            value={form.specialty}
            onChange={set("specialty")}
            help="Optional."
          />
        </Section>

        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Languages you can consult in
          </p>
          <p className="mt-1 text-xs text-slate-500">
            You will only be assigned consultations in a language you select. The first one you
            choose is treated as your primary language.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(languages ?? []).map((language) => {
              const index = selectedLanguages.indexOf(language.code);
              const chosen = index !== -1;
              return (
                <button
                  key={language.code}
                  type="button"
                  onClick={() => toggleLanguage(language.code)}
                  className={cn(
                    "rounded-xl border-2 px-4 py-2 text-sm font-semibold transition-colors",
                    chosen
                      ? "border-brand bg-brand-soft text-brand"
                      : "border-border hover:border-slate-300",
                  )}
                >
                  {language.label}
                  {index === 0 && <span className="ml-1.5 text-[10px] uppercase">primary</span>}
                </button>
              );
            })}
          </div>
          {fieldErrors.languageCodes && (
            <p className="mt-2 text-xs text-red-600">{fieldErrors.languageCodes}</p>
          )}
        </div>

        <ErrorNotice error={register.error} />

        <button
          type="submit"
          disabled={register.isPending || selectedLanguages.length === 0}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3.5 font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          {register.isPending && <Loader2 className="size-4 animate-spin" />}
          Submit application
        </button>

        <p className="text-xs leading-relaxed text-slate-500">
          Your application is reviewed by a Neem administrator. Neem does not verify licences
          automatically with the Medical &amp; Dental Council.
        </p>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface">
      <header className="px-6 py-5">
        <NeemLogo className="text-xl" markClassName="size-9" />
      </header>
      <main className="mx-auto max-w-2xl px-4 pb-20">{children}</main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">
        {title}
      </legend>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  help,
  error,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  help?: string;
  error?: string;
  required?: boolean;
}) {
  const id = label.toLowerCase().replace(/\s+/g, "-");

  return (
    <label htmlFor={id} className="block">
      <span className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        className={cn(
          "mt-1.5 w-full rounded-xl border bg-white px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30",
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
      className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
      <p className="text-sm text-red-700">
        {error instanceof ApiError ? error.message : "Something went wrong. Please try again."}
      </p>
    </div>
  );
}
