import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, CalendarClock, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  useAdminDoctors,
  useAssignShift,
  useSetShiftActive,
  useShiftDefinitions,
} from "@/features/onboarding/api";

export const Route = createFileRoute("/admin/scheduling")({
  component: AdminScheduling,
});

/** Minutes as a person reads a rota: "37h 30m", not 2250. */
function formatHours(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Shift scheduling (spec §25, §80 scenario 14).
 *
 * This screen did not exist until Phase 10, and its absence was the point.
 * `POST /admin/shifts` was built in Phase 2, `useAssignShift` and
 * `useShiftDefinitions` were written in the feature layer, and **no component
 * ever imported them**. So a doctor could not be put on a rota through the
 * product at all, and the 40-hour ceiling — a fatigue rule, not a
 * preference — was enforced on a route no administrator could reach.
 *
 * The ceiling is the reason this screen shows weekly minutes beside every
 * assignment rather than only on failure. A limit you learn about by being
 * refused is a limit you plan around badly; the number has to be visible
 * while the rota is being built.
 *
 * What the screen does **not** do is decide anything. The API refuses an
 * assignment that would breach the ceiling, and it refuses it again if this
 * page is stale or bypassed entirely (spec §92).
 */
function AdminScheduling() {
  const [search, setSearch] = useState("");

  const definitions = useShiftDefinitions();
  // Filtered server-side, because the directory is paged: with more than a
  // page of active doctors the rest were simply absent from the list, and a
  // doctor you cannot select is a doctor you cannot roster.
  const doctors = useAdminDoctors({ status: "ACTIVE", search });
  const assign = useAssignShift();
  const setActive = useSetShiftActive();

  const [doctorPublicId, setDoctorPublicId] = useState("");
  const [shiftCode, setShiftCode] = useState("");
  const [serviceDate, setServiceDate] = useState(() => new Date().toISOString().slice(0, 10));

  const activeShifts = (definitions.data ?? []).filter((shift) => shift.isActive);
  const chosenDoctor = (doctors.data ?? []).find((row) => row.publicId === doctorPublicId);

  // If a search narrows the list past the current selection, the id would
  // still be set while the select showed the placeholder — and the shift
  // would be assigned to someone the administrator can no longer see.
  const selectionIsVisible = doctorPublicId === "" || chosenDoctor !== undefined;

  const ready =
    doctorPublicId !== "" && shiftCode !== "" && serviceDate !== "" && selectionIsVisible;

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Scheduling</h1>
        <p className="mt-2 max-w-2xl text-pretty text-sm leading-relaxed text-slate-500">
          Put a doctor on a shift. No doctor may be scheduled beyond 40 hours in a week — the
          API refuses it, and refuses it whatever this screen shows.
        </p>
      </header>

      <section className="card-soft p-6">
        <h2 className="flex items-center gap-2 font-bold">
          <CalendarClock className="size-4 text-brand" /> Assign a shift
        </h2>

        <label className="mt-4 block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Find a doctor
          </span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name or MDC number"
            className="mt-1 w-full max-w-md rounded-xl border border-border px-3 py-2 text-sm sm:w-80"
          />
        </label>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Doctor
            </span>
            <select
              value={doctorPublicId}
              onChange={(event) => setDoctorPublicId(event.target.value)}
              className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm"
            >
              <option value="">Choose a doctor</option>
              {(doctors.data ?? []).map((doctor) => (
                <option key={doctor.publicId} value={doctor.publicId}>
                  {doctor.fullName} · MDC {doctor.mdcNumber}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Shift
            </span>
            <select
              value={shiftCode}
              onChange={(event) => setShiftCode(event.target.value)}
              className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm"
            >
              <option value="">Choose a shift</option>
              {activeShifts.map((shift) => (
                <option key={shift.code} value={shift.code}>
                  {shift.label} · {shift.startsAt}–{shift.endsAt}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Date
            </span>
            <input
              type="date"
              value={serviceDate}
              onChange={(event) => setServiceDate(event.target.value)}
              className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
            />
          </label>
        </div>

        {/*
          A search that matches nobody leaves the select holding only its
          placeholder, which reads as "there are no doctors" rather than "your
          search found none". Different sentences, and an administrator acts
          on them differently.
        */}
        {search.trim() !== "" && !doctors.isFetching && (doctors.data ?? []).length === 0 && (
          <p className="mt-3 text-sm text-slate-500">
            No active doctor matches <strong className="font-semibold">{search}</strong>. A doctor
            must be ACTIVE before they can be put on a shift — check{" "}
            <Link to="/admin/verification" className="underline">
              verification
            </Link>{" "}
            if you are expecting someone.
          </p>
        )}

        {chosenDoctor && chosenDoctor.contractedHoursPerWeek !== null && (
          <p className="mt-3 text-xs text-slate-500">
            {chosenDoctor.fullName} is contracted for {chosenDoctor.contractedHoursPerWeek}h a
            week.
          </p>
        )}

        <button
          type="button"
          disabled={!ready || assign.isPending}
          onClick={() =>
            assign.mutate({ doctorPublicId, shiftCode, serviceDate })
          }
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
        >
          {assign.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Assign shift
        </button>

        {/*
          The refusal matters more than the success here, so it is rendered
          with the same weight rather than as a toast that disappears. An
          administrator who has just been told "no" needs to know why and by
          how much.
        */}
        {assign.error && (
          <div className="card-soft mt-4 flex items-start gap-3 border-red-200 bg-red-50 p-5">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
            <div className="text-sm leading-relaxed text-red-700">
              <strong className="font-bold">This shift was not assigned.</strong>{" "}
              {assign.error instanceof ApiError
                ? assign.error.message
                : "The assignment could not be made."}
            </div>
          </div>
        )}

        {assign.data && !assign.error && (
          <div className="card-soft mt-4 flex items-start gap-3 border-brand/30 bg-brand-soft p-5">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand" />
            <div className="text-sm leading-relaxed">
              <strong className="font-bold">Shift assigned.</strong> That doctor is now scheduled
              for{" "}
              <strong className="font-bold">
                {formatHours(assign.data.weeklyMinutesScheduled)}
              </strong>{" "}
              of a {formatHours(assign.data.weeklyLimitMinutes)} weekly limit.
            </div>
          </div>
        )}
      </section>

      <section className="card-soft p-6">
        <h2 className="flex items-center gap-2 font-bold">
          <Clock className="size-4 text-brand" /> Shifts
        </h2>

        {definitions.isLoading && (
          <div className="grid place-items-center py-10">
            <Loader2 className="size-5 animate-spin text-brand" />
          </div>
        )}

        {definitions.data && (
          <>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              A doctor can only be put on an active shift. Night cover is seeded off — turning it
              on is a business decision, so it is a decision someone makes here rather than a
              value in the database.
            </p>

            <ul className="mt-4 divide-y divide-border">
              {definitions.data.map((shift) => (
                <li
                  key={shift.code}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                >
                  <div>
                    <p className="font-semibold">{shift.label}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {shift.startsAt}–{shift.endsAt}
                      {shift.crossesMidnight && " · crosses midnight"}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <Chip tone={shift.isActive ? "medical" : "muted"}>
                      {shift.isActive ? "active" : "inactive"}
                    </Chip>
                    <button
                      type="button"
                      disabled={setActive.isPending}
                      onClick={() =>
                        setActive.mutate({ code: shift.code, isActive: !shift.isActive })
                      }
                      className="rounded-xl border border-border px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-40"
                    >
                      {shift.isActive ? "Turn off" : "Turn on"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {setActive.error && (
              <p className="mt-3 text-xs font-semibold text-red-600">
                {setActive.error instanceof ApiError
                  ? setActive.error.message
                  : "Could not change that shift."}
              </p>
            )}

            {/*
              Turning a shift off does not cancel the assignments already on
              it — the API leaves them alone, and a screen that implied
              otherwise would be promising something it does not do.
            */}
            <p className="mt-3 text-xs text-slate-500">
              Turning a shift off stops new assignments. Shifts already assigned to it are not
              cancelled.
            </p>
          </>
        )}
      </section>
    </AppShell>
  );
}
