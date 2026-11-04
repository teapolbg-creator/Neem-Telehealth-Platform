import { useState } from "react";
import { Ambulance, Plus, Send } from "lucide-react";
import {
  FACILITY_TYPE_LABELS,
  REFERRAL_CONTACT_LABELS,
  REFERRAL_CONTACT_METHODS,
  REFERRAL_STATUS_LABELS,
  REFERRAL_URGENCIES,
  REFERRAL_URGENCY_LABELS,
  type FacilityType,
  type ReferralContactMethod,
  type ReferralDestination,
  type ReferralUrgency,
  type ReferralView,
  type VisitView,
} from "@neem/contracts";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { inputClass } from "@/features/facility/form";
import {
  REFERRAL_STATUS_TONE,
  useAcknowledgeReferral,
  useCancelReferral,
  useCreateReferral,
  useReferralDestinations,
  useReferralFeedback,
  useReferralOutcome,
} from "@/features/facility/referrals";

/**
 * Referrals on a visit (slice 2a, D80): issue one, and record what the
 * receiving facility says. Every status is only ever what somebody here was
 * told, so the wording never runs ahead of it.
 */

const OTHER = "__other__";

/** The list runs to hundreds of facilities, so a CHO finds one by region first. */
function destinationsByRegion(entries: ReferralDestination[]) {
  const regions = new Map<string, ReferralDestination[]>();
  for (const entry of entries) {
    regions.set(entry.region, [...(regions.get(entry.region) ?? []), entry]);
  }
  return [...regions.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function ReferralForm({ visit, onDone }: { visit: VisitView; onDone: () => void }) {
  const destinations = useReferralDestinations();
  const create = useCreateReferral(visit.publicId);
  const [destination, setDestination] = useState("");
  const [destinationName, setDestinationName] = useState("");
  const [department, setDepartment] = useState("");
  const [urgency, setUrgency] = useState<ReferralUrgency>(
    visit.status === "ESCALATED" ? "EMERGENCY" : "URGENT",
  );
  const [reason, setReason] = useState(visit.encounter?.referralInstructions ?? "");
  const [summary, setSummary] = useState(() =>
    [
      visit.presentingComplaint,
      visit.encounter?.clinicalAssessment
        ? `Doctor's assessment: ${visit.encounter.clinicalAssessment}`
        : null,
      visit.encounter?.treatmentPlan ? `Plan: ${visit.encounter.treatmentPlan}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const [transport, setTransport] = useState("");
  const errors = create.error instanceof ApiError ? create.error.fieldErrors : {};
  const other = destination === OTHER;

  return (
    <form
      className="space-y-3 rounded-xl border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(
          {
            destinationFacilityPublicId: other ? null : destination || null,
            destinationName: other ? destinationName : null,
            destinationDepartment: department,
            urgency,
            reason,
            clinicalSummary: summary,
            transport,
          },
          { onSuccess: onDone },
        );
      }}
    >
      <p className="flex items-center gap-2 text-sm font-bold">
        <Send className="size-4 text-brand" /> Refer the patient
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-500">Where to</span>
          <select
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            className={inputClass}
          >
            <option value="">Choose a facility</option>
            {destinationsByRegion(destinations.data ?? []).map(([region, entries]) => (
              <optgroup key={region} label={region}>
                {entries.map((entry) => (
                  <option key={entry.publicId} value={entry.publicId}>
                    {entry.name} · {FACILITY_TYPE_LABELS[entry.type as FacilityType] ?? entry.type},{" "}
                    {entry.district}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value={OTHER}>Somewhere not on the list…</option>
          </select>
          {destinations.isError ? (
            <span className="mt-1 block text-xs text-red-600">
              The list of facilities did not load. Check the connection and open this page again.
            </span>
          ) : null}
          {errors.destinationName || errors.destinationFacilityPublicId ? (
            <span className="mt-1 block text-xs text-red-600">
              {errors.destinationName ?? errors.destinationFacilityPublicId}
            </span>
          ) : null}
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-500">
            Department (optional)
          </span>
          <input
            value={department}
            onChange={(event) => setDepartment(event.target.value)}
            placeholder="e.g. Medical OPD, Maternity"
            className={inputClass}
          />
        </label>
      </div>
      {other ? (
        <input
          value={destinationName}
          onChange={(event) => setDestinationName(event.target.value)}
          placeholder="Name of the facility"
          className={inputClass}
        />
      ) : null}

      <div className="flex flex-wrap gap-2">
        {REFERRAL_URGENCIES.map((value) => (
          <button
            key={value}
            type="button"
            data-on={urgency === value}
            onClick={() => setUrgency(value)}
            className={`rounded-lg border px-4 py-2 text-sm font-semibold data-[on=true]:text-white ${
              value === "EMERGENCY"
                ? "border-red-300 text-red-700 data-[on=true]:border-red-600 data-[on=true]:bg-red-600"
                : "border-border text-slate-600 data-[on=true]:border-brand data-[on=true]:bg-brand"
            }`}
          >
            {REFERRAL_URGENCY_LABELS[value]}
          </button>
        ))}
      </div>

      <label className="block text-sm">
        <span className="mb-1 block text-xs font-semibold text-slate-500">Reason *</span>
        <textarea
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className={inputClass}
        />
        {errors.reason ? (
          <span className="mt-1 block text-xs text-red-600">{errors.reason}</span>
        ) : null}
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-semibold text-slate-500">
          Clinical summary for the receiving facility
        </span>
        <textarea
          rows={3}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          className={inputClass}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-semibold text-slate-500">Transport</span>
        <input
          value={transport}
          onChange={(event) => setTransport(event.target.value)}
          placeholder="e.g. NAS ambulance called 10:42, or family taking them tomorrow"
          className={inputClass}
        />
      </label>

      {create.error && Object.keys(errors).length === 0 ? (
        <p className="text-sm text-red-600">
          {create.error instanceof ApiError ? create.error.message : "Not recorded."}
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
          disabled={!reason.trim() || !destination || create.isPending}
          className={`rounded-lg px-5 py-2 text-sm font-semibold text-white disabled:opacity-40 ${
            urgency === "EMERGENCY" ? "bg-red-600" : "bg-brand"
          }`}
        >
          Record referral
        </button>
      </div>
    </form>
  );
}

/** A visit's referrals, and the button that opens the form. */
export function VisitReferrals({ visit, canRefer }: { visit: VisitView; canRefer: boolean }) {
  const [adding, setAdding] = useState(false);
  if (visit.referrals.length === 0 && !canRefer) return null;

  return (
    <div className="space-y-3">
      {visit.referrals.map((referral) => (
        <ReferralCard key={referral.publicId} referral={referral} />
      ))}
      {adding ? (
        <ReferralForm visit={visit} onDone={() => setAdding(false)} />
      ) : canRefer ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          <Plus className="size-4" /> Refer the patient
        </button>
      ) : null}
    </div>
  );
}

function when(iso: string) {
  return new Date(iso).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ReferralCard({ referral }: { referral: ReferralView }) {
  const open = referral.status === "ISSUED" || referral.status === "ACKNOWLEDGED";
  const [action, setAction] = useState<null | "ack" | "outcome" | "feedback" | "cancel">(null);

  return (
    <div className="space-y-2 rounded-xl border border-border p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-2 font-semibold">
            {referral.urgency === "EMERGENCY" ? (
              <Ambulance className="size-4 text-red-600" />
            ) : (
              <Send className="size-4 text-brand" />
            )}
            {referral.destination.name}
            {referral.destination.department ? ` · ${referral.destination.department}` : ""}
          </p>
          <p className="text-xs text-slate-500">
            <span className="font-mono">{referral.publicId}</span> ·{" "}
            {REFERRAL_URGENCY_LABELS[referral.urgency]} · sent {when(referral.issuedAt)} by{" "}
            {referral.issuedBy}
            {referral.doctorName ? ` on ${referral.doctorName}'s advice` : ""}
          </p>
        </div>
        <Chip tone={REFERRAL_STATUS_TONE[referral.status]}>
          {REFERRAL_STATUS_LABELS[referral.status]}
        </Chip>
      </div>
      <p>{referral.reason}</p>
      {referral.transport ? (
        <p className="text-xs text-slate-500">Transport: {referral.transport}</p>
      ) : null}
      {referral.acknowledged ? (
        <p className="text-xs text-slate-500">
          Confirmed {REFERRAL_CONTACT_LABELS[referral.acknowledged.via].toLowerCase()}
          {referral.acknowledged.contact ? ` with ${referral.acknowledged.contact}` : ""},{" "}
          {when(referral.acknowledged.at)}, recorded by {referral.acknowledged.by}
        </p>
      ) : null}
      {referral.feedback ? (
        <p className="rounded-lg bg-slate-50 p-2 text-sm">
          <span className="text-xs font-semibold text-slate-500">Feedback: </span>
          {referral.feedback.text}
          <span className="block text-xs text-slate-400">
            {when(referral.feedback.at)}, recorded by {referral.feedback.by}
          </span>
        </p>
      ) : null}
      {referral.cancelled ? (
        <p className="text-xs text-slate-500">Cancelled: {referral.cancelled.reason}</p>
      ) : null}

      {referral.status !== "CANCELLED" ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {referral.status === "ISSUED" ? (
            <ActionButton onClick={() => setAction("ack")}>They expect the patient</ActionButton>
          ) : null}
          {open ? (
            <ActionButton onClick={() => setAction("outcome")}>Record outcome</ActionButton>
          ) : null}
          <ActionButton onClick={() => setAction("feedback")}>
            {referral.feedback ? "Update feedback" : "Add feedback"}
          </ActionButton>
          {open ? <ActionButton onClick={() => setAction("cancel")}>Cancel</ActionButton> : null}
        </div>
      ) : null}

      {action === "ack" ? (
        <AcknowledgeForm publicId={referral.publicId} onDone={() => setAction(null)} />
      ) : null}
      {action === "outcome" ? (
        <OutcomeForm publicId={referral.publicId} onDone={() => setAction(null)} />
      ) : null}
      {action === "feedback" ? (
        <FeedbackForm publicId={referral.publicId} onDone={() => setAction(null)} />
      ) : null}
      {action === "cancel" ? (
        <CancelForm publicId={referral.publicId} onDone={() => setAction(null)} />
      ) : null}
    </div>
  );
}

function ActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
    >
      {children}
    </button>
  );
}

function ViaSelect({
  value,
  onChange,
}: {
  value: ReferralContactMethod;
  onChange: (value: ReferralContactMethod) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as ReferralContactMethod)}
      className={`${inputClass} max-w-40`}
    >
      {REFERRAL_CONTACT_METHODS.map((method) => (
        <option key={method} value={method}>
          {REFERRAL_CONTACT_LABELS[method]}
        </option>
      ))}
    </select>
  );
}

function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="text-xs text-red-600">
      {error instanceof ApiError ? error.message : "Not recorded."}
    </p>
  );
}

function AcknowledgeForm({ publicId, onDone }: { publicId: string; onDone: () => void }) {
  const acknowledge = useAcknowledgeReferral(publicId);
  const [via, setVia] = useState<ReferralContactMethod>("PHONE");
  const [contact, setContact] = useState("");
  return (
    <div className="space-y-2 rounded-lg bg-slate-50 p-3">
      <div className="flex flex-wrap gap-2">
        <ViaSelect value={via} onChange={setVia} />
        <input
          value={contact}
          onChange={(event) => setContact(event.target.value)}
          placeholder="Who confirmed it, e.g. Nurse Adjei, OPD"
          className={inputClass}
        />
      </div>
      <button
        type="button"
        disabled={acknowledge.isPending}
        onClick={() => acknowledge.mutate({ via, contact }, { onSuccess: onDone })}
        className="rounded-lg bg-brand px-4 py-1.5 text-xs font-semibold text-white"
      >
        Record confirmation
      </button>
      <FormError error={acknowledge.error} />
    </div>
  );
}

function OutcomeForm({ publicId, onDone }: { publicId: string; onDone: () => void }) {
  const outcome = useReferralOutcome(publicId);
  const [via, setVia] = useState<ReferralContactMethod>("PHONE");
  const [feedback, setFeedback] = useState("");
  const record = (value: "ATTENDED" | "DID_NOT_ARRIVE") =>
    outcome.mutate({ outcome: value, via, feedback }, { onSuccess: onDone });
  return (
    <div className="space-y-2 rounded-lg bg-slate-50 p-3">
      <ViaSelect value={via} onChange={setVia} />
      <textarea
        rows={2}
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        placeholder="What they said, if anything: findings, treatment, when to review"
        className={inputClass}
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={outcome.isPending}
          onClick={() => record("ATTENDED")}
          className="rounded-lg bg-brand px-4 py-1.5 text-xs font-semibold text-white"
        >
          Seen there
        </button>
        <button
          type="button"
          disabled={outcome.isPending}
          onClick={() => record("DID_NOT_ARRIVE")}
          className="rounded-lg border border-red-200 px-4 py-1.5 text-xs font-semibold text-red-600"
        >
          Did not arrive
        </button>
      </div>
      <FormError error={outcome.error} />
    </div>
  );
}

function FeedbackForm({ publicId, onDone }: { publicId: string; onDone: () => void }) {
  const save = useReferralFeedback(publicId);
  const [feedback, setFeedback] = useState("");
  return (
    <div className="space-y-2 rounded-lg bg-slate-50 p-3">
      <textarea
        rows={2}
        value={feedback}
        onChange={(event) => setFeedback(event.target.value)}
        placeholder="What the receiving facility said"
        className={inputClass}
      />
      <button
        type="button"
        disabled={feedback.trim().length < 3 || save.isPending}
        onClick={() => save.mutate(feedback, { onSuccess: onDone })}
        className="rounded-lg bg-brand px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
      >
        Save feedback
      </button>
      <FormError error={save.error} />
    </div>
  );
}

function CancelForm({ publicId, onDone }: { publicId: string; onDone: () => void }) {
  const cancel = useCancelReferral(publicId);
  const [reason, setReason] = useState("");
  return (
    <div className="flex flex-wrap gap-2 rounded-lg bg-slate-50 p-3">
      <input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why it is cancelled"
        className={inputClass}
      />
      <button
        type="button"
        disabled={reason.trim().length < 3 || cancel.isPending}
        onClick={() => cancel.mutate(reason, { onSuccess: onDone })}
        className="rounded-lg border border-border px-4 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-40"
      >
        Cancel referral
      </button>
      <FormError error={cancel.error} />
    </div>
  );
}
