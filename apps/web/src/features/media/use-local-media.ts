import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The browser's own camera and microphone (spec §32, decision D18).
 *
 * This is real hardware, not a simulation: the permission prompt, a denied
 * permission, a machine with no camera, and the mute and camera controls all
 * behave exactly as they will in production. Only the transport to the other
 * party is mocked, and the screens say so where it matters.
 *
 * The stream is stopped on unmount without exception. A camera light left on
 * after a consultation ends is not acceptable in a clinical setting.
 */

export type LocalMediaStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "denied"
  | "unavailable"
  | "insecure";

export interface LocalMedia {
  status: LocalMediaStatus;
  stream: MediaStream | null;
  micEnabled: boolean;
  cameraEnabled: boolean;
  toggleMic: () => void;
  toggleCamera: () => void;
  /** Human-readable explanation for the failure states. */
  message: string | null;
  retry: () => void;
  stop: () => void;
}

export function useLocalMedia(options: { video: boolean; enabled: boolean }): LocalMedia {
  const { video, enabled } = options;

  const [status, setStatus] = useState<LocalMediaStatus>("idle");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [attempt, setAttempt] = useState(0);

  // Held in a ref as well as state so cleanup can stop tracks without the
  // effect depending on the stream it created — that would restart the camera
  // on every toggle.
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    setStatus("idle");
  }, []);

  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }

    // Camera and microphone access requires a secure context. On a phone
    // reaching a dev server over the LAN this is the actual failure, and
    // saying so beats a bare "permission denied".
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStatus(
        typeof window !== "undefined" && !window.isSecureContext ? "insecure" : "unavailable",
      );
      setMessage(
        typeof window !== "undefined" && !window.isSecureContext
          ? "Your camera needs a secure (https) connection."
          : "This device or browser does not support camera and microphone access.",
      );
      return;
    }

    let cancelled = false;

    void (async () => {
      setStatus("requesting");
      setMessage(null);

      try {
        const media = await navigator.mediaDevices.getUserMedia({ audio: true, video });

        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = media;
        setStream(media);
        setStatus("ready");
        setMicEnabled(true);
        setCameraEnabled(true);
      } catch (error) {
        if (cancelled) return;

        const name = error instanceof DOMException ? error.name : "";

        if (name === "NotAllowedError" || name === "SecurityError") {
          setStatus("denied");
          setMessage(
            video
              ? "Camera and microphone access was blocked. Allow it in your browser, then try again."
              : "Microphone access was blocked. Allow it in your browser, then try again.",
          );
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setStatus("unavailable");
          setMessage(
            video
              ? "No camera was found on this device."
              : "No microphone was found on this device.",
          );
        } else {
          setStatus("unavailable");
          setMessage("Your camera or microphone could not be started.");
        }
      }
    })();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [enabled, video, attempt, stop]);

  const toggleMic = useCallback(() => {
    const tracks = streamRef.current?.getAudioTracks() ?? [];
    if (tracks.length === 0) return;

    const next = !tracks[0]!.enabled;
    tracks.forEach((track) => (track.enabled = next));
    setMicEnabled(next);
  }, []);

  const toggleCamera = useCallback(() => {
    const tracks = streamRef.current?.getVideoTracks() ?? [];
    if (tracks.length === 0) return;

    const next = !tracks[0]!.enabled;
    tracks.forEach((track) => (track.enabled = next));
    setCameraEnabled(next);
  }, []);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return {
    status,
    stream,
    micEnabled,
    cameraEnabled,
    toggleMic,
    toggleCamera,
    message,
    retry,
    stop,
  };
}

/** Binds a stream to a `<video>` element without re-rendering on every frame. */
export function useVideoElement(stream: MediaStream | null) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    element.srcObject = stream;

    return () => {
      element.srcObject = null;
    };
  }, [stream]);

  return ref;
}
