/** Shared by the facility forms (D73). */

export interface LocationValue {
  regionId: string;
  districtId: string;
  subDistrictId: string;
}

export const EMPTY_LOCATION: LocationValue = { regionId: "", districtId: "", subDistrictId: "" };

export const inputClass =
  "w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none";
export const labelClass = "mb-1 block text-xs font-semibold text-slate-500";
