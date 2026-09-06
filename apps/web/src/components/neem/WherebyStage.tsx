import { useEffect, useRef, useState } from "react";
// Type-only: this pulls in the SDK's JSX declaration for <whereby-embed>
// without emitting a runtime import. The module itself is loaded in the
// browser only — see `registerEmbedElement` below.
import type {} from "@whereby.com/browser-sdk/embed";

/**
 * The Whereby room, embedded (decision D35).
 *
 * Everything visible during a consultation is Neem's own chrome — the timer,
 * the controls, the leave button — and this component supplies only the video.
 * That is why the room URL carries `minimal=on` and `leaveButton=off` from the
 * server: two sets of controls disagreeing about whether the microphone is on
 * is worse than either set alone.
 *
 * **The camera is held by exactly one thing.** The mock adapter renders a local
 * preview with `useLocalMedia`, which calls `getUserMedia` directly. The embed
 * does its own device acquisition, and on several Android browsers a camera
 * already held by the page cannot be opened again — the consultation would come
 * up black. So `CallStage` disables the local preview whenever this is
 * rendered, and neither path runs at the same time.
 *
 * **It is loaded in the browser only.** The SDK registers a custom element and
 * touches `document` at module scope, so a top-level import throws
 * "document is not defined" while TanStack Start renders this page on the
 * server — taking down the whole consultation screen, not just the video. So
 * the module is imported inside an effect and the element is not rendered
 * until it is registered. An unregistered custom element renders as an inert
 * empty box, which would have looked like a camera that never started.
 *
 * **Nothing here can start a recording.** The element exposes `startRecording`,
 * and this component neither calls it nor passes the element anywhere it could
 * be called from. The room is also created without a recording configuration,
 * so the method has nothing to act on — but the guarantee people rely on is
 * that the product does not ask, and `media.test.ts` greps this directory to
 * keep it that way (spec §32).
 */

/**
 * The subset of the element this component uses, for the ref.
 *
 * Deliberately narrow. `startRecording`, `stopRecording`, `startStreaming` and
 * `startLiveTranscription` all exist on the real element — the SDK's own types
 * declare them — and are absent here, so a future edit reaching for one has to
 * widen this type first, and explain why in the diff.
 *
 * The element's JSX attributes are declared by the SDK, which is why there is
 * no `declare module "react"` block: a second declaration collides with it.
 * Those attribute types carry no `className` or `style`, so the element is
 * sized from its wrapper below rather than directly.
 */
interface WherebyEmbedElement extends HTMLElement {
  toggleCamera(enabled?: boolean): void;
  toggleMicrophone(enabled?: boolean): void;
}

export interface WherebyStageHandle {
  toggleMic(enabled: boolean): void;
  toggleCamera(enabled: boolean): void;
}

export interface WherebyStageProps {
  /** The room URL minted for this participant. Never logged, never shared. */
  roomUrl: string;
  kind: "VIDEO" | "AUDIO";
  /** Mirrors the participant's mic and camera state back to the controls. */
  onDeviceState: (state: { mic?: boolean; camera?: boolean }) => void;
  /**
   * Raised if Whereby ever reports that recording has started.
   *
   * Not a hook for a feature. The room is created with no recording
   * configuration and nothing in Neem asks for one, but recording can also be
   * turned on from the Whereby dashboard — outside this repository, and
   * invisible to it (see `security.md` §10). This is what makes that visible
   * to the two people in the room rather than to nobody.
   */
  onRecordingDetected: () => void;
  onConnectionUnstable: (unstable: boolean) => void;
  handleRef: (handle: WherebyStageHandle | null) => void;
}

export function WherebyStage({
  roomUrl,
  kind,
  onDeviceState,
  onRecordingDetected,
  onConnectionUnstable,
  handleRef,
}: WherebyStageProps) {
  const ref = useRef<WherebyEmbedElement | null>(null);
  const [ready, setReady] = useState(false);
  const [registered, setRegistered] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void import("@whereby.com/browser-sdk/embed").then(() => {
      if (!cancelled) setRegistered(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Nothing to bind to until the module has loaded and the element exists.
    const element = registered ? ref.current : null;
    if (!element) return;

    const onReady = () => setReady(true);

    const onMic = (event: Event) => {
      onDeviceState({ mic: (event as CustomEvent<{ enabled: boolean }>).detail?.enabled });
    };
    const onCamera = (event: Event) => {
      onDeviceState({ camera: (event as CustomEvent<{ enabled: boolean }>).detail?.enabled });
    };

    const onConnection = (event: Event) => {
      const status = (event as CustomEvent<{ status: string }>).detail?.status;
      onConnectionUnstable(status === "unstable");
    };

    /**
     * Any status other than "not recording" is treated as recording.
     *
     * The safe direction: a false alarm shows a banner that is wrong, and a
     * missed one lets a consultation be recorded while both parties are told
     * it cannot be.
     */
    const onRecording = (event: Event) => {
      const status = (event as CustomEvent<{ status: string }>).detail?.status;
      if (status && status !== "none" && status !== "not-recording") onRecordingDetected();
    };

    element.addEventListener("ready", onReady);
    element.addEventListener("microphone_toggle", onMic);
    element.addEventListener("camera_toggle", onCamera);
    element.addEventListener("connection_status_change", onConnection);
    element.addEventListener("recording_status_change", onRecording);

    handleRef({
      toggleMic: (enabled) => element.toggleMicrophone(enabled),
      toggleCamera: (enabled) => element.toggleCamera(enabled),
    });

    return () => {
      element.removeEventListener("ready", onReady);
      element.removeEventListener("microphone_toggle", onMic);
      element.removeEventListener("camera_toggle", onCamera);
      element.removeEventListener("connection_status_change", onConnection);
      element.removeEventListener("recording_status_change", onRecording);
      handleRef(null);
    };
  }, [registered, onDeviceState, onRecordingDetected, onConnectionUnstable, handleRef]);

  return (
    // The element takes no className of its own, so it is sized from here.
    <div className="absolute inset-0 [&>whereby-embed]:block [&>whereby-embed]:size-full">
      {!ready && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-slate-900 text-sm text-white/70">
          Connecting…
        </div>
      )}

      {registered && (
        <whereby-embed
          ref={ref as React.Ref<HTMLElement>}
          room={roomUrl}
          /**
           * Off, all of it.
           *
           * `chat` is not a preference: in-consultation text chat was cut in D15
           * because there is no retention rule for message content, and a chat
           * panel inside the video would be exactly the thing that decision
           * ruled out. `screenshare` and `breakout` have no place in a two-person
           * consultation, and `people` lists participants Neem already knows.
           *
           * These repeat what the room URL already asks for. Belt and braces: the
           * URL is authoritative because the server mints it, and the attributes
           * hold if a parameter is ever renamed.
           */
          chat="off"
          people="off"
          screenshare="off"
          breakout="off"
          leaveButton="off"
          minimal="on"
          // The patient chose audio; the camera stays off rather than being
          // something they have to notice and turn off in a pharmacy.
          {...(kind === "AUDIO" ? { video: "off" } : {})}
        />
      )}
    </div>
  );
}
