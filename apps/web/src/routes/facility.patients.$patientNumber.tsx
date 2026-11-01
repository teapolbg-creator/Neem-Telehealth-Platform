import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, AlertTriangle, ArrowLeft, Loader2, Pill, Siren } from "lucide-react";
import {
  NHIS_STATUS_LABELS,
  OPEN_VISIT_STATUSES,
  TRIAGE_CATEGORIES,
  TRIAGE_CATEGORY_INFO,
  VISIT_STATUS_LABELS,
  type PatientRecord,
  type TriageCategory,
  type TriageView,
  type VisitView,
  type VitalSigns,
} from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { inputClass } from "@/features/facility/form";
import {
  SEX_LABEL,
  TRIAGE_STYLE,
  VISIT_STATUS_TONE,
  ageLabel,
  useCloseVisit,
  useEscalateVisit,
  usePatientRecord,
  useRecordTriage,
} from "@/features/facility/patients";
import { TriageBadge } from "@/features/facility/TriageBadge";
import { DoctorRequest } from "@/features/facility/DoctorRequest";
import { DoctorAdvice } from "@/features/facility/DoctorAdvice";

export const Route = createFileRoute("/facility/patients/$patientNumber")({
  component: PatientPage,
});

/**
 * A CHPS patient's record and today's visit (slice 1b, D74, D75).
 *
 * Opening this page is written to the record-access log. The current visit
 * comes first, because that is what the CHO is here to act on; the history
 * underneath is what makes this record worth keeping.
 */
function PatientPage() {
  const { patientNumber } = Route.useParams();
  const record = usePatientRecord(patientNumber);

  return (
    <AppShell active="facility">
      <div className="mx-auto w-full max-w-5xl">
        <Link
          to="/facility"
          className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-brand"
        >
          <ArrowLeft className="size-4" /> Today
        </Link>

        {record.isLoading ? (
          <div className="card-soft mt-6 grid place-items-center p-16">
            <Loader2 className="size-6 animate-spin text-brand" />
          </div>
        ) : null}

        {record.error ? (
          <div className="card-soft mt-6 flex items-start gap-3 border-red-200 bg-red-50 p-6">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-700">
              {record.error instanceof ApiError
                ? record.error.message
                : "This record could not be loaded."}
            </p>
          </div>
        ) : null}

        {record.data ? <Record patient={record.data} /> : null}
      </div>
    </AppShell>
  );
}

function Record({ patient }: { patient: PatientRecord }) {
  const current = patient.visits.find((visit) => OPEN_VISIT_STATUSES.includes(visit.status));
  const past = patient.visits.filter((visit) => visit !== current);

  return (
    <>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">{patient.fullName}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {SEX_LABEL[patient.sex]} · {ageLabel(patient.dateOfBirth, patient.dobIsEstimated)} ·{" "}
            {patient.community}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-lg font-bold tracking-wider">{patient.patientNumber}</p>
          <p className="text-xs text-slate-500">Card number</p>
        </div>
      </div>

      {patient.allergies ? (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" />
          <p>
            <span className="font-bold">Allergies:</span> {patient.allergies}
          </p>
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {current ? (
            <CurrentVisit key={current.publicId} visit={current} />
          ) : (
            <div className="card-soft p-5 text-sm text-slate-600">
              No visit in progress.{" "}
              <Link to="/facility/register" className="font-semibold text-brand hover:underline">
                Start one from Find a patient
              </Link>
              .
            </div>
          )}

          <div className="card-soft p-5">
            <p className="font-bold">Earlier visits</p>
            {past.length === 0 ? (
              <p className="mt-2 text-sm text-slate-500">This is their first visit.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {past.map((visit) => (
                  <PastVisit key={visit.publicId} visit={visit} />
                ))}
              </ul>
            )}
          </div>
        </div>

        <aside className="space-y-4">
          <div className="card-soft space-y-2 p-5 text-sm">
            <p className="font-bold">Details</p>
            <Detail label="Phone" value={patient.phone} />
            <Detail
              label="NHIS"
              value={`${NHIS_STATUS_LABELS[patient.nhisStatus]}${patient.nhisNumber ? ` · ${patient.nhisNumber}` : ""}`}
            />
            <Detail
              label="Emergency contact"
              value={
                patient.emergencyContact
                  ? `${patient.emergencyContact.name} (${patient.emergencyContact.relationship})${patient.emergencyContact.phone ? ` · ${patient.emergencyContact.phone}` : ""}`
                  : null
              }
            />
            {patient.representative ? (
              <Detail
                label="Guardian"
                value={`${patient.representative.name} (${patient.representative.relationship})`}
              />
            ) : null}
            <Detail
              label="Consent"
              value={`${patient.consent.givenBy === "GUARDIAN" ? "Guardian" : "Patient"}, ${new Date(patient.consent.at).toLocaleDateString()}`}
            />
          </div>
          <div className="card-soft space-y-2 p-5 text-sm">
            <p className="flex items-center gap-2 font-bold">
              <Pill className="size-4 text-brand" /> History
            </p>
            <Detail label="Medicines" value={patient.medications} />
            <Detail label="Medical history" value={patient.medicalHistory} />
          </div>
        </aside>
      </div>
    </>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className={value ? "text-slate-800" : "text-slate-400"}>{value ?? "Not recorded"}</p>
    </div>
  );
}

function CurrentVisit({ visit }: { visit: VisitView }) {
  const escalated = visit.status === "ESCALATED";

  return (
    <div className={`card-soft space-y-4 p-5 ${escalated ? "border-red-300" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-brand">Today’s visit</p>
          <p className="mt-1 font-semibold">{visit.presentingComplaint}</p>
          <p className="text-xs text-slate-500">
            Arrived{" "}
            {new Date(visit.arrivedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TriageBadge category={visit.triage?.category ?? null} />
          <Chip tone={VISIT_STATUS_TONE[visit.status]}>{VISIT_STATUS_LABELS[visit.status]}</Chip>
        </div>
      </div>

      {escalated ? (
        <div className="flex items-start gap-3 rounded-xl bg-red-600 p-4 text-sm text-white">
          <Siren className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="font-bold">Emergency</p>
            <p>
              Follow your facility’s emergency protocol now: stabilise, arrange transport and refer.
              This patient is not waiting for a Neem doctor.
            </p>
            {visit.escalationNote ? (
              <p className="mt-2 rounded bg-white/15 p-2">Recorded: {visit.escalationNote}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {visit.triage ? <TriageSummary triage={visit.triage} /> : null}

      <TriageForm visit={visit} />

      {visit.encounter ? <DoctorAdvice encounter={visit.encounter} /> : null}

      <DoctorRequest visit={visit} />

      <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
        {!escalated || !visit.escalationNote ? <EscalateForm visit={visit} /> : null}
        <CloseForm visit={visit} />
      </div>
    </div>
  );
}

const VITAL_FIELDS: { key: keyof VitalSigns; label: string; unit: string; step?: string }[] = [
  { key: "bpSystolic", label: "BP systolic", unit: "mmHg" },
  { key: "bpDiastolic", label: "BP diastolic", unit: "mmHg" },
  { key: "temperatureC", label: "Temperature", unit: "°C", step: "0.1" },
  { key: "pulseBpm", label: "Pulse", unit: "/min" },
  { key: "respiratoryRate", label: "Respiratory rate", unit: "/min" },
  { key: "spo2Percent", label: "Oxygen saturation", unit: "%" },
  { key: "weightKg", label: "Weight", unit: "kg", step: "0.1" },
  { key: "heightCm", label: "Height", unit: "cm", step: "0.1" },
  { key: "glucoseMmolL", label: "Blood glucose", unit: "mmol/L", step: "0.1" },
];

function formatVitals(vitals: VitalSigns): string[] {
  const parts: string[] = [];
  if (vitals.bpSystolic && vitals.bpDiastolic) {
    parts.push(`BP ${vitals.bpSystolic}/${vitals.bpDiastolic}`);
  }
  for (const field of VITAL_FIELDS.slice(2)) {
    const value = vitals[field.key];
    if (value !== null && value !== undefined) parts.push(`${field.label} ${value} ${field.unit}`);
  }
  return parts;
}

function TriageSummary({ triage }: { triage: TriageView }) {
  const vitals = formatVitals(triage.vitals);
  return (
    <div className="rounded-xl bg-slate-50 p-4 text-sm">
      <p className="text-xs text-slate-500">
        Last assessed by {triage.recordedBy},{" "}
        {new Date(triage.recordedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </p>
      {vitals.length > 0 ? <p className="mt-1 font-medium">{vitals.join(" · ")}</p> : null}
      {triage.symptoms ? <p className="mt-1">Symptoms: {triage.symptoms}</p> : null}
      {triage.observations ? <p className="mt-1">Observations: {triage.observations}</p> : null}
    </div>
  );
}

function TriageForm({ visit }: { visit: VisitView }) {
  const record = useRecordTriage(visit.publicId);
  const [open, setOpen] = useState(!visit.triage);
  const [category, setCategory] = useState<TriageCategory | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [symptoms, setSymptoms] = useState("");
  const [observations, setObservations] = useState("");
  const errors = record.error instanceof ApiError ? record.error.fieldErrors : {};

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        Re-assess
      </button>
    );
  }

  const submit = () => {
    if (!category) return;
    const vitals: Record<string, number> = {};
    for (const [key, raw] of Object.entries(values)) {
      if (raw.trim() !== "") vitals[key] = Number(raw);
    }
    record.mutate(
      { category, vitals, symptoms, observations },
      {
        onSuccess: () => {
          setOpen(false);
          setValues({});
          setCategory(null);
        },
      },
    );
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div>
        <p className="mb-2 text-sm font-bold">Vital signs</p>
        <p className="mb-2 text-xs text-slate-500">
          Record what you can measure; leave the rest empty.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {VITAL_FIELDS.map((field) => (
            <label key={field.key} className="text-sm">
              <span className="mb-1 block text-xs font-semibold text-slate-500">
                {field.label} <span className="font-normal">({field.unit})</span>
              </span>
              <input
                inputMode="decimal"
                step={field.step}
                value={values[field.key] ?? ""}
                onChange={(event) =>
                  setValues({
                    ...values,
                    [field.key]: event.target.value.replace(/[^\d.]/g, ""),
                  })
                }
                aria-invalid={Boolean(errors[`vitals.${field.key}`])}
                className={inputClass}
              />
              {errors[`vitals.${field.key}`] ? (
                <span className="mt-1 block text-xs text-red-600">
                  {errors[`vitals.${field.key}`]}
                </span>
              ) : null}
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-500">Symptoms</span>
          <textarea
            rows={2}
            value={symptoms}
            onChange={(event) => setSymptoms(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-500">Your observations</span>
          <textarea
            rows={2}
            value={observations}
            onChange={(event) => setObservations(event.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <div>
        <p className="mb-2 text-sm font-bold">Triage category</p>
        <p className="mb-2 text-xs text-slate-500">
          Your clinical judgement, following your triage protocol. Neem does not calculate it.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TRIAGE_CATEGORIES.map((value) => (
            <button
              key={value}
              type="button"
              data-on={category === value}
              onClick={() => setCategory(value)}
              className={`rounded-xl border-2 px-3 py-3 text-left text-sm ${TRIAGE_STYLE[value].button}`}
            >
              <span className="block font-bold">{TRIAGE_CATEGORY_INFO[value].label}</span>
              <span className="block text-xs opacity-90">
                {TRIAGE_CATEGORY_INFO[value].meaning}
              </span>
            </button>
          ))}
        </div>
        {errors.category ? <p className="mt-1 text-xs text-red-600">{errors.category}</p> : null}
      </div>

      {record.error && Object.keys(errors).length === 0 ? (
        <p className="text-sm text-red-600">
          {record.error instanceof ApiError ? record.error.message : "Not saved."}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        {visit.triage ? (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-600"
          >
            Cancel
          </button>
        ) : null}
        <button
          type="submit"
          disabled={!category || record.isPending}
          className={`rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40 ${category === "RED" ? "bg-red-600" : "bg-brand"}`}
        >
          {category === "RED" ? "Save and start emergency" : "Save assessment"}
        </button>
      </div>
    </form>
  );
}

function EscalateForm({ visit }: { visit: VisitView }) {
  const escalate = useEscalateVisit(visit.publicId);
  const [note, setNote] = useState("");

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        escalate.mutate(note);
      }}
    >
      <p className="text-sm font-bold text-red-700">Emergency</p>
      <textarea
        rows={2}
        value={note}
        placeholder="What have you done? Who was called, where are they going?"
        onChange={(event) => setNote(event.target.value)}
        className={inputClass}
      />
      <button
        type="submit"
        disabled={note.trim().length < 2 || escalate.isPending}
        className="w-full rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
      >
        {visit.status === "ESCALATED" ? "Record emergency actions" : "Escalate as emergency"}
      </button>
      {escalate.error ? (
        <p className="text-xs text-red-600">
          {escalate.error instanceof ApiError ? escalate.error.message : "Not saved."}
        </p>
      ) : null}
    </form>
  );
}

function CloseForm({ visit }: { visit: VisitView }) {
  const close = useCloseVisit(visit.publicId);
  const [note, setNote] = useState("");

  return (
    <div className="space-y-2">
      <p className="text-sm font-bold">End the visit</p>
      <textarea
        rows={2}
        value={note}
        placeholder="How did it end? Treatment given, advice, referral made."
        onChange={(event) => setNote(event.target.value)}
        className={inputClass}
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={note.trim().length < 2 || close.isPending}
          onClick={() => close.mutate({ outcome: "CLOSED", note })}
          className="flex-1 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          Complete visit
        </button>
        <button
          type="button"
          disabled={note.trim().length < 2 || close.isPending}
          onClick={() => close.mutate({ outcome: "CANCELLED", note })}
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-600 disabled:opacity-40"
        >
          Cancel visit
        </button>
      </div>
      {close.error ? (
        <p className="text-xs text-red-600">
          {close.error instanceof ApiError ? close.error.message : "Not saved."}
        </p>
      ) : null}
    </div>
  );
}

function PastVisit({ visit }: { visit: VisitView }) {
  return (
    <li className="space-y-1 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">{new Date(visit.arrivedAt).toLocaleDateString()}</p>
        <div className="flex items-center gap-2">
          <TriageBadge category={visit.triage?.category ?? null} />
          <Chip tone={VISIT_STATUS_TONE[visit.status]}>{VISIT_STATUS_LABELS[visit.status]}</Chip>
        </div>
      </div>
      <p className="text-slate-700">{visit.presentingComplaint}</p>
      {visit.triage && formatVitals(visit.triage.vitals).length > 0 ? (
        <p className="text-xs text-slate-500">{formatVitals(visit.triage.vitals).join(" · ")}</p>
      ) : null}
      {visit.escalationNote ? (
        <p className="text-xs text-red-700">Emergency: {visit.escalationNote}</p>
      ) : null}
      {visit.encounter ? <DoctorAdvice encounter={visit.encounter} compact /> : null}
      {visit.closingNote ? <p className="text-xs text-slate-500">{visit.closingNote}</p> : null}
    </li>
  );
}
