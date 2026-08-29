import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { doctors, pharmacies } from "@/lib/neem-data";
import {
  Activity,
  Users,
  Building2,
  Wallet,
  Timer,
  ShieldCheck,
  BarChart3,
  MapPin,
  Star,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/")({
  component: AdminDashboard,
});

function AdminDashboard() {
  return (
    <AppShell active="admin">
      <header className="flex flex-wrap justify-between items-end gap-4">
        <div>
          <p className="text-sm text-brand font-semibold mb-1">Neem Administration</p>
          <h1 className="text-3xl font-bold tracking-tight">Executive Overview</h1>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone="brand" pulse>
            System healthy
          </Chip>
          <select className="px-4 py-2 rounded-xl border border-border bg-white text-sm font-semibold">
            <option>Today</option>
            <option>Last 7 days</option>
            <option>Last 30 days</option>
          </select>
        </div>
      </header>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPI icon={Activity} label="Live consultations" value="142" tone="brand" delta="+18" />
        <KPI icon={Users} label="Doctors online" value="48 / 62" tone="medical" />
        <KPI icon={Building2} label="Active pharmacies" value="312" delta="+4" />
        <KPI icon={Wallet} label="Revenue today" value="GH₵ 68,420" tone="brand" delta="+12%" />
        <KPI icon={Timer} label="Avg wait" value="8m 14s" />
        <KPI icon={Star} label="Satisfaction" value="4.7 / 5" tone="warning" />
        <KPI icon={ShieldCheck} label="Uptime" value="99.98%" tone="medical" />
        <KPI icon={AlertTriangle} label="Escalations" value="3 open" tone="warning" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card-soft p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-5">
            <h3 className="font-bold">Consultations by hour</h3>
            <div className="flex gap-2 text-xs">
              <Chip tone="brand">Live</Chip>
              <Chip tone="medical">Completed</Chip>
            </div>
          </div>
          <div className="flex items-end gap-2 h-56">
            {[30, 45, 52, 60, 75, 92, 100, 88, 76, 65, 58, 42].map((h, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-2">
                <div className="w-full rounded-lg bg-medical/25" style={{ height: `${h * 0.7}%` }} />
                <div
                  className={cn(
                    "w-full rounded-lg -mt-2",
                    i === 6 ? "bg-brand" : "bg-brand/40",
                  )}
                  style={{ height: `${h * 0.3}%` }}
                />
                <span className="text-[10px] text-slate-400 font-medium">{6 + i}:00</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card-soft p-6">
          <h3 className="font-bold mb-4">Language demand</h3>
          <div className="space-y-3">
            {[
              { lang: "English", pct: 45, tone: "brand" },
              { lang: "Twi", pct: 28, tone: "medical" },
              { lang: "Ga", pct: 12, tone: "brand" },
              { lang: "Hausa", pct: 9, tone: "medical" },
              { lang: "Ewe", pct: 6, tone: "brand" },
            ].map((l) => (
              <div key={l.lang}>
                <div className="flex justify-between text-xs font-semibold mb-1">
                  <span>{l.lang}</span>
                  <span className="text-slate-500">{l.pct}%</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={l.tone === "brand" ? "h-full bg-brand" : "h-full bg-medical"}
                    style={{ width: `${l.pct}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Doctors */}
        <div className="card-soft overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h3 className="font-bold">Doctor management</h3>
            <button className="text-xs font-semibold text-brand">View all →</button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase text-slate-400 bg-slate-50/60">
                <th className="px-5 py-3 font-semibold">Doctor</th>
                <th className="px-5 py-3 font-semibold">Rating</th>
                <th className="px-5 py-3 font-semibold">Hours</th>
                <th className="px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {doctors.map((d) => (
                <tr key={d.id}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <img
                        src={d.photo}
                        alt={d.name}
                        width={36}
                        height={36}
                        className="size-9 rounded-full object-cover"
                      />
                      <div className="min-w-0">
                        <p className="font-semibold truncate">{d.name}</p>
                        <p className="text-[11px] text-slate-500">{d.mdc}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3 font-semibold">{d.rating} ★</td>
                  <td className="px-5 py-3">{d.weeklyHours}h</td>
                  <td className="px-5 py-3">
                    <Chip tone="brand" pulse>
                      Online
                    </Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pharmacies */}
        <div className="card-soft overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h3 className="font-bold">Pharmacy network</h3>
            <button className="text-xs font-semibold text-brand">View all →</button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase text-slate-400 bg-slate-50/60">
                <th className="px-5 py-3 font-semibold">Pharmacy</th>
                <th className="px-5 py-3 font-semibold">Sessions</th>
                <th className="px-5 py-3 font-semibold">Revenue</th>
                <th className="px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {pharmacies.map((p) => (
                <tr key={p.id}>
                  <td className="px-5 py-3">
                    <p className="font-semibold">{p.name}</p>
                    <p className="text-[11px] text-slate-500 flex items-center gap-1">
                      <MapPin className="size-3" /> {p.city}
                    </p>
                  </td>
                  <td className="px-5 py-3">{p.consultations}</td>
                  <td className="px-5 py-3 font-mono">GH₵ {p.revenue.toLocaleString()}</td>
                  <td className="px-5 py-3">
                    <Chip tone={p.status === "active" ? "brand" : "warning"}>{p.status}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card-soft p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold">Smart Queue · live assignment</h3>
            <Chip tone="brand" pulse>
              Auto-assigning
            </Chip>
          </div>
          <p className="text-xs text-slate-500 mb-4">
            Doctors are matched by workload, language, availability, and performance.
          </p>
          <div className="space-y-3">
            {[
              { lang: "Twi", wait: "1m", pos: 1, doc: "Dr. Ama Boateng" },
              { lang: "English", wait: "3m", pos: 2, doc: "Dr. Kwame Owusu" },
              { lang: "Hausa", wait: "6m", pos: 3, doc: "Assigning..." },
            ].map((q, i) => (
              <div key={i} className="flex items-center gap-4 p-4 rounded-2xl bg-slate-50 border border-border">
                <div className="size-10 rounded-xl bg-brand/10 text-brand font-bold grid place-items-center">
                  #{q.pos}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm">Waiting · {q.lang}</p>
                  <p className="text-xs text-slate-500">Assigned: {q.doc}</p>
                </div>
                <Chip tone="medical">{q.wait} wait</Chip>
              </div>
            ))}
          </div>
        </div>

        <div className="card-soft p-6">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="size-4 text-brand" />
            <h3 className="font-bold">Financial split</h3>
          </div>
          <div className="space-y-3">
            {[
              { label: "Doctor earnings", value: "GH₵ 27,368", pct: 40, tone: "brand" },
              { label: "Pharmacy share", value: "GH₵ 20,526", pct: 30, tone: "medical" },
              { label: "Platform", value: "GH₵ 20,526", pct: 30, tone: "warning" },
            ].map((r) => (
              <div key={r.label} className="p-3 rounded-xl bg-slate-50 border border-border">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold">{r.label}</span>
                  <span className="text-sm font-bold">{r.value}</span>
                </div>
                <div className="h-2 bg-white rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full",
                      r.tone === "brand" && "bg-brand",
                      r.tone === "medical" && "bg-medical",
                      r.tone === "warning" && "bg-warning",
                    )}
                    style={{ width: `${r.pct}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function KPI({
  icon: Icon,
  label,
  value,
  tone = "brand",
  delta,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  tone?: "brand" | "medical" | "warning";
  delta?: string;
}) {
  const tones = {
    brand: "bg-brand/10 text-brand",
    medical: "bg-medical/10 text-medical",
    warning: "bg-warning/15 text-warning",
  };
  return (
    <div className="card-soft p-5">
      <div className="flex items-start justify-between mb-3">
        <div className={cn("size-10 rounded-xl grid place-items-center", tones[tone])}>
          <Icon className="size-5" />
        </div>
        {delta && <span className="text-xs font-bold text-brand">{delta}</span>}
      </div>
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}
