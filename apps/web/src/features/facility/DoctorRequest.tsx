import { useState } from "react";
import { Loader2, Mic, Monitor, Stethoscope, Video } from "lucide-react";
import {
  CHPS_CONSULTATION_PROGRESS,
  CONSULTATION_PRIORITIES,
  CONSULTATION_PRIORITY_LABELS,
  type ConsultationPriority,
  type VisitView,
} from "@neem/contracts";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { useLanguages } from "@/features/onboarding/api";
import { inputClass } from "@/features/facility/form";
import {
  WAITING_FOR_DOCTOR_STATES,
  consultationTone,
  useRequestDoctor,
  useWithdrawRequest,
} from "@/features/facility/patients";
import {
  latestLink,
  linkLabel,
  useClearStation,
  useSendToStation,
  useStations,
} from "@/features/facility/stations";

/**
 * Asking for a Neem doctor, and following the request (slice 1c, D76).
 *
 * The state shown is the server's, refreshed with the board. A doctor is named
 * only once they have accepted, because an offer can still be declined.
 */
export function DoctorRequest({ visit }: { visit: VisitView }) {
  const consultation = visit.consultation;

  if (consultation?.active) return <RequestProgress visit={visit} />;
  if (visit.status === "ESCALATED") return null;

  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <p className="flex items-center gap-2 text-sm font-bold">
        <Stethoscope className="size-4 text-brand" /> Neem doctor
      </p>
      {consultation ? (
        <p className="text-xs text-slate-500">
          Last request: {CHPS_CONSULTATION_PROGRESS[consultation.state] ?? consultation.state}.
        </p>
      ) : null}
      {visit.status === "AWAITING_TRIAGE" ? (
        <p className="text-sm text-slate-500">
          Record a triage assessment before requesting a doctor.
        </p>
      ) : (
        <RequestForm visit={visit} />
      )}
    </div>
  );
}

function RequestForm({ visit }: { visit: VisitView }) {
  const languages = useLanguages();
  const requestDoctor = useRequestDoctor(visit.publicId);
  const [languageCode, setLanguageCode] = useState("");
  const [type, setType] = useState<"VIDEO" | "AUDIO">("VIDEO");
  const [priority, setPriority] = useState<ConsultationPriority>("ROUTINE");
  const [note, setNote] = useState("");
  // What the stations last measured, beside the choice it informs (D89).
  const link = latestLink(useStations().data);

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        requestDoctor.mutate({ languageCode, type, priority, note: note.trim() || undefined });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-500">
            Language the patient speaks
          </span>
          <select
            value={languageCode}
            onChange={(event) => setLanguageCode(event.target.value)}
            className={inputClass}
          >
            <option value="">Choose a language</option>
            {languages.data?.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </select>
        </label>
        <div className="text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-500">How</span>
          <div className="flex gap-2">
            {(
              [
                ["VIDEO", "Video", Video],
                ["AUDIO", "Audio only", Mic],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                data-on={type === value}
                onClick={() => setType(value)}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-slate-600 data-[on=true]:border-brand data-[on=true]:bg-brand-soft data-[on=true]:text-brand"
              >
                <Icon className="size-4" /> {label}
              </button>
            ))}
          </div>
          {link ? (
            <p className="mt-1 text-xs text-slate-500">
              Station line to Neem: {linkLabel(link)}. Audio only uses much less data.
            </p>
          ) : null}
        </div>
      </div>
      <div className="text-sm">
        <span className="mb-1 block text-xs font-semibold text-slate-500">
          How soon should they be seen?
        </span>
        <div className="flex gap-2">
          {CONSULTATION_PRIORITIES.map((value) => (
            <button
              key={value}
              type="button"
              data-on={priority === value}
              onClick={() => setPriority(value)}
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-600 data-[on=true]:border-brand data-[on=true]:bg-brand-soft data-[on=true]:text-brand"
            >
              {CONSULTATION_PRIORITY_LABELS[value]}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Your judgement. An urgent request is offered first when doctors are scarce. An emergency
          does not wait for a doctor: escalate it instead.
        </p>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-semibold text-slate-500">
          Note for the doctor (optional)
        </span>
        <input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Anything the assessment does not say"
          className={inputClass}
        />
      </label>
      {requestDoctor.error ? (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {requestDoctor.error instanceof ApiError
            ? requestDoctor.error.message
            : "The request was not sent."}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!languageCode || requestDoctor.isPending}
        className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
      >
        {requestDoctor.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
        Request a doctor
      </button>
    </form>
  );
}

function RequestProgress({ visit }: { visit: VisitView }) {
  const consultation = visit.consultation!;
  const withdraw = useWithdrawRequest(visit.publicId);
  const [reason, setReason] = useState("");
  const waiting = WAITING_FOR_DOCTOR_STATES.includes(consultation.state);
  const requestedAt = new Date(consultation.requestedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="space-y-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-bold">
          <Stethoscope className="size-4 text-brand" /> Neem doctor
        </p>
        <Chip tone={consultationTone(consultation.state)} pulse={waiting}>
          {CHPS_CONSULTATION_PROGRESS[consultation.state] ?? consultation.state}
        </Chip>
      </div>
      <p className="text-sm text-slate-600">
        {consultation.doctorName ? (
          <>
            <span className="font-semibold">{consultation.doctorName}</span> has accepted.{" "}
          </>
        ) : null}
        {consultation.type === "AUDIO" ? "Audio" : "Video"}
        {consultation.language ? `, ${consultation.language}` : ""}
        {consultation.priority === "URGENT" ? ", urgent" : ""}, requested at {requestedAt}.
      </p>
      {waiting ? (
        <>
          <p className="text-xs text-slate-500">
            No doctor has accepted yet. Keep caring for the patient as usual while they wait.
          </p>
          <div className="flex gap-2">
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Reason, to withdraw the request"
              className={inputClass}
            />
            <button
              type="button"
              disabled={reason.trim().length < 2 || withdraw.isPending}
              onClick={() => withdraw.mutate(reason)}
              className="shrink-0 rounded-lg border border-border px-4 text-sm font-semibold text-slate-600 disabled:opacity-40"
            >
              Withdraw
            </button>
          </div>
        </>
      ) : (
        <p className="text-xs text-slate-500">
          The doctor ends the consultation. Send the patient to a station to join the call.
        </p>
      )}
      {withdraw.error ? (
        <p className="text-xs text-red-600">
          {withdraw.error instanceof ApiError ? withdraw.error.message : "Not withdrawn."}
        </p>
      ) : null}
      <StationControl visit={visit} />
    </div>
  );
}

/**
 * Which station this consultation is on, and a way to put it on one (D77).
 * Sent while the patient waits, so the station greets them before the doctor
 * arrives and joins the call by itself when the doctor accepts.
 */
function StationControl({ visit }: { visit: VisitView }) {
  const stations = useStations();
  const send = useSendToStation(visit.publicId);
  const clear = useClearStation();
  const [choice, setChoice] = useState("");

  const paired = (stations.data ?? []).filter((station) => station.status === "PAIRED");
  const showing = paired.find((station) => station.current?.visitPublicId === visit.publicId);
  const error = send.error ?? clear.error;

  if (stations.isLoading) return null;

  return (
    <div className="space-y-2 border-t border-border pt-3">
      {showing ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="flex items-center gap-2">
            <Monitor className="size-4 text-brand" /> On{" "}
            <span className="font-semibold">{showing.label}</span>
            {!showing.online ? (
              <span className="text-xs text-amber-700">(not seen in the last minute)</span>
            ) : null}
          </p>
          <button
            type="button"
            disabled={clear.isPending}
            onClick={() => clear.mutate(showing.publicId)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-slate-600"
          >
            Take off station
          </button>
        </div>
      ) : paired.length === 0 ? (
        <p className="text-xs text-slate-500">
          No paired station. Add one under Consultation stations on the Today page.
        </p>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            send.mutate(choice || paired[0]!.publicId);
          }}
        >
          <select
            value={choice || paired[0]!.publicId}
            onChange={(event) => setChoice(event.target.value)}
            className={inputClass}
          >
            {paired.map((station) => (
              <option key={station.publicId} value={station.publicId}>
                {station.label}
                {station.current ? " (in use)" : station.online ? "" : " (off)"}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={send.isPending}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            <Monitor className="size-4" /> Send to station
          </button>
        </form>
      )}
      {error ? (
        <p className="text-xs text-red-600">
          {error instanceof ApiError ? error.message : "Not sent."}
        </p>
      ) : null}
    </div>
  );
}
