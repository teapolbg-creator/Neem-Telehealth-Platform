import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  MapPin,
  Search,
  Stethoscope,
  Timer,
  UserPlus,
  Users,
} from "lucide-react";
import {
  CHPS_CONSULTATION_PROGRESS,
  FACILITY_TYPE_LABELS,
  VISIT_STATUS_LABELS,
} from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { useSession } from "@/features/auth/use-session";
import {
  CONNECTIVITY_LABEL,
  EQUIPMENT_LABEL,
  STATUS_LABEL,
  useOwnFacility,
} from "@/features/facility/api";
import {
  SEX_LABEL,
  VISIT_STATUS_TONE,
  ageLabel,
  consultationTone,
  useFacilityDay,
} from "@/features/facility/patients";
import { TriageBadge } from "@/features/facility/TriageBadge";
import { StationsPanel } from "@/features/facility/StationsPanel";

export const Route = createFileRoute("/facility/")({
  component: FacilityHome,
});

/**
 * The CHPS facility's day (slices 1a and 1b, D73, D75).
 *
 * Who has come in, who is waiting, who went down the emergency path. The
 * board shows open visits from any day plus everything that arrived today,
 * so a patient still waiting from yesterday is never dropped off it.
 */
function FacilityHome() {
  const { user } = useSession();
  const isStaff = user?.role === "FACILITY";
  const facility = useOwnFacility(isStaff);
  const day = useFacilityDay(isStaff);
  const active = facility.data?.status === "ACTIVE";

  return (
    <AppShell active="facility">
      <div className="mx-auto w-full max-w-6xl">
        {facility.isLoading ? (
          <div className="card-soft grid place-items-center p-16">
            <Loader2 className="size-6 animate-spin text-brand" />
          </div>
        ) : null}

        {facility.error ? (
          <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-700">
              {facility.error instanceof ApiError
                ? facility.error.message
                : "Your facility could not be loaded."}
            </p>
          </div>
        ) : null}

        {facility.data ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-brand">
                  {FACILITY_TYPE_LABELS[facility.data.type]}
                </p>
                <h1 className="mt-1 text-3xl font-bold">{facility.data.name}</h1>
                <p className="mt-1 text-sm text-slate-500">
                  {new Date().toLocaleDateString(undefined, {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                  })}
                </p>
              </div>
              {active ? (
                <div className="flex flex-wrap gap-2">
                  <Link
                    to="/facility/register"
                    className="inline-flex items-center gap-2 rounded-xl border border-border bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <Search className="size-4" /> Find a patient
                  </Link>
                  <Link
                    to="/facility/register"
                    search={{ new: true }}
                    className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-semibold text-white hover:brightness-110"
                  >
                    <UserPlus className="size-4" /> Register walk-in
                  </Link>
                </div>
              ) : (
                <Chip tone="muted">{STATUS_LABEL[facility.data.status]}</Chip>
              )}
            </div>

            {!active ? (
              <div className="card-soft mt-6 border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
                Neem has not switched this facility on yet, so new patients cannot be registered
                here. Care for patients through your usual CHPS and referral arrangements. Your
                district or Neem will tell you when it is ready.
              </div>
            ) : null}

            {day.data ? (
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Stat icon={Users} label="Seen today" value={day.data.seenToday} />
                <Stat icon={Clock} label="Waiting now" value={day.data.waiting} />
                <Stat icon={Timer} label="Awaiting a doctor" value={day.data.awaitingDoctor} />
                <Stat icon={Stethoscope} label="With a doctor" value={day.data.withDoctor} />
                <Stat
                  icon={AlertTriangle}
                  label="Emergencies today"
                  value={day.data.escalatedToday}
                  danger={day.data.escalatedToday > 0}
                />
                <Stat icon={CheckCircle2} label="Completed today" value={day.data.closedToday} />
              </div>
            ) : null}

            <div className="card-soft mt-4 overflow-x-auto">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <p className="font-bold">Patients</p>
                {day.isFetching ? <Loader2 className="size-4 animate-spin text-slate-400" /> : null}
              </div>
              {day.data && day.data.board.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-slate-500">
                  No patients yet today.
                </p>
              ) : null}
              {day.data && day.data.board.length > 0 ? (
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead className="text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Arrived</th>
                      <th className="px-4 py-2 font-semibold">Patient</th>
                      <th className="px-4 py-2 font-semibold">Complaint</th>
                      <th className="px-4 py-2 font-semibold">Triage</th>
                      <th className="px-4 py-2 font-semibold">Status</th>
                      <th className="px-4 py-2 font-semibold">Doctor</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {day.data.board.map((row) => (
                      <tr
                        key={row.publicId}
                        className={
                          row.status === "ESCALATED" ? "bg-red-50/60" : "hover:bg-slate-50"
                        }
                      >
                        <td className="px-4 py-3 tabular-nums text-slate-600">
                          {new Date(row.arrivedAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="px-4 py-3">
                          <Link
                            to="/facility/patients/$patientNumber"
                            params={{ patientNumber: row.patient.patientNumber }}
                            className="font-semibold hover:text-brand"
                          >
                            {row.patient.fullName}
                          </Link>
                          <p className="text-xs text-slate-500">
                            {SEX_LABEL[row.patient.sex]} · {ageLabel(row.patient.dateOfBirth)} ·{" "}
                            <span className="font-mono">{row.patient.patientNumber}</span>
                          </p>
                        </td>
                        <td className="max-w-xs truncate px-4 py-3 text-slate-600">
                          {row.presentingComplaint}
                        </td>
                        <td className="px-4 py-3">
                          <TriageBadge category={row.triageCategory} />
                        </td>
                        <td className="px-4 py-3">
                          <Chip tone={VISIT_STATUS_TONE[row.status]}>
                            {VISIT_STATUS_LABELS[row.status]}
                          </Chip>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {row.consultation ? (
                            <Chip tone={consultationTone(row.consultation.state)}>
                              {CHPS_CONSULTATION_PROGRESS[row.consultation.state] ??
                                row.consultation.state}
                            </Chip>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                          {row.consultation?.doctorName ? (
                            <p className="mt-1 text-slate-500">{row.consultation.doctorName}</p>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <StationsPanel enabled={isStaff && active} />
              <div className="card-soft space-y-3 p-5 text-sm">
                <MapPin className="size-5 text-brand" />
                <p className="mt-2 font-semibold">{facility.data.location.community}</p>
                <p className="text-slate-500">
                  {facility.data.location.district.name}, {facility.data.location.region.name}
                </p>
                <p className="mt-2 text-slate-500">
                  Station: {EQUIPMENT_LABEL[facility.data.equipmentStatus]} · Internet:{" "}
                  {CONNECTIVITY_LABEL[facility.data.connectivityStatus]} (as reported)
                </p>
                <div className="border-t border-border pt-3 text-slate-600">
                  <p className="font-semibold text-foreground">Requesting a doctor</p>
                  <p className="mt-1">
                    Open a triaged patient, choose Request a doctor, then send them to a station. If
                    no doctor is on duty, care for the patient here and use your usual referral
                    arrangements.
                  </p>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  danger = false,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div className={`card-soft p-4 ${danger ? "border-red-200 bg-red-50" : ""}`}>
      <Icon className={`size-5 ${danger ? "text-red-600" : "text-brand"}`} />
      <p className="mt-2 text-3xl font-bold tabular-nums">{value}</p>
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
    </div>
  );
}
