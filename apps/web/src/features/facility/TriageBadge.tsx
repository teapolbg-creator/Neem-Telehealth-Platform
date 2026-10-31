import { TRIAGE_CATEGORY_INFO, type TriageCategory } from "@neem/contracts";
import { cn } from "@/lib/utils";
import { TRIAGE_STYLE } from "@/features/facility/patients";

/** A triage category, as a colour with its name — never colour alone. */
export function TriageBadge({
  category,
  className,
}: {
  category: TriageCategory | null;
  className?: string;
}) {
  if (!category) {
    return <span className={cn("chip bg-slate-100 text-slate-500", className)}>Not triaged</span>;
  }
  return (
    <span className={cn("chip font-bold", TRIAGE_STYLE[category].badge, className)}>
      {TRIAGE_CATEGORY_INFO[category].label}
    </span>
  );
}
