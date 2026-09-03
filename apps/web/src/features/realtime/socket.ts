import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL } from "@/lib/api-client";

/**
 * The realtime client (spec §57, Phase 4's carried-forward gap).
 *
 * The server has emitted to rooms since Phase 4 and nothing listened —
 * `socket.io-client` was a declared dependency with no import, so every screen
 * polled instead. Polling is adequate for a counter workflow measured in
 * minutes and wrong for a 90-second offer window, which is what this fixes.
 *
 * **Authentication is by cookie, not by anything the client sends.** The
 * handshake carries the session cookie and the server decides which rooms this
 * connection may join; there is deliberately no client-side `join`, so a page
 * cannot subscribe itself to another pharmacy's events.
 */

let socket: Socket | undefined;
let refCount = 0;

function connect(): Socket {
  if (socket) return socket;

  socket = io(API_BASE_URL, {
    path: "/realtime",
    // The whole authentication story: the browser sends the session cookie
    // and the server works out the rest.
    withCredentials: true,
    transports: ["websocket", "polling"],
    // Reconnects on its own. A doctor whose train goes through a tunnel must
    // come back into the offer pool without reloading the page.
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });

  return socket;
}

/**
 * Subscribes to one realtime event for as long as the component is mounted.
 *
 * The connection is shared and reference-counted: several screens listening at
 * once use one socket, and it closes when the last of them unmounts. A socket
 * per hook would open a dozen connections on a busy dashboard.
 */
export function useRealtimeEvent<T = unknown>(
  event: string,
  handler: (payload: T) => void,
  enabled = true,
): void {
  // Held in a ref so a handler that closes over changing state does not tear
  // the subscription down and rebuild it on every render.
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    if (!enabled) return;

    const active = connect();
    refCount += 1;

    const listener = (payload: T) => latest.current(payload);
    active.on(event, listener);

    return () => {
      active.off(event, listener);
      refCount -= 1;

      if (refCount === 0) {
        active.disconnect();
        socket = undefined;
      }
    };
  }, [event, enabled]);
}

/**
 * Invalidates React Query caches when the server says something changed.
 *
 * This is the bridge that lets screens drop their polling: instead of asking
 * every few seconds whether anything happened, they are told, and refetch once.
 */
export function useRealtimeInvalidation(
  event: string,
  queryKey: readonly unknown[],
  enabled = true,
): void {
  const queryClient = useQueryClient();

  useRealtimeEvent(
    event,
    () => {
      void queryClient.invalidateQueries({ queryKey });
    },
    enabled,
  );
}
