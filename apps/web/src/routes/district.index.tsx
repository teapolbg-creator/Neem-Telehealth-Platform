import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, Loader2, MapPin } from "lucide-react";
import type { FacilitySummary } from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { CONNECTIVITY_LABEL, EQUIPMENT_LABEL, STATUS_LABEL } from "@/features/facility/api";
import { useDistrictOverview } from "@/features/staff/api";

export const Route = createFileRoute("/district/")({
  component: DistrictHome,
});

/**
 * A district health officer's page (CHPS slice 3a, D84): their area and the
 * CHPS compounds in it. Read-only. The area comes from their account on the
 * server, so nothing on this page can widen it.
 */
function DistrictHome() {
  const overview = useDistrictOverview();

  return (
    <AppShell active="district">
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
              : "Your district could not be loaded."}
          </p>
        </div>
      ) : null}

      {overview.data ? (
        <>
          <header>
            <p className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-brand">
              <MapPin className="size-4" /> {overview.data.scope.label}
            </p>
            <h1 className="text-3xl font-bold tracking-tight">CHPS facilities</h1>
            <p className="mt-2 text-sm text-slate-500">
              {overview.data.officer.fullName}
              {overview.data.officer.title ? `, ${overview.data.officer.title}` : ""}. You can see
              the CHPS compounds using Neem in your area. Nothing here can be changed.
            </p>
          </header>

          {overview.data.facilities.length === 0 ? (
            <div className="card-soft p-6 text-sm text-slate-500">
              No CHPS compound in {overview.data.scope.label} uses Neem yet.
            </div>
          ) : (
            <div className="card-soft overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Facility</th>
                    {overview.data.scope.level === "REGION" ? (
                      <th className="px-4 py-3 font-semibold">District</th>
                    ) : null}
                    <th className="px-4 py-3 font-semibold">Community</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Equipment</th>
                    <th className="px-4 py-3 font-semibold">Connectivity</th>
                    <th className="px-4 py-3 text-right font-semibold">Staff</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {overview.data.facilities.map((facility) => (
                    <FacilityRow
                      key={facility.publicId}
                      facility={facility}
                      showDistrict={overview.data.scope.level === "REGION"}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </AppShell>
  );
}

function FacilityRow({
  facility,
  showDistrict,
}: {
  facility: FacilitySummary;
  showDistrict: boolean;
}) {
  return (
    <tr>
      <td className="px-4 py-3">
        <p className="font-semibold">{facility.name}</p>
        <p className="text-xs text-slate-500">{facility.code}</p>
      </td>
      {showDistrict ? <td className="px-4 py-3">{facility.location.district.name}</td> : null}
      <td className="px-4 py-3">{facility.location.community}</td>
      <td className="px-4 py-3">
        <Chip tone={facility.status === "ACTIVE" ? "brand" : "muted"}>
          {STATUS_LABEL[facility.status]}
        </Chip>
      </td>
      <td className="px-4 py-3">{EQUIPMENT_LABEL[facility.equipmentStatus]}</td>
      <td className="px-4 py-3">{CONNECTIVITY_LABEL[facility.connectivityStatus]}</td>
      <td className="px-4 py-3 text-right tabular-nums">{facility.staffCount}</td>
    </tr>
  );
}
