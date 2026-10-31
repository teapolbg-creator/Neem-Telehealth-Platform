import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import type { GeographyRegion } from "@neem/contracts";
import { ApiError } from "@/lib/api-client";
import { useCreateDistrict, useCreateSubDistrict } from "@/features/facility/api";
import { inputClass, labelClass, type LocationValue } from "@/features/facility/form";

/**
 * Region › district › sub-district, each narrowing the next.
 *
 * Districts are added from here rather than from a separate screen, because
 * the moment an administrator discovers one is missing is the moment they are
 * registering a facility in it. Only the sixteen regions exist until then
 * (D73): nothing below them is invented.
 */
export function LocationFields({
  geography,
  value,
  onChange,
  errors = {},
}: {
  geography: GeographyRegion[];
  value: LocationValue;
  onChange: (next: LocationValue) => void;
  errors?: Record<string, string>;
}) {
  const region = geography.find((entry) => entry.id === value.regionId);
  const district = region?.districts.find((entry) => entry.id === value.districtId);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm">
        <span className={labelClass}>Region</span>
        <select
          value={value.regionId}
          onChange={(event) =>
            onChange({ regionId: event.target.value, districtId: "", subDistrictId: "" })
          }
          className={inputClass}
        >
          <option value="">Choose a region</option>
          {geography.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>

      <div className="text-sm">
        <span className={labelClass}>District</span>
        <select
          value={value.districtId}
          disabled={!region}
          onChange={(event) =>
            onChange({ ...value, districtId: event.target.value, subDistrictId: "" })
          }
          className={inputClass}
          aria-invalid={Boolean(errors.districtId)}
        >
          <option value="">{region ? "Choose a district" : "Choose a region first"}</option>
          {region?.districts.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        {errors.districtId ? (
          <p className="mt-1 text-xs text-red-600">{errors.districtId}</p>
        ) : null}
        {region ? (
          <AddPlace
            label="Add a district"
            placeholder={`District in ${region.name}`}
            kind="district"
            parentId={region.id}
            onAdded={(id) => onChange({ ...value, districtId: id, subDistrictId: "" })}
          />
        ) : null}
      </div>

      <div className="text-sm">
        <span className={labelClass}>Sub-district (optional)</span>
        <select
          value={value.subDistrictId}
          disabled={!district}
          onChange={(event) => onChange({ ...value, subDistrictId: event.target.value })}
          className={inputClass}
          aria-invalid={Boolean(errors.subDistrictId)}
        >
          <option value="">{district ? "None" : "Choose a district first"}</option>
          {district?.subDistricts.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        {errors.subDistrictId ? (
          <p className="mt-1 text-xs text-red-600">{errors.subDistrictId}</p>
        ) : null}
        {district ? (
          <AddPlace
            label="Add a sub-district"
            placeholder={`Sub-district in ${district.name}`}
            kind="sub-district"
            parentId={district.id}
            onAdded={(id) => onChange({ ...value, subDistrictId: id })}
          />
        ) : null}
      </div>
    </div>
  );
}

function AddPlace({
  label,
  placeholder,
  kind,
  parentId,
  onAdded,
}: {
  label: string;
  placeholder: string;
  kind: "district" | "sub-district";
  parentId: string;
  onAdded: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const createDistrict = useCreateDistrict();
  const createSubDistrict = useCreateSubDistrict();
  const mutation = kind === "district" ? createDistrict : createSubDistrict;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline"
      >
        <Plus className="size-3" /> {label}
      </button>
    );
  }

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) return;
    const created =
      kind === "district"
        ? await createDistrict.mutateAsync({ regionId: parentId, name: trimmed })
        : await createSubDistrict.mutateAsync({ districtId: parentId, name: trimmed });
    onAdded(created.id);
    setName("");
    setOpen(false);
  };

  return (
    <div className="mt-2 space-y-1">
      <div className="flex gap-2">
        <input
          autoFocus
          value={name}
          placeholder={placeholder}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit().catch(() => undefined);
            }
          }}
          className={inputClass}
        />
        <button
          type="button"
          disabled={name.trim().length < 2 || mutation.isPending}
          onClick={() => void submit().catch(() => undefined)}
          className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
        >
          Add
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Use the name exactly as it appears on the official district list.
      </p>
      {mutation.error ? (
        <p className="text-xs text-red-600">
          {mutation.error instanceof ApiError ? mutation.error.message : "Not added."}
        </p>
      ) : null}
    </div>
  );
}

/** A labelled form control with its error underneath. */
export function Field({
  label,
  error,
  className,
  children,
}: {
  label: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`text-sm ${className ?? ""}`}>
      <span className={labelClass}>{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : null}
    </label>
  );
}
