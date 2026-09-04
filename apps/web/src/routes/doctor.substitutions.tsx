import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, ArrowRight, Check, Loader2, X } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  useDecideSubstitution,
  useDoctorSubstitutions,
  type PendingSubstitution,
} from "@/features/clinical/api";

export const Route = createFileRoute("/doctor/substitutions")({
  component: DoctorSubstitutions,
});

/**
 * Substitutions awaiting this doctor (spec §47).
 *
 * A pharmacy cannot alter a prescription; it can only propose. Until the
 * doctor answers, the prescription cannot be dispensed — so every row here is
 * a patient standing at a counter with nothing in their hand. That is why this
 * screen exists rather than only a realtime toast: a doctor who was offline
 * when the proposal arrived would otherwise never learn of it.
 */
function DoctorSubstitutions() {
  const { data, isLoading, error } = useDoctorSubstitutions();

  return (
    <AppShell active="doctor">
      <div className="mx-auto w-full max-w-3xl">
        <p className="text-xs font-bold uppercase tracking-wider text-brand">Doctor</p>
        <h1 className="mt-1 text-3xl font-bold">Substitutions</h1>
        <p className="mt-2 max-w-2xl text-pretty text-sm leading-relaxed text-slate-500">
          A pharmacy has asked to dispense something other than what you prescribed. Nothing has
          changed yet — the prescription is held until you decide, and the patient is waiting.
        </p>

        {isLoading && (
          <div className="grid place-items-center py-20">
            <Loader2 className="size-6 animate-spin text-brand" />
          </div>
        )}

        {error && (
          <div className="card-soft mt-6 p-8 text-center">
            <AlertCircle className="mx-auto size-9 text-slate-300" />
            <p className="mt-3 text-sm text-slate-500">
              {error instanceof ApiError ? error.message : "These could not be loaded."}
            </p>
          </div>
        )}

        {data && data.length === 0 && (
          <div className="card-soft mt-6 p-10 text-center">
            <Check className="mx-auto size-9 text-slate-300" />
            <h2 className="mt-3 text-lg font-bold">Nothing waiting</h2>
            <p className="mt-1 text-sm text-slate-500">
              No pharmacy is waiting on a decision from you.
            </p>
          </div>
        )}

        <div className="mt-6 space-y-5">
          {data?.map((proposal) => (
            <ProposalCard key={proposal.id} proposal={proposal} />
          ))}
        </div>
      </div>
    </AppShell>
  );
}

function ProposalCard({ proposal }: { proposal: PendingSubstitution }) {
  const decide = useDecideSubstitution();
  const [note, setNote] = useState("");

  const product = (parts: Array<string | null>) => parts.filter(Boolean).join(" · ");

  return (
    <article className="card-soft p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">{proposal.patient.fullName}</h2>
          <p className="text-sm text-slate-500">
            {proposal.patient.age} years · {proposal.patient.sex.toLowerCase()} ·{" "}
            {proposal.pharmacy.name}, {proposal.pharmacy.city}
          </p>
          <p className="mt-1 font-mono text-xs text-slate-400">{proposal.consultationReference}</p>
        </div>
        <Chip tone="warning">awaiting your decision</Chip>
      </header>

      {/*
        Both products side by side. A doctor deciding this needs to see exactly
        what changes, and reading a proposal without the original in view is
        how a strength gets approved by accident.
      */}
      <div className="mt-5 grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <div className="rounded-2xl border border-border p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
            You prescribed
          </p>
          <p className="mt-1.5 font-bold">
            {product([
              proposal.prescribed.medication,
              proposal.prescribed.strength,
              proposal.prescribed.form,
            ])}
          </p>
          <p className="mt-0.5 text-sm text-slate-600">
            {proposal.prescribed.dose} · {proposal.prescribed.frequency} ·{" "}
            {proposal.prescribed.durationText}
          </p>
          <p className="mt-0.5 text-sm font-semibold">Quantity: {proposal.prescribed.quantity}</p>
        </div>

        <ArrowRight className="mx-auto hidden size-5 shrink-0 text-slate-300 sm:block" />

        <div className="rounded-2xl border-2 border-brand/30 bg-brand/[0.03] p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-brand">
            The pharmacy proposes
          </p>
          <p className="mt-1.5 font-bold">
            {product([
              proposal.proposed.medication,
              proposal.proposed.strength,
              proposal.proposed.form,
            ])}
          </p>
          {/*
            Dose, frequency and duration are deliberately not repeated here.
            A substitution changes the product, never the regimen — showing
            them under the proposal would suggest the pharmacy could alter them.
          */}
          <p className="mt-0.5 text-sm text-slate-500">Same dose, frequency and duration.</p>
        </div>
      </div>

      <div className="mt-4 rounded-2xl bg-slate-50 p-4">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
          The pharmacy’s reason
        </p>
        <p className="mt-1 text-pretty text-sm leading-relaxed text-slate-700">{proposal.reason}</p>
      </div>

      <label className="mt-4 block">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
          Note to the pharmacy (optional)
        </span>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Approved — same molecule and strength."
          className="mt-1.5 w-full rounded-xl border border-border px-3 py-2 text-sm"
        />
      </label>

      {decide.error && (
        <p className="mt-3 text-sm text-red-600">
          {decide.error instanceof ApiError
            ? decide.error.message
            : "The decision could not be recorded."}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() =>
            decide.mutate({ id: proposal.id, approve: true, note: note.trim() || undefined })
          }
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
        >
          {decide.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          Approve the substitution
        </button>
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() =>
            decide.mutate({ id: proposal.id, approve: false, note: note.trim() || undefined })
          }
          className="inline-flex items-center gap-2 rounded-xl border border-border px-5 py-2.5 text-sm font-bold hover:bg-slate-50 disabled:opacity-40"
        >
          <X className="size-4" /> Keep what I prescribed
        </button>
      </div>

      {/*
        Rejecting is not a dead end for the patient: the prescription returns to
        a dispensable state as originally written. Saying so stops a doctor
        rejecting a reasonable substitution out of fear of stranding them.
      */}
      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        Either answer releases the prescription. If you keep what you prescribed, the pharmacy
        dispenses your original — or tells the patient where else to fill it.
      </p>
    </article>
  );
}
