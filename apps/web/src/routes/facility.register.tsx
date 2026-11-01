import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft, CloudOff, Loader2, Search, ShieldCheck, UserPlus } from "lucide-react";
import {
  CHPS_CONSENT_TEXT,
  NHIS_STATUSES,
  NHIS_STATUS_LABELS,
  patientRegistrationSchema,
  type ConsentGivenBy,
  type NhisStatus,
  type PatientSummary,
} from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { ApiError } from "@/lib/api-client";
import { useSession } from "@/features/auth/use-session";
import { saveWalkIn, useOfflineQueue } from "@/features/offline/queue";
import { Field } from "@/features/facility/LocationFields";
import { inputClass } from "@/features/facility/form";
import {
  SEX_LABEL,
  ageLabel,
  useOpenVisit,
  usePatientSearch,
  useRegisterPatient,
} from "@/features/facility/patients";

export const Route = createFileRoute("/facility/register")({
  validateSearch: (search: Record<string, unknown>): { new?: boolean } => ({
    new: search.new === true || search.new === "true" ? true : undefined,
  }),
  component: FindOrRegister,
});

/**
 * Find the patient first, register only if they are not there (D75).
 *
 * Searching before registering is what keeps one person from becoming two
 * records. A returning patient gets a new visit on their existing record.
 */
function FindOrRegister() {
  const { new: startNew } = Route.useSearch();
  const [registering, setRegistering] = useState(Boolean(startNew));

  return (
    <AppShell active="facility">
      <div className="mx-auto w-full max-w-4xl">
        <Link
          to="/facility"
          className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-brand"
        >
          <ArrowLeft className="size-4" /> Today
        </Link>
        <h1 className="mt-2 text-3xl font-bold">
          {registering ? "Register a walk-in" : "Find a patient"}
        </h1>

        {registering ? (
          <RegisterForm onBack={() => setRegistering(false)} />
        ) : (
          <FindPatient onRegister={() => setRegistering(true)} />
        )}
      </div>
    </AppShell>
  );
}

function FindPatient({ onRegister }: { onRegister: () => void }) {
  const [by, setBy] = useState<"name" | "phone" | "nhisNumber" | "patientNumber">("name");
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState("");
  const search = usePatientSearch(submitted ? { [by]: submitted } : {});

  return (
    <div className="mt-6 space-y-4">
      <form
        className="card-soft space-y-3 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(text);
        }}
      >
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["name", "Name"],
              ["phone", "Phone"],
              ["nhisNumber", "NHIS number"],
              ["patientNumber", "Card number"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-on={by === value}
              onClick={() => setBy(value)}
              className="rounded-full border border-border px-4 py-2 text-sm font-semibold text-slate-600 data-[on=true]:border-brand data-[on=true]:bg-brand-soft data-[on=true]:text-brand"
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              by === "name"
                ? "Any full word of their name, e.g. Serwaa"
                : by === "phone"
                  ? "024 000 0000"
                  : by === "patientNumber"
                    ? "NM-XXXX-XXXX"
                    : "NHIS number"
            }
            className={`${inputClass} py-3 text-base`}
          />
          <button
            type="submit"
            disabled={!text.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 text-sm font-semibold text-white disabled:opacity-40"
          >
            <Search className="size-4" /> Search
          </button>
        </div>
        {by === "name" ? (
          <p className="text-xs text-slate-500">
            Names are matched by whole words, so search “Serwaa”, not “Ser”.
          </p>
        ) : null}
      </form>

      {search.isFetching ? (
        <div className="grid place-items-center p-6">
          <Loader2 className="size-5 animate-spin text-brand" />
        </div>
      ) : null}

      {search.error ? (
        <p className="text-sm text-red-600">
          {search.error instanceof ApiError && search.error.status === 0
            ? "Searching needs the connection. Register them as a walk-in instead: Neem checks whether they are already on file once the connection returns."
            : search.error instanceof ApiError
              ? search.error.message
              : "Search failed."}
        </p>
      ) : null}

      {search.data ? (
        <div className="card-soft divide-y divide-border">
          {search.data.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">
              No patient found here with that {by === "name" ? "name" : "detail"}.
            </p>
          ) : (
            search.data.map((patient) => <Match key={patient.publicId} patient={patient} />)
          )}
        </div>
      ) : null}

      <div className="card-soft flex flex-wrap items-center justify-between gap-3 p-5">
        <p className="text-sm text-slate-600">Not here? Register them as a new patient.</p>
        <button
          type="button"
          onClick={onRegister}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-semibold text-white hover:brightness-110"
        >
          <UserPlus className="size-4" /> Register new patient
        </button>
      </div>
    </div>
  );
}

function Match({ patient }: { patient: PatientSummary }) {
  const navigate = useNavigate();
  const [complaint, setComplaint] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const open = useOpenVisit(patient.patientNumber);
  const toRecord = () =>
    navigate({
      to: "/facility/patients/$patientNumber",
      params: { patientNumber: patient.patientNumber },
    });

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{patient.fullName}</p>
          <p className="text-xs text-slate-500">
            {SEX_LABEL[patient.sex]} · {ageLabel(patient.dateOfBirth, patient.dobIsEstimated)} ·{" "}
            {patient.community} · <span className="font-mono">{patient.patientNumber}</span>
          </p>
          <p className="text-xs text-slate-500">
            {patient.lastVisitAt
              ? `Last seen ${new Date(patient.lastVisitAt).toLocaleDateString()}`
              : "No visits yet"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void toRecord()}
          className="rounded-lg border border-border px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
        >
          Open record
        </button>
      </div>
      {patient.hasOpenVisit ? (
        <p className="text-xs font-semibold text-amber-700">
          Already has a visit in progress. Open the record to continue it.
        </p>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            open.mutate(
              { presentingComplaint: complaint, clientRequestId: requestId },
              { onSuccess: () => void toRecord() },
            );
          }}
        >
          <input
            value={complaint}
            onChange={(event) => setComplaint(event.target.value)}
            placeholder="Why have they come today?"
            className={inputClass}
          />
          <button
            type="submit"
            disabled={complaint.trim().length < 2 || open.isPending}
            className="shrink-0 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            Start visit
          </button>
        </form>
      )}
      {open.error ? (
        <p className="text-sm text-red-600">
          {open.error instanceof ApiError ? open.error.message : "Visit not started."}
        </p>
      ) : null}
    </div>
  );
}

function RegisterForm({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const register = useRegisterPatient();
  const [requestId] = useState(() => crypto.randomUUID());
  const { user } = useSession();
  const offline = useOfflineQueue(user?.role === "FACILITY" ? user.publicId : null);
  const [offlineErrors, setOfflineErrors] = useState<Record<string, string>>({});
  const [savingOffline, setSavingOffline] = useState(false);

  const [fullName, setFullName] = useState("");
  const [sex, setSex] = useState<"FEMALE" | "MALE" | "OTHER" | "">("");
  const [ageMode, setAgeMode] = useState<"age" | "date">("age");
  const [ageYears, setAgeYears] = useState("");
  const [ageMonths, setAgeMonths] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [phone, setPhone] = useState("");
  const [community, setCommunity] = useState("");
  const [nhisStatus, setNhisStatus] = useState<NhisStatus>("UNKNOWN");
  const [nhisNumber, setNhisNumber] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactRelationship, setContactRelationship] = useState("");
  const [allergies, setAllergies] = useState("");
  const [medications, setMedications] = useState("");
  const [medicalHistory, setMedicalHistory] = useState("");
  const [complaint, setComplaint] = useState("");
  const [consentGivenBy, setConsentGivenBy] = useState<ConsentGivenBy | "">("");
  const [guardianName, setGuardianName] = useState("");
  const [guardianRelationship, setGuardianRelationship] = useState("");

  const errors = {
    ...(register.error instanceof ApiError ? register.error.fieldErrors : {}),
    ...offlineErrors,
  };
  const years = ageYears === "" ? null : Number(ageYears);
  // No connection now, or the last attempt could not reach Neem (D88).
  const unreachable =
    !offline.reachable || (register.error instanceof ApiError && register.error.status === 0);

  const build = () => {
    if (!sex || !consentGivenBy) return null;
    return {
      fullName,
      sex,
      dateOfBirth: ageMode === "date" ? dateOfBirth || null : null,
      ageYears: ageMode === "age" ? years : null,
      ageMonths: ageMode === "age" && ageMonths !== "" ? Number(ageMonths) : null,
      phone,
      community,
      nhisStatus,
      nhisNumber: nhisStatus === "NOT_MEMBER" ? null : nhisNumber,
      emergencyContact: contactName.trim()
        ? { name: contactName, phone: contactPhone, relationship: contactRelationship }
        : null,
      allergies,
      medications,
      medicalHistory,
      presentingComplaint: complaint,
      consentGivenBy,
      representative:
        consentGivenBy === "GUARDIAN"
          ? { name: guardianName, relationship: guardianRelationship }
          : null,
      clientRequestId: requestId,
    };
  };

  /**
   * Checked here with the same rules the API applies, because nothing will
   * check it again until the connection returns.
   */
  const saveOffline = async () => {
    const parsed = patientRegistrationSchema.safeParse(build());
    if (!parsed.success) {
      setOfflineErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join("."), issue.message]),
        ),
      );
      return;
    }
    setOfflineErrors({});
    setSavingOffline(true);
    try {
      await saveWalkIn(parsed.data, null);
      void navigate({ to: "/facility/offline" });
    } finally {
      setSavingOffline(false);
    }
  };

  const submit = () => {
    const input = build();
    if (!input) return;
    if (!offline.reachable && offline.canSave) {
      void saveOffline();
      return;
    }
    setOfflineErrors({});
    register.mutate(input, {
      onSuccess: (result) =>
        void navigate({
          to: "/facility/patients/$patientNumber",
          params: { patientNumber: result.patientNumber },
        }),
    });
  };

  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="text-sm text-slate-500">
        Only the fields marked * are needed. A patient without a phone or ID is registered all the
        same and given a card number.
      </p>

      <section className="card-soft space-y-3 p-5">
        <p className="font-bold">The patient</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name *" error={errors.fullName}>
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className={inputClass}
            />
          </Field>
          <div className="text-sm">
            <span className="mb-1 block text-xs font-semibold text-slate-500">Sex *</span>
            <div className="flex gap-2">
              {(["FEMALE", "MALE", "OTHER"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  data-on={sex === value}
                  onClick={() => setSex(value)}
                  className="flex-1 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-slate-600 data-[on=true]:border-brand data-[on=true]:bg-brand-soft data-[on=true]:text-brand"
                >
                  {SEX_LABEL[value]}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="text-sm">
          <div className="mb-1 flex items-center gap-3">
            <span className="text-xs font-semibold text-slate-500">Age *</span>
            <button
              type="button"
              onClick={() => setAgeMode(ageMode === "age" ? "date" : "age")}
              className="text-xs font-semibold text-brand hover:underline"
            >
              {ageMode === "age" ? "I know the date of birth" : "Enter an estimated age instead"}
            </button>
          </div>
          {ageMode === "age" ? (
            <div className="flex gap-2">
              <input
                inputMode="numeric"
                value={ageYears}
                onChange={(event) => setAgeYears(event.target.value.replace(/\D/g, ""))}
                placeholder="Years"
                className={`${inputClass} max-w-32`}
              />
              {years !== null && years < 5 ? (
                <input
                  inputMode="numeric"
                  value={ageMonths}
                  onChange={(event) => setAgeMonths(event.target.value.replace(/\D/g, ""))}
                  placeholder="and months"
                  className={`${inputClass} max-w-32`}
                />
              ) : null}
            </div>
          ) : (
            <input
              type="date"
              value={dateOfBirth}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(event) => setDateOfBirth(event.target.value)}
              className={`${inputClass} max-w-48`}
            />
          )}
          {errors.dateOfBirth || errors.ageYears ? (
            <p className="mt-1 text-xs text-red-600">{errors.dateOfBirth ?? errors.ageYears}</p>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Community or village *" error={errors.community}>
            <input
              value={community}
              onChange={(event) => setCommunity(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Phone" error={errors.phone}>
            <input
              value={phone}
              inputMode="tel"
              placeholder="024 000 0000"
              onChange={(event) => setPhone(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="NHIS" error={errors.nhisStatus}>
            <select
              value={nhisStatus}
              onChange={(event) => setNhisStatus(event.target.value as NhisStatus)}
              className={inputClass}
            >
              {NHIS_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {NHIS_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          {nhisStatus !== "NOT_MEMBER" ? (
            <Field label="NHIS number" error={errors.nhisNumber}>
              <input
                value={nhisNumber}
                inputMode="numeric"
                onChange={(event) => setNhisNumber(event.target.value)}
                className={inputClass}
              />
            </Field>
          ) : null}
        </div>
      </section>

      <section className="card-soft space-y-3 p-5">
        <p className="font-bold">Today</p>
        <Field label="Why have they come? *" error={errors.presentingComplaint}>
          <textarea
            value={complaint}
            rows={2}
            onChange={(event) => setComplaint(event.target.value)}
            className={inputClass}
          />
        </Field>
      </section>

      <details className="card-soft p-5">
        <summary className="cursor-pointer font-bold">
          History, allergies and emergency contact{" "}
          <span className="text-sm font-normal text-slate-500">(optional)</span>
        </summary>
        <div className="mt-3 space-y-3">
          <Field label="Allergies" error={errors.allergies}>
            <input
              value={allergies}
              onChange={(event) => setAllergies(event.target.value)}
              placeholder="e.g. penicillin, or none known"
              className={inputClass}
            />
          </Field>
          <Field label="Medicines they take" error={errors.medications}>
            <input
              value={medications}
              onChange={(event) => setMedications(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Relevant medical history" error={errors.medicalHistory}>
            <textarea
              value={medicalHistory}
              rows={2}
              onChange={(event) => setMedicalHistory(event.target.value)}
              className={inputClass}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Emergency contact" error={errors["emergencyContact.name"]}>
              <input
                value={contactName}
                onChange={(event) => setContactName(event.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Their phone" error={errors["emergencyContact.phone"]}>
              <input
                value={contactPhone}
                inputMode="tel"
                onChange={(event) => setContactPhone(event.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Relationship" error={errors["emergencyContact.relationship"]}>
              <input
                value={contactRelationship}
                onChange={(event) => setContactRelationship(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
        </div>
      </details>

      <section className="card-soft space-y-3 border-brand/30 p-5">
        <p className="flex items-center gap-2 font-bold">
          <ShieldCheck className="size-5 text-brand" /> Consent *
        </p>
        <p className="rounded-lg bg-slate-50 p-3 text-sm leading-relaxed text-slate-700">
          Read this aloud: “{CHPS_CONSENT_TEXT}”
        </p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["PATIENT", "The patient agrees"],
              ["GUARDIAN", "A guardian agrees for them"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-on={consentGivenBy === value}
              onClick={() => setConsentGivenBy(value)}
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-600 data-[on=true]:border-brand data-[on=true]:bg-brand-soft data-[on=true]:text-brand"
            >
              {label}
            </button>
          ))}
        </div>
        {consentGivenBy === "GUARDIAN" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Guardian’s name *" error={errors["representative.name"]}>
              <input
                value={guardianName}
                onChange={(event) => setGuardianName(event.target.value)}
                className={inputClass}
              />
            </Field>
            <Field label="Relationship *" error={errors["representative.relationship"]}>
              <input
                value={guardianRelationship}
                placeholder="e.g. Mother"
                onChange={(event) => setGuardianRelationship(event.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
        ) : null}
        {errors.representative ? (
          <p className="text-xs text-red-600">{errors.representative}</p>
        ) : null}
        <p className="text-xs text-slate-500">
          If they refuse, do not register them. Care for them at the facility as usual.
        </p>
      </section>

      {unreachable ? (
        <div className="card-soft flex items-start gap-3 border-warning/30 bg-warning-soft p-4 text-sm">
          <CloudOff className="mt-0.5 size-5 shrink-0 text-warning" />
          <p>
            {offline.canSave
              ? "No connection to Neem. Save this walk-in on this device: it is encrypted here and sent, with a check for a match among your patients, when the connection returns."
              : "No connection to Neem, and this device cannot save walk-ins until it has connected once since sign-in. Record this patient on paper."}
          </p>
        </div>
      ) : register.error && Object.keys(errors).length === 0 ? (
        <p className="text-sm text-red-600">
          {register.error instanceof ApiError ? register.error.message : "Not registered."}
        </p>
      ) : null}
      {Object.keys(errors).length > 0 ? (
        <p className="text-sm text-red-600">Check the fields marked above.</p>
      ) : null}

      <div className="flex justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded-xl border border-border px-5 py-3 text-sm font-semibold text-slate-600 hover:bg-slate-50"
        >
          Search first
        </button>
        {unreachable && offline.canSave ? (
          <button
            type="button"
            onClick={() => void saveOffline()}
            disabled={!sex || !consentGivenBy || savingOffline}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {savingOffline ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CloudOff className="size-4" />
            )}
            Save on this device
          </button>
        ) : (
          <button
            type="submit"
            disabled={!sex || !consentGivenBy || register.isPending}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {register.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Register and start visit
          </button>
        )}
      </div>
    </form>
  );
}
