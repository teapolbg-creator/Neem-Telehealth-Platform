import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Loader2, MessageSquareWarning, RefreshCw, X } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/quality")({
  component: AdminQuality,
});

interface Complaint {
  publicId: string;
  state: "OPEN" | "UNDER_REVIEW" | "RESOLVED" | "DISMISSED";
  description: string;
  categoryLabel: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  consultationReference: string | null;
  pharmacyName: string | null;
  doctorName: string | null;
  doctorRating: number | null;
  neemRating: number | null;
}

interface QualityRow {
  doctorPublicId: string;
  fullName: string;
  status: string;
  score: number | null;
  breakdown: Record<string, number | boolean> | null;
  computedAt: string | null;
  provisional: boolean;
  consultations90Days: number;
  openComplaints: number;
}

const complaintsKey = ["admin", "complaints"] as const;

function useComplaints(openOnly: boolean) {
  return useQuery({
    queryKey: [...complaintsKey, openOnly],
    queryFn: ({ signal }) => api.get<Complaint[]>(`/admin/complaints?openOnly=${openOnly}`, signal),
  });
}

function useDecideComplaint() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { publicId: string; state: string; note?: string }) =>
      api.post<{ state: string }>(`/admin/complaints/${input.publicId}/decide`, {
        state: input.state,
        note: input.note,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: complaintsKey }),
  });
}

function useQualityBoard() {
  return useQuery({
    queryKey: ["admin", "quality"],
    queryFn: ({ signal }) => api.get<QualityRow[]>("/admin/quality", signal),
  });
}

function useRecomputeQuality() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<{ scored: number }>("/admin/quality/recompute"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "quality"] }),
  });
}

/**
 * Complaints and quality review (spec §51, §52, §55).
 *
 * Two things a doctor never sees, and which have no route returning them to a
 * doctor principal: their quality score, and the ratings behind it. A score a
 * clinician can watch becomes a target they optimise rather than a signal
 * about care.
 *
 * Working a complaint does **not** open the clinical record. What is here is
 * the patient's own words and the consultation's operational context; a
 * complaint that genuinely needs the record goes through archived retrieval,
 * where it is logged as an access (D27) — a separate, audited act rather than
 * a side effect of opening a complaint.
 */
function AdminQuality() {
  const [openOnly, setOpenOnly] = useState(true);
  const complaints = useComplaints(openOnly);
  const quality = useQualityBoard();
  const recompute = useRecomputeQuality();

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Quality and complaints</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Complaints raised by patients, and the routing quality score each doctor carries. Doctors
          are never shown either.
        </p>
      </header>

      <section className="card-soft p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-bold">
            <MessageSquareWarning className="size-4 text-brand" /> Complaints
          </h2>
          <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
            {[
              { key: true, label: "Open" },
              { key: false, label: "All" },
            ].map((option) => (
              <button
                key={String(option.key)}
                type="button"
                onClick={() => setOpenOnly(option.key)}
                className={cn(
                  "rounded-lg px-4 py-1.5 text-xs font-semibold transition-colors",
                  openOnly === option.key
                    ? "bg-white text-brand shadow-sm"
                    : "text-slate-500 hover:bg-white/60",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {complaints.isLoading && (
          <div className="grid place-items-center py-10">
            <Loader2 className="size-5 animate-spin text-brand" />
          </div>
        )}

        {complaints.error && (
          <p className="mt-4 flex items-start gap-2 text-sm text-red-600">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {complaints.error instanceof ApiError
              ? complaints.error.message
              : "Complaints could not be loaded."}
          </p>
        )}

        {complaints.data?.length === 0 && (
          <p className="mt-4 text-sm text-slate-500">
            {openOnly ? "No complaint is waiting on you." : "No complaint has been raised."}
          </p>
        )}

        <div className="mt-4 space-y-4">
          {complaints.data?.map((complaint) => (
            <ComplaintCard key={complaint.publicId} complaint={complaint} />
          ))}
        </div>
      </section>

      <section className="card-soft p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-bold">Doctor quality</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              What the queue weighs when choosing between available doctors. Recomputed nightly.
            </p>
          </div>
          <button
            type="button"
            disabled={recompute.isPending}
            onClick={() => recompute.mutate()}
            className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
          >
            {recompute.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Recompute
          </button>
        </div>

        {quality.data && quality.data.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left">
                <tr className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  <th className="py-2 pr-4">Doctor</th>
                  <th className="py-2 pr-4">Consultations</th>
                  <th className="py-2 pr-4">Open complaints</th>
                  <th className="py-2 text-right">Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {quality.data.map((row) => (
                  <QualityRowView key={row.doctorPublicId} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  );
}

function ComplaintCard({ complaint }: { complaint: Complaint }) {
  const decide = useDecideComplaint();
  const [note, setNote] = useState("");

  const open = complaint.state === "OPEN" || complaint.state === "UNDER_REVIEW";

  return (
    <article className="rounded-2xl border border-border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold">{complaint.categoryLabel}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {complaint.pharmacyName ?? "Unknown pharmacy"}
            {complaint.doctorName && ` · ${complaint.doctorName}`} ·{" "}
            {new Date(complaint.createdAt).toLocaleDateString()}
          </p>
          {complaint.consultationReference && (
            <p className="mt-1 font-mono text-[11px] text-slate-400">
              {complaint.consultationReference}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {complaint.doctorRating !== null && (
            <Chip tone="muted">{complaint.doctorRating}/5 doctor</Chip>
          )}
          <Chip tone={open ? "warning" : "muted"}>
            {complaint.state.replace(/_/g, " ").toLowerCase()}
          </Chip>
        </div>
      </div>

      <p className="mt-3 text-pretty rounded-xl bg-slate-50 p-3 text-sm leading-relaxed text-slate-700">
        {complaint.description}
      </p>

      {complaint.resolutionNote && !open && (
        <div className="mt-3 rounded-xl border border-border p-3">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">Outcome</p>
          <p className="mt-1 text-pretty text-sm leading-relaxed">{complaint.resolutionNote}</p>
        </div>
      )}

      {open && (
        <>
          {/*
            Required to close, either way. A complaint dismissed with no
            reason is indistinguishable from one ignored, and the patient
            cannot be answered without it.
          */}
          <label className="mt-4 block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              What was decided (recorded, required to close)
            </span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              maxLength={2000}
              className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
            />
          </label>

          {decide.error && (
            <p className="mt-2 text-sm text-red-600">
              {decide.error instanceof ApiError
                ? decide.error.message
                : "The decision could not be recorded."}
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {complaint.state === "OPEN" && (
              <button
                type="button"
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({ publicId: complaint.publicId, state: "UNDER_REVIEW" })
                }
                className="rounded-xl border border-border px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
              >
                Start reviewing
              </button>
            )}
            <button
              type="button"
              disabled={note.trim().length < 3 || decide.isPending}
              onClick={() =>
                decide.mutate({
                  publicId: complaint.publicId,
                  state: "RESOLVED",
                  note: note.trim(),
                })
              }
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
            >
              <Check className="size-4" /> Resolve
            </button>
            <button
              type="button"
              disabled={note.trim().length < 3 || decide.isPending}
              onClick={() =>
                decide.mutate({
                  publicId: complaint.publicId,
                  state: "DISMISSED",
                  note: note.trim(),
                })
              }
              className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
            >
              <X className="size-4" /> Dismiss
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function QualityRowView({ row }: { row: QualityRow }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr>
        <td className="py-2 pr-4">
          <button type="button" onClick={() => setOpen((value) => !value)} className="text-left">
            <span className="font-semibold">{row.fullName}</span>
            {row.provisional && (
              <Chip tone="muted" className="ml-2">
                provisional
              </Chip>
            )}
            {row.status !== "ACTIVE" && (
              <Chip tone="warning" className="ml-2">
                {row.status.toLowerCase()}
              </Chip>
            )}
          </button>
        </td>
        <td className="py-2 pr-4 text-slate-600">{row.consultations90Days}</td>
        <td className="py-2 pr-4">
          {row.openComplaints > 0 ? (
            <span className="font-semibold text-amber-700">{row.openComplaints}</span>
          ) : (
            <span className="text-slate-400">0</span>
          )}
        </td>
        <td className="py-2 text-right font-mono font-bold">
          {row.score === null ? "—" : row.score.toFixed(2)}
        </td>
      </tr>

      {open && row.breakdown && (
        <tr>
          <td colSpan={4} className="pb-3">
            {/*
              The components, not just the number. A score nobody can explain
              is one nobody should act on.
            */}
            <div className="rounded-xl bg-slate-50 p-3">
              <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
                {Object.entries(row.breakdown)
                  .filter(([, value]) => typeof value === "number")
                  .map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-3">
                      <dt className="text-slate-500">{key}</dt>
                      <dd className="font-mono font-semibold">{Number(value).toFixed(2)}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
