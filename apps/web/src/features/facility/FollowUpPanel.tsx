import { useState } from "react";
import { CalendarClock, Plus } from "lucide-react";
import { FOLLOW_UP_STATUS_LABELS, type FollowUpView, type VisitView } from "@neem/contracts";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { inputClass } from "@/features/facility/form";
import {
  formatDue,
  todayIso,
  useResolveFollowUp,
  useSetFollowUp,
} from "@/features/facility/followups";

/**
 * Follow-ups on a visit (slice 2b, D81). A follow-up belongs to the visit it
 * came from, so it is resolved from that visit's card even after the visit
 * has ended: that is when the patient comes back.
 */
export function VisitFollowUps({ visit, canSet }: { visit: VisitView; canSet: boolean }) {
  const [adding, setAdding] = useState(false);
  if (visit.followUps.length === 0 && !canSet) return null;

  return (
    <div className="space-y-2">
      {visit.followUps.map((followUp) => (
        <FollowUpCard key={followUp.publicId} followUp={followUp} />
      ))}
      {adding ? (
        <FollowUpForm visit={visit} onDone={() => setAdding(false)} />
      ) : canSet ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          <Plus className="size-4" /> Set a follow-up
        </button>
      ) : null}
    </div>
  );
}

function FollowUpForm({ visit, onDone }: { visit: VisitView; onDone: () => void }) {
  const set = useSetFollowUp(visit.publicId);
  const withFeedback = visit.referrals.filter((referral) => referral.feedback);
  const [dueDate, setDueDate] = useState("");
  const [referral, setReferral] = useState("");
  const [instructions, setInstructions] = useState(visit.encounter?.followUp ?? "");
  const errors = set.error instanceof ApiError ? set.error.fieldErrors : {};

  return (
    <form
      className="space-y-3 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        set.mutate(
          { dueDate, instructions, referralPublicId: referral || null },
          { onSuccess: onDone },
        );
      }}
    >
      <p className="flex items-center gap-2 text-sm font-bold">
        <CalendarClock className="size-4 text-brand" /> Set a follow-up
      </p>
      {visit.encounter?.followUp ? (
        <p className="text-xs text-slate-500">The doctor advised: “{visit.encounter.followUp}”</p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-500">Due on *</span>
          <input
            type="date"
            min={todayIso()}
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            className={inputClass}
          />
          {errors.dueDate ? (
            <span className="mt-1 block text-xs text-red-600">{errors.dueDate}</span>
          ) : null}
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-500">What for *</span>
          <input
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="e.g. Recheck BP after starting treatment"
            className={inputClass}
          />
        </label>
      </div>
      {withFeedback.length > 0 ? (
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-500">
            Asked for by a referral (optional)
          </span>
          <select
            value={referral}
            onChange={(event) => setReferral(event.target.value)}
            className={inputClass}
          >
            <option value="">No</option>
            {withFeedback.map((entry) => (
              <option key={entry.publicId} value={entry.publicId}>
                {entry.destination.name}: “{entry.feedback!.text.slice(0, 60)}”
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {set.error && Object.keys(errors).length === 0 ? (
        <p className="text-sm text-red-600">
          {set.error instanceof ApiError ? set.error.message : "Not saved."}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-600"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!dueDate || instructions.trim().length < 3 || set.isPending}
          className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          Set follow-up
        </button>
      </div>
    </form>
  );
}

export function FollowUpCard({ followUp }: { followUp: FollowUpView }) {
  const resolve = useResolveFollowUp(followUp.publicId);
  const [action, setAction] = useState<null | "complete" | "missed" | "cancel">(null);
  const [text, setText] = useState("");
  const due = followUp.status === "DUE";

  return (
    <div
      className={`space-y-2 rounded-xl border p-3 text-sm ${
        followUp.overdue ? "border-amber-300 bg-amber-50/50" : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">
          <CalendarClock className="size-4 text-brand" /> Follow-up {formatDue(followUp.dueDate)}
        </p>
        <Chip
          tone={
            followUp.overdue
              ? "warning"
              : followUp.status === "DONE"
                ? "brand"
                : followUp.status === "MISSED"
                  ? "danger"
                  : "muted"
          }
        >
          {followUp.overdue ? "Overdue" : FOLLOW_UP_STATUS_LABELS[followUp.status]}
        </Chip>
      </div>
      <p>{followUp.instructions}</p>
      <p className="text-xs text-slate-500">
        Set by {followUp.createdBy}
        {followUp.referralPublicId ? ` after referral ${followUp.referralPublicId}` : ""}
      </p>
      {followUp.resolved ? (
        <p className="text-xs text-slate-500">
          {FOLLOW_UP_STATUS_LABELS[followUp.status]}{" "}
          {new Date(followUp.resolved.at).toLocaleDateString()} by {followUp.resolved.by}
          {followUp.resolved.note ? `: ${followUp.resolved.note}` : ""}
        </p>
      ) : null}

      {due && !action ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setAction("complete")}
            className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white"
          >
            Patient was seen
          </button>
          <button
            type="button"
            onClick={() => setAction("missed")}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-slate-600"
          >
            Missed
          </button>
          <button
            type="button"
            onClick={() => setAction("cancel")}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-slate-600"
          >
            No longer needed
          </button>
        </div>
      ) : null}

      {action ? (
        <div className="flex flex-wrap gap-2 rounded-lg bg-slate-50 p-2">
          <input
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              action === "complete"
                ? "What you found (optional)"
                : action === "missed"
                  ? "What happened: called, no answer, moved away…"
                  : "Why it is no longer needed"
            }
            className={inputClass}
          />
          <button
            type="button"
            disabled={(action !== "complete" && text.trim().length < 3) || resolve.isPending}
            onClick={() =>
              resolve.mutate(
                action === "complete"
                  ? { action, note: text }
                  : action === "missed"
                    ? { action, note: text }
                    : { action, reason: text },
                { onSuccess: () => setAction(null) },
              )
            }
            className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setAction(null)}
            className="rounded-lg px-2 text-xs font-semibold text-slate-500"
          >
            Back
          </button>
        </div>
      ) : null}
      {resolve.error ? (
        <p className="text-xs text-red-600">
          {resolve.error instanceof ApiError ? resolve.error.message : "Not saved."}
        </p>
      ) : null}
    </div>
  );
}
