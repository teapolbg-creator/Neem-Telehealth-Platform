import { useState } from "react";
import { Activity, Check, Loader2, Lock, Plus, Thermometer } from "lucide-react";
import { ApiError } from "@/lib/api-client";
import {
  usePharmacyCapabilities,
  usePharmacyObservations,
  useRecordTest,
  useRecordVitals,
  type Observations,
  type VitalsInput,
} from "@/features/clinical/api";
import { cn } from "@/lib/utils";

/**
 * What the pharmacy measures before the doctor joins (spec §50).
 *
 * This is the only clinical data a pharmacy contributes, and the only reason
 * the doctor sees anything at all beyond the patient's name and age. A remote
 * doctor cannot take a blood pressure; the pharmacy can, and that is most of
 * what makes the consultation safe.
 *
 * Deliberately absent: any field for a complaint, a history, or an opinion.
 * The pharmacy records what it measured. What it means is the doctor's to
 * decide (spec §19).
 */
export function ClinicalIntake({ consultationPublicId }: { consultationPublicId: string }) {
  const { data, isLoading, error } = usePharmacyObservations(consultationPublicId);

  if (isLoading) {
    return (
      <section className="card-soft grid place-items-center p-10">
        <Loader2 className="size-5 animate-spin text-brand" />
      </section>
    );
  }

  if (error || !data) {
    return (
      <section className="card-soft p-6">
        <h2 className="font-bold">Observations</h2>
        <p className="mt-2 text-sm text-slate-500">
          {error instanceof ApiError ? error.message : "These could not be loaded."}
        </p>
      </section>
    );
  }

  if (data.sealed) {
    return (
      <section className="card-soft p-6">
        <h2 className="flex items-center gap-2 font-bold">
          <Lock className="size-4 text-slate-400" /> Observations
        </h2>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-slate-500">
          This consultation has ended. What was recorded is sealed and is no longer readable here,
          including by this pharmacy.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <VitalsPanel consultationPublicId={consultationPublicId} recorded={data.vitals} />
      <TestsPanel consultationPublicId={consultationPublicId} tests={data.tests} />
    </div>
  );
}

const VITAL_FIELDS: Array<{
  key: keyof VitalsInput;
  label: string;
  unit: string;
  step?: string;
}> = [
  { key: "bpSystolic", label: "Systolic BP", unit: "mmHg" },
  { key: "bpDiastolic", label: "Diastolic BP", unit: "mmHg" },
  { key: "pulseBpm", label: "Pulse", unit: "bpm" },
  { key: "temperatureC", label: "Temperature", unit: "°C", step: "0.1" },
  { key: "spo2Percent", label: "Oxygen saturation", unit: "%" },
  { key: "weightKg", label: "Weight", unit: "kg", step: "0.1" },
];

function VitalsPanel({
  consultationPublicId,
  recorded,
}: {
  consultationPublicId: string;
  recorded: Observations["vitals"];
}) {
  const record = useRecordVitals(consultationPublicId);
  const [values, setValues] = useState<Record<string, string>>({});

  /**
   * Blank means "not measured", not zero.
   *
   * A pharmacy without a pulse oximeter must be able to submit a blood
   * pressure alone. Sending 0 for the rest would put a fabricated reading in
   * front of the doctor, so empty fields are omitted entirely.
   */
  const readings: VitalsInput = {};
  for (const field of VITAL_FIELDS) {
    const raw = values[field.key]?.trim();
    if (raw) readings[field.key] = Number(raw) as never;
  }
  const anything = Object.keys(readings).length > 0;

  return (
    <section className="card-soft p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-bold">
            <Activity className="size-4 text-brand" /> Vitals
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            The doctor cannot take these remotely. Leave anything you did not measure blank.
          </p>
        </div>
        {recorded && (
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-medical-soft px-3 py-1.5 text-xs font-semibold text-medical">
            <Check className="size-3.5" />
            Recorded{" "}
            {new Date(recorded.recordedAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>

      {recorded && (
        <dl className="mt-4 grid gap-x-6 gap-y-2 rounded-2xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
          {VITAL_FIELDS.filter((field) => recorded[field.key] !== null && recorded[field.key] !== undefined).map(
            (field) => (
              <div key={field.key} className="flex justify-between gap-4">
                <dt className="text-slate-500">{field.label}</dt>
                <dd className="font-semibold tabular-nums">
                  {String(recorded[field.key])} {field.unit}
                </dd>
              </div>
            ),
          )}
        </dl>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {VITAL_FIELDS.map((field) => (
          <label key={field.key} className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              {field.label}
              <span className="ml-1 font-semibold normal-case tracking-normal text-slate-400">
                {field.unit}
              </span>
            </span>
            <input
              type="number"
              inputMode="decimal"
              step={field.step ?? "1"}
              value={values[field.key] ?? ""}
              onChange={(event) =>
                setValues((current) => ({ ...current, [field.key]: event.target.value }))
              }
              className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm tabular-nums"
            />
          </label>
        ))}
      </div>

      {record.error && (
        <p className="mt-3 text-sm text-red-600">
          {record.error instanceof ApiError
            ? record.error.message
            : "The readings could not be saved."}
        </p>
      )}

      <button
        type="button"
        disabled={!anything || record.isPending}
        onClick={() =>
          record.mutate(readings, {
            onSuccess: () => setValues({}),
          })
        }
        className={cn(
          "mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white",
          "hover:brightness-110 disabled:opacity-40",
        )}
      >
        {record.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        {recorded ? "Record new readings" : "Record vitals"}
      </button>

      {/*
        Said out loud because the button label alone does not make it obvious,
        and a pharmacist who thinks they are editing will not re-measure.
      */}
      <p className="mt-2 text-xs text-slate-500">
        Each set of readings is added, not overwritten. The doctor sees the most recent.
      </p>
    </section>
  );
}

/**
 * Point-of-care tests.
 *
 * The pharmacy's own declared tests come first, as one tap each. Free text
 * stays underneath for anything else: the range of strips and devices in a
 * Ghanaian pharmacy is not something to guess at, and a closed list that
 * omitted what they actually ran would push them into recording nothing.
 *
 * Choosing a declared test carries its real code through. Typing one derives a
 * code from the text, which is why the declared list matters — three
 * pharmacists typing the same test three ways produced three codes, and
 * nothing downstream could group them.
 */
function TestsPanel({
  consultationPublicId,
  tests,
}: {
  consultationPublicId: string;
  tests: Observations["tests"];
}) {
  const record = useRecordTest(consultationPublicId);
  const { data: capabilities } = usePharmacyCapabilities();
  const [label, setLabel] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [result, setResult] = useState("");

  const declaredTests = (capabilities ?? []).filter((capability) => capability.kind === "TEST");

  // Already recorded this visit, so the same test is not offered twice.
  const recorded = new Set(tests.map((test) => test.code));

  const choose = (capability: { code: string; label: string }) => {
    setCode(capability.code);
    setLabel(capability.label);
  };

  const reset = () => {
    setLabel("");
    setCode(null);
    setResult("");
  };

  const submit = () => {
    const trimmedLabel = label.trim();
    const trimmedResult = result.trim();
    if (!trimmedLabel || !trimmedResult) return;

    record.mutate(
      {
        // The declared code when one was chosen; otherwise derived, because a
        // pharmacist should not have to invent a code and the label is what
        // the doctor reads.
        code: code ?? trimmedLabel.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 60),
        label: trimmedLabel,
        result: trimmedResult,
      },
      { onSuccess: reset },
    );
  };

  return (
    <section className="card-soft p-6">
      <h2 className="flex items-center gap-2 font-bold">
        <Thermometer className="size-4 text-brand" /> Point-of-care tests
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Anything you ran at the counter — malaria RDT, blood glucose, a pregnancy test.
      </p>

      {tests.length > 0 && (
        <ul className="mt-4 space-y-2">
          {tests.map((test) => (
            <li
              key={`${test.code}-${test.recordedAt}`}
              className="flex flex-wrap items-baseline justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3 text-sm"
            >
              <span className="font-semibold">{test.label}</span>
              <span className="text-slate-700">{test.result}</span>
              <span className="text-xs text-slate-400">
                {new Date(test.recordedAt).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </li>
          ))}
        </ul>
      )}

      {declaredTests.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Tests this pharmacy offers
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {declaredTests.map((capability) => (
              <button
                key={capability.code}
                type="button"
                disabled={recorded.has(capability.code)}
                onClick={() => choose(capability)}
                className={
                  code === capability.code
                    ? "rounded-xl border-2 border-brand bg-brand/5 px-3 py-1.5 text-xs font-bold"
                    : "rounded-xl border border-border px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-40"
                }
              >
                {capability.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Test</span>
          <input
            value={label}
            onChange={(event) => {
              setLabel(event.target.value);
              // Typing over a chosen test means it is no longer that test, so
              // its code must not travel with the new name.
              setCode(null);
            }}
            maxLength={160}
            placeholder="Something else you ran"
            className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Result</span>
          <input
            value={result}
            onChange={(event) => setResult(event.target.value)}
            maxLength={500}
            placeholder="Positive"
            className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
          />
        </label>
      </div>

      {record.error && (
        <p className="mt-3 text-sm text-red-600">
          {record.error instanceof ApiError ? record.error.message : "The result could not be saved."}
        </p>
      )}

      <button
        type="button"
        disabled={!label.trim() || !result.trim() || record.isPending}
        onClick={submit}
        className="mt-4 inline-flex items-center gap-2 rounded-xl border border-border px-5 py-2.5 text-sm font-bold hover:bg-slate-50 disabled:opacity-40"
      >
        {record.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        Add result
      </button>
    </section>
  );
}
