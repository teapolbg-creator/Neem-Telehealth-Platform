import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Ambulance, Loader2, Send } from "lucide-react";
import {
  REFERRAL_STATUSES,
  REFERRAL_STATUS_LABELS,
  REFERRAL_URGENCY_LABELS,
  type ReferralStatus,
} from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { inputClass } from "@/features/facility/form";
import { REFERRAL_STATUS_TONE, useReferralRegister } from "@/features/facility/referrals";

export const Route = createFileRoute("/facility/referrals")({
  component: ReferralRegister,
});

/**
 * The facility's referral register (slice 2a, D80): every patient sent on,
 * and whether anybody has heard back. Waiting ones first, by default.
 */
function ReferralRegister() {
  const [view, setView] = useState<"open" | ReferralStatus | "all">("open");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const register = useReferralRegister({
    open: view === "open",
    status: view !== "open" && view !== "all" ? view : undefined,
    from: from || undefined,
    to: to || undefined,
  });

  return (
    <AppShell active="facility">
      <div className="mx-auto w-full max-w-6xl">
        <p className="text-xs font-bold uppercase tracking-wider text-brand">Referrals</p>
        <h1 className="mt-1 text-3xl font-bold">Referral register</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Patients sent on from this facility. A referral stays “not yet confirmed” until you record
          what the receiving facility told you.
        </p>

        <div className="card-soft mt-6 flex flex-wrap items-end gap-3 p-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold text-slate-500">Show</span>
            <select
              value={view}
              onChange={(event) => setView(event.target.value as typeof view)}
              className={inputClass}
            >
              <option value="open">Waiting for news</option>
              <option value="all">All</option>
              {REFERRAL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {REFERRAL_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold text-slate-500">Sent from</span>
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-semibold text-slate-500">to</span>
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        {register.isLoading ? (
          <div className="card-soft mt-4 grid place-items-center p-12">
            <Loader2 className="size-6 animate-spin text-brand" />
          </div>
        ) : null}
        {register.error ? (
          <div className="card-soft mt-4 flex items-start gap-3 border-red-200 bg-red-50 p-6">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-700">
              {register.error instanceof ApiError
                ? register.error.message
                : "The register could not be loaded."}
            </p>
          </div>
        ) : null}

        {register.data && register.data.length === 0 ? (
          <p className="card-soft mt-4 p-10 text-center text-sm text-slate-500">
            No referrals match.
          </p>
        ) : null}

        {register.data && register.data.length > 0 ? (
          <div className="card-soft mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Sent</th>
                  <th className="px-4 py-3 font-semibold">Patient</th>
                  <th className="px-4 py-3 font-semibold">To</th>
                  <th className="px-4 py-3 font-semibold">Urgency</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {register.data.map((row) => (
                  <tr key={row.publicId} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-600">
                      {new Date(row.issuedAt).toLocaleDateString()}
                      <p className="font-mono text-xs text-slate-400">{row.publicId}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to="/facility/patients/$patientNumber"
                        params={{ patientNumber: row.patient.patientNumber }}
                        className="font-semibold hover:text-brand"
                      >
                        {row.patient.fullName}
                      </Link>
                      <p className="font-mono text-xs text-slate-400">
                        {row.patient.patientNumber}
                      </p>
                    </td>
                    <td className="px-4 py-3">{row.destinationName}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        {row.urgency === "EMERGENCY" ? (
                          <Ambulance className="size-4 text-red-600" />
                        ) : (
                          <Send className="size-4 text-slate-400" />
                        )}
                        {REFERRAL_URGENCY_LABELS[row.urgency]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Chip tone={REFERRAL_STATUS_TONE[row.status]}>
                        {REFERRAL_STATUS_LABELS[row.status]}
                      </Chip>
                      {row.daysOutstanding !== null && row.daysOutstanding > 0 ? (
                        <p className="mt-1 text-xs text-amber-700">
                          {row.daysOutstanding} day{row.daysOutstanding === 1 ? "" : "s"} without
                          news
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
