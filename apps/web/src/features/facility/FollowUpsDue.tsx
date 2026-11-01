import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { CalendarClock, Phone } from "lucide-react";
import { Chip } from "@/components/neem/Chip";
import { formatDue, useFollowUpList } from "@/features/facility/followups";

/**
 * Patients the facility expects back (slice 2b, D81): due today and overdue
 * first, oldest at the top, with what is needed to reach them.
 */
export function FollowUpsDue({ enabled }: { enabled: boolean }) {
  const [view, setView] = useState<"due" | "upcoming">("due");
  const list = useFollowUpList(view, enabled);

  return (
    <div className="card-soft mt-4 overflow-x-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <p className="flex items-center gap-2 font-bold">
          <CalendarClock className="size-4 text-brand" /> Follow-ups
        </p>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-xs font-semibold">
          {(
            [
              ["due", "Due now"],
              ["upcoming", "Next 14 days"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-on={view === value}
              onClick={() => setView(value)}
              className="rounded-md px-3 py-1 text-slate-600 data-[on=true]:bg-white data-[on=true]:text-brand data-[on=true]:shadow-sm"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {list.data && list.data.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-slate-500">
          {view === "due" ? "No follow-ups due." : "None in the next 14 days."}
        </p>
      ) : null}
      {list.data && list.data.length > 0 ? (
        <ul className="divide-y divide-border">
          {list.data.map((row) => (
            <li
              key={row.publicId}
              className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm ${
                row.overdue ? "bg-amber-50/60" : ""
              }`}
            >
              <div className="min-w-0">
                <Link
                  to="/facility/patients/$patientNumber"
                  params={{ patientNumber: row.patient.patientNumber }}
                  className="font-semibold hover:text-brand"
                >
                  {row.patient.fullName}
                </Link>
                <p className="truncate text-xs text-slate-500">
                  {row.instructions} · {row.patient.community}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {row.patient.phone ? (
                  <a
                    href={`tel:${row.patient.phone}`}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-brand"
                  >
                    <Phone className="size-3" /> {row.patient.phone}
                  </a>
                ) : null}
                {row.patient.hasOpenVisit ? <Chip tone="brand">Here now</Chip> : null}
                <Chip tone={row.overdue ? "warning" : "muted"}>
                  {row.overdue ? `Overdue · ${formatDue(row.dueDate)}` : formatDue(row.dueDate)}
                </Chip>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
