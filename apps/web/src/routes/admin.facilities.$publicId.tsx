import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, ArrowLeft, Check, Copy, KeyRound, Loader2, UserPlus } from "lucide-react";
import { Field, LocationFields } from "@/features/facility/LocationFields";
import {
  FACILITY_CONNECTIVITY_STATUSES,
  FACILITY_EQUIPMENT_STATUSES,
  FACILITY_TYPES,
  FACILITY_TYPE_LABELS,
  type FacilityDetail,
  type FacilityStaffSetup,
  type FacilityType,
} from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  CONNECTIVITY_LABEL,
  EQUIPMENT_LABEL,
  STATUS_LABEL,
  useCreateStaff,
  useFacility,
  useGeography,
  useReissueSetupLink,
  useSetStaffStatus,
  useUpdateFacility,
} from "@/features/facility/api";
import { inputClass, type LocationValue } from "@/features/facility/form";

export const Route = createFileRoute("/admin/facilities/$publicId")({
  component: AdminFacilityDetail,
});

/**
 * One facility: its details, whether it takes part, its station as last
 * reported, and — for a CHPS compound — the staff who sign in for it (D73).
 */
function AdminFacilityDetail() {
  const { publicId } = Route.useParams();
  const facility = useFacility(publicId);

  return (
    <AppShell active="admin">
      <div className="mx-auto w-full max-w-5xl">
        <Link
          to="/admin/facilities"
          className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-brand"
        >
          <ArrowLeft className="size-4" /> Facilities
        </Link>

        {facility.isLoading ? (
          <div className="card-soft mt-6 grid place-items-center p-16">
            <Loader2 className="size-6 animate-spin text-brand" />
          </div>
        ) : null}

        {facility.error ? (
          <div className="card-soft mt-6 flex items-start gap-3 border-red-200 bg-red-50 p-6">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-700">
              {facility.error instanceof ApiError
                ? facility.error.message
                : "This facility could not be loaded."}
            </p>
          </div>
        ) : null}

        {facility.data ? <FacilityView facility={facility.data} /> : null}
      </div>
    </AppShell>
  );
}

function FacilityView({ facility }: { facility: FacilityDetail }) {
  return (
    <>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-brand">
            {FACILITY_TYPE_LABELS[facility.type]}
          </p>
          <h1 className="mt-1 text-3xl font-bold">{facility.name}</h1>
          <p className="mt-1 text-sm text-slate-500">
            <span className="font-mono">{facility.code}</span> · {facility.location.community},{" "}
            {facility.location.subDistrict ? `${facility.location.subDistrict.name}, ` : ""}
            {facility.location.district.name}, {facility.location.region.name}
          </p>
        </div>
        <Chip tone={facility.status === "ACTIVE" ? "brand" : "muted"}>
          {STATUS_LABEL[facility.status]}
        </Chip>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <DetailsForm key={facility.publicId + facility.code} facility={facility} />
          {facility.type === "CHPS" ? <StaffPanel facility={facility} /> : null}
        </div>
        <div className="space-y-4">
          <StatusPanel facility={facility} />
          {facility.type === "CHPS" ? <StationPanel facility={facility} /> : null}
        </div>
      </div>
    </>
  );
}

function DetailsForm({ facility }: { facility: FacilityDetail }) {
  const geography = useGeography();
  const update = useUpdateFacility(facility.publicId);

  const [name, setName] = useState(facility.name);
  const [code, setCode] = useState(facility.code);
  const [type, setType] = useState<FacilityType>(facility.type);
  const [community, setCommunity] = useState(facility.location.community);
  const [location, setLocation] = useState<LocationValue>({
    regionId: facility.location.region.id,
    districtId: facility.location.district.id,
    subDistrictId: facility.location.subDistrict?.id ?? "",
  });
  const [ghanaPostGps, setGhanaPostGps] = useState(facility.ghanaPostGps ?? "");
  const [addressLine, setAddressLine] = useState(facility.addressLine ?? "");
  const [contactName, setContactName] = useState(facility.contactName ?? "");
  const [contactPhone, setContactPhone] = useState(facility.contactPhone ?? "");
  const [contactEmail, setContactEmail] = useState(facility.contactEmail ?? "");

  const fieldErrors = update.error instanceof ApiError ? update.error.fieldErrors : {};
  // Staff accounts exist only at a CHPS compound, so it cannot become anything else.
  const typeLocked = facility.type === "CHPS" && facility.staff.length > 0;

  return (
    <form
      className="card-soft space-y-4 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        update.mutate({
          name,
          code,
          type,
          community,
          districtId: location.districtId,
          subDistrictId: location.subDistrictId || null,
          ghanaPostGps,
          addressLine,
          contactName,
          contactPhone,
          contactEmail,
        });
      }}
    >
      <p className="font-bold">Details</p>

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
            className={`${inputClass} font-mono uppercase`}
          />
        </Field>
        <Field label="Type" error={fieldErrors.type}>
          <select
            value={type}
            disabled={typeLocked}
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
        <Field label="GhanaPostGPS" error={fieldErrors.ghanaPostGps}>
          <input
            value={ghanaPostGps}
            onChange={(event) => setGhanaPostGps(event.target.value)}
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

      <Field label="Address or directions" error={fieldErrors.addressLine}>
        <input
          value={addressLine}
          onChange={(event) => setAddressLine(event.target.value)}
          className={inputClass}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Facility contact" error={fieldErrors.contactName}>
          <input
            value={contactName}
            onChange={(event) => setContactName(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Contact phone" error={fieldErrors.contactPhone}>
          <input
            value={contactPhone}
            inputMode="tel"
            onChange={(event) => setContactPhone(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Contact email" error={fieldErrors.contactEmail}>
          <input
            value={contactEmail}
            type="email"
            onChange={(event) => setContactEmail(event.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="flex items-center justify-end gap-3">
        {update.isSuccess ? (
          <span className="inline-flex items-center gap-1 text-xs text-brand">
            <Check className="size-3" /> Saved
          </span>
        ) : null}
        {update.error && Object.keys(fieldErrors).length === 0 ? (
          <span className="text-sm text-red-600">
            {update.error instanceof ApiError ? update.error.message : "Not saved."}
          </span>
        ) : null}
        <button
          type="submit"
          disabled={update.isPending || !location.districtId}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          Save details
        </button>
      </div>
    </form>
  );
}

function StatusPanel({ facility }: { facility: FacilityDetail }) {
  const update = useUpdateFacility(facility.publicId);
  const [reason, setReason] = useState("");
  const active = facility.status === "ACTIVE";

  return (
    <div className="card-soft space-y-3 p-5">
      <p className="font-bold">Taking part</p>
      {active ? (
        <>
          <p className="text-sm text-slate-500">
            This facility is active.
            {facility.type === "CHPS" ? " Its staff will use Neem from here." : ""}
          </p>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-semibold text-slate-500">
              Reason for deactivating
            </span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="For example: station removed for repair"
              className={inputClass}
            />
          </label>
          <button
            type="button"
            disabled={!reason.trim() || update.isPending}
            onClick={() => update.mutate({ status: "INACTIVE", statusReason: reason })}
            className="w-full rounded-lg border border-red-200 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            Deactivate
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-slate-500">
            Inactive.{facility.statusReason ? ` Reason: ${facility.statusReason}` : ""}
          </p>
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => update.mutate({ status: "ACTIVE" })}
            className="w-full rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            Activate
          </button>
        </>
      )}
      {update.error ? (
        <p className="text-sm text-red-600">
          {update.error instanceof ApiError ? update.error.message : "Not changed."}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The station as last reported by a person. Nothing measures it yet — station
 * heartbeats arrive with slice 1d — so this says "reported", never "live".
 */
function StationPanel({ facility }: { facility: FacilityDetail }) {
  const update = useUpdateFacility(facility.publicId);

  return (
    <div className="card-soft space-y-3 p-5">
      <div>
        <p className="font-bold">Consultation station</p>
        <p className="text-xs text-slate-500">As last reported. Nothing measures these yet.</p>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-semibold text-slate-500">Equipment</span>
        <select
          value={facility.equipmentStatus}
          disabled={update.isPending}
          onChange={(event) =>
            update.mutate({
              equipmentStatus: event.target.value as FacilityDetail["equipmentStatus"],
            })
          }
          className={inputClass}
        >
          {FACILITY_EQUIPMENT_STATUSES.map((entry) => (
            <option key={entry} value={entry}>
              {EQUIPMENT_LABEL[entry]}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-semibold text-slate-500">Internet connection</span>
        <select
          value={facility.connectivityStatus}
          disabled={update.isPending}
          onChange={(event) =>
            update.mutate({
              connectivityStatus: event.target.value as FacilityDetail["connectivityStatus"],
            })
          }
          className={inputClass}
        >
          {FACILITY_CONNECTIVITY_STATUSES.map((entry) => (
            <option key={entry} value={entry}>
              {CONNECTIVITY_LABEL[entry]}
            </option>
          ))}
        </select>
      </label>
      {facility.connectivityReportedAt ? (
        <p className="text-xs text-slate-500">
          Connection reported {new Date(facility.connectivityReportedAt).toLocaleString()}
        </p>
      ) : null}
      {update.error ? (
        <p className="text-sm text-red-600">
          {update.error instanceof ApiError ? update.error.message : "Not saved."}
        </p>
      ) : null}
    </div>
  );
}

function StaffPanel({ facility }: { facility: FacilityDetail }) {
  const [adding, setAdding] = useState(false);
  const [setup, setSetup] = useState<FacilityStaffSetup | null>(null);
  const setStatus = useSetStaffStatus(facility.publicId);
  const reissue = useReissueSetupLink(facility.publicId);

  return (
    <div className="card-soft space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-bold">Staff</p>
          <p className="text-xs text-slate-500">
            Community Health Officers and other authorised staff who sign in for this facility.
          </p>
        </div>
        {!adding ? (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setSetup(null);
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <UserPlus className="size-4" /> Add staff member
          </button>
        ) : null}
      </div>

      {setup ? <SetupLink setup={setup} onDone={() => setSetup(null)} /> : null}

      {adding ? (
        <AddStaff
          facility={facility}
          onCancel={() => setAdding(false)}
          onCreated={(created) => {
            setAdding(false);
            setSetup(created);
          }}
        />
      ) : null}

      {facility.staff.length === 0 && !adding ? (
        <p className="text-sm text-slate-500">No staff accounts yet.</p>
      ) : null}

      <ul className="divide-y divide-border">
        {facility.staff.map((member) => (
          <li
            key={member.userPublicId}
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div className="min-w-0">
              <p className="font-semibold">
                {member.fullName}
                {member.isFacilityAdmin ? (
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    facility administrator
                  </span>
                ) : null}
              </p>
              <p className="truncate text-xs text-slate-500">
                {member.title ? `${member.title} · ` : ""}
                {member.email}
                {member.phone ? ` · ${member.phone}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {member.status !== "ACTIVE" ? (
                <Chip tone="danger">
                  {member.status === "SUSPENDED" ? "Suspended" : "Disabled"}
                </Chip>
              ) : member.hasSetPassword ? (
                <Chip tone="brand">Set up</Chip>
              ) : (
                <Chip tone="warning">Awaiting set-up</Chip>
              )}
              {member.status === "ACTIVE" ? (
                <button
                  type="button"
                  disabled={reissue.isPending}
                  onClick={() =>
                    reissue.mutate(member.userPublicId, { onSuccess: (next) => setSetup(next) })
                  }
                  title="Issue a new one-time link. Any earlier link stops working."
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  <KeyRound className="size-3" /> New set-up link
                </button>
              ) : null}
              {member.status !== "DISABLED" ? (
                <button
                  type="button"
                  disabled={setStatus.isPending}
                  onClick={() =>
                    setStatus.mutate({
                      userPublicId: member.userPublicId,
                      status: member.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE",
                    })
                  }
                  className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  {member.status === "ACTIVE" ? "Suspend" : "Restore"}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {setStatus.error || reissue.error ? (
        <p className="text-sm text-red-600">
          {(setStatus.error ?? reissue.error) instanceof ApiError
            ? (setStatus.error ?? reissue.error)!.message
            : "Not changed."}
        </p>
      ) : null}
    </div>
  );
}

function AddStaff({
  facility,
  onCancel,
  onCreated,
}: {
  facility: FacilityDetail;
  onCancel: () => void;
  onCreated: (setup: FacilityStaffSetup) => void;
}) {
  const create = useCreateStaff(facility.publicId);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("Community Health Officer");
  const [phone, setPhone] = useState("");
  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};

  return (
    <form
      className="space-y-3 rounded-xl border border-border bg-slate-50/60 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(
          { fullName, email, title, phone, isFacilityAdmin: false },
          { onSuccess: onCreated },
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" error={fieldErrors.fullName}>
          <input
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Email (used to sign in)" error={fieldErrors.email}>
          <input
            value={email}
            type="email"
            onChange={(event) => setEmail(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Title" error={fieldErrors.title}>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Phone (optional)" error={fieldErrors.phone}>
          <input
            value={phone}
            inputMode="tel"
            onChange={(event) => setPhone(event.target.value)}
            className={inputClass}
          />
        </Field>
      </div>
      {create.error && Object.keys(fieldErrors).length === 0 ? (
        <p className="text-sm text-red-600">
          {create.error instanceof ApiError ? create.error.message : "Not created."}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-white"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!fullName.trim() || !email.trim() || create.isPending}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          Create account
        </button>
      </div>
    </form>
  );
}

/**
 * The one-time link, shown once. It is a credential: whoever holds it can set
 * the password. The administrator hands it to the staff member and nobody
 * else, and it cannot be shown again — only replaced.
 */
function SetupLink({ setup, onDone }: { setup: FacilityStaffSetup; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}${setup.setupPath}`;

  return (
    <div className="space-y-2 rounded-xl border border-brand/30 bg-brand-soft p-4">
      <p className="text-sm font-semibold">Set-up link for {setup.member.fullName}</p>
      <p className="text-xs text-slate-600">
        Give this to {setup.member.fullName} and nobody else. They use it once to choose their
        password. It expires {new Date(setup.setupExpiresAt).toLocaleString()} and will not be shown
        again.{" "}
        {setup.emailed
          ? `It has also been emailed to ${setup.member.email}.`
          : "Email is not set up on this deployment, so it has not been emailed."}
      </p>
      <div className="flex gap-2">
        <input readOnly value={url} className={`${inputClass} font-mono text-xs`} />
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => setCopied(true));
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <button
        type="button"
        onClick={onDone}
        className="text-xs font-semibold text-slate-600 hover:underline"
      >
        Done — hide the link
      </button>
    </div>
  );
}
