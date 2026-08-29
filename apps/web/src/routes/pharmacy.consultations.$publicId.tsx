import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, ArrowLeft, Loader2, Lock, User } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  formatMoney,
  useCancelConsultation,
  useConsultation,
  type PharmacyConsultation,
} from "@/features/consultation/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/pharmacy/consultations/$publicId")({
  component: ConsultationMonitor,
});

const STATE_TONE: Record<string, "brand" | "medical" | "warning" | "muted" | "danger"> = {
  PENDING_PAYMENT: "warning",
  PAYMENT_PROCESSING: "warning",
  PAYMENT_FAILED: "danger",
  PAID: "medical",
  ACTIVATED: "medical",
  WAITING_FOR_PATIENT: "medical",
  PATIENT_JOINED: "medical",
  WAITING_FOR_DOCTOR: "warning",
  ASSIGNED: "medical",
  DOCTOR_ACCEPTED: "brand",
  IN_PROGRESS: "brand",
  COMPLETED: "muted",
  CANCELLED: "muted",
  EXPIRED: "muted",
};

const STATE_LABEL: Record<string, string> = {
  PENDING_PAYMENT: "Awaiting payment",
  PAYMENT_PROCESSING: "Payment in progress",
  PAYMENT_FAILED: "Payment failed",
  PAID: "Paid",
  ACTIVATED: "Ready — awaiting patient",
  WAITING_FOR_PATIENT: "Patient scanning",
  PATIENT_JOINED: "Patient joined",
  WAITING_FOR_DOCTOR: "Finding a doctor",
  ASSIGNED: "Doctor assigned",
  DOCTOR_ACCEPTED: "Doctor accepted",
  IN_PROGRESS: "Consultation live",
  COMPLETING: "Completing",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

/**
 * The pharmacy's view of one consultation (spec §73).
 *
 * Shows status, the temporary patient panel, and the actions available. What it
 * deliberately does NOT show is any clinical content — the pharmacy never sees
 * notes, diagnosis or treatment, at any point.
 */
function ConsultationMonitor() {
  const { publicId } = Route.useParams();
  const { data: consultation, isLoading, error } = useConsultation(publicId, true);
  const cancel = useCancelConsultation();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  if (isLoading) {
    return (
      <AppShell active="pharmacy">
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      </AppShell>
    );
  }

  if (error || !consultation) {
    return (
      <AppShell active="pharmacy">
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {error instanceof ApiError ? error.message : "Could not load this consultation."}
          </p>
        </div>
      </AppShell>
    );
  }

  const live = !["COMPLETED", "CANCELLED", "EXPIRED", "ABANDONED", "REFUNDED"].includes(
    consultation.state,
  );

  return (
    <AppShell active="pharmacy">
      <Link
        to="/pharmacy"
        className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-brand"
      >
        <ArrowLeft className="size-4" /> Back to dashboard
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs text-slate-500">{consultation.publicId}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            {STATE_LABEL[consultation.state] ?? consultation.state}
          </h1>
        </div>
        <Chip tone={STATE_TONE[consultation.state] ?? "muted"} pulse={live}>
          {STATE_LABEL[consultation.state] ?? consultation.state}
        </Chip>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="card-soft p-6">
            <h2 className="mb-4 font-bold">Progress</h2>
            <Timeline consultation={consultation} />
          </section>

          {live && (
            <section className="card-soft p-6">
              <h2 className="mb-1 font-bold">Actions</h2>
              <p className="mb-4 text-xs text-slate-500">
                A consultation cannot be cancelled once a doctor has accepted it.
              </p>

              {cancelling ? (
                <div className="rounded-2xl border border-border bg-slate-50 p-4">
                  <label className="block">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                      Reason for cancelling
                    </span>
                    <textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      rows={2}
                      className="mt-1.5 w-full resize-none rounded-xl border border-border bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
                    />
                  </label>

                  {/* Spec §37 — a paid consultation is never silently discarded. */}
                  {["PAID", "ACTIVATED", "WAITING_FOR_PATIENT", "PATIENT_JOINED", "WAITING_FOR_DOCTOR"].includes(
                    consultation.state,
                  ) && (
                    <p className="mt-2 text-xs text-slate-600">
                      This consultation has been paid for. Cancelling raises a refund request for
                      Neem administration to review.
                    </p>
                  )}

                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      disabled={cancel.isPending || reason.trim().length < 3}
                      onClick={() =>
                        cancel.mutate(
                          { publicId, reason: reason.trim() },
                          { onSuccess: () => setCancelling(false) },
                        )
                      }
                      className="rounded-xl bg-red-500 px-4 py-2 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-40"
                    >
                      Cancel consultation
                    </button>
                    <button
                      type="button"
                      onClick={() => setCancelling(false)}
                      className="rounded-xl border border-border bg-white px-4 py-2 text-xs font-semibold"
                    >
                      Keep it open
                    </button>
                  </div>

                  {cancel.error && (
                    <p className="mt-2 text-xs text-red-600">
                      {cancel.error instanceof ApiError
                        ? cancel.error.message
                        : "Could not cancel."}
                    </p>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setCancelling(true)}
                  className="rounded-xl border border-red-200 px-4 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"
                >
                  Cancel consultation
                </button>
              )}
            </section>
          )}
        </div>

        <aside className="space-y-6">
          <section className="card-soft p-6">
            <h2 className="mb-1 font-bold">Patient</h2>
            {consultation.patient ? (
              <>
                <p className="mb-4 text-xs text-slate-500">
                  Visible only while this consultation is live.
                </p>
                <dl className="space-y-3 text-sm">
                  <Detail label="Name" value={consultation.patient.fullName} />
                  <Detail
                    label="Age and sex"
                    value={`${consultation.patient.age} · ${consultation.patient.sex.toLowerCase()}`}
                  />
                  <Detail label="Phone" value={consultation.patient.phone} />
                </dl>
              </>
            ) : (
              <div className="rounded-2xl bg-slate-50 p-4 text-center">
                <User className="mx-auto size-6 text-slate-300" />
                <p className="mt-2 text-xs text-slate-500">
                  {consultation.state === "COMPLETED"
                    ? "Patient details were deleted when the consultation ended."
                    : "The patient has not entered their details yet."}
                </p>
              </div>
            )}
          </section>

          {/*
            States plainly what the pharmacy will and will not receive. The
            prototype made a similar promise; this one is enforced by the API,
            which has no route that returns clinical content to a pharmacy.
          */}
          <section className="card-soft border-medical/20 bg-medical/5 p-4">
            <div className="flex items-start gap-3">
              <Lock className="mt-0.5 size-4 shrink-0 text-medical" />
              <p className="text-xs leading-relaxed text-slate-600">
                <span className="font-bold text-medical">The consultation is private.</span> You will
                receive a prescription or referral if the doctor issues one. Clinical notes and
                diagnoses are never shared with the pharmacy, and are sealed when the consultation
                ends.
              </p>
            </div>
          </section>

          <section className="card-soft p-6">
            <h2 className="mb-4 font-bold">Details</h2>
            <dl className="space-y-3 text-sm">
              <Detail label="Amount" value={formatMoney(consultation.net)} />
              <Detail label="Payment" value={consultation.paymentStatus} />
              <Detail label="Language" value={consultation.language?.label ?? "Not chosen yet"} />
              <Detail
                label="Type"
                value={consultation.type?.replace("_", " ").toLowerCase() ?? "Not chosen yet"}
              />
              <Detail label="Doctor" value={consultation.doctor?.fullName ?? "Not assigned yet"} />
            </dl>
          </section>
        </aside>
      </div>
    </AppShell>
  );
}

function Timeline({ consultation }: { consultation: PharmacyConsultation }) {
  const stages: Array<{ label: string; at: string | null }> = [
    { label: "Consultation created", at: consultation.createdAt },
    { label: "Payment confirmed", at: consultation.activatedAt },
    { label: "Patient joined", at: consultation.patientJoinedAt },
    { label: "Consultation started", at: consultation.startedAt },
    { label: "Completed", at: consultation.completedAt },
  ];

  return (
    <ol className="space-y-3">
      {stages.map((stage) => (
        <li key={stage.label} className="flex items-center gap-3">
          <div
            className={cn(
              "size-2.5 shrink-0 rounded-full",
              stage.at ? "bg-brand" : "bg-slate-200",
            )}
          />
          <span className={cn("flex-1 text-sm", stage.at ? "font-medium" : "text-slate-400")}>
            {stage.label}
          </span>
          <span className="text-xs tabular-nums text-slate-500">
            {stage.at
              ? new Date(stage.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : "—"}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className="mt-0.5 capitalize">{value}</dd>
    </div>
  );
}
