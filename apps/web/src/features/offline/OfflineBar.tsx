import { Link, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { CloudOff, Loader2, RefreshCw } from "lucide-react";
import { syncNow, useOfflineQueue } from "./queue";

/**
 * The connection and the offline queue, on every facility screen (D88).
 * Silent while online with nothing waiting.
 */
export function OfflineBar({ userId }: { userId: string }) {
  const offline = useOfflineQueue(userId);

  /*
   * Each screen's code is fetched the first time it is opened, which cannot
   * happen with no connection: saving a walk-in moved to a page that could not
   * load, and the CHO was left looking at a blank screen. So every facility
   * screen is fetched while the line is up.
   */
  const router = useRouter();
  useEffect(() => {
    const screens = [
      { to: "/facility" },
      { to: "/facility/register" },
      { to: "/facility/offline" },
      { to: "/facility/referrals" },
      { to: "/facility/reports" },
      { to: "/facility/patients/$patientNumber", params: { patientNumber: "preload" } },
    ] as const;
    for (const screen of screens) void router.preloadRoute(screen).catch(() => undefined);
  }, [router]);

  const queued = offline.entries.filter((entry) => entry.state === "QUEUED").length;
  const needsYou = offline.entries.length - queued;
  const waiting = offline.entries.length + offline.locked;

  if (offline.reachable && waiting === 0 && offline.othersWaiting === 0) return null;

  const tone = offline.reachable
    ? "bg-brand-soft border-brand/20 text-slate-700"
    : "bg-warning-soft border-warning/30 text-slate-800";

  return (
    <div className={`border-b px-4 py-2.5 text-sm sm:px-6 ${tone}`} role="status">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1">
        {offline.reachable ? (
          offline.syncing ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-brand" />
          ) : (
            <RefreshCw className="size-4 shrink-0 text-brand" />
          )
        ) : (
          <CloudOff className="size-4 shrink-0 text-warning" />
        )}
        <span className="font-semibold">
          {offline.reachable
            ? offline.syncing
              ? "Sending walk-ins recorded offline…"
              : "Connected"
            : "No connection to Neem"}
        </span>
        <span>
          {!offline.reachable
            ? offline.canSave
              ? "New walk-ins are saved on this device, encrypted, and sent when the connection returns. Doctors cannot be requested."
              : "Walk-ins cannot be saved on this device until it has connected once since sign-in. Record on paper."
            : offline.signedOut
              ? "Sign in again to send what is waiting."
              : null}
        </span>
        {waiting > 0 ? (
          <Link to="/facility/offline" className="ml-auto font-semibold text-brand hover:underline">
            {queued > 0 ? `${queued} waiting to send` : null}
            {queued > 0 && needsYou > 0 ? " · " : null}
            {needsYou > 0 ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : null}
            {offline.locked > 0 ? `${offline.locked} locked until connected` : null}
          </Link>
        ) : null}
        {offline.reachable && queued > 0 && !offline.syncing ? (
          <button
            type="button"
            onClick={() => void syncNow()}
            className="font-semibold text-brand hover:underline"
          >
            Send now
          </button>
        ) : null}
        {offline.othersWaiting > 0 ? (
          <span className="text-xs text-slate-500">
            {offline.othersWaiting} saved here by another account; they send when that person signs
            in.
          </span>
        ) : null}
      </div>
    </div>
  );
}
