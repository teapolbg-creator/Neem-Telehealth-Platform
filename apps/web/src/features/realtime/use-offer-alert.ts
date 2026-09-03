import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The alert that reaches a doctor who is not looking at the screen (spec §58).
 *
 * A 90-second window is short enough that a silent tab is the difference
 * between a patient being seen and the offer going to somebody else. Two
 * things happen: a browser notification, and a sound.
 *
 * **Nothing clinical appears in either.** A browser notification is rendered
 * by the operating system, may persist in a notification centre, and is
 * visible to anyone near the screen. It says a consultation is waiting and
 * where — never who, never why (spec §60).
 */

export type NotificationPermission_ = "default" | "granted" | "denied" | "unsupported";

export function useNotificationPermission(): {
  permission: NotificationPermission_;
  request: () => Promise<void>;
} {
  const [permission, setPermission] = useState<NotificationPermission_>(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  const request = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    // Browsers require a user gesture, which is why this is called from a
    // button rather than on mount. Asking unprompted also gets denied by
    // habit, and a denial is sticky.
    setPermission(await Notification.requestPermission());
  }, []);

  return { permission, request };
}

/**
 * A short tone, synthesised rather than shipped as a file.
 *
 * No asset to load, cache or fail to load — which matters, because the one
 * time this must work is the one time the doctor is not watching. Two notes so
 * it reads as an alert rather than a system beep.
 */
function playChime(): void {
  try {
    const AudioContextClass =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    const now = context.currentTime;

    for (const [index, frequency] of [880, 1174.7].entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.frequency.value = frequency;
      oscillator.type = "sine";

      const start = now + index * 0.18;
      // Shaped rather than switched: an abrupt gain change clicks.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.18);
    }

    // Released once the sound has finished; browsers cap concurrent contexts.
    setTimeout(() => void context.close(), 1000);
  } catch {
    // Audio is an enhancement. A browser that refuses it — autoplay policy, no
    // output device — must not take the rest of the alert down with it.
  }
}

export interface OfferAlert {
  title: string;
  body: string;
  /** Focuses the tab and navigates when the notification is clicked. */
  onClick?: () => void;
}

/**
 * Raises an alert, on every channel the browser allows.
 *
 * Returns a function rather than firing on render, so the caller decides what
 * counts as an event worth interrupting someone for.
 */
export function useOfferAlert(): (alert: OfferAlert) => void {
  // Suppresses a repeat for the same offer, which a reconnect can deliver
  // twice. Being told once is an alert; being told three times is noise.
  const lastAlertAt = useRef(0);

  return useCallback((alert: OfferAlert) => {
    const now = Date.now();
    if (now - lastAlertAt.current < 3000) return;
    lastAlertAt.current = now;

    playChime();

    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

    try {
      const notification = new Notification(alert.title, {
        body: alert.body,
        // A tag replaces an earlier notification with the same one rather than
        // stacking them, so a reconnect does not leave three in the tray.
        tag: "neem-offer",
        requireInteraction: true,
      });

      notification.onclick = () => {
        window.focus();
        alert.onClick?.();
        notification.close();
      };
    } catch {
      // Some browsers throw on construction inside a non-secure context. The
      // sound has already played, which is the part that matters.
    }
  }, []);
}

/**
 * Asks for permission once the doctor is somewhere it makes sense to ask.
 *
 * Returns whether a prompt is worth showing — permission is `default`, and the
 * browser supports it. A doctor who has denied it is not asked again; the
 * browser would not show the prompt anyway.
 */
export function useShouldPromptForNotifications(): boolean {
  const { permission } = useNotificationPermission();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(localStorage.getItem("neem.notifications.dismissed") === "1");
  }, []);

  return permission === "default" && !dismissed;
}

export function dismissNotificationPrompt(): void {
  localStorage.setItem("neem.notifications.dismissed", "1");
}
