import { useEffect } from "react";
import { CONNECTION_CHECK_UP_BYTES, STATION_HEADER, type ConnectionReport } from "@neem/contracts";
import { API_BASE_URL, apiRequest } from "@/lib/api-client";

/**
 * The station measures its own line (slice 4b, D89): a round trip, a
 * download and an upload against Neem's server, reported for the CHO to see.
 *
 * Against Neem, not the video service, so it describes the line rather than
 * promising a call. Only while the station is idle, so it never takes
 * bandwidth from a patient who is about to be, or is, on a call.
 */

/** How often an idle station measures again. */
const CHECK_INTERVAL_MS = 10 * 60_000;

const url = (path: string) => `${API_BASE_URL}/api/v1${path}`;

async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await work();
  return Math.max(performance.now() - started, 1);
}

const kbps = (bytes: number, ms: number) => Math.round((bytes * 8) / ms);

export async function measureConnection(): Promise<ConnectionReport> {
  // The quickest of three small requests: the line, not a busy moment.
  const trips: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    trips.push(
      await timed(() => fetch(url("/health"), { cache: "no-store" }).then((r) => r.arrayBuffer())),
    );
  }

  let downBytes = 0;
  const downMs = await timed(async () => {
    const response = await fetch(url("/station/connection-check"), {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`connection check ${response.status}`);
    downBytes = (await response.arrayBuffer()).byteLength;
  });

  const sample = "x".repeat(CONNECTION_CHECK_UP_BYTES);
  const upMs = await timed(() =>
    apiRequest("/station/connection-check/upload", {
      method: "POST",
      body: { sample },
      headers: { [STATION_HEADER]: "1" },
    }),
  );

  return {
    rttMs: Math.round(Math.min(...trips)),
    downKbps: kbps(downBytes, downMs),
    upKbps: kbps(sample.length, upMs),
  };
}

/** Measures now and every ten minutes while `idle`; reports each result. */
export function useConnectionCheck(idle: boolean) {
  useEffect(() => {
    if (!idle) return;
    let cancelled = false;
    const run = async () => {
      try {
        const report = await measureConnection();
        if (cancelled) return;
        await apiRequest("/station/connection-check", {
          method: "POST",
          body: report,
          headers: { [STATION_HEADER]: "1" },
        });
      } catch {
        // A check that fails says the line is down, which the screen already shows.
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [idle]);
}
