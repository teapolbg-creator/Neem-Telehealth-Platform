import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, ArrowLeft, Check, Loader2 } from "lucide-react";
import { NeemLogo } from "@/components/neem/Logo";
import { ApiError } from "@/lib/api-client";
import { useCapabilities, useRegisterPharmacy } from "@/features/onboarding/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/onboarding/pharmacy")({
  component: PharmacyApplication,
});

/**
 * Pharmacy application (spec §20).
 *
 * Creates a PENDING pharmacy. Registration documents are uploaded after
 * signing in, and a Neem administrator verifies them by hand before the
 * pharmacy can operate — no pharmacy is activated automatically, and none can
 * be activated with nothing verified.
 *
 * The API and the client hook for this already existed; the screen did not, so
 * there was no way to apply.
 */
function PharmacyApplication() {
  const { data: capabilities } = useCapabilities();
  const register = useRegisterPharmacy();

  const [form, setForm] = useState({
    name: "",
    councilRegistrationNo: "",
    ownerName: "",
    responsiblePharmacistName: "",
    responsiblePharmacistLicenceNo: "",
    addressLine1: "",
    city: "",
    region: "",
    phone: "",
    email: "",
    password: "",
  });
  const [tests, setTests] = useState<string[]>([]);
  const [equipment, setEquipment] = useState<string[]>([]);

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const toggle = (list: string[], setList: (next: string[]) => void, code: string) =>
    setList(list.includes(code) ? list.filter((entry) => entry !== code) : [...list, code]);

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
          <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-slate-600">
            Sign in to upload your Pharmacy Council registration and supporting documents. Your
            pharmacy cannot be activated until an administrator has verified them.
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
            name: form.name,
            councilRegistrationNo: form.councilRegistrationNo,
            ownerName: form.ownerName,
            responsiblePharmacistName: form.responsiblePharmacistName,
            responsiblePharmacistLicenceNo: form.responsiblePharmacistLicenceNo || undefined,
            addressLine1: form.addressLine1,
            city: form.city,
            region: form.region,
            phone: form.phone,
            openingHours: [],
            tests,
            equipment,
            services: [],
          } as never);
        }}
        className="card-soft space-y-6 p-8"
        noValidate
      >
        <div>
          <h1 className="text-2xl font-bold">Register your pharmacy with Neem</h1>
          <p className="mt-1 text-sm text-slate-500">
            Your pharmacy is verified by hand before it can start consultations.
          </p>
        </div>

        <ErrorNotice error={register.error} />

        <Section title="The pharmacy">
          <Field
            label="Pharmacy name"
            value={form.name}
            onChange={set("name")}
            error={fieldErrors.name}
            required
          />
          <Field
            label="Pharmacy Council registration number"
            value={form.councilRegistrationNo}
            onChange={set("councilRegistrationNo")}
            error={fieldErrors.councilRegistrationNo}
            required
          />
          <Field
            label="Owner’s name"
            value={form.ownerName}
            onChange={set("ownerName")}
            error={fieldErrors.ownerName}
            required
          />
          <Field
            label="Responsible pharmacist"
            value={form.responsiblePharmacistName}
            onChange={set("responsiblePharmacistName")}
            error={fieldErrors.responsiblePharmacistName}
            required
          />
          <Field
            label="Pharmacist licence number"
            value={form.responsiblePharmacistLicenceNo}
            onChange={set("responsiblePharmacistLicenceNo")}
            error={fieldErrors.responsiblePharmacistLicenceNo}
            help="Optional."
          />
        </Section>

        <Section title="Where you are">
          <Field
            label="Street address"
            value={form.addressLine1}
            onChange={set("addressLine1")}
            error={fieldErrors.addressLine1}
            required
          />
          <Field
            label="City or town"
            value={form.city}
            onChange={set("city")}
            error={fieldErrors.city}
            required
          />
          <Field
            label="Region"
            value={form.region}
            onChange={set("region")}
            error={fieldErrors.region}
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

        <Section title="Your Neem account">
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
        </Section>

        {/*
          Capabilities drive which point-of-care tests the consultation screen
          offers, so a pharmacy only ever sees what it can actually do.
        */}
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
            What you can do on site
          </p>
          <p className="mt-1 text-xs text-slate-500">
            This decides which tests and readings you are offered during a consultation. You can
            change it later.
          </p>

          <CapabilityGroup
            heading="Point-of-care tests"
            options={capabilities?.tests ?? []}
            selected={tests}
            onToggle={(code) => toggle(tests, setTests, code)}
          />
          <CapabilityGroup
            heading="Equipment"
            options={capabilities?.equipment ?? []}
            selected={equipment}
            onToggle={(code) => toggle(equipment, setEquipment, code)}
          />
        </div>

        <button
          type="submit"
          disabled={register.isPending}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3.5 font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          {register.isPending && <Loader2 className="size-4 animate-spin" />}
          Submit application
        </button>

        <p className="text-xs leading-relaxed text-slate-500">
          A Neem administrator reviews your application and opens each document you upload. Neem
          does not check registrations automatically with the Pharmacy Council.
        </p>
      </form>
    </Shell>
  );
}

function CapabilityGroup({
  heading,
  options,
  selected,
  onToggle,
}: {
  heading: string;
  options: Array<{ code: string; label: string }>;
  selected: string[];
  onToggle: (code: string) => void;
}) {
  if (options.length === 0) return null;

  return (
    <div className="mt-4">
      <p className="mb-2 text-xs font-semibold text-slate-500">{heading}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const chosen = selected.includes(option.code);
          return (
            <button
              key={option.code}
              type="button"
              onClick={() => onToggle(option.code)}
              aria-pressed={chosen}
              className={cn(
                "rounded-xl border-2 px-4 py-2 text-sm font-semibold transition-colors",
                chosen
                  ? "border-brand bg-brand-soft text-brand"
                  : "border-border hover:border-slate-300",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
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
  const id = label.toLowerCase().replace(/[^a-z]+/g, "-");

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
