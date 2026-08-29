import { createFileRoute } from "@tanstack/react-router";
import { NeemLogo } from "@/components/neem/Logo";
import { Building2, User, Stethoscope, ShieldCheck, ArrowRight } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Landing,
});

const apps = [
  {
    to: "/pharmacy",
    icon: Building2,
    title: "Pharmacy Dashboard",
    desc: "Initiate consultations, collect payment, generate QR codes, dispense prescriptions.",
    tone: "brand" as const,
  },
  {
    to: "/patient/$sessionId",
    params: { sessionId: "NM-99281" },
    icon: User,
    title: "Patient Consultation Portal",
    desc: "QR-launched, browser-based, no account. Session-only, privacy-first experience.",
    tone: "medical" as const,
  },
  {
    to: "/doctor",
    icon: Stethoscope,
    title: "Doctor Dashboard",
    desc: "Clinical workspace with video, vitals, prescription builder, and referral tools.",
    tone: "brand" as const,
  },
  {
    to: "/admin",
    icon: ShieldCheck,
    title: "Neem Administration",
    desc: "Executive oversight: doctors, pharmacies, live consultations, financials, quality.",
    tone: "medical" as const,
  },
];

function Landing() {
  return (
    <div className="min-h-dvh bg-surface">
      <nav className="px-6 py-4 flex items-center justify-between max-w-7xl mx-auto">
        <NeemLogo className="text-xl" markClassName="size-10" />
        <span className="text-xs text-slate-500 font-medium hidden sm:inline">
          Telemedicine for Ghanaian community pharmacies
        </span>
      </nav>

      <header className="max-w-4xl mx-auto px-6 pt-12 sm:pt-20 pb-10 text-center">
        <span className="chip bg-brand/10 text-brand mb-6">
          <span className="size-1.5 rounded-full bg-brand animate-pulse" />
          Live pilot across Accra, Kumasi & Tamale
        </span>
        <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance">
          A doctor's visit,
          <br />
          <span className="text-brand">just around the corner.</span>
        </h1>
        <p className="mt-6 text-lg text-slate-600 max-w-2xl mx-auto text-pretty">
          Neem connects patients at community pharmacies with licensed Ghanaian doctors through
          secure, session-based video and audio consultations. No downloads, no accounts.
        </p>
      </header>

      <section className="max-w-6xl mx-auto px-6 pb-24 grid grid-cols-1 md:grid-cols-2 gap-5">
        {apps.map((app) => {
          const Icon = app.icon;
          return (
            <a
              key={app.to}
              href={app.to === "/patient/$sessionId" ? "/patient/NM-99281" : app.to}
              className="group card-soft p-8 hover:-translate-y-0.5 hover:shadow-lg transition-all"
            >
              <div className="flex items-start justify-between mb-6">
                <div
                  className={`size-14 rounded-2xl grid place-items-center ${
                    app.tone === "brand" ? "bg-brand/10 text-brand" : "bg-medical/10 text-medical"
                  }`}
                >
                  <Icon className="size-6" />
                </div>
                <ArrowRight className="size-5 text-slate-300 group-hover:text-brand group-hover:translate-x-1 transition-all" />
              </div>
              <h2 className="text-xl font-bold mb-2">{app.title}</h2>
              <p className="text-sm text-slate-500 leading-relaxed">{app.desc}</p>
            </a>
          );
        })}
      </section>

      <footer className="border-t border-border bg-white">
        <div className="max-w-7xl mx-auto px-6 py-6 flex flex-wrap gap-4 justify-between items-center text-xs text-slate-500">
          <span>&copy; 2026 Neem Health · Approved by the Ghana Medical & Dental Council</span>
          <div className="flex gap-6">
            <span>Privacy-first · Session-only</span>
            <span>WCAG AA</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
