import { Stethoscope } from "lucide-react";
import type { VisitEncounterSummary } from "@neem/contracts";

/**
 * The doctor's finalised advice, as the CHO sees it (D78): what to do next.
 * A draft never appears here, only a record the doctor completed.
 */
export function DoctorAdvice({
  encounter,
  compact = false,
}: {
  encounter: VisitEncounterSummary;
  compact?: boolean;
}) {
  const rows: [string, string | null][] = [
    ["Assessment", encounter.clinicalAssessment],
    ["Diagnosis", encounter.diagnosis],
    ["Treatment plan", encounter.treatmentPlan],
    ["Referral", encounter.referralInstructions],
    ["Follow-up", encounter.followUp],
  ];
  const shown = compact ? rows.filter(([label]) => label !== "Assessment") : rows;

  return (
    <div
      className={
        compact
          ? "rounded-lg bg-slate-50 p-2 text-xs text-slate-600"
          : "space-y-2 rounded-xl border border-medical/30 bg-medical/5 p-4"
      }
    >
      {!compact ? (
        <p className="flex items-center gap-2 text-sm font-bold">
          <Stethoscope className="size-4 text-medical" /> Doctor’s advice
          {encounter.doctorName ? (
            <span className="font-normal text-slate-500">— {encounter.doctorName}</span>
          ) : null}
        </p>
      ) : null}
      <dl className={compact ? "space-y-0.5" : "space-y-1.5 text-sm"}>
        {shown
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt
                className={
                  compact ? "inline font-semibold" : "text-xs font-semibold text-slate-500"
                }
              >
                {label}
                {compact ? ": " : ""}
              </dt>
              <dd className={compact ? "inline" : ""}>{value}</dd>
            </div>
          ))}
      </dl>
      {!compact && encounter.version > 1 ? (
        <p className="text-xs text-slate-500">
          Amended by the doctor (version {encounter.version}).
        </p>
      ) : null}
    </div>
  );
}
