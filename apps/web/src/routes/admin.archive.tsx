import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Archive, FileLock2, Loader2, ShieldAlert, X } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  PURPOSE_LABEL,
  RETRIEVAL_PURPOSES,
  useEndRetrieval,
  useRetentionHealth,
  useRetrievals,
  useRetrieveArchived,
  type ArchivedConsultation,
  type RetrievalPurpose,
} from "@/features/retention/api";

export const Route = createFileRoute("/admin/archive")({
  component: AdminArchive,
});

/**
 * Archived consultation retrieval (decisions D23, D27).
 *
 * The mechanism counsel required in the G7c answer, and the reason it exists:
 * Ghanaian record-keeping law does not permit deleting clinical notes at
 * completion, so Neem seals them instead. Sealed means unreachable through
 * every ordinary surface — no doctor, pharmacy or patient can open one — but
 * a record that could never be produced for a court, a regulator or the
 * patient themselves would not satisfy the obligation either.
 *
 * This is that narrow door. It is not a search: a consultation reference must
 * be known, a purpose named from a fixed list, a reference to the request
 * given, and a second person recorded as authorising it. Every retrieval is
 * logged, and the log is the point.
 *
 * There is deliberately **no browse, no list of consultations, and no search
 * by patient**. A screen offering those would be the longitudinal medical
 * history D24 exists to prevent, reached by a different route.
 */
function AdminArchive() {
  const health = useRetentionHealth();
  const retrievals = useRetrievals();
  const retrieve = useRetrieveArchived();

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Archived records</h1>
        <p className="mt-2 max-w-2xl text-pretty text-sm leading-relaxed text-slate-500">
          Clinical records are sealed when a consultation completes and cannot be opened through any
          ordinary part of Neem. They can be retrieved here for a named purpose, and every retrieval
          is recorded permanently.
        </p>
      </header>

      {/*
        Retention health first. Records held past their destruction date are a
        compliance failure, and a destruction job failing quietly is precisely
        what nobody notices.
      */}
      {health.data && health.data.overdueDestructions > 0 && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-red-500" />
          <div className="text-sm text-red-700">
            <p className="font-bold">
              {health.data.overdueDestructions} clinical record
              {health.data.overdueDestructions === 1 ? " is" : "s are"} past their destruction date.
            </p>
            <p className="mt-1 leading-relaxed">
              Retention is a legal obligation in both directions: a record kept beyond its period
              should have been destroyed. Check the destruction job.
            </p>
          </div>
        </div>
      )}

      {health.data && health.data.overdueDestructions === 0 && (
        <p className="text-sm text-slate-500">No record is past its destruction date.</p>
      )}

      <RetrievalForm retrieve={retrieve} />

      {retrieve.data && <RetrievedRecord record={retrieve.data} />}

      <section className="card-soft p-6">
        <h2 className="flex items-center gap-2 font-bold">
          <FileLock2 className="size-4 text-brand" /> Retrieval log
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          Who opened what, why, and when it was closed. Never what it said — a log holding the
          record would be a second copy of it.
        </p>

        {retrievals.isLoading && (
          <div className="grid place-items-center py-10">
            <Loader2 className="size-5 animate-spin text-brand" />
          </div>
        )}

        {retrievals.data?.length === 0 && (
          <p className="mt-4 text-sm text-slate-500">No record has ever been retrieved.</p>
        )}

        <ul className="mt-4 divide-y divide-border">
          {retrievals.data?.map((entry) => (
            <LogRow key={entry.id} entry={entry} />
          ))}
        </ul>
      </section>
    </AppShell>
  );
}

function RetrievalForm({ retrieve }: { retrieve: ReturnType<typeof useRetrieveArchived> }) {
  const [consultationPublicId, setConsultationPublicId] = useState("");
  const [purpose, setPurpose] = useState<RetrievalPurpose>("LEGAL_OR_REGULATORY_PROCEEDING");
  const [reference, setReference] = useState("");
  const [authorisedBy, setAuthorisedBy] = useState("");

  const ready =
    consultationPublicId.trim().length > 3 &&
    reference.trim().length >= 3 &&
    authorisedBy.trim().length > 3;

  return (
    <section className="card-soft p-6">
      <h2 className="flex items-center gap-2 font-bold">
        <Archive className="size-4 text-brand" /> Retrieve a record
      </h2>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Consultation reference
          </span>
          <input
            value={consultationPublicId}
            onChange={(event) => setConsultationPublicId(event.target.value.trim())}
            placeholder="NEEM-XXXX-XXXX-XXXX"
            className="mt-1 w-full rounded-xl border border-border px-3 py-2 font-mono text-sm"
          />
          {/*
            The only way in. Neem holds no patient index, so a record cannot be
            found by name or phone number — which is the design (D24), not a
            missing feature.
          */}
          <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">
            The reference given to the patient. Records cannot be found by name or number.
          </span>
        </label>

        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Purpose</span>
          <select
            value={purpose}
            onChange={(event) => setPurpose(event.target.value as RetrievalPurpose)}
            className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm"
          >
            {RETRIEVAL_PURPOSES.map((option) => (
              <option key={option} value={option}>
                {PURPOSE_LABEL[option]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Request reference
          </span>
          <input
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            maxLength={200}
            placeholder="Court order, ticket or case number"
            className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Authorised by
          </span>
          <input
            value={authorisedBy}
            onChange={(event) => setAuthorisedBy(event.target.value.trim())}
            placeholder="The approving administrator’s user id"
            className="mt-1 w-full rounded-xl border border-border px-3 py-2 font-mono text-sm"
          />
          {/*
            Says "another" explicitly. The service refuses self-authorisation —
            four eyes is the point — and a hint that only said "a second
            person" left an administrator to discover that by being refused.
          */}
          <span className="mt-1 block text-[11px] leading-relaxed text-slate-500">
            Another administrator must authorise this. You cannot authorise your own.
          </span>
        </label>
      </div>

      {retrieve.error && (
        <p className="mt-3 flex items-start gap-2 text-sm text-red-600">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {retrieve.error instanceof ApiError
            ? retrieve.error.message
            : "The record could not be retrieved."}
        </p>
      )}

      <button
        type="button"
        disabled={!ready || retrieve.isPending}
        onClick={() =>
          retrieve.mutate({
            consultationPublicId: consultationPublicId.trim(),
            purpose,
            reference: reference.trim(),
            authorisedByUserPublicId: authorisedBy.trim(),
          })
        }
        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
      >
        {retrieve.isPending && <Loader2 className="size-4 animate-spin" />}
        Retrieve
      </button>

      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        This is recorded permanently against your account and cannot be removed.
      </p>
    </section>
  );
}

/**
 * The retrieved record.
 *
 * Shown once, in the page, and never cached. Closing it ends the access, which
 * is what makes the log entry a bounded event rather than an open door.
 */
function RetrievedRecord({ record }: { record: ArchivedConsultation }) {
  const end = useEndRetrieval();
  const [closed, setClosed] = useState(false);

  if (closed) {
    return (
      <div className="card-soft border-brand/30 bg-brand/[0.03] p-6">
        <p className="text-sm font-semibold">This retrieval is closed.</p>
        <p className="mt-1 text-sm text-slate-600">
          The access has been recorded as ended. Retrieve the record again if you still need it.
        </p>
      </div>
    );
  }

  return (
    <section className="card-soft border-2 border-brand/30 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold">{record.consultationPublicId}</h2>
          <p className="mt-1 text-sm text-slate-500">
            Sealed {new Date(record.sealedAt).toLocaleDateString()}
            {record.destroyAt &&
              ` · destroyed on ${new Date(record.destroyAt).toLocaleDateString()}`}
          </p>
        </div>
        <button
          type="button"
          disabled={end.isPending}
          onClick={() => end.mutate(record.accessLogId, { onSuccess: () => setClosed(true) })}
          className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-bold hover:bg-slate-50 disabled:opacity-40"
        >
          {end.isPending ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
          Close this retrieval
        </button>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Encounter</h3>
          <dl className="mt-2 space-y-1.5 text-sm">
            <Row label="Date" value={new Date(record.encounter.date).toLocaleString()} />
            <Row label="Pharmacy" value={record.encounter.pharmacyName} />
            <Row label="Doctor" value={record.encounter.doctorName ?? "—"} />
            <Row label="Type" value={record.encounter.type ?? "—"} />
            <Row label="Language" value={record.encounter.language ?? "—"} />
            <Row label="Outcome" value={record.encounter.outcome ?? "—"} />
          </dl>

          {record.patient && (
            <>
              <h3 className="mt-5 text-xs font-bold uppercase tracking-wider text-slate-400">
                Patient
              </h3>
              <dl className="mt-2 space-y-1.5 text-sm">
                <Row label="Name" value={record.patient.fullName} />
                <Row
                  label="Age and sex"
                  value={`${record.patient.age ?? "—"} · ${record.patient.sex?.toLowerCase() ?? "—"}`}
                />
                <Row label="Phone" value={record.patient.phone ?? "—"} />
              </dl>
            </>
          )}
        </div>

        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
            Clinical record
          </h3>

          <dl className="mt-2 space-y-3 text-sm">
            <Block label="Notes" value={record.clinical.notes} />
            <Block label="Diagnosis" value={record.clinical.diagnosis} />
            <Block label="Treatment" value={record.clinical.treatment} />
          </dl>

          {record.clinical.tests.length > 0 && (
            <>
              <h3 className="mt-5 text-xs font-bold uppercase tracking-wider text-slate-400">
                Point-of-care tests
              </h3>
              <ul className="mt-2 space-y-1 text-sm">
                {record.clinical.tests.map((test) => (
                  <li key={test.code} className="flex justify-between gap-4">
                    <span className="text-slate-500">{test.label}</span>
                    <span className="font-semibold">{test.result}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function LogRow({
  entry,
}: {
  entry: {
    id: string;
    consultationPublicId: string;
    purpose: string;
    reference: string;
    actorRole: string;
    accessedAt: string;
    accessEndedAt: string | null;
  };
}) {
  const end = useEndRetrieval();

  return (
    <li className="flex flex-wrap items-baseline justify-between gap-3 py-3 text-sm">
      <div className="min-w-0">
        <p className="font-mono text-xs">{entry.consultationPublicId}</p>
        <p className="mt-0.5 text-slate-600">
          {PURPOSE_LABEL[entry.purpose as RetrievalPurpose] ?? entry.purpose} · {entry.reference}
        </p>
        <p className="mt-0.5 text-xs text-slate-400">
          {entry.actorRole.toLowerCase()} · {new Date(entry.accessedAt).toLocaleString()}
        </p>
      </div>

      {entry.accessEndedAt ? (
        <Chip tone="muted">closed</Chip>
      ) : (
        <div className="flex items-center gap-2">
          <Chip tone="warning">still open</Chip>
          <button
            type="button"
            disabled={end.isPending}
            onClick={() => end.mutate(entry.id)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-40"
          >
            Close
          </button>
        </div>
      )}
    </li>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-semibold">{value}</dd>
    </div>
  );
}

function Block({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-slate-500">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap text-pretty leading-relaxed">
        {value ?? <span className="text-slate-400">Not recorded</span>}
      </dd>
    </div>
  );
}
