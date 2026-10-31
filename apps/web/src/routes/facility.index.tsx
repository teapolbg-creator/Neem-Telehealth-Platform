import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, Loader2, MapPin, Users, Wifi } from "lucide-react";
import { FACILITY_TYPE_LABELS } from "@neem/contracts";
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

export const Route = createFileRoute("/facility/")({
  component: FacilityHome,
});

/**
 * The CHPS facility's own page (CHPS slice 1a, D73).
 *
 * What a CHO signs in to. For now it shows the facility as Neem has it on
 * record, so mistakes in it can be reported before patients depend on it.
 * Walk-in registration, triage and consultation requests arrive in slices 1b
 * and 1c; this page says so rather than offering buttons that do nothing.
 */
function FacilityHome() {
  const { user } = useSession();
  const facility = useOwnFacility(user?.role === "FACILITY");

  return (
    <AppShell active="facility">
      <div className="mx-auto w-full max-w-4xl">
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
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-brand">
                  {FACILITY_TYPE_LABELS[facility.data.type]}
                </p>
                <h1 className="mt-1 text-3xl font-bold">{facility.data.name}</h1>
                <p className="mt-1 font-mono text-sm text-slate-500">{facility.data.code}</p>
              </div>
              <Chip tone={facility.data.status === "ACTIVE" ? "brand" : "muted"}>
                {STATUS_LABEL[facility.data.status]}
              </Chip>
            </div>

            {facility.data.status !== "ACTIVE" ? (
              <div className="card-soft mt-6 border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
                Neem has not switched this facility on yet. Your district or Neem will tell you when
                it is ready.
              </div>
            ) : null}

            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              <div className="card-soft p-5">
                <MapPin className="size-5 text-brand" />
                <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Location
                </p>
                <p className="mt-1 font-semibold">{facility.data.location.community}</p>
                <p className="text-sm text-slate-500">
                  {facility.data.location.subDistrict
                    ? `${facility.data.location.subDistrict.name}, `
                    : ""}
                  {facility.data.location.district.name}, {facility.data.location.region.name}
                </p>
              </div>
              <div className="card-soft p-5">
                <Wifi className="size-5 text-brand" />
                <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Consultation station
                </p>
                <p className="mt-1 font-semibold">
                  {EQUIPMENT_LABEL[facility.data.equipmentStatus]}
                </p>
                <p className="text-sm text-slate-500">
                  Internet: {CONNECTIVITY_LABEL[facility.data.connectivityStatus]} (as reported)
                </p>
              </div>
              <div className="card-soft p-5">
                <Users className="size-5 text-brand" />
                <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Staff on Neem
                </p>
                <ul className="mt-1 space-y-1 text-sm">
                  {facility.data.staff.map((member) => (
                    <li key={member.userPublicId}>
                      <span className="font-semibold">{member.fullName}</span>
                      {member.title ? (
                        <span className="text-slate-500"> · {member.title}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="card-soft mt-4 p-5 text-sm text-slate-600">
              <p className="font-semibold text-foreground">Coming next</p>
              <p className="mt-1">
                Registering walk-in patients, recording vital signs and requesting a doctor will
                appear here. Until then, care for patients through your usual CHPS and referral
                arrangements. If anything above is wrong, tell your district office or Neem.
              </p>
            </div>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
