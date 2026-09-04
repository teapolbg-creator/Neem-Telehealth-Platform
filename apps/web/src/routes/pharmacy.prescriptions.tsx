import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, ArrowLeftRight, Ban, Check, FileText, Loader2, Pill } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { API_BASE_URL, ApiError } from "@/lib/api-client";
import {
  useDispense,
  usePharmacyPrescriptions,
  useProposeSubstitution,
  type PharmacyPrescription,
  type PharmacyPrescriptionItem,
} from "@/features/clinical/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/pharmacy/prescriptions")({
  component: PharmacyPrescriptions,
});

/**
 * Prescriptions at the pharmacy (spec §45–§48).
 *
 * What this screen deliberately cannot do: change what a doctor prescribed.
 * There is no edit control anywhere on it, because there is no route behind
 * one. A pharmacy that needs a different product proposes a substitution and
 * the issuing doctor decides (spec §47).
 *
 * The list refreshes on its own because a doctor may revoke while a pharmacist
 * is looking at it, and dispensing a revoked prescription is precisely what
 * must not happen.
 */
function PharmacyPrescriptions() {
  const [activeOnly, setActiveOnly] = useState(true);
  const { data: prescriptions, isLoading, error } = usePharmacyPrescriptions(activeOnly);

  return (
    <AppShell active="pharmacy">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Pharmacy</p>
        <h1 className="text-3xl font-bold tracking-tight">Prescriptions</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Issued by Neem doctors for patients seen at this pharmacy. You cannot change a
          prescription — if you need a different product, propose a substitution and the doctor
          decides.
        </p>
      </header>

      <div className="flex gap-1 rounded-xl bg-slate-100 p-1 w-fit">
        {[
          { key: true, label: "To dispense" },
          { key: false, label: "All" },
        ].map((option) => (
          <button
            key={String(option.key)}
            type="button"
            onClick={() => setActiveOnly(option.key)}
            className={cn(
              "rounded-lg px-4 py-2 text-xs font-semibold transition-colors",
              activeOnly === option.key
                ? "bg-white text-brand shadow-sm"
                : "text-slate-500 hover:bg-white/60",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      )}

      {error && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {error instanceof ApiError ? error.message : "Could not load prescriptions."}
          </p>
        </div>
      )}

      {prescriptions?.length === 0 && (
        <div className="card-soft p-12 text-center">
          <Pill className="mx-auto size-10 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">
            {activeOnly
              ? "Nothing waiting to be dispensed."
              : "No prescriptions have been issued here yet."}
          </p>
        </div>
      )}

      <div className="space-y-4">
        {prescriptions?.map((prescription) => (
          <PrescriptionCard key={prescription.publicId} prescription={prescription} />
        ))}
      </div>
    </AppShell>
  );
}

const STATE_TONE: Record<string, "brand" | "medical" | "warning" | "muted" | "danger"> = {
  ACTIVE: "brand",
  PENDING_SUBSTITUTION: "warning",
  SUBSTITUTION_APPROVED: "medical",
  SUBSTITUTION_REJECTED: "medical",
  DISPENSED: "muted",
  REVOKED: "danger",
};

function PrescriptionCard({ prescription }: { prescription: PharmacyPrescription }) {
  const dispense = useDispense();
  const [substituting, setSubstituting] = useState<PharmacyPrescriptionItem | null>(null);

  const revoked = prescription.state === "REVOKED";
  const dispensed = prescription.state === "DISPENSED";
  const awaitingDoctor = prescription.state === "PENDING_SUBSTITUTION";
  const dispensable = !revoked && !dispensed && !awaitingDoctor;

  const decision =
    prescription.lastSubstitution &&
    (prescription.lastSubstitution.state === "APPROVED" ||
      prescription.lastSubstitution.state === "REJECTED")
      ? prescription.lastSubstitution
      : null;

  return (
    <section className={cn("card-soft p-6", revoked && "border-red-200 bg-red-50/40")}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-bold">{prescription.patientName}</h2>
          <p className="text-sm text-slate-500">
            {prescription.patientAge} years · {prescription.doctor.fullName}
          </p>
          {/*
            The consultation reference (D24). The patient may quote this, and
            it is printed on their copy of the document.
          */}
          <p className="mt-2 font-mono text-[11px] text-slate-500">
            {prescription.consultationReference}
          </p>
        </div>

        <Chip tone={STATE_TONE[prescription.state] ?? "muted"}>
          {prescription.state.replace(/_/g, " ").toLowerCase()}
        </Chip>
      </div>

      {revoked && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3">
          <Ban className="mt-0.5 size-4 shrink-0 text-red-500" />
          <div className="text-sm text-red-700">
            <p className="font-bold">The doctor revoked this prescription. Do not dispense.</p>
            {prescription.revokedReason && <p className="mt-1">{prescription.revokedReason}</p>}
          </div>
        </div>
      )}

      {awaitingDoctor && (
        <p className="mt-4 rounded-xl bg-warning-soft p-3 text-sm text-warning">
          A substitution is with the doctor. Wait for their decision before dispensing.
        </p>
      )}

      {/*
        The doctor's answer, in their words.

        A refusal reaches the counter as SUBSTITUTION_REJECTED, which says the
        answer was no and nothing else. The pharmacist has to explain it to the
        patient in front of them, so the doctor's note belongs here.
      */}
      {decision && (
        <div
          className={cn(
            "mt-4 rounded-xl p-3 text-sm",
            decision.state === "APPROVED"
              ? "bg-medical-soft text-medical"
              : "border border-border bg-slate-50 text-slate-700",
          )}
        >
          <p className="font-bold">
            {decision.state === "APPROVED"
              ? `The doctor approved ${decision.proposedMedication}.`
              : `The doctor declined ${decision.proposedMedication}. Dispense as originally written.`}
          </p>
          {decision.decisionNote && <p className="mt-1">“{decision.decisionNote}”</p>}
        </div>
      )}

      <ul className="mt-4 space-y-3">
        {prescription.items.map((item) => (
          <li key={item.id} className="rounded-2xl border border-border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold">
                  {[item.medication, item.strength, item.form].filter(Boolean).join(" · ")}
                </p>
                <p className="mt-0.5 text-sm text-slate-600">
                  {item.dose} · {item.frequency} · {item.durationText}
                </p>
                <p className="mt-0.5 text-sm font-semibold text-slate-900">
                  Quantity: {item.quantity}
                </p>
                {item.instructions && (
                  <p className="mt-1 text-xs italic text-slate-500">{item.instructions}</p>
                )}
              </div>

              {dispensable && (
                <button
                  type="button"
                  onClick={() => setSubstituting(item)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-slate-50"
                >
                  <ArrowLeftRight className="size-3.5" /> Propose substitution
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {substituting && (
        <SubstitutionForm
          prescriptionPublicId={prescription.publicId}
          item={substituting}
          onClose={() => setSubstituting(null)}
        />
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <a
          href={`${API_BASE_URL}/api/v1/documents/prescriptions/${prescription.publicId}.pdf`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-slate-50"
        >
          <FileText className="size-4" /> Open prescription
        </a>

        {dispensed ? (
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500">
            <Check className="size-4" /> Dispensed{" "}
            {prescription.dispensedAt && new Date(prescription.dispensedAt).toLocaleString()}
          </span>
        ) : (
          <button
            type="button"
            disabled={!dispensable || dispense.isPending}
            onClick={() => dispense.mutate(prescription.publicId)}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
          >
            {dispense.isPending && <Loader2 className="size-4 animate-spin" />}
            Mark dispensed
          </button>
        )}
      </div>

      {dispense.error && (
        <p className="mt-3 text-sm text-red-600">
          {dispense.error instanceof ApiError ? dispense.error.message : "Could not dispense."}
        </p>
      )}

      {dispensable && (
        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          Marking dispensed is final. After it, the doctor can no longer revoke this prescription.
        </p>
      )}
    </section>
  );
}

/**
 * Proposing a substitution.
 *
 * The dosing fields are deliberately not editable here: a substitution is of
 * the product, not the regimen. Changing how much or how often is prescribing,
 * and that is the doctor's alone (spec §47).
 */
function SubstitutionForm({
  prescriptionPublicId,
  item,
  onClose,
}: {
  prescriptionPublicId: string;
  item: PharmacyPrescriptionItem;
  onClose: () => void;
}) {
  const propose = useProposeSubstitution();
  const [form, setForm] = useState({ medication: "", strength: "", form: "", reason: "" });

  if (propose.isSuccess) {
    return (
      <div className="mt-4 rounded-2xl border border-brand/30 bg-brand-soft p-4">
        <p className="text-sm font-bold text-brand">Sent to the doctor</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          They will approve or decline it. This prescription cannot be dispensed until they answer.
        </p>
      </div>
    );
  }

  const complete = form.medication.length > 1 && form.reason.length > 2;

  return (
    <div className="mt-4 rounded-2xl border-2 border-border p-4">
      <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
        Substitute for {item.medication}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <SmallInput
          label="Medication"
          value={form.medication}
          onChange={(medication) => setForm({ ...form, medication })}
        />
        <SmallInput
          label="Strength"
          value={form.strength}
          onChange={(strength) => setForm({ ...form, strength })}
        />
        <SmallInput
          label="Form"
          value={form.form}
          onChange={(value) => setForm({ ...form, form: value })}
        />
      </div>

      <label htmlFor="substitution-reason" className="mt-3 block">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Reason
        </span>
        <textarea
          id="substitution-reason"
          rows={2}
          value={form.reason}
          onChange={(event) => setForm({ ...form, reason: event.target.value })}
          placeholder="Out of stock, same molecule available"
          className="mt-1 w-full resize-y rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
      </label>

      <p className="mt-2 text-xs text-slate-500">
        The dose, frequency and duration the doctor set carry over unchanged.
      </p>

      {propose.error && (
        <p className="mt-2 text-sm text-red-600">
          {propose.error instanceof ApiError ? propose.error.message : "Could not send."}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={!complete || propose.isPending}
          onClick={() =>
            propose.mutate({
              prescriptionPublicId,
              itemId: item.id,
              medication: form.medication,
              strength: form.strength || undefined,
              form: form.form || undefined,
              reason: form.reason,
            })
          }
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
        >
          {propose.isPending && <Loader2 className="size-4 animate-spin" />}
          Send to the doctor
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-border px-5 py-2.5 text-sm font-semibold hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SmallInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `sub-${label.toLowerCase()}`;

  return (
    <label htmlFor={id} className="block">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
      />
    </label>
  );
}
