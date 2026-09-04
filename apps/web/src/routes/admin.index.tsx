import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity,
  AlertCircle,
  Archive,
  Clock,
  FlaskConical,
  Loader2,
  Stethoscope,
  Timer,
  Users,
  Wallet,
} from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { formatMinor } from "@/features/finance/api";
import {
  useFinancialSummary,
  useOperationalSummary,
  useOutcomeMix,
  useSatisfactionSummary,
  useSystemHealth,
  type ClinicalCoverage,
} from "@/features/analytics/api";

export const Route = createFileRoute("/admin/")({
  component: AdminOverview,
});

/**
 * The administrator's overview (spec §54, §100).
 *
 * These are real figures. Until Phase 9 this screen carried numbers invented
 * for the design prototype — GH₵ 68,420 of revenue that never existed — behind
 * a notice saying so. A dashboard that has to warn you not to believe it is
 * not a dashboard.
 *
 * Everything here is operational: counts, durations, money. Nothing is derived
 * from a clinical record, so nothing degrades as records are destroyed under
 * the retention policy — and where a figure *could* be affected, its coverage
 * is stated rather than assumed.
 */
function AdminOverview() {
  const operational = useOperationalSummary();
  const financial = useFinancialSummary();
  const satisfaction = useSatisfactionSummary();
  const outcomes = useOutcomeMix();
  const health = useSystemHealth();

  const loading = operational.isLoading || financial.isLoading;
  const error = operational.error ?? financial.error;

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
        <p className="mt-2 text-sm text-slate-500">The last 30 days.</p>
      </header>

      {/*
        Demo mode, stated where an administrator will see it.

        A mocked payment provider means this deployment takes no money and
        every activation is free — which is correct for a demonstration and
        catastrophic to mistake for production. It is worth the space at the
        top of the overview, above the figures, because it changes what all
        of those figures mean.
      */}
      {health.data?.demoMode && (
        <div className="card-soft flex items-start gap-3 border-amber-300/60 bg-amber-50 p-5">
          <FlaskConical className="mt-0.5 size-5 shrink-0 text-amber-600" />
          <div className="text-sm leading-relaxed text-amber-900">
            <strong className="font-bold">Demo mode.</strong>{" "}
            {health.data.mockedProviders.join(", ")}{" "}
            {health.data.mockedProviders.length === 1 ? "is" : "are"} mocked, so no money moves and
            no message leaves this system. The figures below are real records of simulated activity.
          </div>
        </div>
      )}

      {health.data?.database.status === "down" && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-5">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            <strong className="font-bold">The database is unreachable.</strong> Consultations cannot
            be created or paid for until it returns.
          </p>
        </div>
      )}

      {loading && (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      )}

      {error && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {error instanceof ApiError ? error.message : "The overview could not be loaded."}
          </p>
        </div>
      )}

      {operational.data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              icon={Stethoscope}
              label="Consultations"
              value={String(operational.data.consultations.created)}
              hint={`${operational.data.consultations.completed} completed`}
            />
            <Stat
              icon={Timer}
              label="Waiting now"
              value={String(operational.data.queue.waitingNow)}
              hint={
                operational.data.queue.medianTimeToDoctorSeconds === null
                  ? "No wait recorded yet"
                  : `Median ${Math.round(operational.data.queue.medianTimeToDoctorSeconds)}s to a doctor`
              }
              tone={operational.data.queue.waitingNow > 0 ? "warn" : undefined}
            />
            <Stat
              icon={Users}
              label="Doctors online"
              value={String(operational.data.doctors.onlineNow)}
              hint={`${operational.data.doctors.active} active`}
            />
            <Stat
              icon={Wallet}
              label="Net revenue"
              value={
                financial.data ? formatMinor(financial.data.netMinor, financial.data.currency) : "—"
              }
              hint={financial.data ? `${financial.data.paidConsultations} paid consultations` : ""}
            />
          </div>

          {/*
            The queue's failures, not its successes. A missed offer and a
            language starvation are the two things an administrator can act on
            today, so they are on the overview rather than buried a click away.
          */}
          {(operational.data.queue.noLanguageMatch > 0 ||
            operational.data.queue.missedOffers > 0) && (
            <section className="card-soft border-amber-300/60 bg-amber-50 p-5">
              <h2 className="flex items-center gap-2 font-bold text-amber-900">
                <AlertCircle className="size-4" /> Needs attention
              </h2>
              <ul className="mt-2 space-y-1 text-sm text-amber-900">
                {operational.data.queue.noLanguageMatch > 0 && (
                  <li>
                    {operational.data.queue.noLanguageMatch} consultation
                    {operational.data.queue.noLanguageMatch === 1 ? "" : "s"} could not be matched
                    to a doctor speaking the patient’s language.{" "}
                    <Link to="/admin/queue" className="font-semibold underline">
                      Live queue
                    </Link>
                  </li>
                )}
                {operational.data.queue.missedOffers > 0 && (
                  <li>
                    {operational.data.queue.missedOffers} offer
                    {operational.data.queue.missedOffers === 1 ? "" : "s"} went unanswered inside
                    the response window.
                  </li>
                )}
              </ul>
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <ConsultationBreakdown data={operational.data} />
            {financial.data && <FinancialBreakdown data={financial.data} />}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {outcomes.data && <Outcomes data={outcomes.data} />}
            {satisfaction.data && <Satisfaction data={satisfaction.data} />}
          </div>
        </>
      )}
    </AppShell>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  hint: string;
  tone?: "warn";
}) {
  return (
    <div className="card-soft p-5">
      <div className="flex items-center gap-2 text-slate-400">
        <Icon className={tone === "warn" ? "size-4 text-warning" : "size-4"} />
        <span className="text-xs font-bold uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-1.5 text-2xl font-bold">{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function ConsultationBreakdown({
  data,
}: {
  data: NonNullable<ReturnType<typeof useOperationalSummary>["data"]>;
}) {
  const { consultations, consultationMinutes } = data;

  const rows = [
    { label: "Completed", value: consultations.completed },
    { label: "Cancelled", value: consultations.cancelled },
    { label: "Expired unused", value: consultations.expired },
    { label: "Abandoned", value: consultations.abandoned },
    { label: "Refunded", value: consultations.refunded },
  ];

  return (
    <section className="card-soft p-6">
      <h2 className="flex items-center gap-2 font-bold">
        <Activity className="size-4 text-brand" /> Consultations
      </h2>

      <p className="mt-3 text-sm text-slate-600">
        {consultations.completionRate === null
          ? "Nothing has been paid for in this period."
          : `${Math.round(consultations.completionRate * 100)}% of paid consultations completed.`}
      </p>

      <dl className="mt-4 space-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between gap-4">
            <dt className="text-slate-500">{row.label}</dt>
            <dd className="font-semibold tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-4 flex items-center gap-2 border-t border-border pt-4 text-sm text-slate-600">
        <Clock className="size-4 text-slate-400" />
        {consultationMinutes.median === null
          ? "No completed consultation to measure yet."
          : `Median ${consultationMinutes.median.toFixed(1)} minutes, ${consultationMinutes.total} minutes in total.`}
      </p>
    </section>
  );
}

function FinancialBreakdown({
  data,
}: {
  data: NonNullable<ReturnType<typeof useFinancialSummary>["data"]>;
}) {
  return (
    <section className="card-soft p-6">
      <h2 className="flex items-center gap-2 font-bold">
        <Wallet className="size-4 text-brand" /> Money
      </h2>

      <dl className="mt-4 space-y-2 text-sm">
        <Row label="Gross" value={formatMinor(data.grossMinor, data.currency)} />
        <Row label="Discounts given" value={formatMinor(data.discountMinor, data.currency)} />
        <Row label="Net" value={formatMinor(data.netMinor, data.currency)} strong />
        <Row label="Pharmacy share" value={formatMinor(data.pharmacyShareMinor, data.currency)} />
        <Row label="Neem share" value={formatMinor(data.neemShareMinor, data.currency)} />
        <Row label="Doctor memberships" value={formatMinor(data.membershipMinor, data.currency)} />
      </dl>

      {/*
        Refunds are reported separately rather than subtracted. A refunded
        consultation never earned anything, and netting it off unrelated
        revenue makes the total impossible to reconcile against the
        consultations behind it.
      */}
      <div className="mt-4 border-t border-border pt-4 text-sm">
        <Row label="Refunded" value={formatMinor(data.refundedMinor, data.currency)} />
        {data.reversedAllocations > 0 && (
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {data.reversedAllocations} allocation
            {data.reversedAllocations === 1 ? " was" : "s were"} reversed by a refund and are
            excluded from the figures above, not netted off them.
          </p>
        )}
      </div>
    </section>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  ADVICE_ONLY: "Advice only",
  PRESCRIPTION: "Prescription",
  REFERRAL: "Referral",
  EMERGENCY_REFERRAL: "Emergency referral",
  OTHER: "Other",
};

function Outcomes({ data }: { data: NonNullable<ReturnType<typeof useOutcomeMix>["data"]> }) {
  const total = data.outcomes.reduce((sum, row) => sum + row.count, 0);

  return (
    <section className="card-soft p-6">
      <h2 className="flex items-center gap-2 font-bold">
        <Stethoscope className="size-4 text-brand" /> What consultations concluded with
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        The kind of document issued — never what was in it.
      </p>

      {total === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No consultation has completed in this period.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {data.outcomes.map((row) => (
            <li key={row.outcome}>
              <div className="flex justify-between gap-4 text-sm">
                <span className="text-slate-600">{OUTCOME_LABEL[row.outcome] ?? row.outcome}</span>
                <span className="font-semibold tabular-nums">{row.count}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand"
                  style={{ width: `${(row.count / total) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {data.unrecorded > 0 && (
        <p className="mt-3 text-xs text-slate-500">
          {data.unrecorded} completed consultation{data.unrecorded === 1 ? "" : "s"} recorded no
          outcome and {data.unrecorded === 1 ? "is" : "are"} not in the mix above.
        </p>
      )}

      <CoverageNotice coverage={data.coverage} />
    </section>
  );
}

/**
 * States plainly when a period's clinical records have been destroyed.
 *
 * The Phase 9 exit criterion: analytics must never manufacture deleted
 * clinical data. For a recent period this renders nothing, because there is
 * nothing to say — and it exists for the day there is.
 */
function CoverageNotice({ coverage }: { coverage: ClinicalCoverage }) {
  if (coverage.complete) return null;

  return (
    <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-300/60 bg-amber-50 p-3">
      <Archive className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <p className="text-xs leading-relaxed text-amber-900">
        <strong className="font-bold">This period is no longer complete.</strong>{" "}
        {coverage.recordsDestroyed} of {coverage.consultationsInPeriod} clinical records have
        reached the end of their retention period and been destroyed. Figures derived from them
        cannot be recovered and are not estimated.
      </p>
    </div>
  );
}

function Satisfaction({
  data,
}: {
  data: NonNullable<ReturnType<typeof useSatisfactionSummary>["data"]>;
}) {
  return (
    <section className="card-soft p-6">
      <h2 className="flex items-center gap-2 font-bold">
        <Users className="size-4 text-brand" /> What patients said
      </h2>

      {data.responses === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No feedback has been given in this period.</p>
      ) : (
        <>
          <div className="mt-4 flex gap-6">
            <div>
              <p className="text-2xl font-bold">{data.meanDoctorRating?.toFixed(1) ?? "—"}</p>
              <p className="text-xs text-slate-500">The doctor</p>
            </div>
            <div>
              <p className="text-2xl font-bold">{data.meanNeemRating?.toFixed(1) ?? "—"}</p>
              <p className="text-xs text-slate-500">Neem</p>
            </div>
          </div>

          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Responses" value={String(data.responses)} />
            <Row
              label="Response rate"
              value={data.responseRate === null ? "—" : `${Math.round(data.responseRate * 100)}%`}
            />
            <Row label="Compliments" value={String(data.compliments)} />
            <Row label="Suggestions" value={String(data.suggestions)} />
            <Row label="Complaints" value={String(data.complaints)} />
          </dl>
        </>
      )}

      {data.openComplaints > 0 && (
        <p className="mt-4 border-t border-border pt-4">
          <Chip tone="warning">
            {data.openComplaints} open complaint{data.openComplaints === 1 ? "" : "s"}
          </Chip>
        </p>
      )}
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className={strong ? "font-bold tabular-nums" : "font-semibold tabular-nums"}>{value}</dd>
    </div>
  );
}
