import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import doctorAma from "@/assets/doctor-ama.jpg";
import patientVideo from "@/assets/patient-video.jpg";
import {
  Activity,
  Thermometer,
  HeartPulse,
  Droplet,
  Wind,
  Search,
  FileText,
  Send,
  PhoneOff,
  Mic,
  Video,
  MessageSquare,
  AlertTriangle,
  Signature,
  Bell,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/doctor/")({
  component: DoctorDashboard,
});

function DoctorDashboard() {
  const [available, setAvailable] = useState(true);
  const [showIncoming, setShowIncoming] = useState(true);

  return (
    <AppShell active="doctor">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Doctor profile / status */}
        <div className="lg:col-span-1 space-y-6">
          <div className="card-soft p-6">
            <div className="flex items-center gap-4">
              <img
                src={doctorAma}
                alt="Dr. Ama Boateng"
                width={64}
                height={64}
                className="size-16 rounded-2xl object-cover"
              />
              <div className="min-w-0">
                <p className="font-bold truncate">Dr. Ama Boateng</p>
                <p className="text-xs text-medical font-semibold">MDC-44291-GH</p>
                <div className="flex items-center gap-1 mt-1">
                  <Chip tone="medical">✓ Verified</Chip>
                </div>
              </div>
            </div>
            <div className="mt-5 p-4 rounded-2xl bg-slate-50 border border-border flex items-center justify-between">
              <div>
                <p className="text-xs font-bold text-slate-500">Shift status</p>
                <p className="text-sm font-bold">{available ? "Available" : "Off shift"}</p>
              </div>
              <button
                onClick={() => setAvailable((v) => !v)}
                className={cn(
                  "relative w-12 h-7 rounded-full transition-colors",
                  available ? "bg-brand" : "bg-slate-300",
                )}
                aria-label="Toggle availability"
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-6 rounded-full bg-white shadow transition-transform",
                    available ? "translate-x-5" : "translate-x-0.5",
                  )}
                />
              </button>
            </div>
          </div>

          <div className="card-soft p-6 space-y-4">
            <h3 className="font-bold">Today</h3>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Completed" value="14" />
              <Stat label="In queue" value="3" tone="medical" />
              <Stat label="Earnings" value="GH₵ 420" tone="brand" />
              <Stat label="Avg time" value="9m" />
            </div>
          </div>

          <div className="card-soft p-6">
            <h3 className="font-bold mb-3">Notifications</h3>
            <div className="space-y-2">
              {[
                { text: "New consultation assigned", time: "1m", tone: "brand" as const },
                { text: "Prescription signed & sent", time: "12m", tone: "medical" as const },
                { text: "Weekly earnings ready", time: "2h", tone: "muted" as const },
              ].map((n, i) => (
                <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 border border-border">
                  <div
                    className={cn(
                      "size-8 rounded-lg grid place-items-center shrink-0",
                      n.tone === "brand" && "bg-brand/10 text-brand",
                      n.tone === "medical" && "bg-medical/10 text-medical",
                      n.tone === "muted" && "bg-slate-200 text-slate-500",
                    )}
                  >
                    <Bell className="size-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{n.text}</p>
                    <p className="text-xs text-slate-500">{n.time} ago</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Center + right: consultation workspace */}
        <div className="lg:col-span-2 space-y-6">
          <div className="card-soft overflow-hidden">
            <div className="p-4 flex items-center justify-between border-b border-border bg-slate-50/60">
              <div className="flex items-center gap-3">
                <Chip tone="brand" pulse>
                  Live · 08:42
                </Chip>
                <p className="text-sm font-semibold">Session NM-99281 · Efua M.</p>
              </div>
              <div className="text-xs text-slate-500">
                Pharmacy: Akosua Pharmacy, Adabraka
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-5 gap-0">
              <div className="md:col-span-3 relative bg-slate-900 aspect-video md:aspect-auto md:min-h-[420px]">
                <img
                  src={patientVideo}
                  alt="Patient"
                  className="absolute inset-0 size-full object-cover"
                  width={1024}
                  height={768}
                />
                <div className="absolute top-4 left-4 chip bg-black/50 text-white backdrop-blur">
                  Patient · Female · 30–44
                </div>
                <div className="absolute bottom-4 right-4 w-32 aspect-video rounded-xl overflow-hidden border-2 border-white/30 shadow-lg">
                  <img
                    src={doctorAma}
                    alt="You"
                    className="size-full object-cover"
                    width={200}
                    height={112}
                  />
                </div>
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 bg-black/60 backdrop-blur px-3 py-2 rounded-full">
                  <IconBtn icon={Mic} label="Mute" />
                  <IconBtn icon={Video} label="Cam" />
                  <IconBtn icon={MessageSquare} label="Chat" />
                  <button className="px-4 py-2 rounded-full bg-red-500 text-white text-xs font-bold flex items-center gap-1.5">
                    <PhoneOff className="size-4" /> End
                  </button>
                </div>
              </div>
              <div className="md:col-span-2 p-5 space-y-5">
                <div>
                  <p className="text-xs font-bold text-slate-400 uppercase mb-2">
                    Vitals (from pharmacy)
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <VitalCard icon={HeartPulse} label="BP" value="118/79" />
                    <VitalCard icon={Thermometer} label="Temp" value="38.2°" tone="warning" />
                    <VitalCard icon={Activity} label="Pulse" value="88" />
                    <VitalCard icon={Wind} label="SpO₂" value="98%" />
                  </div>
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-400 uppercase mb-2">
                    Point-of-care tests
                  </p>
                  <div className="space-y-2">
                    <TestRow icon={Droplet} label="Malaria RDT" result="Positive" tone="warning" />
                    <TestRow icon={Droplet} label="Blood sugar" result="5.4 mmol/L" tone="brand" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="card-soft p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold">Clinical notes</h3>
                <span className="text-xs text-slate-400">Autosaved</span>
              </div>
              <textarea
                defaultValue="Patient reports fever + body aches for 48h. Malaria RDT positive. No red flags. Plan: antimalarial course + antipyretic. Advise return if fever persists >48h."
                className="w-full min-h-32 p-3 rounded-xl border border-border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </div>

            <div className="card-soft p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold">Prescription builder</h3>
                <Chip tone="medical">2 items</Chip>
              </div>
              <div className="relative mb-3">
                <Search className="size-4 absolute left-3 top-3 text-slate-400" />
                <input
                  placeholder="Search medicine..."
                  className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-border text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
              </div>
              <div className="space-y-2">
                <RxRow name="Artemether-Lumefantrine 20/120mg" dose="4 tabs BID × 3 days" />
                <RxRow name="Paracetamol 500mg" dose="2 tabs q6h PRN" />
              </div>
              <div className="grid grid-cols-2 gap-2 mt-4">
                <button className="flex items-center justify-center gap-2 py-3 rounded-xl border border-border text-sm font-bold hover:bg-slate-50">
                  <Signature className="size-4" /> Sign
                </button>
                <button className="flex items-center justify-center gap-2 py-3 rounded-xl bg-brand text-white text-sm font-bold hover:brightness-110">
                  <Send className="size-4" /> Send to pharmacy
                </button>
              </div>
            </div>
          </div>

          <div className="card-soft p-5 border-warning/40 bg-warning-soft">
            <div className="flex items-start gap-4">
              <div className="size-10 rounded-xl bg-warning/20 text-warning grid place-items-center shrink-0">
                <AlertTriangle className="size-5" />
              </div>
              <div className="flex-1">
                <p className="font-bold text-warning-foreground text-slate-900">
                  Need to escalate? Generate an urgent referral.
                </p>
                <p className="text-xs text-slate-600 mt-1">
                  Select a hospital, add a clinical summary, and mark urgency. Referral is sent
                  digitally to the receiving facility.
                </p>
              </div>
              <button className="px-4 py-2.5 rounded-xl bg-warning text-white text-sm font-bold shrink-0">
                Create referral
              </button>
            </div>
          </div>
        </div>
      </div>

      {showIncoming && (
        <div className="fixed bottom-6 right-6 max-w-sm card-soft p-4 shadow-2xl border-brand/30 animate-in fade-in slide-in-from-bottom-4">
          <div className="flex items-start gap-3">
            <div className="size-10 rounded-xl bg-brand/10 text-brand grid place-items-center shrink-0 animate-pulse">
              <Bell className="size-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-brand uppercase tracking-wider">
                Incoming consultation
              </p>
              <p className="font-bold text-sm mt-0.5">Video · Twi · Est. 10 min</p>
              <p className="text-xs text-slate-500">Kumasi Central Chemist</p>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => setShowIncoming(false)}
                  className="px-3 py-1.5 rounded-lg bg-brand text-white text-xs font-bold flex-1"
                >
                  Accept
                </button>
                <button
                  onClick={() => setShowIncoming(false)}
                  className="px-3 py-1.5 rounded-lg border border-border text-xs font-bold flex-1"
                >
                  Decline
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "brand" | "medical" }) {
  return (
    <div className="p-3 rounded-xl bg-slate-50 border border-border">
      <p className="text-[10px] font-bold text-slate-400 uppercase">{label}</p>
      <p
        className={cn(
          "text-lg font-bold mt-0.5",
          tone === "brand" && "text-brand",
          tone === "medical" && "text-medical",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function VitalCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  tone?: "warning";
}) {
  return (
    <div className="p-3 rounded-xl bg-slate-50 border border-border">
      <div className="flex items-center gap-1.5 text-slate-500">
        <Icon className="size-3.5" />
        <span className="text-[10px] font-bold uppercase">{label}</span>
      </div>
      <p
        className={cn(
          "text-base font-bold mt-1",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function TestRow({
  icon: Icon,
  label,
  result,
  tone,
}: {
  icon: React.ElementType;
  label: string;
  result: string;
  tone: "brand" | "warning";
}) {
  return (
    <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-border">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-slate-500" />
        <span className="text-sm font-medium">{label}</span>
      </div>
      <Chip tone={tone}>{result}</Chip>
    </div>
  );
}

function IconBtn({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <button
      aria-label={label}
      className="size-10 rounded-full bg-white/10 grid place-items-center text-white hover:bg-white/20"
    >
      <Icon className="size-4" />
    </button>
  );
}

function RxRow({ name, dose }: { name: string; dose: string }) {
  return (
    <div className="p-3 rounded-xl border border-medical/10 bg-medical/5 flex items-start gap-3">
      <FileText className="size-4 text-medical shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold truncate">{name}</p>
        <p className="text-xs text-slate-600">{dose}</p>
      </div>
    </div>
  );
}
