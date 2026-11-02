import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { MONITORING_WINDOWS, type SystemMonitoring } from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { useSystemHealth } from "@/features/analytics/api";
import { Section } from "@/features/facility/ReportView";
import { linkLabel } from "@/features/facility/stations";
import { sinceLabel, useSystemMonitoring } from "@/features/operations/api";

export const Route = createFileRoute("/admin/monitoring")({
  component: Monitoring,
});

const WINDOW_LABEL: Record<number, string> = { 24: "Last 24 hours", 168: "Last 7 days" };

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Super admin",
  OPS_ADMIN: "Operations",
  DOCTOR: "Doctors",
  PHARMACY: "Pharmacies",
  FACILITY: "CHPS staff",
  DISTRICT: "District officers",
};

const CHANNEL_LABEL: Record<string, string> = {
  EMAIL: "Email",
  SMS: "SMS",
  WHATSAPP: "WhatsApp",
  IN_APP: "In app",
  BROWSER: "Browser",
  PUSH: "Push",
};

/**
 * System monitoring (slice 3d, D87): what the system has already recorded,
 * counted, beside its configuration. Nothing here raises an alarm by itself;
 * a number that should be zero and is not is for operations to judge.
 */
function Monitoring() {
  const [hours, setHours] = useState<number>(24);
  const monitoring = useSystemMonitoring(hours);
  const health = useSystemHealth();

  return (
    <AppShell active="admin">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
          <h1 className="text-3xl font-bold tracking-tight">Monitoring</h1>
          <p className="mt-2 text-sm text-slate-500">
            {monitoring.data
              ? `As of ${new Date(monitoring.data.generatedAt).toLocaleTimeString()}, refreshed every minute.`
              : "Counted from what the system records."}
          </p>
        </div>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm font-semibold">
          {MONITORING_WINDOWS.map((value) => (
            <button
              key={value}
              type="button"
              data-on={hours === value}
              onClick={() => setHours(value)}
              className="rounded-md px-3 py-1.5 text-slate-600 data-[on=true]:bg-white data-[on=true]:text-brand data-[on=true]:shadow-sm"
            >
              {WINDOW_LABEL[value]}
            </button>
          ))}
        </div>
      </header>

      {health.data ? (
        <Section title="System">
          <Rows
            rows={[
              [
                "Database",
                health.data.database.status === "up"
                  ? `Up · ${health.data.database.latencyMs ?? "?"} ms`
                  : "Down",
              ],
              ["Environment", health.data.environment],
              ...Object.entries(health.data.providers).map(
                ([name, provider]) =>
                  [
                    name[0]!.toUpperCase() + name.slice(1),
                    health.data!.mockedProviders.includes(name) ? `${provider} (mocked)` : provider,
                  ] as [string, string],
              ),
            ]}
          />
        </Section>
      ) : null}

      {monitoring.isLoading ? (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      ) : null}
      {monitoring.error ? (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {monitoring.error instanceof ApiError
              ? monitoring.error.message
              : "Monitoring could not be loaded."}
          </p>
        </div>
      ) : null}
      {monitoring.data ? <Figures data={monitoring.data} /> : null}
    </AppShell>
  );
}

function Figures({ data }: { data: SystemMonitoring }) {
  const window = WINDOW_LABEL[data.windowHours]?.toLowerCase() ?? `last ${data.windowHours} h`;
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Now">
          <Rows
            rows={[
              ["Staff signed in", data.sessions.active],
              ...Object.entries(data.sessions.byRole).map(
                ([role, count]) => [`· ${ROLE_LABEL[role] ?? role}`, count] as [string, number],
              ),
              ["Doctors online", data.doctors.online],
              ["Declared online, heartbeat stale", data.doctors.staleHeartbeat],
              ["Stations online", `${data.stations.online} of ${data.stations.paired} paired`],
              ["Video rooms open", data.activeVideoSessions],
            ]}
          />
        </Section>

        <Section title={`Calls and messages, ${window}`}>
          <Rows
            rows={[
              ["Rooms opened", data.calls.roomsOpened],
              ["Calls interrupted", data.calls.interruptions],
              ["Rooms replaced", data.calls.roomsReplaced],
              ["Notifications failed", data.notifications.failed],
              ...Object.entries(data.notifications.byChannel).map(
                ([channel, count]) =>
                  [`· ${CHANNEL_LABEL[channel] ?? channel}`, count] as [string, number],
              ),
              ["Provider webhooks", data.webhooks.received],
              ["Webhooks with a bad signature", data.webhooks.invalidSignatures],
            ]}
          />
        </Section>
      </div>

      <Section title={`Security, ${window}`}>
        <Rows
          rows={[
            ["Failed sign-ins", data.security.loginFailures],
            ["Accounts locked", data.security.lockouts],
            ["Wrong 2FA codes", data.security.twoFactorFailures],
            ["Station pairings refused", data.security.pairingRefusals],
          ]}
        />
        {data.security.recent === null ? (
          <p className="mt-3 text-xs text-slate-500">
            The events themselves come from the audit log, which only the super administrator reads.
          </p>
        ) : data.security.recent.length > 0 ? (
          <div className="-mx-5 mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-slate-500">
                <tr>
                  <th className="px-5 py-2 font-semibold">When</th>
                  <th className="px-3 py-2 font-semibold">What</th>
                  <th className="px-3 py-2 font-semibold">Account</th>
                  <th className="px-3 py-2 font-semibold">Recorded reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.security.recent.map((event, index) => (
                  <tr key={`${event.occurredAt}-${index}`}>
                    <td className="px-5 py-2 whitespace-nowrap tabular-nums">
                      {new Date(event.occurredAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">{event.label}</td>
                    <td className="px-3 py-2">
                      {event.account
                        ? `${event.account.email} (${ROLE_LABEL[event.account.role] ?? event.account.role})`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-slate-500">
                      {event.reason?.replace(/_/g, " ") ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Section>

      <Section title="Station devices">
        {data.stations.all.length === 0 ? (
          <p className="text-sm text-slate-500">No station is paired.</p>
        ) : (
          <>
            <div className="-mx-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-5 py-2 font-semibold">Station</th>
                    <th className="px-3 py-2 font-semibold">Line to Neem</th>
                    <th className="px-3 py-2 font-semibold">Battery</th>
                    <th className="px-3 py-2 font-semibold">Camera and mic</th>
                    <th className="px-3 py-2 font-semibold">Browser</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.stations.all.map((station) => (
                    <tr key={station.publicId}>
                      <td className="px-5 py-2">
                        <span className="font-semibold">{station.facilityName}</span> ·{" "}
                        {station.label}
                        <span className="block text-xs text-slate-500">
                          {station.online
                            ? "On"
                            : `Seen ${sinceLabel(station.lastSeenAt).toLowerCase()}`}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {station.link ? linkLabel(station.link) : "Not measured"}
                      </td>
                      <td className="px-3 py-2">
                        {station.device?.batteryPercent === null || !station.device
                          ? "Not reported"
                          : `${station.device.batteryPercent}%${station.device.charging ? ", charging" : ""}`}
                      </td>
                      <td className="px-3 py-2">
                        {!station.device
                          ? "Not reported"
                          : `Camera ${station.device.hasCamera ? "found" : "missing"}, mic ${station.device.hasMicrophone ? "found" : "missing"}`}
                      </td>
                      <td className="px-3 py-2">{station.device?.browser ?? "Not reported"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              As each station last reported while idle, every ten minutes.
            </p>
          </>
        )}
      </Section>

      <Section title="Stations not seen in the last minute">
        {data.stations.offline.length === 0 ? (
          <p className="text-sm text-slate-500">
            {data.stations.paired === 0
              ? "No station is paired."
              : "Every paired station is online."}
          </p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {data.stations.offline.map((station) => (
              <li key={station.publicId} className="flex justify-between gap-4 py-1.5">
                <span>
                  <Link
                    to="/admin/facilities/$publicId"
                    params={{ publicId: station.facilityPublicId }}
                    className="font-semibold hover:text-brand hover:underline"
                  >
                    {station.facilityName}
                  </Link>{" "}
                  · {station.label}
                </span>
                <Chip tone="muted">Seen {sinceLabel(station.lastSeenAt).toLowerCase()}</Chip>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function Rows({ rows }: { rows: [string, string | number][] }) {
  return (
    <dl className="divide-y divide-border text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 py-1.5">
          <dt className={label.startsWith("·") ? "pl-3 text-slate-500" : "text-slate-600"}>
            {label.replace(/^· /, "")}
          </dt>
          <dd className="font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
