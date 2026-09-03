import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertCircle,
  BadgeCheck,
  CalendarClock,
  Clock,
  Loader2,
  Radio,
  ShieldAlert,
  Stethoscope,
  Wallet,
} from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { useDoctorProfile, useDoctorShifts } from "@/features/onboarding/api";
import { useGoOffline, useGoOnline, usePresence } from "@/features/queue/api";
import { useDoctorSubstitutions } from "@/features/clinical/api";
import { formatMinor, useDoctorEarnings, useMembership } from "@/features/finance/api";

/** Minutes as a doctor reads them: "6h 30m", not 390. */
function formatHours(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export const Route = createFileRoute("/doctor/")({
  component: DoctorDashboard,
});

/**
 * The doctor's dashboard.
 *
 * These are real figures. Until Phase 9 this screen showed a stock photograph,
 * fourteen consultations and GH₵ 420 of earnings, none of which existed,
 * behind a notice saying not to believe them.
 *
 * Deliberately absent, as everywhere a doctor can see: any rating, any quality
 * score, and any reason they were chosen for a consultation. The routes behind
 * this screen do not return them to a doctor principal (spec §24, §52).
 */
function DoctorDashboard() {
  const profile = useDoctorProfile();
  const presence = usePresence();
  const shifts = useDoctorShifts();
  const substitutions = useDoctorSubstitutions();
  const earnings = useDoctorEarnings();
  const membership = useMembership();

  const goOnline = useGoOnline();
  const goOffline = useGoOffline();
  const online = presence.data?.online ?? false;

  const today = new Date().toISOString().slice(0, 10);
  const todaysShift = shifts.data?.shifts.find((shift) => shift.serviceDate.startsWith(today));

  if (profile.isLoading) {
    return (
      <AppShell active="doctor">
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      </AppShell>
    );
  }

  if (profile.error || !profile.data) {
    return (
      <AppShell active="doctor">
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {profile.error instanceof ApiError
              ? profile.error.message
              : "Your profile could not be loaded."}
          </p>
        </div>
      </AppShell>
    );
  }

  const doctor = profile.data;

  return (
    <AppShell active="doctor">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-sm font-semibold text-brand">Doctor</p>
          <h1 className="text-3xl font-bold tracking-tight">{doctor.fullName}</h1>
          <p className="mt-1 text-sm text-slate-500">
            MDC {doctor.mdcNumber}
            {doctor.languages.length > 0 &&
              ` · ${doctor.languages.map((language) => language.label).join(", ")}`}
          </p>
        </div>
        <Chip tone={doctor.status === "ACTIVE" ? "medical" : "warning"}>
          {doctor.status.toLowerCase()}
        </Chip>
      </header>

      {/*
        Anything blocking this doctor from working comes first — a suspended
        account, a lapsed membership, an unconfirmed shift. A dashboard that
        led with statistics while the doctor could not take a consultation
        would be showing the wrong thing.
      */}
      <Blockers
        status={doctor.status}
        statusReason={doctor.statusReason}
        membershipDue={membership.data?.renewalDue ?? false}
        membershipStatus={membership.data?.status}
        substitutions={substitutions.data?.length ?? 0}
        shiftNeedsConfirming={Boolean(todaysShift && !todaysShift.confirmedAt)}
      />

      <section className="card-soft flex flex-wrap items-center justify-between gap-4 p-6">
        <div className="flex items-center gap-3">
          <Radio className={online ? "size-5 text-brand" : "size-5 text-slate-300"} />
          <div>
            <p className="font-bold">{online ? "You are available" : "You are offline"}</p>
            <p className="text-xs text-slate-500">
              {todaysShift
                ? `${todaysShift.shift.label} shift today, ${todaysShift.shift.startsAt}–${todaysShift.shift.endsAt}`
                : "No shift confirmed for today."}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            disabled={goOnline.isPending || goOffline.isPending}
            onClick={() => (online ? goOffline.mutate() : goOnline.mutate())}
            className={
              online
                ? "rounded-xl border border-border px-5 py-2.5 text-sm font-bold hover:bg-slate-50 disabled:opacity-40"
                : "rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
            }
          >
            {online ? "Go offline" : "Go online"}
          </button>
          <Link
            to="/doctor/queue"
            className="rounded-xl border border-border px-5 py-2.5 text-sm font-bold hover:bg-slate-50"
          >
            Queue
          </Link>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          icon={Clock}
          label="Hours this week"
          value={formatHours(doctor.serviceHours?.minutesServed ?? 0)}
          hint={`${formatHours(doctor.serviceHours?.minutesScheduled ?? 0)} scheduled`}
        />
        <Stat
          icon={Stethoscope}
          label="Consultations"
          value={String(earnings.data?.consultationsThisPeriod ?? 0)}
          hint="Completed this month"
        />
        <Stat
          icon={Wallet}
          label="This month"
          value={
            earnings.data?.monthlyMinor === null || earnings.data === undefined
              ? "—"
              : formatMinor(earnings.data.monthlyMinor, earnings.data.currency)
          }
          hint={
            earnings.data?.monthlyMinor === null
              ? "No contracted hours recorded"
              : "From your contracted hours"
          }
        />
      </div>

      {shifts.data && shifts.data.shifts.length > 0 && (
        <section className="card-soft p-6">
          <h2 className="flex items-center gap-2 font-bold">
            <CalendarClock className="size-4 text-brand" /> Your shifts
          </h2>
          <ul className="mt-4 divide-y divide-border">
            {shifts.data.shifts.slice(0, 6).map((shift) => (
              <li
                key={shift.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <p className="font-semibold">
                    {new Date(shift.serviceDate).toLocaleDateString(undefined, {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    })}
                  </p>
                  <p className="text-xs text-slate-500">
                    {shift.shift.label} · {shift.shift.startsAt}–{shift.shift.endsAt}
                  </p>
                </div>
                {shift.confirmedAt ? (
                  <Chip tone="medical">
                    <BadgeCheck className="mr-1 inline size-3" /> confirmed
                  </Chip>
                ) : (
                  <Link
                    to="/doctor/onboarding"
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-slate-50"
                  >
                    Confirm
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </AppShell>
  );
}

/**
 * What is stopping this doctor working, if anything.
 *
 * Rendered before the statistics because that is the order they matter in: a
 * doctor whose account is suspended does not need to know their hours.
 */
function Blockers({
  status,
  statusReason,
  membershipDue,
  membershipStatus,
  substitutions,
  shiftNeedsConfirming,
}: {
  status: string;
  statusReason: string | null;
  membershipDue: boolean;
  membershipStatus?: string;
  substitutions: number;
  shiftNeedsConfirming: boolean;
}) {
  const items: Array<{ tone: "danger" | "warn"; text: React.ReactNode }> = [];

  if (status !== "ACTIVE") {
    items.push({
      tone: "danger",
      text: (
        <>
          <strong className="font-bold">Your account is {status.toLowerCase()}.</strong>{" "}
          {statusReason ?? "You will not be offered consultations."}
        </>
      ),
    });
  }

  if (membershipDue && membershipStatus !== "ACTIVE") {
    items.push({
      tone: "danger",
      text: (
        <>
          <strong className="font-bold">Your membership needs paying.</strong>{" "}
          <Link to="/doctor/membership" className="underline">
            Renew it
          </Link>{" "}
          to keep receiving consultations.
        </>
      ),
    });
  } else if (membershipDue) {
    items.push({
      tone: "warn",
      text: (
        <>
          Your membership is ending soon.{" "}
          <Link to="/doctor/membership" className="underline">
            Renew early
          </Link>
          .
        </>
      ),
    });
  }

  if (substitutions > 0) {
    items.push({
      tone: "warn",
      text: (
        <>
          <strong className="font-bold">
            {substitutions} substitution{substitutions === 1 ? "" : "s"} awaiting your decision.
          </strong>{" "}
          A prescription cannot be dispensed until you answer.{" "}
          <Link to="/doctor/substitutions" className="underline">
            Review
          </Link>
        </>
      ),
    });
  }

  if (shiftNeedsConfirming) {
    items.push({
      tone: "warn",
      text: <>You have an unconfirmed shift today. Confirm it to receive consultations.</>,
    });
  }

  if (items.length === 0) return null;

  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div
          key={index}
          className={
            item.tone === "danger"
              ? "card-soft flex items-start gap-3 border-red-200 bg-red-50 p-5"
              : "card-soft flex items-start gap-3 border-amber-300/60 bg-amber-50 p-5"
          }
        >
          <ShieldAlert
            className={
              item.tone === "danger"
                ? "mt-0.5 size-5 shrink-0 text-red-500"
                : "mt-0.5 size-5 shrink-0 text-amber-600"
            }
          />
          <p
            className={
              item.tone === "danger"
                ? "text-sm leading-relaxed text-red-700"
                : "text-sm leading-relaxed text-amber-900"
            }
          >
            {item.text}
          </p>
        </div>
      ))}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="card-soft p-5">
      <div className="flex items-center gap-2 text-slate-400">
        <Icon className="size-4" />
        <span className="text-xs font-bold uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-1.5 text-2xl font-bold">{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
    </div>
  );
}
