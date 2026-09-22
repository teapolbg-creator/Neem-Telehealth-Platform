import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AlertCircle, CalendarClock, Loader2, Plus, Trash2 } from "lucide-react";
import { useProfessionalRole } from "@/features/auth/use-role";
import { AppShell } from "@/components/neem/AppShell";
import { ApiError } from "@/lib/api-client";
import {
  useMyAvailability,
  useSetAvailability,
  type AvailabilityWindow,
} from "@/features/professionals/api";

export const Route = createFileRoute("/doctor/availability")({
  component: BookableHours,
});

/** Monday first, because that is how a working week is read. `value` is getUTCDay(). */
const DAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

/**
 * When patients may book this professional in advance (v2).
 *
 * Separate from shifts on purpose. A shift is when the queue may send somebody
 * a patient who needs seeing now; these are the hours a patient can pick a
 * slot in, days ahead. A booked appointment counts as duty for its minute, so
 * nobody needs a shift to see the patients who chose them.
 *
 * The whole week is saved at once. Removing a window does not cancel anything
 * already booked inside it — those were promised to somebody.
 *
 * Times are Ghana time, which is UTC all year.
 */
function BookableHours() {
  const role = useProfessionalRole();
  const { data, isLoading, error } = useMyAvailability();
  const save = useSetAvailability();

  const [windows, setWindows] = useState<AvailabilityWindow[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) setWindows(data);
  }, [data, dirty]);

  const change = (next: AvailabilityWindow[]) => {
    setWindows(next);
    setDirty(true);
  };

  return (
    <AppShell active="doctor">
      <div className="mx-auto w-full max-w-2xl">
        <p className="text-xs font-bold uppercase tracking-wider text-brand">{role.title}</p>
        <h1 className="mt-1 text-3xl font-bold">Bookable hours</h1>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-slate-500">
          The hours patients can book you in advance, every week. Separate from your shifts: those
          are for patients who need someone now. Times are Ghana time.
        </p>

        {isLoading && (
          <div className="card-soft mt-6 grid place-items-center p-16">
            <Loader2 className="size-6 animate-spin text-brand" />
          </div>
        )}

        {error && (
          <div className="card-soft mt-6 flex items-start gap-3 border-red-200 bg-red-50 p-6">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-700">
              {error instanceof ApiError ? error.message : "Your hours could not be loaded."}
            </p>
          </div>
        )}

        {data && (
          <>
            <div className="card-soft mt-6 divide-y divide-border">
              {DAYS.map((day) => {
                const today = windows.filter((window) => window.weekday === day.value);

                return (
                  <div key={day.value} className="flex flex-wrap items-start gap-3 p-4">
                    <p className="w-28 shrink-0 pt-2 text-sm font-semibold">{day.label}</p>

                    <div className="min-w-0 flex-1 space-y-2">
                      {today.length === 0 ? (
                        <p className="pt-2 text-sm text-slate-400">Not bookable</p>
                      ) : (
                        today.map((window) => {
                          const index = windows.indexOf(window);

                          return (
                            <div key={index} className="flex items-center gap-2">
                              <input
                                type="time"
                                value={window.startsAt}
                                onChange={(event) =>
                                  change(
                                    windows.map((entry, i) =>
                                      i === index
                                        ? { ...entry, startsAt: event.target.value }
                                        : entry,
                                    ),
                                  )
                                }
                                className="rounded-lg border border-border px-2 py-1.5 text-sm"
                              />
                              <span className="text-sm text-slate-400">to</span>
                              <input
                                type="time"
                                value={window.endsAt}
                                onChange={(event) =>
                                  change(
                                    windows.map((entry, i) =>
                                      i === index
                                        ? { ...entry, endsAt: event.target.value }
                                        : entry,
                                    ),
                                  )
                                }
                                className="rounded-lg border border-border px-2 py-1.5 text-sm"
                              />
                              <button
                                type="button"
                                aria-label={`Remove ${day.label} ${window.startsAt}`}
                                onClick={() => change(windows.filter((_, i) => i !== index))}
                                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"
                              >
                                <Trash2 className="size-4" />
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        change([
                          ...windows,
                          { weekday: day.value, startsAt: "09:00", endsAt: "12:00" },
                        ])
                      }
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-brand hover:bg-brand/5"
                    >
                      <Plus className="size-3.5" /> Add hours
                    </button>
                  </div>
                );
              })}
            </div>

            {save.error ? (
              <p className="mt-4 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                {save.error instanceof ApiError ? save.error.message : "Your hours were not saved."}
              </p>
            ) : null}

            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                disabled={!dirty || save.isPending}
                onClick={() =>
                  save.mutate(windows, {
                    onSuccess: () => setDirty(false),
                  })
                }
                className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
              >
                <CalendarClock className="size-4" />
                {save.isPending ? "Saving…" : "Save my week"}
              </button>
              {!dirty && save.isSuccess ? (
                <span className="text-sm text-medical">Saved. Patients can book these hours.</span>
              ) : null}
            </div>

            <p className="mt-6 rounded-2xl bg-slate-50 p-4 text-xs leading-relaxed text-slate-600">
              Patients only see these hours for the services you have joined, which Neem
              administration sets. Removing hours does not cancel appointments already booked in
              them.
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}
