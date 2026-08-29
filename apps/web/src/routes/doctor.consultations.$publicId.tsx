import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Loader2,
  MapPin,
  Phone,
  PhoneOutgoing,
  ShieldCheck,
} from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { CallStage } from "@/components/neem/CallStage";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { useDoctorConsultation } from "@/features/queue/api";
import {
  useDoctorTimer,
  useJoinDoctorMedia,
  useLeaveDoctorMedia,
  usePlaceCall,
} from "@/features/media/api";

export const Route = createFileRoute("/doctor/consultations/$publicId")({
  component: DoctorConsultation,
});

/**
 * The doctor's consultation screen (spec §24, §32, §33).
 *
 * Deliberately absent: a record button, the patient's phone number, and any
 * rating or quality score for the doctor (spec §24, §32, §52).
 *
 * The clinical workspace — notes, diagnosis, prescribing and completion — is
 * Phase 6. Until then this screen carries the call and the timer, and says so.
 */
function DoctorConsultation() {
  const { publicId } = Route.useParams();
  const { data, isLoading, error } = useDoctorConsultation(publicId);

  if (isLoading) {
    return (
      <AppShell active="doctor">
        <div className="grid flex-1 place-items-center py-24">
          <Loader2 className="size-6 animate-spin text-brand" />
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
              {data.pharmacy.name}, {data.pharmacy.city}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.language && <Chip tone="muted">{data.language.label}</Chip>}
            <Chip tone="brand">{data.state.replace(/_/g, " ").toLowerCase()}</Chip>
          </div>
        </header>

        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
          <div className="card-soft overflow-hidden">
            {data.type === "CALL_ME" ? (
              <CallMePanel publicId={publicId} />
            ) : (
              <VideoPanel publicId={publicId} patientName={data.patient?.fullName ?? "Patient"} />
            )}
          </div>

          <PatientPanel consultation={data} />
        </div>

        <p className="mt-6 flex items-start gap-2 rounded-2xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-600">
          <ShieldCheck className="mt-px size-4 shrink-0 text-slate-400" />
          Nothing here is recorded. Clinical notes, prescribing and completing the consultation
          arrive in the next phase.
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

function VideoPanel({ publicId, patientName }: { publicId: string; patientName: string }) {
  const join = useJoinDoctorMedia(publicId);
  const leave = useLeaveDoctorMedia(publicId);
  const { data: timer } = useDoctorTimer(publicId, true);
  const [left, setLeft] = useState(false);

  // Guarded: joining twice would mint a second credential and orphan the
  // first. React's development double-invoke makes this a real case.
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    join.mutate();
  }, [join]);

  if (left) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <h2 className="text-lg font-bold">You have left the call</h2>
        <p className="mt-2 max-w-sm text-pretty text-sm text-slate-500">
          The consultation is still open. Rejoin to continue, or complete it from the clinical
          workspace once that arrives.
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
      />
    </div>
  );
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
        {place.isPending ? <Loader2 className="size-5 animate-spin" /> : <Phone className="size-5" />}
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
              is simulated in this build — the patient’s phone will not ring.
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

/** Demographics and what the pharmacy recorded. No history, by design. */
function PatientPanel({
  consultation,
}: {
  consultation: {
    patient: { fullName: string; age: number; sex: string } | null;
    vitals: Record<string, unknown> | null;
    tests: Array<{ code: string; label: string; result: string; recordedAt: string }>;
  };
}) {
  const { patient, vitals, tests } = consultation;

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
        Recorded at the pharmacy
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
        <p className="mt-2 text-sm text-slate-500">No vitals were recorded.</p>
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

      <p className="mt-6 text-xs leading-relaxed text-slate-400">
        This consultation only. Neem keeps no medical history, and everything above is deleted when
        it completes.
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
