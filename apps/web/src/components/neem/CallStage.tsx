import { useCallback, useEffect, useState } from "react";
import type { ConsultationTimer, MediaSessionView } from "@neem/contracts";
import {
  AlertCircle,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useLocalMedia, useVideoElement } from "@/features/media/use-local-media";
import { WherebyStage, type WherebyStageHandle } from "./WherebyStage";
import { cn } from "@/lib/utils";

/**
 * The consultation stage, shared by the patient and doctor screens.
 *
 * Deliberately absent: a record button, a chat panel, and an image upload
 * (spec §32, decision D15). None of these has a server route either.
 *
 * The remote pane states plainly when media is simulated. An empty black pane
 * would read as a failed connection, and a clinician must never be left
 * guessing whether the patient can hear them (decision D18).
 *
 * **Two ways of showing a call, and only ever one at a time.** When the server
 * returns a `joinUrl` the media is real and Whereby fills the stage; otherwise
 * the mock path renders the local camera with a pane saying so. They are
 * mutually exclusive because both want the camera: `useLocalMedia` calls
 * `getUserMedia` on this page, the embed acquires devices in its own frame,
 * and on several Android browsers the second one to ask gets nothing (D35).
 */

export interface CallStageProps {
  session: MediaSessionView | null;
  /** Null before the consultation has started. */
  timer: ConsultationTimer | null;
  /** Whose screen this is — only the label differs. */
  role: "PATIENT" | "DOCTOR";
  /** Name shown on the remote pane. */
  remoteName: string;
  joining: boolean;
  error: string | null;
  onRetryJoin: () => void;
  /** The patient's control ends their participation; the doctor's completes. */
  onLeave: () => void;
  leaveLabel: string;
  /** Rendered under the controls — the doctor's notes panel, for instance. */
  children?: React.ReactNode;
}

export function CallStage({
  session,
  timer,
  role,
  remoteName,
  joining,
  error,
  onRetryJoin,
  onLeave,
  leaveLabel,
  children,
}: CallStageProps) {
  const isVideo = session?.kind === "VIDEO";
  const embedded = Boolean(session?.joinUrl);

  // Disabled entirely while the embed is up — see the note above.
  const local = useLocalMedia({ video: isVideo, enabled: session !== null && !embedded });
  const videoRef = useVideoElement(local.stream);
  const [speakerOn, setSpeakerOn] = useState(true);

  const [embed, setEmbed] = useState<WherebyStageHandle | null>(null);
  const [embedMic, setEmbedMic] = useState(true);
  const [embedCamera, setEmbedCamera] = useState(isVideo);
  const [recordingDetected, setRecordingDetected] = useState(false);
  const [unstable, setUnstable] = useState(false);

  const onDeviceState = useCallback((state: { mic?: boolean; camera?: boolean }) => {
    if (state.mic !== undefined) setEmbedMic(state.mic);
    if (state.camera !== undefined) setEmbedCamera(state.camera);
  }, []);
  const onRecordingDetected = useCallback(() => setRecordingDetected(true), []);
  const onConnectionUnstable = useCallback((value: boolean) => setUnstable(value), []);

  // One set of controls, whichever stage is behind them.
  const micEnabled = embedded ? embedMic : local.micEnabled;
  const cameraEnabled = embedded ? embedCamera : local.cameraEnabled;
  const controlsReady = embedded ? embed !== null : local.status === "ready";
  const toggleMic = embedded ? () => embed?.toggleMic(!embedMic) : local.toggleMic;
  const toggleCamera = embedded ? () => embed?.toggleCamera(!embedCamera) : local.toggleCamera;

  return (
    <div className="flex flex-1 flex-col">
      <div className="relative flex-1 overflow-hidden bg-slate-900">
        {embedded && session?.joinUrl ? (
          <WherebyStage
            roomUrl={session.joinUrl}
            kind={isVideo ? "VIDEO" : "AUDIO"}
            onDeviceState={onDeviceState}
            onRecordingDetected={onRecordingDetected}
            onConnectionUnstable={onConnectionUnstable}
            handleRef={setEmbed}
          />
        ) : (
          <RemotePane
            isMock={session?.isMockProvider ?? false}
            connected={session !== null}
            joining={joining}
            name={remoteName}
            role={role}
          />
        )}

        {/* The local preview belongs to the mock path; the embed draws its own. */}
        {!embedded && isVideo && (
          <div className="absolute bottom-4 right-4 h-32 w-24 overflow-hidden rounded-xl border-2 border-white/20 bg-slate-800 shadow-lg">
            {local.status === "ready" && local.cameraEnabled ? (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                // Muted without exception: playing your own microphone back
                // through the speaker produces immediate feedback howl.
                muted
                className="size-full scale-x-[-1] object-cover"
              />
            ) : (
              <div className="grid size-full place-items-center px-2 text-center">
                {local.status === "requesting" ? (
                  <Loader2 className="size-5 animate-spin text-white/60" />
                ) : (
                  <VideoOff className="size-5 text-white/40" />
                )}
              </div>
            )}
          </div>
        )}

        {timer && <TimerBadge timer={timer} />}
      </div>

      {!embedded && local.message && (
        <div className="flex items-start gap-2 bg-amber-50 px-5 py-3 text-xs leading-relaxed text-amber-900">
          <AlertCircle className="mt-px size-4 shrink-0" />
          <div className="flex-1">
            <p>{local.message}</p>
            <button
              type="button"
              onClick={local.retry}
              className="mt-1 font-bold underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {recordingDetected && (
        /**
         * Neem never asks Whereby to record, and the room is created without a
         * recording configuration — but recording can be switched on in the
         * Whereby dashboard, which no code here can see (D35, security.md §10).
         * If it ever happens, the two people in the room are the ones who need
         * to know, and they need to know while it is happening.
         */
        <div
          role="alert"
          className="flex items-start gap-2 bg-red-600 px-5 py-3 text-xs font-bold leading-relaxed text-white"
        >
          <AlertCircle className="mt-px size-4 shrink-0" />
          <p>
            This consultation is being recorded. Neem does not record consultations — stop and
            report this before continuing.
          </p>
        </div>
      )}

      {unstable && (
        <div className="flex items-start gap-2 bg-amber-50 px-5 py-3 text-xs leading-relaxed text-amber-900">
          <AlertCircle className="mt-px size-4 shrink-0" />
          <p>The connection is unstable. Audio may drop.</p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 bg-red-50 px-5 py-3 text-xs leading-relaxed text-red-900">
          <AlertCircle className="mt-px size-4 shrink-0" />
          <div className="flex-1">
            <p>{error}</p>
            <button
              type="button"
              onClick={onRetryJoin}
              className="mt-1 font-bold underline underline-offset-2"
            >
              Reconnect
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-center gap-3 border-t border-border bg-white px-5 py-4">
        <ControlButton
          label={micEnabled ? "Mute microphone" : "Unmute microphone"}
          active={micEnabled}
          disabled={!controlsReady}
          onClick={toggleMic}
        >
          {micEnabled ? <Mic className="size-5" /> : <MicOff className="size-5" />}
        </ControlButton>

        {isVideo && (
          <ControlButton
            label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
            active={cameraEnabled}
            disabled={!controlsReady}
            onClick={toggleCamera}
          >
            {cameraEnabled ? <Video className="size-5" /> : <VideoOff className="size-5" />}
          </ControlButton>
        )}

        <ControlButton
          label={speakerOn ? "Mute speaker" : "Unmute speaker"}
          active={speakerOn}
          onClick={() => setSpeakerOn((value) => !value)}
        >
          {speakerOn ? <Volume2 className="size-5" /> : <VolumeX className="size-5" />}
        </ControlButton>

        <button
          type="button"
          onClick={onLeave}
          aria-label={leaveLabel}
          className="ml-2 inline-flex items-center gap-2 rounded-full bg-red-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-red-700"
        >
          <PhoneOff className="size-5" />
          {leaveLabel}
        </button>
      </div>

      {children}
    </div>
  );
}

/**
 * Where the other party appears.
 *
 * While the mock adapter is in use this says so in as many words. Overstating
 * what the software does is the one thing a clinical tool must not do.
 */
function RemotePane({
  isMock,
  connected,
  joining,
  name,
  role,
}: {
  isMock: boolean;
  connected: boolean;
  joining: boolean;
  name: string;
  role: "PATIENT" | "DOCTOR";
}) {
  if (joining || !connected) {
    return (
      <div className="grid size-full place-items-center text-center text-white/70">
        <div>
          <Loader2 className="mx-auto size-7 animate-spin" />
          <p className="mt-3 text-sm">Connecting…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid size-full place-items-center px-8 text-center">
      <div>
        <div className="mx-auto grid size-20 place-items-center rounded-full bg-white/10 text-2xl font-bold text-white">
          {initials(name)}
        </div>
        <p className="mt-4 text-lg font-bold text-white">{name}</p>

        {isMock ? (
          <div className="mx-auto mt-5 max-w-xs rounded-xl border border-amber-300/40 bg-amber-400/10 px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-wide text-amber-200">
              Simulated connection
            </p>
            <p className="mt-1 text-xs leading-relaxed text-amber-100/90">
              {role === "DOCTOR"
                ? "Live video and audio are not connected in this build. You cannot see or hear the patient."
                : "Live video and audio are not connected in this build. The doctor cannot see or hear you."}{" "}
              Your own camera and microphone are working normally.
            </p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-white/60">Connected</p>
        )}
      </div>
    </div>
  );
}

/**
 * The elapsed-time badge.
 *
 * Counts locally between polls, so the seconds move smoothly without a request
 * per second. It warns and then shows the overrun — and it never ends
 * anything, on either side (spec §15).
 */
function TimerBadge({ timer }: { timer: ConsultationTimer }) {
  const [elapsed, setElapsed] = useState(timer.elapsedSeconds);

  useEffect(() => setElapsed(timer.elapsedSeconds), [timer.elapsedSeconds]);

  useEffect(() => {
    const id = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = timer.durationSeconds - elapsed;
  const overrun = remaining < 0;
  const warning = !overrun && remaining <= 60;

  return (
    <div
      className={cn(
        "absolute left-4 top-4 rounded-full px-3 py-1.5 text-xs font-bold tabular-nums",
        overrun
          ? "bg-amber-400/90 text-amber-950"
          : warning
            ? "bg-amber-300/90 text-amber-950"
            : "bg-black/40 text-white",
      )}
      role="timer"
      aria-live="off"
    >
      {overrun ? `+${formatSeconds(-remaining)} over` : formatSeconds(Math.max(0, remaining))}
    </div>
  );
}

function ControlButton({
  children,
  label,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "grid size-12 place-items-center rounded-full border transition disabled:opacity-40",
        active
          ? "border-border bg-slate-100 text-slate-700 hover:bg-slate-200"
          : "border-transparent bg-red-100 text-red-700 hover:bg-red-200",
      )}
    >
      {children}
    </button>
  );
}

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
