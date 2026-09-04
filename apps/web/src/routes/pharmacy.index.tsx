import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowRight,
  FileText,
  Loader2,
  Plus,
  Stethoscope,
  Wallet,
} from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  formatMoney,
  usePharmacyConsultations,
  type PharmacyConsultation,
} from "@/features/consultation/api";
import { formatMinor, usePharmacyFinance } from "@/features/finance/api";
import { usePharmacyPrescriptions } from "@/features/clinical/api";

export const Route = createFileRoute("/pharmacy/")({
  component: PharmacyDashboard,
});

const STATE_TONE: Record<string, "brand" | "medical" | "warning" | "muted" | "danger"> = {
  PENDING_PAYMENT: "warning",
  PAYMENT_PROCESSING: "warning",
  PAYMENT_FAILED: "danger",
  ACTIVATED: "brand",
  WAITING_FOR_PATIENT: "brand",
  PATIENT_JOINED: "brand",
  WAITING_FOR_DOCTOR: "warning",
  ASSIGNED: "medical",
  DOCTOR_ACCEPTED: "medical",
  IN_PROGRESS: "medical",
  COMPLETED: "muted",
  CANCELLED: "muted",
  EXPIRED: "muted",
};

/**
 * The pharmacy's dashboard.
 *
 * These are real figures. Until Phase 9 this screen showed numbers invented
 * for the design prototype — GH₵ 1,420 of revenue that never existed — behind
 * a notice saying not to believe them.
 *
 * What a pharmacy sees here is its own: its consultations, its share, its
 * prescriptions. Never another pharmacy's, and never anything clinical — the
 * routes behind this return none of it (spec §73, D13).
 */
function PharmacyDashboard() {
  const live = usePharmacyConsultations(true);
  const finance = usePharmacyFinance();
  const prescriptions = usePharmacyPrescriptions(true);

  const waiting = (live.data ?? []).filter((row) =>
    ["WAITING_FOR_DOCTOR", "ASSIGNED", "REASSIGNING"].includes(row.state),
  );
  const needsPayment = (live.data ?? []).filter((row) =>
    ["PENDING_PAYMENT", "PAYMENT_PROCESSING", "PAYMENT_FAILED"].includes(row.state),
  );

  return (
    <AppShell active="pharmacy">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-sm font-semibold text-brand">Pharmacy</p>
          <h1 className="text-3xl font-bold tracking-tight">Today</h1>
        </div>
        <Link
          to="/pharmacy/new"
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-white hover:brightness-110"
        >
          <Plus className="size-4" /> New consultation
        </Link>
      </header>

      {live.error && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {live.error instanceof ApiError
              ? live.error.message
              : "Your consultations could not be loaded."}
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          icon={Stethoscope}
          label="In progress"
          value={String(live.data?.length ?? 0)}
          hint={waiting.length > 0 ? `${waiting.length} waiting for a doctor` : "None waiting"}
        />
        <Stat
          icon={FileText}
          label="To dispense"
          value={String(prescriptions.data?.length ?? 0)}
          hint="Prescriptions ready at the counter"
          to="/pharmacy/prescriptions"
        />
        <Stat
          icon={Wallet}
          label="Awaiting payout"
          value={
            finance.data
              ? formatMinor(finance.data.awaitingPayoutMinor, finance.data.currency)
              : "—"
          }
          hint={finance.data ? `${finance.data.consultations30Days} consultations in 30 days` : ""}
          to="/pharmacy/finance"
        />
      </div>

      {/*
        Payment first. A consultation stuck unpaid is the one thing the counter
        can fix immediately, and the patient is standing there.
      */}
      {needsPayment.length > 0 && (
        <section className="card-soft border-warning/40 bg-warning-soft p-5">
          <h2 className="font-bold text-warning">Waiting on payment</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {needsPayment.map((row) => (
              <li key={row.publicId}>
                <Link
                  to="/pharmacy/consultations/$publicId"
                  params={{ publicId: row.publicId }}
                  className="font-mono text-xs font-semibold underline"
                >
                  {row.publicId}
                </Link>{" "}
                — {formatMoney(row.net)}
                {row.secondsRemaining !== null && row.secondsRemaining > 0 && (
                  <span className="text-slate-600">
                    {" "}
                    · {Math.floor(row.secondsRemaining / 60)}:
                    {String(row.secondsRemaining % 60).padStart(2, "0")} left
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card-soft p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Consultations in progress</h2>
          {live.isLoading && <Loader2 className="size-4 animate-spin text-brand" />}
        </div>

        {live.data?.length === 0 ? (
          <div className="py-10 text-center">
            <Stethoscope className="mx-auto size-10 text-slate-300" />
            <p className="mt-3 text-sm text-slate-500">
              Nothing in progress. Start a consultation when a patient needs one.
            </p>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-border">
            {live.data?.map((row) => (
              <ConsultationRow key={row.publicId} row={row} />
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}

function ConsultationRow({ row }: { row: PharmacyConsultation }) {
  return (
    <li>
      <Link
        to="/pharmacy/consultations/$publicId"
        params={{ publicId: row.publicId }}
        className="flex flex-wrap items-center justify-between gap-3 py-3 hover:bg-slate-50"
      >
        <div className="min-w-0">
          <p className="font-mono text-xs font-semibold">{row.publicId}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {row.type ?? "Not yet chosen"}
            {row.language && ` · ${row.language.label}`} ·{" "}
            {new Date(row.createdAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Chip tone={STATE_TONE[row.state] ?? "muted"}>
            {row.state.replace(/_/g, " ").toLowerCase()}
          </Chip>
          <ArrowRight className="size-4 text-slate-300" />
        </div>
      </Link>
    </li>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  to,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  hint: string;
  to?: "/pharmacy/prescriptions" | "/pharmacy/finance";
}) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-slate-400">
        <Icon className="size-4" />
        <span className="text-xs font-bold uppercase tracking-wider">{label}</span>
      </div>
      <p className="mt-1.5 text-2xl font-bold">{value}</p>
      <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
    </>
  );

  return to ? (
    <Link to={to} className="card-soft p-5 transition-colors hover:bg-slate-50">
      {body}
    </Link>
  ) : (
    <div className="card-soft p-5">{body}</div>
  );
}
