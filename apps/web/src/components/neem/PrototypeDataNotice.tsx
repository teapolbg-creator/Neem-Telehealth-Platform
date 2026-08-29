import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Marks a screen whose figures are still placeholder data from the original
 * prototype rather than real records.
 *
 * The specification is explicit that the system must not present information it
 * cannot substantiate (spec §75, §93). Until the engines that produce these
 * numbers exist — consultations in Phase 3, the queue in Phase 4, finance in
 * Phase 7, analytics in Phase 9 — the layout is real but the values are not,
 * and saying so plainly is the only honest option.
 *
 * Delete this component's usages as each dashboard is connected to live data.
 */
export function PrototypeDataNotice({
  phase,
  className,
}: {
  /** Which build phase replaces these figures with real data. */
  phase: string;
  className?: string;
}) {
  return (
    <div
      role="note"
      className={cn(
        "card-soft flex items-start gap-3 border-warning/30 bg-warning-soft p-4",
        className,
      )}
    >
      <FlaskConical className="size-5 shrink-0 text-warning" aria-hidden />
      <p className="text-xs leading-relaxed text-slate-700">
        <span className="font-bold text-warning">Placeholder figures.</span> The layout below is
        real, but these numbers are sample data carried over from the design prototype — not
        records from this system. They are replaced with live data in {phase}.
      </p>
    </div>
  );
}
