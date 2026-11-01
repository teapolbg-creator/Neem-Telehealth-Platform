import { useEffect, useState } from "react";
import { AlertTriangle, Building2, Check, History, Loader2, MessageSquare } from "lucide-react";
import {
  ENCOUNTER_REQUIRED,
  ENCOUNTER_SECTIONS,
  NHIS_STATUS_LABELS,
  type ChpsConsultationContext,
  type EncounterContent,
  type TriageView,
  type VitalSigns,
} from "@neem/contracts";
import { ApiError } from "@/lib/api-client";
import { TriageBadge } from "@/features/facility/TriageBadge";
import { SEX_LABEL, ageLabel } from "@/features/facility/patients";
import { useSaveEncounter } from "@/features/chps/doctor";

/**
 * What the doctor sees from the CHPS compound, and the encounter record they
 * write (slice 1e, D78).
 */

const VITAL_LABELS: { key: keyof VitalSigns; label: string; unit: string }[] = [
  { key: "temperatureC", label: "Temp", unit: "°C" },
  { key: "pulseBpm", label: "Pulse", unit: "/min" },
  { key: "respiratoryRate", label: "Resp", unit: "/min" },
  { key: "spo2Percent", label: "SpO₂", unit: "%" },
  { key: "weightKg", label: "Weight", unit: "kg" },
  { key: "heightCm", label: "Height", unit: "cm" },
  { key: "glucoseMmolL", label: "Glucose", unit: "mmol/L" },
];

function Vitals({ vitals }: { vitals: VitalSigns | Record<string, number | null> | null }) {
  if (!vitals) return null;
  const items: string[] = [];
  if (vitals.bpSystolic && vitals.bpDiastolic) {
    items.push(`BP ${vitals.bpSystolic}/${vitals.bpDiastolic} mmHg`);
  }
  for (const field of VITAL_LABELS) {
    const value = vitals[field.key];
    if (value !== null && value !== undefined) items.push(`${field.label} ${value} ${field.unit}`);
  }
  if (items.length === 0) return <p className="text-sm text-slate-400">No readings recorded.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span key={item} className="rounded-lg bg-slate-100 px-2.5 py-1 text-sm font-medium">
          {item}
        </span>
      ))}
    </div>
  );
}

function TriageBlock({ triage }: { triage: TriageView }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <TriageBadge category={triage.category} />
        <span>
          by {triage.recordedBy},{" "}
          {new Date(triage.recordedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      </div>
      <Vitals vitals={triage.vitals} />
      {triage.symptoms ? <p className="text-sm">Symptoms: {triage.symptoms}</p> : null}
      {triage.observations ? (
        <p className="text-sm">CHO observations: {triage.observations}</p>
      ) : null}
    </div>
  );
}

/** The CHO's side of the patient, above the call. */
export function ChpsContextPanel({ context }: { context: ChpsConsultationContext }) {
  const { patient, visit, facility } = context;

  return (
    <div className="card-soft space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-brand">
            <Building2 className="size-4" /> From {facility.name}
          </p>
          <p className="mt-1 text-lg font-bold">{patient.fullName}</p>
          <p className="text-sm text-slate-500">
            {SEX_LABEL[patient.sex]} · {ageLabel(patient.dateOfBirth, patient.dobIsEstimated)} ·{" "}
            {patient.community} · NHIS: {NHIS_STATUS_LABELS[patient.nhisStatus]}
          </p>
        </div>
        <p className="font-mono text-sm text-slate-500">{patient.patientNumber}</p>
      </div>

      {patient.allergies ? (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-bold">Allergies:</span> {patient.allergies}
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Why they came
          </p>
          <p className="text-sm font-medium">{visit.presentingComplaint}</p>
          {visit.choNote ? (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-sm text-amber-900">
              <MessageSquare className="mt-0.5 size-4 shrink-0" />
              <span>CHO note: {visit.choNote}</span>
            </p>
          ) : null}
          {patient.medications ? (
            <p className="text-sm">
              <span className="text-slate-500">Medicines:</span> {patient.medications}
            </p>
          ) : null}
          {patient.medicalHistory ? (
            <p className="text-sm">
              <span className="text-slate-500">History:</span> {patient.medicalHistory}
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            CHO assessment
          </p>
          {visit.triage ? (
            <TriageBlock triage={visit.triage} />
          ) : (
            <p className="text-sm text-slate-400">Not triaged.</p>
          )}
        </div>
      </div>

      {context.priorVisits.length > 0 ? (
        <details className="rounded-xl border border-border p-3">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
            <History className="size-4 text-brand" /> Earlier visits ({context.priorVisits.length})
          </summary>
          <ul className="mt-3 divide-y divide-border">
            {context.priorVisits.map((prior) => (
              <li key={prior.arrivedAt} className="space-y-1 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold">{new Date(prior.arrivedAt).toLocaleDateString()}</p>
                  <TriageBadge category={prior.triage?.category ?? null} />
                </div>
                <p>{prior.presentingComplaint}</p>
                {prior.encounter ? (
                  <div className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
                    {prior.encounter.diagnosis ? (
                      <p>Diagnosis: {prior.encounter.diagnosis}</p>
                    ) : null}
                    {prior.encounter.treatmentPlan ? (
                      <p>Plan: {prior.encounter.treatmentPlan}</p>
                    ) : null}
                    {prior.encounter.doctorName ? <p>— {prior.encounter.doctorName}</p> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

const EMPTY: EncounterContent = Object.fromEntries(
  ENCOUNTER_SECTIONS.map((section) => [section.key, null]),
) as EncounterContent;

/**
 * The structured encounter record (brief §B4). A draft until the
 * consultation is completed; after that, saving is an amendment and asks why.
 */
export function EncounterForm({
  publicId,
  context,
}: {
  publicId: string;
  context: ChpsConsultationContext;
}) {
  const save = useSaveEncounter(publicId);
  const encounter = context.encounter;
  const final = Boolean(encounter?.finalisedAt);
  const [content, setContent] = useState<EncounterContent>(
    () =>
      encounter?.content ?? {
        ...EMPTY,
        presentingComplaint: context.visit.presentingComplaint,
      },
  );
  const [reason, setReason] = useState("");
  const [dirty, setDirty] = useState(false);
  const { mutate } = save;

  /*
   * Drafts save themselves a moment after the doctor stops typing, and at
   * once when they leave a field, so a doctor who goes straight to Complete
   * does not complete over a draft a keystroke behind.
   */
  const saveDraft = () => {
    if (!dirty || final) return;
    mutate({ content }, { onSuccess: () => setDirty(false) });
  };
  useEffect(() => {
    if (!dirty || final) return;
    const timer = window.setTimeout(() => {
      mutate({ content }, { onSuccess: () => setDirty(false) });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [content, dirty, final, mutate]);

  const missing = ENCOUNTER_REQUIRED.filter((key) => !content[key]?.trim());

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-bold">Encounter record</p>
          <p className="text-xs text-slate-500">
            Kept in the patient’s CHPS record for the clinicians who care for them. Not sealed.
          </p>
        </div>
        <span className="text-xs text-slate-500">
          {save.isPending ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" /> Saving
            </span>
          ) : final ? (
            `Final, version ${encounter!.version}`
          ) : encounter && !dirty ? (
            <span className="inline-flex items-center gap-1 text-brand">
              <Check className="size-3" /> Draft saved
            </span>
          ) : dirty ? (
            "Unsaved"
          ) : null}
        </span>
      </div>

      <div className="rounded-xl bg-slate-50 p-3">
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Vital signs (recorded by the CHO)
        </p>
        <Vitals vitals={encounter?.vitalsSnapshot ?? context.visit.triage?.vitals ?? null} />
      </div>

      {ENCOUNTER_SECTIONS.map((section) => (
        <label key={section.key} className="block text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-600">
            {section.label}
            {ENCOUNTER_REQUIRED.includes(section.key) ? " *" : ""}
            {section.hint ? (
              <span className="ml-1 font-normal text-slate-400">{section.hint}</span>
            ) : null}
          </span>
          <textarea
            rows={section.key === "presentingComplaint" || section.key === "diagnosis" ? 1 : 2}
            value={content[section.key] ?? ""}
            onChange={(event) => {
              setContent({ ...content, [section.key]: event.target.value });
              setDirty(true);
            }}
            onBlur={saveDraft}
            className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none"
          />
        </label>
      ))}

      <p className="text-xs text-slate-500">
        Prescriptions and referrals are issued from their own tabs. Completing the consultation
        needs a clinical assessment and a treatment plan
        {missing.length > 0 ? " — still to write." : "."}
      </p>

      {final ? (
        <div className="space-y-2 rounded-xl border border-border p-3">
          <p className="text-sm font-semibold">Amend the final record</p>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why are you amending it?"
            className="w-full rounded-lg border border-border px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={reason.trim().length < 3 || !dirty || save.isPending}
            onClick={() =>
              save.mutate(
                { content, amendmentReason: reason },
                {
                  onSuccess: () => {
                    setReason("");
                    setDirty(false);
                  },
                },
              )
            }
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            Save amendment
          </button>
          {encounter && encounter.versions.length > 0 ? (
            <ul className="space-y-0.5 text-xs text-slate-500">
              {encounter.versions.map((version) => (
                <li key={version.version}>
                  v{version.version} · {version.author} ·{" "}
                  {new Date(version.createdAt).toLocaleString()}
                  {version.reason ? ` · “${version.reason}”` : " · completed"}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {save.error ? (
        <p className="text-sm text-red-600">
          {save.error instanceof ApiError ? save.error.message : "Not saved."}
        </p>
      ) : null}
    </div>
  );
}
