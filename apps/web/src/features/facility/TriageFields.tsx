import { TRIAGE_CATEGORIES, TRIAGE_CATEGORY_INFO } from "@neem/contracts";
import { inputClass } from "./form";
import { TRIAGE_STYLE } from "./patients";
import { VITAL_FIELDS, type TriageDraft } from "./triage";

/**
 * Vital signs, symptoms, observations and the category: the triage form's
 * fields, shared by a visit on file and a walk-in saved offline (D75, D88).
 */
export function TriageFields({
  draft,
  onChange,
  errors,
}: {
  draft: TriageDraft;
  onChange: (draft: TriageDraft) => void;
  errors: Record<string, string>;
}) {
  return (
    <>
      <div>
        <p className="mb-2 text-sm font-bold">Vital signs</p>
        <p className="mb-2 text-xs text-slate-500">
          Record what you can measure; leave the rest empty.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {VITAL_FIELDS.map((field) => (
            <label key={field.key} className="text-sm">
              <span className="mb-1 block text-xs font-semibold text-slate-500">
                {field.label} <span className="font-normal">({field.unit})</span>
              </span>
              <input
                inputMode="decimal"
                step={field.step}
                value={draft.values[field.key] ?? ""}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    values: {
                      ...draft.values,
                      [field.key]: event.target.value.replace(/[^\d.]/g, ""),
                    },
                  })
                }
                aria-invalid={Boolean(errors[`vitals.${field.key}`])}
                className={inputClass}
              />
              {errors[`vitals.${field.key}`] ? (
                <span className="mt-1 block text-xs text-red-600">
                  {errors[`vitals.${field.key}`]}
                </span>
              ) : null}
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-500">Symptoms</span>
          <textarea
            rows={2}
            value={draft.symptoms}
            onChange={(event) => onChange({ ...draft, symptoms: event.target.value })}
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-500">Your observations</span>
          <textarea
            rows={2}
            value={draft.observations}
            onChange={(event) => onChange({ ...draft, observations: event.target.value })}
            className={inputClass}
          />
        </label>
      </div>

      <div>
        <p className="mb-2 text-sm font-bold">Triage category</p>
        <p className="mb-2 text-xs text-slate-500">
          Your clinical judgement, following your triage protocol. Neem does not calculate it.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {TRIAGE_CATEGORIES.map((value) => (
            <button
              key={value}
              type="button"
              data-on={draft.category === value}
              onClick={() => onChange({ ...draft, category: value })}
              className={`rounded-xl border-2 px-3 py-3 text-left text-sm ${TRIAGE_STYLE[value].button}`}
            >
              <span className="block font-bold">{TRIAGE_CATEGORY_INFO[value].label}</span>
              <span className="block text-xs opacity-90">
                {TRIAGE_CATEGORY_INFO[value].meaning}
              </span>
            </button>
          ))}
        </div>
        {errors.category ? <p className="mt-1 text-xs text-red-600">{errors.category}</p> : null}
      </div>
    </>
  );
}
