import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ArrowLeft, ArrowRight, Check, Smartphone, CreditCard, QrCode, Copy } from "lucide-react";

export const Route = createFileRoute("/pharmacy/new")({
  component: NewConsultation,
});

type Step = "details" | "payment" | "qr";

function NewConsultation() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("details");
  const [method, setMethod] = useState<string>("momo");
  const [paid, setPaid] = useState(false);

  return (
    <AppShell active="pharmacy">
      <div className="max-w-3xl mx-auto w-full">
        <Link to="/pharmacy" className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-brand mb-6">
          <ArrowLeft className="size-4" /> Back to dashboard
        </Link>

        <div className="flex items-center gap-2 mb-8">
          {(["details", "payment", "qr"] as Step[]).map((s, i) => {
            const idx = ["details", "payment", "qr"].indexOf(step);
            const done = i < idx;
            const active = i === idx;
            return (
              <div key={s} className="flex-1 flex items-center gap-2">
                <div
                  className={`size-8 rounded-full grid place-items-center text-xs font-bold border-2 ${
                    done
                      ? "bg-brand border-brand text-white"
                      : active
                        ? "bg-white border-brand text-brand"
                        : "bg-white border-border text-slate-400"
                  }`}
                >
                  {done ? <Check className="size-4" /> : i + 1}
                </div>
                <span className={`text-xs font-semibold ${active ? "text-brand" : "text-slate-500"}`}>
                  {["Session Details", "Payment", "Scan QR"][i]}
                </span>
                {i < 2 && <div className={`flex-1 h-0.5 ${done ? "bg-brand" : "bg-border"}`} />}
              </div>
            );
          })}
        </div>

        {step === "details" && (
          <div className="card-soft p-8 space-y-6">
            <div>
              <h1 className="text-2xl font-bold mb-1">Session details</h1>
              <p className="text-sm text-slate-500">
                Optional. These stay only for this session — no permanent profile is stored.
              </p>
            </div>

            <Chip tone="medical">
              <Smartphone className="size-3" /> Privacy-first · Session only
            </Chip>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="First name" placeholder="Efua" />
              <Select label="Age range" options={["Under 18", "18–29", "30–44", "45–64", "65+"]} />
              <Select label="Gender" options={["Female", "Male", "Other", "Prefer not to say"]} />
            </div>
            <p className="text-xs text-slate-500">
              Only first name, age range, and gender are collected. No phone number, ID, or medical history
              is stored on the pharmacy side.
            </p>

            <div className="p-4 bg-brand-soft rounded-2xl text-sm text-brand/90">
              After this consultation ends, only the prescription, payment record, and audit log will
              remain. Nothing else about this patient will be stored.
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => setStep("payment")}
                className="inline-flex items-center gap-2 bg-brand text-white font-semibold px-6 py-3 rounded-xl hover:brightness-110"
              >
                Continue to payment <ArrowRight className="size-4" />
              </button>
            </div>
          </div>
        )}

        {step === "payment" && (
          <div className="card-soft p-8 space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold mb-1">Collect payment</h1>
                <p className="text-sm text-slate-500">
                  Consultation only starts after payment is confirmed.
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-400 uppercase font-bold">Amount</p>
                <p className="text-2xl font-bold text-brand">GH₵ 45.00</p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { id: "momo", label: "Mobile Money", icon: Smartphone },
                { id: "card", label: "Card", icon: CreditCard },
                { id: "link", label: "Payment link", icon: Copy },
                { id: "qr", label: "Payment QR", icon: QrCode },
              ].map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMethod(m.id)}
                  className={`p-4 rounded-2xl border-2 flex flex-col items-start gap-2 transition-colors ${
                    method === m.id ? "border-brand bg-brand-soft" : "border-border hover:border-slate-300"
                  }`}
                >
                  <m.icon className={`size-5 ${method === m.id ? "text-brand" : "text-slate-500"}`} />
                  <span className="text-xs font-bold">{m.label}</span>
                </button>
              ))}
            </div>

            {method === "momo" && (
              <div className="space-y-3">
                <Field label="Mobile Money number" placeholder="024 000 0000" />
                <div className="flex gap-2">
                  {["MTN", "Vodafone", "AirtelTigo"].map((n) => (
                    <span key={n} className="chip bg-slate-100 text-slate-600">
                      {n}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between p-4 rounded-2xl bg-slate-50 border border-border">
              <div className="flex items-center gap-3">
                <span
                  className={`size-2.5 rounded-full ${paid ? "bg-brand animate-pulse" : "bg-warning animate-pulse"}`}
                />
                <span className="text-sm font-semibold">
                  {paid ? "Payment confirmed" : "Waiting for payment"}
                </span>
              </div>
              <span className="text-xs font-mono text-slate-500">TXN-8827192</span>
            </div>

            <div className="flex items-center justify-between">
              <button
                onClick={() => setStep("details")}
                className="text-sm font-semibold text-slate-500 hover:text-brand"
              >
                ← Back
              </button>
              {!paid ? (
                <button
                  onClick={() => setPaid(true)}
                  className="inline-flex items-center gap-2 bg-brand text-white font-semibold px-6 py-3 rounded-xl hover:brightness-110"
                >
                  Confirm payment received
                </button>
              ) : (
                <button
                  onClick={() => setStep("qr")}
                  className="inline-flex items-center gap-2 bg-brand text-white font-semibold px-6 py-3 rounded-xl"
                >
                  Generate consultation QR <ArrowRight className="size-4" />
                </button>
              )}
            </div>
          </div>
        )}

        {step === "qr" && (
          <div className="card-soft p-8 text-center space-y-6">
            <Chip tone="brand" pulse className="mx-auto">
              Session active · NM-99282
            </Chip>
            <h1 className="text-2xl font-bold">Ask the patient to scan this QR</h1>
            <p className="text-sm text-slate-500 max-w-md mx-auto">
              The patient uses their own phone camera. The consultation opens in the browser — no
              app needed.
            </p>

            <div className="mx-auto p-6 bg-slate-50 rounded-3xl border-2 border-dashed border-border w-fit">
              <div className="size-56 bg-white rounded-2xl grid place-items-center p-4">
                <QrPattern />
              </div>
            </div>

            <div className="flex items-center justify-center gap-2 text-sm font-mono">
              <span className="text-slate-500">Or share link:</span>
              <span className="px-3 py-1 bg-slate-100 rounded-lg text-slate-700">
                neem.gh/s/NM-99282
              </span>
              <button className="text-brand">
                <Copy className="size-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-4">
              {[
                { label: "Payment", value: "Paid", tone: "brand" as const },
                { label: "Patient", value: "Not joined", tone: "muted" as const },
                { label: "Doctor", value: "Queued", tone: "medical" as const },
                { label: "Language", value: "Any", tone: "muted" as const },
              ].map((s) => (
                <div key={s.label} className="p-3 rounded-xl bg-slate-50 border border-border">
                  <p className="text-[10px] font-bold text-slate-400 uppercase">{s.label}</p>
                  <Chip tone={s.tone} className="mt-1">
                    {s.value}
                  </Chip>
                </div>
              ))}
            </div>

            <div className="flex justify-center gap-3 pt-4">
              <Link
                to="/patient/$sessionId"
                params={{ sessionId: "NM-99282" }}
                className="inline-flex items-center gap-2 bg-brand text-white font-semibold px-6 py-3 rounded-xl"
              >
                Simulate patient scan →
              </Link>
              <button
                onClick={() => navigate({ to: "/pharmacy" })}
                className="inline-flex items-center gap-2 bg-white border border-border font-semibold px-6 py-3 rounded-xl"
              >
                Return to dashboard
              </button>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Field({ label, placeholder }: { label: string; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">{label}</span>
      <input
        type="text"
        placeholder={placeholder}
        className="mt-1.5 w-full px-4 py-3 bg-white border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand"
      />
    </label>
  );
}

function Select({ label, options }: { label: string; options: string[] }) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">{label}</span>
      <select className="mt-1.5 w-full px-4 py-3 bg-white border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand">
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

function QrPattern() {
  // Decorative QR-like grid
  const cells = Array.from({ length: 15 * 15 }, (_, i) => (i * 7919) % 100 > 55);
  return (
    <div className="grid grid-cols-15 gap-[2px]" style={{ gridTemplateColumns: "repeat(15, minmax(0, 1fr))" }}>
      {cells.map((on, i) => (
        <div key={i} className={`aspect-square ${on ? "bg-slate-900" : "bg-transparent"}`} />
      ))}
    </div>
  );
}
