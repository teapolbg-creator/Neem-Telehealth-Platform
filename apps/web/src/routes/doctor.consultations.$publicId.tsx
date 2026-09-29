import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Loader2,
  MapPin,
  Phone,
  PhoneOutgoing,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { isTerminalConsultationState } from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { ClinicalWorkspace } from "@/components/neem/ClinicalWorkspace";
import { CallStage } from "@/components/neem/CallStage";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { channelLabel, consultationOrigin, useDoctorConsultation } from "@/features/queue/api";
import {
  doctorLeftBeacon,
  useDoctorTimer,
  useInterruptConsultation,
  useJoinDoctorMedia,
  useLeaveDoctorMedia,
  usePlaceCall,
} from "@/features/media/api";
import { useRealtimeEvent } from "@/features/realtime/socket";

export const Route = createFileRoute("/doctor/consultations/$publicId")({
  component: DoctorConsultation,
});

/**
 * The doctor's consultation screen (spec §24, §32, §33).
 *
 * Deliberately absent: a record button, the patient's phone number, and any
 * rating or quality score for the doctor (spec §24, §32, §52).
 *
 * The call and the timer sit at the top; the clinical workspace — notes,
 * prescribing, referral, summary and completion — below it.
 */
function DoctorConsultation() {
  const { publicId } = Route.useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useDoctorConsultation(publicId);

  // Held here rather than re-read from the server: once completed, the
  // workspace query is a 403 by design, so the result of the completion is the
  // only place the destruction date is available.
  const [completion, setCompletion] = useState<{ destroyAt: string | null } | null>(null);

  if (isLoading) {
    return (
      <AppShell active="doctor">
        <div className="grid flex-1 place-items-center py-24">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      </AppShell>
    );
  }

  /**
   * The completion notice outranks every other state on this screen.
   *
   * A doctor who has just completed a consultation must see what happened to
   * what they wrote. If the query behind this page fails or refetches at that
   * moment, showing "Consultation not found" instead would read as though the
   * completion itself had failed.
   */
  if (completion) {
    return (
      <AppShell active="doctor">
        <div className="mx-auto w-full max-w-2xl">
          <BackToQueue />
          <div className="mt-4">
            <CompletedNotice
              destroyAt={completion.destroyAt}
              onBack={() => void navigate({ to: "/doctor/queue" })}
            />
          </div>
        </div>
      </AppShell>
    );
  }

  if (error || !data) {
    return (
      <AppShell active="doctor">
        <div className="card-soft mx-auto max-w-lg p-10 text-center">
          <AlertCircle className="mx-auto size-10 text-slate-300" />
          <h1 className="mt-4 text-xl font-bold">Consultation not found</h1>
          <p className="mt-2 text-sm text-slate-500">
            {error instanceof ApiError ? error.message : "It may have been reassigned."}
          </p>
          <BackToQueue />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell active="doctor">
      <div className="mx-auto w-full max-w-5xl">
        <BackToQueue />

        <header className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Consultation</h1>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
              <MapPin className="size-4" />
              {consultationOrigin(data.pharmacy)}
            </p>
            {/* What the channel means in practice, rather than leaving the
                professional to infer it from a pharmacy name. */}
            <p className="mt-1 text-xs text-slate-400">
              {data.pharmacy
                ? "Anything you issue goes to this pharmacy, which may propose a substitution for you to decide."
                : "No pharmacy is involved. The patient keeps whatever you issue, under My care."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={data.pharmacy ? "medical" : "muted"}>{channelLabel(data.pharmacy)}</Chip>
            {data.language && <Chip tone="muted">{data.language.label}</Chip>}
            <Chip tone="brand">{data.state.replace(/_/g, " ").toLowerCase()}</Chip>
          </div>
        </header>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="card-soft overflow-hidden">
            {/*
              A finished consultation gets no call surface at all.

              Rendering one and letting the join fail was worse than useless: it
              spent a request, showed "Connecting…" and a running overtime
              counter, and offered a Reconnect button that could never work.
            */}
            {isTerminalConsultationState(data.state) ? (
              <EndedPanel state={data.state} outcome={data.outcome} outcomes={data.outcomes} />
            ) : data.type === "CALL_ME" ? (
              <CallMePanel publicId={publicId} />
            ) : (
              <VideoPanel
                publicId={publicId}
                patientName={data.patient?.fullName ?? "Patient"}
                interrupted={data.state === "INTERRUPTED"}
                rejoinableUntil={data.rejoinableUntil ?? null}
              />
            )}
          </div>

          <PatientPanel consultation={data} />
        </div>

        {/*
          The clinical workspace sits below the call rather than beside it: the
          doctor is looking at the patient while they talk, and writing
          afterwards. Squeezing both into one row would make each too narrow to
          use on a laptop.
        */}
        <div className="mt-6">
          <ClinicalWorkspace
            consultationPublicId={publicId}
            viaPharmacy={Boolean(data.pharmacy)}
            onCompleted={setCompletion}
          />
        </div>

        <p className="mt-6 flex items-start gap-2 rounded-2xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-600">
          <ShieldCheck className="mt-px size-4 shrink-0 text-slate-400" />
          Nothing here is recorded. What you write is sealed when you complete the consultation and
          retained under a legal record-keeping obligation. It is not readable afterwards, and is
          destroyed when its retention period ends.
        </p>
      </div>
    </AppShell>
  );
}

function BackToQueue() {
  const navigate = useNavigate();

  return (
    <button
      type="button"
      onClick={() => void navigate({ to: "/doctor/queue" })}
      className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-900"
    >
      <ArrowLeft className="size-4" /> Back to queue
    </button>
  );
}

/** How long the doctor is left waiting before being asked what to do. */
const WAIT_SECONDS = 300;

function VideoPanel({
  publicId,
  patientName,
  interrupted,
  rejoinableUntil,
}: {
  publicId: string;
  patientName: string;
  interrupted: boolean;
  rejoinableUntil: string | null;
}) {
  const join = useJoinDoctorMedia(publicId);
  const leave = useLeaveDoctorMedia(publicId);
  const interrupt = useInterruptConsultation(publicId);
  const { data: timer } = useDoctorTimer(publicId, true);
  const [left, setLeft] = useState(false);

  /**
   * Since when the doctor has been alone in the room, or null if they are not.
   *
   * A timestamp rather than a countdown, so a re-render does not restart the
   * wait and the doctor is not asked the same question twice.
   */
  const [aloneSince, setAloneSince] = useState<number | null>(null);
  const [extended, setExtended] = useState(0);

  /*
   * Guarded twice.
   *
   * Once against joining a second time, which would mint another credential and
   * orphan the first — React's development double-invoke makes that a real case.
   *
   * And once against joining at all while the consultation is interrupted (D57).
   * Rejoining resumes it and takes the doctor's slot back, so an automatic join
   * here would undo the marking the moment the doctor opened the page to write
   * their notes, and put them back at capacity for a patient who is not there.
   * Coming back is a button.
   */
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current || interrupted) return;
    requested.current = true;
    join.mutate();
  }, [join, interrupted]);

  /*
   * Two ways of learning the patient is gone, because each misses cases the
   * other catches: the room reports an empty room, and the server reports a
   * patient whose browser said it was going away. Whichever arrives first
   * starts the wait.
   */
  useRealtimeEvent<{ consultationPublicId: string }>("consultation.patient_left", (payload) => {
    if (payload.consultationPublicId === publicId) {
      setAloneSince((since) => since ?? Date.now());
    }
  });

  // The doctor closing their laptop is attendance too, and it is what lets the
  // patient's screen stop saying the doctor is in the call.
  useEffect(() => {
    const onHide = () => doctorLeftBeacon(publicId);
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [publicId]);

  /**
   * Already marked unfinished.
   *
   * No stage, because there is no call to show: joining is what brings it back,
   * and the workspace below stays usable throughout, because a doctor who saw
   * the patient before the call broke still has notes to write and may still
   * complete the consultation from what they saw.
   */
  if (interrupted) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <div className="grid size-14 place-items-center rounded-full bg-amber-100">
          <RotateCcw className="size-7 text-amber-700" />
        </div>
        <h2 className="mt-4 text-lg font-bold">Marked as interrupted</h2>
        <p className="mt-2 max-w-sm text-pretty text-sm text-slate-500">
          The patient can rejoin without paying again
          {rejoinableUntil ? ` until ${formatDeadline(rejoinableUntil)}` : ""}. You are free to take
          other patients. You can still write up and complete this consultation below.
        </p>
        <button
          type="button"
          onClick={() => {
            /*
             * Joined here rather than by releasing the mount effect's guard.
             * The join is what resumes the consultation, and the effect will
             * not fire while it is still interrupted — so the guard is set, not
             * cleared, and this is the one join rather than the first of two.
             */
            requested.current = true;
            setAloneSince(null);
            join.mutate();
          }}
          className="mt-5 rounded-xl border border-border px-5 py-2.5 text-sm font-bold hover:bg-slate-50"
        >
          Rejoin the call
        </button>
      </div>
    );
  }

  if (left) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <h2 className="text-lg font-bold">You have left the call</h2>
        <p className="mt-2 max-w-sm text-pretty text-sm text-slate-500">
          The consultation is still open. Rejoin to continue, or complete it from the workspace
          below. Leaving the call does not end the consultation.
        </p>
        <button
          type="button"
          onClick={() => {
            requested.current = false;
            setLeft(false);
          }}
          className="mt-5 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110"
        >
          Rejoin
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-[28rem] flex-col">
      <CallStage
        session={join.data ?? null}
        timer={timer ?? null}
        role="DOCTOR"
        remoteName={patientName}
        joining={join.isPending}
        error={
          join.isError
            ? join.error instanceof ApiError
              ? join.error.message
              : "The connection could not be started."
            : null
        }
        onRetryJoin={() => join.mutate()}
        leaveLabel="Leave call"
        onLeave={() => {
          leave.mutate();
          setLeft(true);
        }}
        onRemotePresence={(present) => {
          setAloneSince((since) => (present ? null : (since ?? Date.now())));
          if (present) setExtended(0);
        }}
        // The doctor's own connection dying is not the patient's fault and not
        // the consultation ending: the stage offers Reconnect, and this is what
        // stops the wait banner accusing the patient of having left.
        onDropped={() => setAloneSince(null)}
        notice={
          aloneSince === null ? null : (
            <PatientAwayBanner
              since={aloneSince}
              extraSeconds={extended}
              patientName={patientName}
              onWaitLonger={() => setExtended((value) => value + WAIT_SECONDS)}
              onInterrupt={() => interrupt.mutate(undefined)}
              interrupting={interrupt.isPending}
              error={
                interrupt.isError
                  ? interrupt.error instanceof ApiError
                    ? interrupt.error.message
                    : "That could not be recorded."
                  : null
              }
            />
          )
        }
      />
    </div>
  );
}

/**
 * The patient is not in the call (D57).
 *
 * The doctor is asked, and never overruled. Nothing in Neem decides on its own
 * that a consultation is unfinished: no timeout, no missing heartbeat and no
 * closed browser, because each of those is also what a working consultation
 * looks like on a Ghanaian mobile connection for thirty seconds at a time.
 *
 * So this counts, says what it can see, and offers the two answers a clinician
 * actually has: keep waiting, or record that the call broke. It does not offer
 * "complete", because completing from here would be completing a consultation
 * the patient walked out of, and that decision belongs in the workspace with
 * the notes in front of them.
 */
function PatientAwayBanner({
  since,
  extraSeconds,
  patientName,
  onWaitLonger,
  onInterrupt,
  interrupting,
  error,
}: {
  since: number;
  extraSeconds: number;
  patientName: string;
  onWaitLonger: () => void;
  onInterrupt: () => void;
  interrupting: boolean;
  error: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const waited = Math.max(0, Math.round((now - since) / 1000));
  const remaining = WAIT_SECONDS + extraSeconds - waited;
  const elapsed = remaining <= 0;

  return (
    <div className="bg-amber-50 px-5 py-4 text-xs leading-relaxed text-amber-900">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-px size-4 shrink-0" />
        <div className="flex-1">
          <p className="font-bold">
            {patientName} is not in the call
            {elapsed ? "" : `. Waiting ${formatWait(remaining)} more`}
          </p>
          <p className="mt-1">
            They may be reconnecting. Nothing has ended, and nothing will end on its own — the
            consultation stays open, and they are not charged again whenever they come back.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onWaitLonger}
              className="rounded-xl border border-amber-300 bg-white px-4 py-2 text-xs font-bold text-amber-900 hover:bg-amber-100"
            >
              Wait longer
            </button>
            <button
              type="button"
              disabled={interrupting}
              onClick={onInterrupt}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-700 px-4 py-2 text-xs font-bold text-white hover:bg-amber-800 disabled:opacity-40"
            >
              {interrupting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              Mark the call as interrupted
            </button>
          </div>

          <p className="mt-2 text-amber-800/80">
            Marking it frees you to see other patients and lets this one rejoin later without paying
            again. It does not complete the consultation or refund anything.
          </p>

          {error && <p className="mt-2 font-bold text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
}

/** "4:05" — a wait, in the shape a clock shows it. */
function formatWait(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A deadline in the doctor's own local time, since they are the one watching it. */
function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Call Me (spec §33).
 *
 * The doctor presses one button and the platform dials both parties. No number
 * is shown, entered, or returned — neither party learns the other's.
 */
function CallMePanel({ publicId }: { publicId: string }) {
  const place = usePlaceCall(publicId);

  return (
    <div className="flex flex-col items-center justify-center p-12 text-center">
      <div className="grid size-16 place-items-center rounded-full bg-brand/10">
        <PhoneOutgoing className="size-8 text-brand" />
      </div>
      <h2 className="mt-5 text-xl font-bold">Call this patient</h2>
      <p className="mt-2 max-w-sm text-pretty text-sm text-slate-500">
        Neem dials you both and connects the call. You will not see the patient’s number, and they
        will not see yours.
      </p>

      <button
        type="button"
        disabled={place.isPending || place.isSuccess}
        onClick={() => place.mutate()}
        className="mt-6 inline-flex items-center gap-2 rounded-2xl bg-brand px-6 py-3.5 text-base font-bold text-white shadow-lg shadow-brand/20 hover:brightness-110 disabled:opacity-40"
      >
        {place.isPending ? (
          <Loader2 className="size-5 animate-spin" />
        ) : (
          <Phone className="size-5" />
        )}
        {place.isSuccess ? "Call placed" : "Place the call"}
      </button>

      {place.isSuccess && (
        <div className="mt-5 w-full max-w-sm rounded-2xl bg-slate-50 p-4 text-left">
          <p className="text-xs leading-relaxed text-slate-600">
            The patient’s phone will show{" "}
            <strong className="font-bold">{place.data.callerIdShown}</strong>.
          </p>
          {place.data.isMockProvider && (
            <p className="mt-2 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
              <strong className="font-bold">No call was actually placed.</strong> Telephone bridging
              is simulated in this build, and the patient’s phone will not ring.
            </p>
          )}
        </div>
      )}

      {place.error && (
        <p className="mt-4 text-sm text-red-600">
          {place.error instanceof ApiError ? place.error.message : "The call could not be placed."}
        </p>
      )}
    </div>
  );
}

/**
 * What stands in for the call once the consultation is over.
 *
 * States plainly that it has ended, without implying the doctor did something
 * wrong by opening it — coming back to a completed consultation is ordinary.
 */
const OUTCOME_LABEL: Record<string, string> = {
  ADVICE_ONLY: "Advice only",
  PRESCRIPTION: "Prescription issued",
  REFERRAL: "Referred",
  EMERGENCY_REFERRAL: "Referred as an emergency",
  OTHER: "Other",
};

function EndedPanel({
  state,
  outcome,
  outcomes,
}: {
  state: string;
  outcome: string | null;
  outcomes?: string[];
}) {
  /*
    Everything the consultation produced, or the single outcome for a record
    written before consultations could have several (D56).
  */
  const recorded = outcomes?.length ? outcomes : outcome ? [outcome] : [];
  const wasCompleted = state === "COMPLETED";

  return (
    <div className="flex min-h-[20rem] flex-col items-center justify-center p-12 text-center">
      <div className="grid size-16 place-items-center rounded-full bg-slate-100">
        {wasCompleted ? (
          <ShieldCheck className="size-8 text-slate-400" />
        ) : (
          <AlertCircle className="size-8 text-slate-400" />
        )}
      </div>
      <h2 className="mt-5 text-xl font-bold">
        {wasCompleted ? "This consultation is complete" : "This consultation has ended"}
      </h2>
      <p className="mt-2 max-w-sm text-pretty text-sm leading-relaxed text-slate-500">
        {wasCompleted
          ? "There is no call to rejoin. What you wrote is sealed."
          : `It ended as ${state.replace(/_/g, " ").toLowerCase()} and cannot be rejoined.`}
      </p>

      {/*
        The outcome, not the record. What kind of document was issued is
        operational — it drives the pharmacy's next step and the revenue split —
        and stays readable after sealing, unlike anything clinical.
      */}
      {wasCompleted && recorded.length > 0 && (
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {recorded.map((entry) => (
            <p
              key={entry}
              className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-600"
            >
              {OUTCOME_LABEL[entry] ?? entry.replace(/_/g, " ").toLowerCase()}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/** Demographics and what the pharmacy recorded. No history, by design. */
function PatientPanel({
  consultation,
}: {
  consultation: {
    pharmacy: { name: string; city: string } | null;
    patient: { fullName: string; age: number; sex: string } | null;
    vitals: Record<string, unknown> | null;
    tests: Array<{ code: string; label: string; result: string; recordedAt: string }>;
    clinicalSealed: boolean;
  };
}) {
  const { patient, vitals, tests, clinicalSealed } = consultation;

  return (
    <aside className="card-soft h-fit p-6">
      <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400">Patient</h2>

      {patient ? (
        <>
          <p className="mt-2 text-lg font-bold">{patient.fullName}</p>
          <p className="text-sm text-slate-500">
            {patient.age} years · {patient.sex.toLowerCase()}
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-slate-500">Details are no longer available.</p>
      )}

      <h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-slate-400">
        {consultation.pharmacy ? "Recorded at the pharmacy" : "Recorded before the consultation"}
      </h3>
      {vitals ? (
        <dl className="mt-2 space-y-1.5 text-sm">
          {readVitals(vitals).map((row) => (
            <div key={row.label} className="flex justify-between gap-4">
              <dt className="text-slate-500">{row.label}</dt>
              <dd className="font-semibold tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-slate-500">
          {clinicalSealed
            ? "Sealed. This consultation is complete, so its clinical record can no longer be read here."
            : "No vitals were recorded."}
        </p>
      )}

      {tests.length > 0 && (
        <>
          <h3 className="mt-6 text-xs font-bold uppercase tracking-wider text-slate-400">
            Point-of-care tests
          </h3>
          <ul className="mt-2 space-y-1.5 text-sm">
            {tests.map((test) => (
              <li key={test.code} className="flex justify-between gap-4">
                <span className="text-slate-500">{test.label}</span>
                <span className="font-semibold">{test.result}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/*
        Rewritten for D23. This said the data was deleted at completion; it is
        now retained under seal for a legally required period. What has not
        changed is what matters to the doctor reading this screen: they see
        this consultation and no other, ever.
      */}
      <p className="mt-6 text-xs leading-relaxed text-slate-400">
        This consultation only. Neem shows you no past consultations for this patient, and this
        record is sealed once you complete it.
      </p>
    </aside>
  );
}

/**
 * Vitals, as a clinician expects to read them.
 *
 * Units are not decoration here — an unlabelled "38.2" is ambiguous, and
 * systolic and diastolic pressures belong on one line, not two. Named
 * explicitly rather than derived from the column names, so a schema change
 * cannot silently produce a mislabelled clinical reading.
 */
function readVitals(vitals: Record<string, unknown>): Array<{ label: string; value: string }> {
  const number = (key: string): number | null => {
    const value = vitals[key];
    return value === null || value === undefined ? null : Number(value);
  };

  const rows: Array<{ label: string; value: string }> = [];

  const systolic = number("bpSystolic");
  const diastolic = number("bpDiastolic");
  if (systolic !== null && diastolic !== null) {
    rows.push({ label: "Blood pressure", value: `${systolic}/${diastolic} mmHg` });
  }

  const pulse = number("pulseBpm");
  if (pulse !== null) rows.push({ label: "Pulse", value: `${pulse} bpm` });

  const temperature = number("temperatureC");
  if (temperature !== null) {
    rows.push({ label: "Temperature", value: `${temperature.toFixed(1)} °C` });
  }

  const spo2 = number("spo2Percent");
  if (spo2 !== null) rows.push({ label: "Oxygen saturation", value: `${spo2}%` });

  const weight = number("weightKg");
  if (weight !== null) rows.push({ label: "Weight", value: `${weight} kg` });

  const recordedAt = vitals.recordedAt;
  if (typeof recordedAt === "string") {
    rows.push({
      label: "Recorded",
      value: new Date(recordedAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
  }

  return rows;
}

/**
 * What the doctor sees once the consultation is complete.
 *
 * States the retention outcome plainly. A doctor who has just written clinical
 * notes should know what happens to them, and "sealed" is not self-explanatory.
 */
function CompletedNotice({ destroyAt, onBack }: { destroyAt: string | null; onBack: () => void }) {
  return (
    <div className="card-soft p-8 text-center">
      <div className="mx-auto grid size-16 place-items-center rounded-full bg-brand/10">
        <ShieldCheck className="size-8 text-brand" />
      </div>
      <h2 className="mt-5 text-xl font-bold">Consultation complete</h2>
      <p className="mx-auto mt-2 max-w-md text-pretty text-sm leading-relaxed text-slate-500">
        The clinical record is sealed. It is retained under a legal record-keeping obligation, is
        not readable through Neem by anyone
        {destroyAt ? `, and is destroyed on ${new Date(destroyAt).toLocaleDateString()}.` : "."}
      </p>
      <p className="mx-auto mt-3 max-w-md text-pretty text-xs leading-relaxed text-slate-400">
        Any prescription, referral or summary you issued stays available to the patient and the
        pharmacy: those are documents you deliberately issued, not working notes.
      </p>
      <button
        type="button"
        onClick={onBack}
        className="mt-6 rounded-xl bg-brand px-6 py-3 text-sm font-bold text-white hover:brightness-110"
      >
        Back to queue
      </button>
    </div>
  );
}
