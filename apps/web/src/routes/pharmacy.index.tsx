import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { todaySessions, statusMeta } from "@/lib/neem-data";
import {
  Plus,
  FileText,
  BarChart3,
  MessageSquareWarning,
  TrendingUp,
  Users,
  Wallet,
  ShieldCheck,
  Lock,
} from "lucide-react";


export const Route = createFileRoute("/pharmacy/")({
  component: PharmacyDashboard,
});

function StatCard({
  icon: Icon,
  label,
  value,
  delta,
  tone = "brand",
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  delta?: string;
  tone?: "brand" | "medical" | "warning";
}) {
  const tones = {
    brand: "bg-brand/10 text-brand",
    medical: "bg-medical/10 text-medical",
    warning: "bg-warning/15 text-warning",
  };
  return (
    <div className="card-soft p-5">
      <div className="flex items-start justify-between mb-4">
        <div className={`size-10 rounded-xl grid place-items-center ${tones[tone]}`}>
          <Icon className="size-5" />
        </div>
        {delta && (
          <span className="text-xs font-bold text-brand flex items-center gap-1">
            <TrendingUp className="size-3" /> {delta}
          </span>
        )}
      </div>
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}

function PharmacyDashboard() {
  return (
    <AppShell
      active="pharmacy"
      sidebar={
        <>
          <div className="bg-brand text-white p-6 rounded-3xl shadow-lg shadow-brand/20">
            <h2 className="text-lg font-bold mb-2">New Consultation</h2>
            <p className="text-white/80 text-sm mb-6">
              Start a secure session for a visiting patient.
            </p>
            <Link
              to="/pharmacy/new"
              className="block text-center w-full bg-white text-brand font-bold py-3 rounded-xl hover:bg-white/90 transition-colors"
            >
              + Initiate Request
            </Link>
          </div>

          <div className="card-soft p-5 space-y-3">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              Live Queue
            </h3>
            {todaySessions.filter((s) => s.status !== "completed").slice(0, 3).map((s) => {
              const meta = statusMeta[s.status];
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-3 p-3 bg-slate-50 rounded-2xl border border-slate-100"
                >
                  <div className="size-10 bg-brand/10 rounded-full grid place-items-center text-brand font-bold text-xs">
                    <Lock className="size-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold truncate font-mono">{s.id}</p>
                    <p className="text-xs text-slate-500 truncate">{meta.label}</p>
                  </div>
                  <Chip tone={meta.tone} pulse={s.status === "live"}>
                    {s.status === "live" ? "Live" : ""}
                  </Chip>
                </div>
              );
            })}
          </div>

          <div className="card-soft p-5">
            <p className="text-xs font-bold text-slate-400 uppercase mb-3">Quick Actions</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { icon: FileText, label: "Prescriptions" },
                { icon: BarChart3, label: "Reports" },
                { icon: Users, label: "Patients" },
                { icon: MessageSquareWarning, label: "Complaints" },
              ].map((q) => (
                <button
                  key={q.label}
                  className="p-3 rounded-xl border border-border hover:bg-slate-50 flex flex-col items-start gap-2 text-left"
                >
                  <q.icon className="size-4 text-slate-500" />
                  <span className="text-xs font-semibold">{q.label}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      }
    >
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-brand font-semibold mb-1">
            Akosua Pharmacy · Adabraka, Accra
          </p>
          <h1 className="text-3xl font-bold tracking-tight">Good morning, Nana</h1>
        </div>
        <Link
          to="/pharmacy/new"
          className="inline-flex items-center gap-2 bg-brand text-white font-semibold px-5 py-3 rounded-xl shadow-sm hover:brightness-110"
        >
          <Plus className="size-4" /> Start New Consultation
        </Link>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Users} label="Consultations Initiated" value="18" delta="+4" />
        <StatCard icon={Wallet} label="Revenue Today" value="GH₵ 1,420" delta="+12%" tone="medical" />
        <StatCard icon={FileText} label="Prescriptions Received" value="14" />
        <StatCard icon={ShieldCheck} label="Privacy Mode" value="Active" tone="medical" />
      </div>

      <div className="card-soft p-4 flex items-start gap-3 bg-medical/5 border border-medical/20">
        <ShieldCheck className="size-5 text-medical shrink-0 mt-0.5" />
        <div className="text-xs text-slate-600 leading-relaxed">
          <span className="font-bold text-medical">Patient privacy is protected.</span> Your pharmacy only sees
          the session ID, first name, age range, and gender. Consultation content, medical history, and
          diagnoses are never shared with the pharmacy. Only the final prescription is delivered here.
        </div>
      </div>

      <div className="card-soft overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h3 className="font-bold">Ongoing Consultations</h3>
          <Chip tone="brand" pulse>
            Live
          </Chip>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[520px]">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400 bg-slate-50/50">
                <th className="px-6 py-3 font-semibold">Session</th>
                <th className="px-6 py-3 font-semibold">Patient</th>
                <th className="px-6 py-3 font-semibold">Status</th>
                <th className="px-6 py-3 font-semibold text-right">Access</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {todaySessions.filter((s) => s.status !== "completed").map((s) => {
                const meta = statusMeta[s.status];
                return (
                  <tr key={s.id} className="hover:bg-slate-50/60">
                    <td className="px-6 py-4 font-mono text-xs text-slate-500">{s.id}</td>
                    <td className="px-6 py-4">
                      <div className="font-semibold">{s.patient.split(" ")[0]}</div>
                      <div className="text-xs text-slate-500">
                        {s.gender} · {s.ageRange}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <Chip tone={meta.tone} pulse={s.status === "live"}>
                        {meta.label}
                      </Chip>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <span className="inline-flex items-center gap-1 text-xs text-slate-400 font-medium">
                        <Lock className="size-3" /> Private
                      </span>
                    </td>
                  </tr>
                );
              })}
              {todaySessions.filter((s) => s.status !== "completed").length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-10 text-center text-sm text-slate-400">
                    No active consultations right now.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card-soft p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-bold">Drug Prescriptions Received</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Only prescriptions are shared with the pharmacy — no diagnosis or notes.
              </p>
            </div>
            <span className="text-xs font-bold text-brand">14 today</span>
          </div>
          <div className="space-y-3">
            {[
              { drug: "Amoxicillin 500mg", dose: "1 cap TID × 7 days", patient: "Efua · F · 30–40", session: "NM-99279" },
              { drug: "Paracetamol 500mg", dose: "2 caps every 6 hrs PRN", patient: "Yaw · M · 50–60", session: "NM-99278" },
              { drug: "Artemether-Lumefantrine", dose: "4 tabs BID × 3 days", patient: "Adjoa · F · 30–40", session: "NM-99277" },
            ].map((p) => (
              <div
                key={p.session}
                className="flex items-center gap-4 p-3 rounded-xl border border-border bg-slate-50/40"
              >
                <div className="size-9 rounded-lg bg-medical/10 text-medical grid place-items-center">
                  <FileText className="size-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">{p.drug}</p>
                  <p className="text-xs text-slate-500 truncate">
                    {p.dose} · {p.patient} · <span className="font-mono">{p.session}</span>
                  </p>
                </div>
                <button className="text-xs font-semibold text-brand shrink-0">Dispense</button>
              </div>
            ))}
          </div>
        </div>


        <div className="card-soft p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold">Weekly Revenue</h3>
            <span className="text-xs font-bold text-brand">+18% vs last week</span>
          </div>
          <div className="flex items-end gap-2 h-40 mb-4">
            {[40, 65, 55, 80, 50, 90, 100].map((h, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-2">
                <div
                  className={`w-full rounded-lg ${i === 6 ? "bg-brand" : "bg-brand/25"}`}
                  style={{ height: `${h}%` }}
                />
                <span className="text-[10px] text-slate-400 font-medium">
                  {["M", "T", "W", "T", "F", "S", "S"][i]}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-2xl font-bold">GH₵ 8,940</p>
              <p className="text-xs text-slate-500">Pharmacy share: GH₵ 3,576</p>
            </div>
            <div className="text-right">
              <p className="text-xs font-bold text-slate-400 uppercase">Payouts</p>
              <p className="text-xs text-slate-500 mt-1">Next: Friday</p>
            </div>

          </div>
        </div>
      </div>
    </AppShell>
  );
}
