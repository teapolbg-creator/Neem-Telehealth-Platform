import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft, CheckCircle2, CloudOff, Lock, UserCheck, UserPlus } from "lucide-react";
import { triageCreateSchema, type PatientSummary } from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { useSession } from "@/features/auth/use-session";
import { SEX_LABEL, ageLabel } from "@/features/facility/patients";
import { TriageBadge } from "@/features/facility/TriageBadge";
import { TriageFields } from "@/features/facility/TriageFields";
import { EMPTY_TRIAGE, toTriage, type TriageDraft } from "@/features/facility/triage";
import {
  addTriage,
  decide,
  discard,
  retry,
  useOfflineQueue,
  type QueueEntry,
} from "@/features/offline/queue";

export const Route = createFileRoute("/facility/offline")({
  component: SavedOffline,
});

const STATE_LABEL = {
  QUEUED: { text: "Waiting to send", tone: "muted" },
  NEEDS_DECISION: { text: "May already be on file", tone: "warning" },
  REFUSED: { text: "Not accepted", tone: "danger" },
} as const;

/**
 * Walk-ins recorded on this device while it was offline (slice 4a, D88):
 * what is waiting, what needs the CHO, and what has gone.
 */
function SavedOffline() {
  const { user } = useSession();
  const offline = useOfflineQueue(user?.role === "FACILITY" ? user.publicId : null);

  return (
    <AppShell active="facility">
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <Link
          to="/facility"
          className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-brand"
        >
          <ArrowLeft className="size-4" /> Today
        </Link>
        <div>
          <h1 className="text-3xl font-bold">Saved offline</h1>
          <p className="mt-2 text-sm text-slate-500">
            Walk-ins registered on this device without a connection. They are encrypted here and
            readable only after you sign in, and they go to Neem by themselves when the connection
            returns. Neem checks each one against your patients when it arrives.
          </p>
        </div>

        {offline.sent.length > 0 ? (
          <section className="card-soft p-5">
            <p className="mb-2 font-bold">Sent</p>
            <ul className="divide-y divide-border text-sm">
              {offline.sent.map((sent) => (
                <li
                  key={sent.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-brand" />
                    {sent.fullName}
                    <span className="text-xs text-slate-500">
                      {sent.matchedExisting ? "added to their existing record" : "registered"}
                    </span>
                  </span>
                  <Link
                    to="/facility/patients/$patientNumber"
                    params={{ patientNumber: sent.patientNumber }}
                    className="font-mono text-xs font-semibold text-brand hover:underline"
                  >
                    {sent.patientNumber}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {offline.locked > 0 ? (
          <div className="card-soft flex items-start gap-3 p-5 text-sm text-slate-600">
            <Lock className="mt-0.5 size-4 shrink-0" />
            {offline.locked} walk-in{offline.locked === 1 ? " is" : "s are"} saved here and can be
            opened once this device reaches Neem.
          </div>
        ) : null}

        {offline.entries.length === 0 && offline.locked === 0 ? (
          <div className="card-soft flex items-center gap-3 p-6 text-sm text-slate-500">
            <CloudOff className="size-5" /> Nothing is waiting on this device.
          </div>
        ) : null}

        {offline.entries.map((entry) => (
          <Entry key={entry.id} entry={entry} />
        ))}
      </div>
    </AppShell>
  );
}

function Entry({ entry }: { entry: QueueEntry }) {
  const { registration, triage, decision } = entry.walkIn;
  const [triaging, setTriaging] = useState(false);
  const [draft, setDraft] = useState<TriageDraft>(EMPTY_TRIAGE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const label = STATE_LABEL[entry.state];
  const age = registration.dateOfBirth
    ? ageLabel(registration.dateOfBirth)
    : `${registration.ageYears ?? 0} y (est.)`;

  const saveTriage = () => {
    const parsed = triageCreateSchema.safeParse(toTriage(draft));
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join("."), issue.message]),
        ),
      );
      return;
    }
    void addTriage(entry.id, parsed.data).then(() => setTriaging(false));
  };

  return (
    <article className="card-soft space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{registration.fullName}</p>
          <p className="text-xs text-slate-500">
            {SEX_LABEL[registration.sex]} · {age} · {registration.community}
          </p>
          <p className="mt-1 text-sm">{registration.presentingComplaint}</p>
          <p className="text-xs text-slate-500">
            Arrived{" "}
            {new Date(entry.walkIn.capturedAt).toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TriageBadge category={triage?.category ?? null} />
          <Chip tone={label.tone}>{label.text}</Chip>
        </div>
      </div>

      {entry.state === "NEEDS_DECISION" ? <Decision entry={entry} /> : null}

      {entry.state === "REFUSED" ? (
        <div className="space-y-2 rounded-xl bg-red-50 p-4 text-sm text-red-800">
          <p>{entry.refusal}</p>
          {decision?.kind === "EXISTING" ? (
            <p>If this walk-in is that same visit, delete it from this device.</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void retry(entry.id)}
              className="rounded-lg border border-red-200 bg-white px-3 py-1.5 font-semibold"
            >
              Try again
            </button>
            {decision?.kind === "EXISTING" ? (
              <button
                type="button"
                onClick={() => void decide(entry.id, { kind: "NEW" })}
                className="rounded-lg border border-red-200 bg-white px-3 py-1.5 font-semibold"
              >
                Register as a new patient instead
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {triaging ? (
        <form
          className="space-y-4 border-t border-border pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            saveTriage();
          }}
        >
          <TriageFields draft={draft} onChange={setDraft} errors={errors} />
          {draft.category === "RED" ? (
            <p className="rounded-lg bg-red-600 p-3 text-sm text-white">
              Follow your facility’s emergency protocol now. Neem records the emergency when this
              walk-in is sent.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setTriaging(false)}
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-600"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!draft.category}
              className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              Save assessment on this device
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-3">
          {triage ? (
            <span className="text-xs text-slate-500">
              Triaged{" "}
              {new Date(triage.triagedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
              . To assess again, open their record once it has been sent.
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setTriaging(true)}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white"
            >
              Triage
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  `Delete ${registration.fullName}'s walk-in from this device? It has not reached Neem and cannot be recovered.`,
                )
              ) {
                void discard(entry.id);
              }
            }}
            className="text-sm font-semibold text-slate-500 hover:text-red-600"
          >
            Delete from this device
          </button>
        </div>
      )}
    </article>
  );
}

function Decision({ entry }: { entry: QueueEntry }) {
  if (!entry.candidates) {
    return (
      <div className="rounded-xl bg-warning-soft p-4 text-sm">
        <p>Someone already on file may be this person.</p>
        <button
          type="button"
          onClick={() => void retry(entry.id)}
          className="mt-2 font-semibold text-brand hover:underline"
        >
          Show who
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-xl bg-warning-soft p-4 text-sm">
      <p>
        Is this one of your patients? Choosing them adds today’s visit to their record; the details
        typed offline are not copied onto it, so check their allergies there.
      </p>
      <ul className="divide-y divide-warning/20">
        {entry.candidates.map((candidate) => (
          <Candidate key={candidate.publicId} entry={entry} candidate={candidate} />
        ))}
      </ul>
      <button
        type="button"
        onClick={() => void decide(entry.id, { kind: "NEW" })}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 font-semibold text-slate-700"
      >
        <UserPlus className="size-4" /> None of them: register as new
      </button>
    </div>
  );
}

function Candidate({ entry, candidate }: { entry: QueueEntry; candidate: PatientSummary }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span>
        <span className="font-semibold">{candidate.fullName}</span>{" "}
        <span className="text-xs text-slate-600">
          {SEX_LABEL[candidate.sex]} · {ageLabel(candidate.dateOfBirth, candidate.dobIsEstimated)} ·{" "}
          {candidate.community} · <span className="font-mono">{candidate.patientNumber}</span>
          {candidate.hasOpenVisit ? " · visit in progress" : ""}
        </span>
      </span>
      <button
        type="button"
        onClick={() =>
          void decide(entry.id, { kind: "EXISTING", patientNumber: candidate.patientNumber })
        }
        className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 font-semibold text-white"
      >
        <UserCheck className="size-4" /> This is them
      </button>
    </li>
  );
}
