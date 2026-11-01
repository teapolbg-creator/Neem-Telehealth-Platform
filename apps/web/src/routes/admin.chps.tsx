import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  UTILISATION_PERIODS,
  type ChpsFacilityLive,
  type ChpsOperationsOverview,
} from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { CONNECTIVITY_LABEL, EQUIPMENT_LABEL } from "@/features/facility/api";
import { Section, Tile } from "@/features/facility/ReportView";
import { sinceLabel, useChpsOperations } from "@/features/operations/api";

export const Route = createFileRoute("/admin/chps")({
  component: ChpsOperations,
});

const PERIOD_LABEL: Record<number, string> = { 1: "Today", 7: "7 days", 30: "30 days" };

/**
 * Neem operations' live view of CHPS (slice 3c, D86): every compound as it
 * stands now, and what each doctor has done across all three channels.
 * Nothing is marked late by a threshold of Neem's own; what needs looking at
 * sorts to the top.
 */
function ChpsOperations() {
  const [days, setDays] = useState<number>(1);
  const overview = useChpsOperations(days);

  return (
    <AppShell active="admin">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
          <h1 className="text-3xl font-bold tracking-tight">CHPS operations</h1>
          <p className="mt-2 text-sm text-slate-500">
            {overview.data
              ? `As of ${new Date(overview.data.generatedAt).toLocaleTimeString()}, refreshed every 30 seconds.`
              : "Every CHPS compound as it stands now."}
          </p>
        </div>
      </header>

      {overview.isLoading ? (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      ) : null}
      {overview.error ? (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {overview.error instanceof ApiError
              ? overview.error.message
              : "The overview could not be loaded."}
          </p>
        </div>
      ) : null}
      {overview.data ? <Overview data={overview.data} days={days} setDays={setDays} /> : null}
    </AppShell>
  );
}

function Overview({
  data,
  days,
  setDays,
}: {
  data: ChpsOperationsOverview;
  days: number;
  setDays: (days: number) => void;
}) {
  const { totals } = data;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile
          label="Facilities active"
          value={`${totals.activeFacilities} / ${totals.facilities}`}
        />
        <Tile
          label="Stations online"
          value={`${totals.stationsOnline} / ${totals.stationsPaired}`}
        />
        <Tile label="Visits today" value={totals.visitsToday} />
        <Tile label="Open emergencies" value={totals.openEmergencies} />
        <Tile label="Waiting for a doctor" value={totals.waitingForDoctor} />
        <Tile
          label="Doctors online"
          value={totals.doctorsOnline}
          note={`${totals.withDoctor} with a CHPS patient`}
        />
      </div>

      <Section title="Facilities">
        {data.facilities.length === 0 ? (
          <p className="text-sm text-slate-500">No CHPS compound is registered yet.</p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-semibold">Facility</th>
                  <th className="px-3 py-2 text-right font-semibold">Emergencies</th>
                  <th className="px-3 py-2 text-right font-semibold">Waiting</th>
                  <th className="px-3 py-2 text-right font-semibold">Longest wait</th>
                  <th className="px-3 py-2 text-right font-semibold">With doctor</th>
                  <th className="px-3 py-2 text-right font-semibold">To triage</th>
                  <th className="px-3 py-2 text-right font-semibold">Visits today</th>
                  <th className="px-3 py-2 font-semibold">Stations</th>
                  <th className="px-3 py-2 font-semibold">Staff last active</th>
                  <th className="px-3 py-2 font-semibold">Set-up</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.facilities.map((facility) => (
                  <FacilityRow key={facility.publicId} facility={facility} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Doctors">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-500">
            Online now, and anyone who completed a consultation in the period, on every channel.
          </p>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm font-semibold">
            {UTILISATION_PERIODS.map((value) => (
              <button
                key={value}
                type="button"
                data-on={days === value}
                onClick={() => setDays(value)}
                className="rounded-md px-3 py-1.5 text-slate-600 data-[on=true]:bg-white data-[on=true]:text-brand data-[on=true]:shadow-sm"
              >
                {PERIOD_LABEL[value]}
              </button>
            ))}
          </div>
        </div>
        {data.doctors.length === 0 ? (
          <p className="text-sm text-slate-500">
            No doctor is online, and none completed a consultation in this period.
          </p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-semibold">Doctor</th>
                  <th className="px-3 py-2 font-semibold">Now</th>
                  <th className="px-3 py-2 text-right font-semibold">CHPS</th>
                  <th className="px-3 py-2 text-right font-semibold">Pharmacy</th>
                  <th className="px-3 py-2 text-right font-semibold">Direct</th>
                  <th className="px-3 py-2 text-right font-semibold">Minutes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.doctors.map((doctor) => (
                  <tr key={doctor.publicId}>
                    <td className="px-5 py-2 font-semibold">{doctor.name}</td>
                    <td className="px-3 py-2">
                      {doctor.online ? (
                        <Chip tone="brand">
                          Online · {doctor.currentLoad} of {doctor.maxLoad}
                        </Chip>
                      ) : (
                        <Chip tone="muted">Offline</Chip>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{doctor.completed.CHPS}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {doctor.completed.COUNTER}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{doctor.completed.DIRECT}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {doctor.consultationMinutes}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

function FacilityRow({ facility }: { facility: ChpsFacilityLive }) {
  const { stations } = facility;
  return (
    <tr className={facility.status === "ACTIVE" ? "" : "text-slate-400"}>
      <td className="px-5 py-2">
        <Link
          to="/admin/facilities/$publicId"
          params={{ publicId: facility.publicId }}
          className="font-semibold hover:text-brand hover:underline"
        >
          {facility.name}
        </Link>
        <p className="text-xs text-slate-500">
          {facility.district}, {facility.region}
          {facility.status === "ACTIVE" ? "" : " · inactive"}
        </p>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {facility.openEmergencies > 0 ? <Chip tone="danger">{facility.openEmergencies}</Chip> : 0}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{facility.waitingForDoctor}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {facility.longestWaitMinutes === null ? "—" : `${facility.longestWaitMinutes} min`}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{facility.withDoctor}</td>
      <td className="px-3 py-2 text-right tabular-nums">{facility.awaitingTriage}</td>
      <td className="px-3 py-2 text-right tabular-nums">{facility.visitsToday}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        {stations.paired === 0 ? (
          <span className="text-slate-400">None paired</span>
        ) : (
          <>
            <span className="tabular-nums">
              {stations.online} of {stations.paired} online
            </span>
            {stations.online < stations.paired ? (
              <span className="block text-xs text-slate-500">
                seen {sinceLabel(stations.lastSeenAt).toLowerCase()}
              </span>
            ) : null}
          </>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">{sinceLabel(facility.staffLastActiveAt)}</td>
      <td className="px-3 py-2 text-xs text-slate-500">
        {EQUIPMENT_LABEL[facility.equipmentStatus]} ·{" "}
        {CONNECTIVITY_LABEL[facility.connectivityStatus]}
      </td>
    </tr>
  );
}
