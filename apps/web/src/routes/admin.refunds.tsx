import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Check, Loader2, Undo2, X } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  formatMinor,
  useAdminRefunds,
  useDecideRefund,
  type AdminRefund,
} from "@/features/finance/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/refunds")({
  component: AdminRefunds,
});

/**
 * Refund decisions (spec §41).
 *
 * The only surface in Neem that moves money back. There is no automatic
 * refund anywhere in the system — a patient or a pharmacy asks, and an
 * administrator decides here, with a reason recorded either way.
 */
function AdminRefunds() {
  const [openOnly, setOpenOnly] = useState(true);
  const { data: refunds, isLoading, error } = useAdminRefunds(openOnly);

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Refunds</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Every request is reviewed by a person. Approving one returns the fee through the payment
          provider and reverses the revenue split; the allocation is kept and marked reversed, never
          deleted.
        </p>
      </header>

      <div className="flex w-fit gap-1 rounded-xl bg-slate-100 p-1">
        {[
          { key: true, label: "Awaiting a decision" },
          { key: false, label: "All" },
        ].map((option) => (
          <button
            key={String(option.key)}
            type="button"
            onClick={() => setOpenOnly(option.key)}
            className={cn(
              "rounded-lg px-4 py-2 text-xs font-semibold transition-colors",
              openOnly === option.key
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
            {error instanceof ApiError ? error.message : "Refunds could not be loaded."}
          </p>
        </div>
      )}

      {refunds?.length === 0 && (
        <div className="card-soft p-12 text-center">
          <Undo2 className="mx-auto size-10 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">
            {openOnly ? "Nothing is waiting on a decision." : "No refunds have been requested yet."}
          </p>
        </div>
      )}

      <div className="space-y-4">
        {refunds?.map((refund) => (
          <RefundCard key={refund.publicId} refund={refund} />
        ))}
      </div>
    </AppShell>
  );
}

const STATE_TONE: Record<string, "brand" | "medical" | "warning" | "muted" | "danger"> = {
  REQUESTED: "warning",
  APPROVED: "medical",
  PROCESSING: "medical",
  COMPLETED: "muted",
  REJECTED: "muted",
  FAILED: "danger",
};

function RefundCard({ refund }: { refund: AdminRefund }) {
  const decide = useDecideRefund();
  const [note, setNote] = useState("");

  /**
   * Only an undecided refund can be decided.
   *
   * PROCESSING means the provider already has it and the money is on its way
   * back; the decision has been made. Offering the buttons there invited an
   * administrator to press one and be told 409 — accurate, and a poor way to
   * find out.
   */
  const open = refund.state === "REQUESTED";

  const awaitingProvider = refund.state === "APPROVED" || refund.state === "PROCESSING";

  return (
    <section className="card-soft p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-2xl font-bold">{formatMinor(refund.amountMinor, refund.currency)}</p>
          <p className="mt-1 text-sm text-slate-500">
            {refund.pharmacyName} · asked by {refund.requestedByType.toLowerCase()} ·{" "}
            {new Date(refund.createdAt).toLocaleDateString()}
          </p>
          <p className="mt-2 font-mono text-[11px] text-slate-500">
            {refund.consultationReference}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Chip tone={STATE_TONE[refund.state] ?? "muted"}>
            {refund.state.replace(/_/g, " ").toLowerCase()}
          </Chip>
          <span className="text-[11px] text-slate-400">
            consultation {refund.consultationState.replace(/_/g, " ").toLowerCase()}
          </span>
        </div>
      </div>

      <div className="mt-4 rounded-2xl bg-slate-50 p-4">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
          Why they are asking
        </p>
        <p className="mt-1 text-pretty text-sm leading-relaxed text-slate-700">{refund.reason}</p>
      </div>

      {refund.decisionNote && (
        <div className="mt-3 rounded-2xl border border-border p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">The decision</p>
          <p className="mt-1 text-pretty text-sm leading-relaxed text-slate-700">
            {refund.decisionNote}
          </p>
        </div>
      )}

      {awaitingProvider && (
        <p className="mt-4 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
          Approved. The payment provider is settling this — it closes on its own when they confirm.
        </p>
      )}

      {open && (
        <>
          {/*
            Required for both answers. A rejection the patient cannot be given
            a reason for is not a decision anyone can stand behind, and an
            approval without one leaves money moved and nothing saying why.
          */}
          <label className="mt-4 block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Your reason (recorded, required)
            </span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              maxLength={500}
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
              disabled={note.trim().length < 3 || decide.isPending}
              onClick={() =>
                decide.mutate({ publicId: refund.publicId, approve: true, note: note.trim() })
              }
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
            >
              {decide.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Approve and refund
            </button>
            <button
              type="button"
              disabled={note.trim().length < 3 || decide.isPending}
              onClick={() =>
                decide.mutate({ publicId: refund.publicId, approve: false, note: note.trim() })
              }
              className="inline-flex items-center gap-2 rounded-xl border border-border px-5 py-2.5 text-sm font-bold hover:bg-slate-50 disabled:opacity-40"
            >
              <X className="size-4" /> Decline
            </button>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            Approving sends the refund to the payment provider now. It cannot be undone from here.
          </p>
        </>
      )}
    </section>
  );
}
