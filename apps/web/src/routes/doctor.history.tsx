import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { ApiError } from "@/lib/api-client";
import { useDoctorHistory, type HistoryFilters } from "@/features/doctor/history";
import { inputClass, labelClass } from "@/features/facility/form";

export const Route = createFileRoute("/doctor/history")({
  component: History,
});

const EMPTY: HistoryFilters = { patient: "", facility: "", from: "", to: "" };

const when = (iso: string) =>
  new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

const words = (state: string) => {
  const lower = state.replace(/_/g, " ").toLowerCase();
  return lower[0]!.toUpperCase() + lower.slice(1);
};

/**
 * What this doctor has done (slice 5a, brief §B1 and §B5, D91): today's
 * workload, and their own consultations to look back over. Opening one is what
 * reads the record, and is logged there.
 */
function History() {
  const [typed, setTyped] = useState(EMPTY);
  const [filters, setFilters] = useState(EMPTY);
  const history = useDoctorHistory(filters);
  const first = history.data?.pages[0];
  const rows = history.data?.pages.flatMap((page) => page.rows) ?? [];

  return (
    <AppShell active="doctor">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Your consultations</p>
        <h1 className="text-3xl font-bold tracking-tight">History</h1>
      </header>

      {first ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {(
            [
              ["Offers open now", first.workload.pending],
              ["With you now", first.workload.active],
              ["Completed today", first.workload.completedToday],
              ["Completed in all", first.workload.completedTotal],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="card-soft p-4">
              <p className="text-xs font-semibold text-slate-500">{label}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
            </div>
          ))}
        </div>
      ) : null}

      <form
        className="card-soft grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters(typed);
        }}
      >
        <label className="text-sm lg:col-span-2">
          <span className={labelClass}>Patient</span>
          <input
            value={typed.patient}
            onChange={(event) => setTyped({ ...typed, patient: event.target.value })}
            placeholder="A whole word of the name, or NM-XXXX-XXXX"
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          <span className={labelClass}>Facility</span>
          <select
            value={typed.facility}
            onChange={(event) => setTyped({ ...typed, facility: event.target.value })}
            className={inputClass}
          >
            <option value="">All</option>
            {first?.facilities.map((facility) => (
              <option key={facility.publicId} value={facility.publicId}>
                {facility.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className={labelClass}>From</span>
          <input
            type="date"
            value={typed.from}
            onChange={(event) => setTyped({ ...typed, from: event.target.value })}
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          <span className={labelClass}>To</span>
          <input
            type="date"
            value={typed.to}
            onChange={(event) => setTyped({ ...typed, to: event.target.value })}
            className={inputClass}
          />
        </label>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-5">
          <button
            type="submit"
            className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            Search
          </button>
          <button
            type="button"
            onClick={() => {
              setTyped(EMPTY);
              setFilters(EMPTY);
            }}
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
          >
            Clear
          </button>
        </div>
      </form>

      {history.isLoading ? (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      ) : null}

      {history.error ? (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {history.error instanceof ApiError
              ? history.error.message
              : "Your history could not be loaded."}
          </p>
        </div>
      ) : null}

      {history.data ? (
        <div className="card-soft overflow-x-auto">
          {rows.length === 0 ? (
            <p className="p-6 text-sm text-slate-500">No consultations match.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Requested</th>
                  <th className="px-4 py-3 font-semibold">Patient</th>
                  <th className="px-4 py-3 font-semibold">From</th>
                  <th className="px-4 py-3 font-semibold">State</th>
                  <th className="px-4 py-3 font-semibold">Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.publicId}>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                      {when(row.requestedAt)}
                    </td>
                    <td className="px-4 py-3">
                      {row.patientName ? (
                        <>
                          <span className="font-semibold">{row.patientName}</span>
                          <span className="block font-mono text-xs text-slate-500">
                            {row.patientNumber}
                          </span>
                        </>
                      ) : (
                        // Sealed when the consultation ended (D23).
                        <span className="text-slate-500">Identity sealed</span>
                      )}
                    </td>
                    <td className="px-4 py-3">{row.origin ?? "Online patient"}</td>
                    <td className="px-4 py-3">{words(row.state)}</td>
                    <td className="px-4 py-3">
                      <Link
                        to="/doctor/consultations/$publicId"
                        params={{ publicId: row.publicId }}
                        className="font-mono text-xs font-semibold text-brand hover:underline"
                      >
                        {row.publicId}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {history.hasNextPage ? (
        <button
          type="button"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
          className="mx-auto rounded-lg border border-border px-5 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Show more
        </button>
      ) : null}
    </AppShell>
  );
}
