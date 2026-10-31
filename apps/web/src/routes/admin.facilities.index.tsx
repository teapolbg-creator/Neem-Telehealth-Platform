import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Building2, Loader2, Plus, Search, X } from "lucide-react";
import { Field, LocationFields } from "@/features/facility/LocationFields";
import {
  FACILITY_STATUSES,
  FACILITY_TYPES,
  FACILITY_TYPE_LABELS,
  type FacilityStatus,
  type FacilityType,
} from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  CONNECTIVITY_LABEL,
  EQUIPMENT_LABEL,
  FACILITY_PAGE_SIZE,
  STATUS_LABEL,
  useCreateFacility,
  useFacilities,
  useGeography,
} from "@/features/facility/api";
import { EMPTY_LOCATION, inputClass, type LocationValue } from "@/features/facility/form";

export const Route = createFileRoute("/admin/facilities/")({
  component: AdminFacilities,
});

/**
 * The facility registry (CHPS slice 1a, D73).
 *
 * CHPS compounds that use Neem, and the health centres and hospitals their
 * patients may be referred to, in one list. A facility is registered here by
 * Neem; there is no application for it to make.
 */
function AdminFacilities() {
  const [registering, setRegistering] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<FacilityStatus | "">("");
  const [type, setType] = useState<FacilityType | "">("");
  const [regionId, setRegionId] = useState("");
  const [districtId, setDistrictId] = useState("");

  const geography = useGeography();
  const facilities = useFacilities({
    search: search.trim() || undefined,
    status: status || undefined,
    type: type || undefined,
    regionId: regionId || undefined,
    districtId: districtId || undefined,
  });

  const region = geography.data?.find((entry) => entry.id === regionId);

  return (
    <AppShell active="admin">
      <div className="mx-auto w-full max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-brand">
              Neem Administration
            </p>
            <h1 className="mt-1 text-3xl font-bold">Facilities</h1>
            <p className="mt-2 max-w-2xl text-pretty text-sm leading-relaxed text-slate-500">
              CHPS compounds that use Neem, and the facilities their patients may be referred to. A
              new facility starts inactive; switch it on once its consultation station is in place.
            </p>
          </div>
          {!registering ? (
            <button
              type="button"
              onClick={() => setRegistering(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110"
            >
              <Plus className="size-4" /> Register facility
            </button>
          ) : null}
        </div>

        {registering && geography.data ? (
          <RegisterFacility onClose={() => setRegistering(false)} />
        ) : null}

        <div className="card-soft mt-6 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
          <label className="relative text-sm lg:col-span-2">
            <span className="sr-only">Search</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, code or community"
              className={`${inputClass} pl-9`}
            />
          </label>
          <select
            aria-label="Region"
            value={regionId}
            onChange={(event) => {
              setRegionId(event.target.value);
              setDistrictId("");
            }}
            className={inputClass}
          >
            <option value="">All regions</option>
            {geography.data?.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <select
            aria-label="District"
            value={districtId}
            disabled={!region}
            onChange={(event) => setDistrictId(event.target.value)}
            className={inputClass}
          >
            <option value="">All districts</option>
            {region?.districts.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Type"
            value={type}
            onChange={(event) => setType(event.target.value as FacilityType | "")}
            className={inputClass}
          >
            <option value="">All types</option>
            {FACILITY_TYPES.map((entry) => (
              <option key={entry} value={entry}>
                {FACILITY_TYPE_LABELS[entry]}
              </option>
            ))}
          </select>
          <select
            aria-label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value as FacilityStatus | "")}
            className={inputClass}
          >
            <option value="">Any status</option>
            {FACILITY_STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {STATUS_LABEL[entry]}
              </option>
            ))}
          </select>
        </div>

        {facilities.isLoading ? (
          <div className="card-soft mt-4 grid place-items-center p-16">
            <Loader2 className="size-6 animate-spin text-brand" />
          </div>
        ) : null}

        {facilities.error ? (
          <div className="card-soft mt-4 flex items-start gap-3 border-red-200 bg-red-50 p-6">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-700">
              {facilities.error instanceof ApiError
                ? facilities.error.message
                : "Facilities could not be loaded."}
            </p>
          </div>
        ) : null}

        {facilities.data && facilities.data.length === 0 ? (
          <div className="card-soft mt-4 grid place-items-center gap-2 p-12 text-center">
            <Building2 className="size-8 text-slate-300" />
            <p className="font-semibold">No facilities match</p>
            <p className="max-w-sm text-sm text-slate-500">
              Register the first CHPS compound, or clear the filters above.
            </p>
          </div>
        ) : null}

        {facilities.data && facilities.data.length > 0 ? (
          <div className="card-soft mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Facility</th>
                  <th className="px-4 py-3 font-semibold">Location</th>
                  <th className="px-4 py-3 font-semibold">Station</th>
                  <th className="px-4 py-3 font-semibold">Staff</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {facilities.data.map((facility) => (
                  <tr key={facility.publicId} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link
                        to="/admin/facilities/$publicId"
                        params={{ publicId: facility.publicId }}
                        className="font-semibold text-foreground hover:text-brand"
                      >
                        {facility.name}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {FACILITY_TYPE_LABELS[facility.type]} ·{" "}
                        <span className="font-mono">{facility.code}</span>
                        {facility.isDemo ? " · demo" : ""}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {facility.location.community}
                      <p className="text-xs text-slate-500">
                        {facility.location.district.name}, {facility.location.region.name}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      {facility.type === "CHPS" ? (
                        <>
                          {EQUIPMENT_LABEL[facility.equipmentStatus]}
                          <p className="text-slate-500">
                            Internet: {CONNECTIVITY_LABEL[facility.connectivityStatus]}
                          </p>
                        </>
                      ) : (
                        <span className="text-slate-400">Referral destination</span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-600">
                      {facility.type === "CHPS" ? facility.staffCount : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Chip tone={facility.status === "ACTIVE" ? "brand" : "muted"}>
                        {STATUS_LABEL[facility.status]}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {facilities.data.length >= FACILITY_PAGE_SIZE ? (
              <p className="border-t border-border px-4 py-3 text-xs text-slate-500">
                Showing the first {FACILITY_PAGE_SIZE}. Narrow the filters to find the rest.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

function RegisterFacility({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const geography = useGeography();
  const create = useCreateFacility();

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [type, setType] = useState<FacilityType>("CHPS");
  const [location, setLocation] = useState<LocationValue>(EMPTY_LOCATION);
  const [community, setCommunity] = useState("");
  const [ghanaPostGps, setGhanaPostGps] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");

  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};
  const ready = name.trim() && code.trim() && location.districtId && community.trim();

  const submit = () =>
    create.mutate(
      {
        name,
        code,
        type,
        districtId: location.districtId,
        subDistrictId: location.subDistrictId || null,
        community,
        ghanaPostGps,
        contactName,
        contactPhone,
      },
      {
        onSuccess: (facility) =>
          void navigate({
            to: "/admin/facilities/$publicId",
            params: { publicId: facility.publicId },
          }),
      },
    );

  return (
    <form
      className="card-soft mt-6 space-y-4 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) submit();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-bold">Register a facility</p>
          <p className="text-xs text-slate-500">
            It will be created inactive. Staff accounts are added on the next screen.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Facility name" error={fieldErrors.name} className="sm:col-span-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Facility code" error={fieldErrors.code}>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="GHS code if it has one"
            className={`${inputClass} font-mono uppercase`}
          />
        </Field>
        <Field label="Type" error={fieldErrors.type}>
          <select
            value={type}
            onChange={(event) => setType(event.target.value as FacilityType)}
            className={inputClass}
          >
            {FACILITY_TYPES.map((entry) => (
              <option key={entry} value={entry}>
                {FACILITY_TYPE_LABELS[entry]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Community or town" error={fieldErrors.community}>
          <input
            value={community}
            onChange={(event) => setCommunity(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="GhanaPostGPS (optional)" error={fieldErrors.ghanaPostGps}>
          <input
            value={ghanaPostGps}
            onChange={(event) => setGhanaPostGps(event.target.value)}
            placeholder="AK-039-5028"
            className={`${inputClass} font-mono uppercase`}
          />
        </Field>
      </div>

      {geography.data ? (
        <LocationFields
          geography={geography.data}
          value={location}
          onChange={setLocation}
          errors={fieldErrors}
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Facility contact (optional)" error={fieldErrors.contactName}>
          <input
            value={contactName}
            onChange={(event) => setContactName(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Contact phone (optional)" error={fieldErrors.contactPhone}>
          <input
            value={contactPhone}
            onChange={(event) => setContactPhone(event.target.value)}
            inputMode="tel"
            placeholder="024 000 0000"
            className={inputClass}
          />
        </Field>
      </div>

      {create.error && Object.keys(fieldErrors).length === 0 ? (
        <p className="text-sm text-red-600">
          {create.error instanceof ApiError ? create.error.message : "Not registered."}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!ready || create.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          {create.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Register facility
        </button>
      </div>
    </form>
  );
}
