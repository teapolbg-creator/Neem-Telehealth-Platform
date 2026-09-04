import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, Languages, Loader2, RefreshCw, Timer } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { useAdminQueue, useReallocate, type AdminQueueEntry } from "@/features/queue/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/queue")({
  component: AdminQueue,
});

/**
 * Live queue oversight (spec §29, §53).
 *
 * The admin sees what a doctor and a patient do not: how long each patient has
 * waited, how many offers have been made, and the routing score behind the
 * last one. That score is the fairness audit trail — it is what makes an
 * allocation explainable after the fact.
 */
function AdminQueue() {
  const { data: entries, isLoading } = useAdminQueue();

  const starved = (entries ?? []).filter((entry) => entry.noLanguageMatch);
  const delayed = (entries ?? []).filter((entry) => entry.delayed && !entry.noLanguageMatch);

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Live queue</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Patients waiting to be matched with a doctor. Updates every few seconds.
        </p>
      </header>

      {starved.length > 0 && (
        <div className="card-soft border-red-200 bg-red-50 p-4">
          <p className="flex items-center gap-2 text-sm font-bold text-red-700">
            <Languages className="size-4" />
            {starved.length} patient{starved.length > 1 ? "s" : ""} waiting with no language-matched
            doctor
          </p>
          <p className="mt-1 text-xs leading-relaxed text-red-700">
            No doctor currently on shift speaks their language. Neem will never assign a doctor who
            does not — find one who can, or contact the pharmacy.
          </p>
        </div>
      )}

      {delayed.length > 0 && (
        <div className="card-soft border-warning/30 bg-warning-soft p-4">
          <p className="flex items-center gap-2 text-sm font-bold text-warning">
            <Timer className="size-4" />
            {delayed.length} patient{delayed.length > 1 ? "s" : ""} waiting longer than expected
          </p>
        </div>
      )}

      {isLoading ? (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      ) : !entries?.length ? (
        <div className="card-soft grid place-items-center p-16 text-center">
          <p className="text-sm text-slate-500">No patients are waiting.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <QueueRow key={entry.consultationPublicId} entry={entry} />
          ))}
        </div>
      )}
    </AppShell>
  );
}

function QueueRow({ entry }: { entry: AdminQueueEntry }) {
  const reallocate = useReallocate();

  const minutes = Math.floor(entry.waitingSeconds / 60);
  const seconds = entry.waitingSeconds % 60;

  return (
    <div
      className={cn(
        "card-soft p-5",
        entry.noLanguageMatch && "border-red-200",
        entry.delayed && !entry.noLanguageMatch && "border-warning/40",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-slate-500">{entry.consultationPublicId}</span>
            <Chip tone={entry.queueState === "OFFERING" ? "medical" : "warning"} pulse>
              {entry.queueState === "OFFERING" ? "Offered to a doctor" : "Waiting"}
            </Chip>
            {entry.noLanguageMatch && <Chip tone="danger">No language match</Chip>}
          </div>

          <p className="mt-2 text-sm font-semibold">{entry.pharmacyName}</p>
          <p className="text-xs text-slate-500">
            {entry.language.label} · {entry.offerAttempts} offer
            {entry.offerAttempts === 1 ? "" : "s"} made
            {/* The fairness audit trail: why this doctor, and how strong a match. */}
            {entry.lastOfferScore !== null &&
              ` · last match score ${entry.lastOfferScore.toFixed(2)}`}
          </p>
        </div>

        <div className="text-right">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Waiting</p>
          <p
            className={cn(
              "font-mono text-2xl font-bold tabular-nums",
              entry.delayed || entry.noLanguageMatch ? "text-red-600" : "text-slate-700",
            )}
          >
            {minutes}:{String(seconds).padStart(2, "0")}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={reallocate.isPending}
          onClick={() => reallocate.mutate(entry.consultationPublicId)}
          className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
        >
          {reallocate.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Try allocating now
        </button>

        {/*
          Manual reallocation still runs the ordinary allocation path, so the
          language gate and every other eligibility rule continue to apply
          (spec §29). An admin can prioritise; they cannot override safety.
        */}
        <span className="text-xs text-slate-500">
          Runs the normal matching rules — language requirements still apply.
        </span>
      </div>

      {reallocate.data && (
        <p
          className={cn(
            "mt-3 flex items-start gap-2 text-xs",
            reallocate.data.offered ? "text-brand" : "text-slate-600",
          )}
        >
          {!reallocate.data.offered && <AlertCircle className="mt-0.5 size-3.5 shrink-0" />}
          {reallocate.data.message}
        </p>
      )}

      {reallocate.error && (
        <p className="mt-3 text-xs text-red-600">
          {reallocate.error instanceof ApiError
            ? reallocate.error.message
            : "Could not reallocate."}
        </p>
      )}
    </div>
  );
}
