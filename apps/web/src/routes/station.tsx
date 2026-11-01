import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { HeartHandshake, Loader2, RotateCcw, Stethoscope, WifiOff } from "lucide-react";
import { NeemLogo } from "@/components/neem/Logo";
import { CallStage } from "@/components/neem/CallStage";
import { ApiError } from "@/lib/api-client";
import {
  usePairStation,
  useStationJoin,
  useStationLeave,
  useStationState,
} from "@/features/station/api";
import { useConnectionCheck } from "@/features/station/connection";

export const Route = createFileRoute("/station")({
  component: StationScreen,
});

/**
 * The consultation station: the screen at a CHPS compound that the patient
 * speaks to the doctor on (slice 1d, D77).
 *
 * Built for someone who may never have used a tablet. One thing on screen at
 * a time, large type, no navigation, nothing to tap but the call controls and
 * a rejoin. The CHO drives everything else from their own dashboard.
 *
 * Privacy on a shared screen is enforced twice. The API gives this screen a
 * first name and nothing else. And when a consultation ends, after a short
 * thank-you, the page reloads itself, so nothing about that patient survives
 * in memory for the next person to walk up.
 *
 * Run it in the device's kiosk or screen-pinning mode (docs/station-setup.md).
 */
function StationScreen() {
  const state = useStationState();
  const [finished, setFinished] = useState(false);
  const lastSession = useRef<string | null>(null);
  const online = useOnline();
  useWakeLock();
  // Measured while nobody is waiting or on a call (D89).
  useConnectionCheck(state.data?.mode === "IDLE");

  const sessionKey = state.data?.sessionKey ?? null;
  useEffect(() => {
    // A consultation this screen was showing has gone: thank, then wipe.
    if (lastSession.current && sessionKey !== lastSession.current) setFinished(true);
    lastSession.current = sessionKey;
  }, [sessionKey]);

  useEffect(() => {
    if (!finished) return;
    const timer = window.setTimeout(() => window.location.reload(), 8_000);
    return () => window.clearTimeout(timer);
  }, [finished]);

  /*
   * Latched, not derived. A refetch with no data resets the query to pending
   * and clears its error, which would unmount the pairing form and lose a
   * half-typed code; once told it is unpaired, the screen stays on pairing
   * until pairing succeeds.
   */
  const [unpaired, setUnpaired] = useState(false);
  useEffect(() => {
    if (state.error instanceof ApiError && state.error.status === 401) setUnpaired(true);
    else if (state.data) setUnpaired(false);
  }, [state.error, state.data]);

  return (
    <div className="flex min-h-dvh flex-col bg-surface text-foreground">
      <header className="flex items-center justify-between px-8 py-5">
        <NeemLogo className="text-2xl" markClassName="size-10" />
        <div className="flex items-center gap-4 text-right">
          {!online || (state.isError && !unpaired) ? (
            <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-4 py-2 text-base font-semibold text-amber-900">
              <WifiOff className="size-5" /> Reconnecting…
            </span>
          ) : null}
          {state.data ? (
            <div>
              <p className="text-lg font-bold">{state.data.facility.name}</p>
              <p className="text-sm text-slate-500">{state.data.station.label}</p>
            </div>
          ) : null}
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 pb-10">
        {finished ? (
          <Finished />
        ) : unpaired ? (
          <Pairing onPaired={() => void state.refetch()} />
        ) : !state.data ? (
          <Loader2 className="size-12 animate-spin text-brand" />
        ) : state.data.mode === "READY" ? (
          <InCall key={state.data.sessionKey} doctorName={state.data.doctorName ?? "your doctor"} />
        ) : state.data.mode === "WAITING_FOR_DOCTOR" ? (
          <Message
            icon={<Stethoscope className="size-16 text-brand" />}
            title={`Welcome${state.data.patientFirstName ? `, ${state.data.patientFirstName}` : ""}.`}
            body="Your doctor will be with you shortly. Please stay here."
            pulse
          />
        ) : (
          <Message
            icon={<HeartHandshake className="size-16 text-brand" />}
            title="Welcome to Neem."
            body="Please speak to the health staff here. They will connect you to a doctor."
          />
        )}
      </main>
    </div>
  );
}

function Message({
  icon,
  title,
  body,
  pulse = false,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  pulse?: boolean;
}) {
  return (
    <div className="max-w-2xl text-center">
      <div
        className={`mx-auto grid size-28 place-items-center rounded-full bg-brand-soft ${pulse ? "animate-pulse" : ""}`}
      >
        {icon}
      </div>
      <h1 className="mt-8 font-display text-5xl font-bold leading-tight">{title}</h1>
      <p className="mt-4 text-2xl leading-relaxed text-slate-600">{body}</p>
    </div>
  );
}

function Finished() {
  return (
    <Message
      icon={<HeartHandshake className="size-16 text-brand" />}
      title="Thank you."
      body="Please see the health staff here before you leave."
    />
  );
}

/**
 * The call. Joins on its own as soon as it is shown: the patient should not
 * have to find a button. A dropped or left call offers one large Rejoin.
 */
function InCall({ doctorName }: { doctorName: string }) {
  const join = useStationJoin();
  const leave = useStationLeave();
  const [left, setLeft] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    join.mutate();
  }, [join]);

  if (left) {
    return (
      <div className="text-center">
        <p className="text-3xl font-bold">You have left the call.</p>
        <p className="mt-3 text-xl text-slate-600">Your consultation is still open.</p>
        <button
          type="button"
          onClick={() => {
            setLeft(false);
            join.mutate();
          }}
          className="mt-8 inline-flex items-center gap-3 rounded-2xl bg-brand px-10 py-5 text-2xl font-bold text-white hover:brightness-110"
        >
          <RotateCcw className="size-7" /> Rejoin
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl">
      <CallStage
        session={join.data ?? null}
        timer={null}
        role="PATIENT"
        remoteName={doctorName}
        joining={join.isPending}
        error={
          join.isError
            ? join.error instanceof ApiError
              ? join.error.message
              : "The call could not be connected."
            : null
        }
        onRetryJoin={() => join.mutate()}
        onDropped={() => setLeft(true)}
        onLeave={() => {
          leave.mutate();
          setLeft(true);
        }}
        leaveLabel="Leave call"
      />
    </div>
  );
}

function Pairing({ onPaired }: { onPaired: () => void }) {
  const pair = usePairStation();
  const [code, setCode] = useState("");

  return (
    <form
      className="w-full max-w-md text-center"
      onSubmit={(event) => {
        event.preventDefault();
        pair.mutate(code, { onSuccess: onPaired });
      }}
    >
      <h1 className="font-display text-3xl font-bold">Set up this station</h1>
      <p className="mt-3 text-slate-600">
        Facility staff: open Neem on your own device, add a station, and type its pairing code here.
      </p>
      <input
        autoFocus
        value={code}
        onChange={(event) => setCode(event.target.value.toUpperCase())}
        placeholder="XXXX-XXXX"
        autoComplete="off"
        className="mt-8 w-full rounded-2xl border-2 border-border bg-white px-5 py-4 text-center font-mono text-3xl tracking-[0.3em] focus:border-brand focus:outline-none"
      />
      {pair.error ? (
        <p className="mt-3 text-red-600">
          {pair.error instanceof ApiError ? pair.error.message : "Pairing failed."}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={code.replace(/[^0-9A-Z]/g, "").length < 8 || pair.isPending}
        className="mt-6 w-full rounded-2xl bg-brand px-6 py-4 text-xl font-bold text-white disabled:opacity-40"
      >
        Pair station
      </button>
    </form>
  );
}

function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/** Keeps the screen on while the station is open, where the browser allows it. */
function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const request = async () => {
      try {
        const wakeLock = (
          navigator as Navigator & {
            wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
          }
        ).wakeLock;
        lock = (await wakeLock?.request("screen")) ?? null;
      } catch {
        // Not supported, or refused: the device's own settings decide.
      }
    };
    void request();
    const onVisible = () => {
      if (document.visibilityState === "visible") void request();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}
