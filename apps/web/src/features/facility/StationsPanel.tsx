import { useState } from "react";
import { Monitor, Plus } from "lucide-react";
import type { StationPairing, StationSummary } from "@neem/contracts";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { inputClass } from "@/features/facility/form";
import {
  useClearStation,
  useCreateStation,
  useRepairStation,
  useRevokeStation,
  useSetVideoQuality,
  useStations,
  useVideoQuality,
  linkLabel,
} from "@/features/facility/stations";
import { sinceLabel } from "@/features/operations/api";

/**
 * The facility's consultation stations (slice 1d, D77): add one, pair it,
 * see whether it is on, and take a patient off it.
 */
export function StationsPanel({ enabled }: { enabled: boolean }) {
  const stations = useStations(enabled);
  const create = useCreateStation();
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState<StationPairing | null>(null);

  return (
    <div className="card-soft space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-bold">
            <Monitor className="size-4 text-brand" /> Consultation stations
          </p>
          <p className="text-xs text-slate-500">
            The tablet or screen patients speak to the doctor on.
          </p>
        </div>
        {!adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Plus className="size-4" /> Add station
          </button>
        ) : null}
      </div>

      {adding ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(label, {
              onSuccess: (result) => {
                setPairing(result);
                setAdding(false);
                setLabel("");
              },
            });
          }}
        >
          <input
            autoFocus
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Name, e.g. Consulting room tablet"
            className={inputClass}
          />
          <button
            type="submit"
            disabled={label.trim().length < 2 || create.isPending}
            className="shrink-0 rounded-lg bg-brand px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            Add
          </button>
        </form>
      ) : null}
      {create.error ? (
        <p className="text-sm text-red-600">
          {create.error instanceof ApiError ? create.error.message : "Not added."}
        </p>
      ) : null}

      {pairing ? <PairingCode pairing={pairing} onDone={() => setPairing(null)} /> : null}

      {stations.data && stations.data.length === 0 && !adding ? (
        <p className="text-sm text-slate-500">No stations yet.</p>
      ) : null}

      <ul className="divide-y divide-border">
        {stations.data?.map((station) => (
          <StationRow key={station.publicId} station={station} onPairing={setPairing} />
        ))}
      </ul>

      {stations.data && stations.data.length > 0 ? <VideoQualityChoice enabled={enabled} /> : null}
    </div>
  );
}

/**
 * Lower video quality for every call from this facility (D89). The CHO's
 * choice, from what they see of their own line; Neem never turns it on.
 */
function VideoQualityChoice({ enabled }: { enabled: boolean }) {
  const quality = useVideoQuality(enabled);
  const set = useSetVideoQuality();
  if (!quality.data) return null;
  const on = quality.data.lowData;

  return (
    <div className="space-y-1 border-t border-border pt-3 text-sm">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={on}
          disabled={set.isPending}
          onChange={(event) => set.mutate(event.target.checked)}
          className="mt-0.5 size-4 accent-[var(--color-brand)]"
        />
        <span>
          <span className="font-semibold">Lower video quality for calls from here</span>
          <span className="block text-xs text-slate-500">
            Uses less data on a slow or costly connection; the picture is less sharp for the patient
            and the doctor. Applies from the next call. Audio only uses less still.
          </span>
        </span>
      </label>
      {set.error ? (
        <p className="text-xs text-red-600">
          {set.error instanceof ApiError ? set.error.message : "Not changed."}
        </p>
      ) : null}
    </div>
  );
}

function StationRow({
  station,
  onPairing,
}: {
  station: StationSummary;
  onPairing: (pairing: StationPairing) => void;
}) {
  const repair = useRepairStation();
  const revoke = useRevokeStation();
  const clear = useClearStation();
  const error = repair.error ?? revoke.error ?? clear.error;

  return (
    <li className="space-y-2 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold">{station.label}</p>
          <p className="text-xs text-slate-500">
            {station.current
              ? `Showing ${station.current.patientName}`
              : station.status === "PAIRED"
                ? "Showing the welcome screen"
                : station.status === "REVOKED"
                  ? "Revoked"
                  : "Waiting to be paired"}
          </p>
          {station.status === "PAIRED" ? (
            <p className="text-xs text-slate-500">
              {station.link
                ? `Line to Neem ${linkLabel(station.link)}, measured ${sinceLabel(station.link.measuredAt).toLowerCase()}`
                : "Line to Neem not measured yet"}
              {station.device?.batteryPercent !== null &&
              station.device?.batteryPercent !== undefined
                ? ` · battery ${station.device.batteryPercent}%`
                : ""}
              {station.device && (!station.device.hasCamera || !station.device.hasMicrophone)
                ? " · camera or microphone missing"
                : ""}
            </p>
          ) : null}
        </div>
        <Chip
          tone={station.status !== "PAIRED" ? "muted" : station.online ? "brand" : "warning"}
          pulse={station.status === "PAIRED" && station.online}
        >
          {station.status !== "PAIRED"
            ? station.status === "REVOKED"
              ? "Revoked"
              : "Not paired"
            : station.online
              ? "On"
              : "Not seen in the last minute"}
        </Chip>
      </div>
      <div className="flex flex-wrap gap-2">
        {station.current ? (
          <button
            type="button"
            disabled={clear.isPending}
            onClick={() => clear.mutate(station.publicId)}
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            Clear screen
          </button>
        ) : null}
        <button
          type="button"
          disabled={repair.isPending}
          onClick={() => repair.mutate(station.publicId, { onSuccess: onPairing })}
          className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          {station.status === "PAIRED" ? "Pair again" : "New pairing code"}
        </button>
        {station.status !== "REVOKED" ? (
          <button
            type="button"
            disabled={revoke.isPending}
            onClick={() => {
              if (window.confirm(`Revoke ${station.label}? It will stop working at once.`)) {
                revoke.mutate(station.publicId);
              }
            }}
            className="rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
          >
            Revoke
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-red-600">
          {error instanceof ApiError ? error.message : "Not changed."}
        </p>
      ) : null}
    </li>
  );
}

function PairingCode({ pairing, onDone }: { pairing: StationPairing; onDone: () => void }) {
  return (
    <div className="space-y-2 rounded-xl border border-brand/30 bg-brand-soft p-4 text-center">
      <p className="text-sm font-semibold">Pairing code for {pairing.station.label}</p>
      <p className="font-mono text-3xl font-bold tracking-[0.25em]">{pairing.pairingCode}</p>
      <p className="text-xs text-slate-600">
        On the station, open <span className="font-mono">{window.location.origin}/station</span> and
        type this code. It works once, until{" "}
        {new Date(pairing.pairingExpiresAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
        .
      </p>
      <button
        type="button"
        onClick={onDone}
        className="text-xs font-semibold text-slate-600 hover:underline"
      >
        Done
      </button>
    </div>
  );
}
