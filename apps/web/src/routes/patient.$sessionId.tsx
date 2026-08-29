import { createFileRoute, Link } from "@tanstack/react-router";
import { NeemLogo } from "@/components/neem/Logo";
import { useState } from "react";
import waitingIllustration from "@/assets/waiting-illustration.png";
import doctorAma from "@/assets/doctor-ama.jpg";
import patientVideo from "@/assets/patient-video.jpg";
import {
  Check,
  Video,
  Phone,
  PhoneOutgoing,
  Mic,
  MicOff,
  VideoOff,
  MessageSquare,
  Image as ImageIcon,
  PhoneOff,
  Download,
  Star,
} from "lucide-react";
import { languages } from "@/lib/neem-data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/patient/$sessionId")({
  component: PatientPortal,
});

type Step = "welcome" | "language" | "type" | "waiting" | "call" | "complete" | "feedback" | "done";

function PatientPortal() {
  const { sessionId } = Route.useParams();
  const [step, setStep] = useState<Step>("welcome");
  const [lang, setLang] = useState("en");
  const [type, setType] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [rating, setRating] = useState(0);

  return (
    <div className="min-h-dvh bg-slate-950 text-white grid place-items-center p-0 sm:p-6">
      {/* Phone frame on desktop, full-screen on mobile */}
      <div className="w-full max-w-md sm:rounded-[3rem] sm:border-8 sm:border-slate-900 bg-white text-slate-900 overflow-hidden sm:shadow-2xl min-h-dvh sm:min-h-0 sm:h-[820px] flex flex-col relative">
        <div className="px-6 py-3 flex items-center justify-between text-[10px] font-bold text-slate-500 border-b border-border">
          <span>neem.gh/s/{sessionId}</span>
          <span className="chip bg-brand/10 text-brand">🔒 Secure</span>
        </div>

        {step === "welcome" && (
          <div className="flex-1 flex flex-col p-8 text-center">
            <div className="flex items-center justify-center mt-6">
              <NeemLogo className="text-xl" markClassName="size-9" />
            </div>
            <div className="flex-1 flex flex-col justify-center">
              <img
                src={waitingIllustration}
                alt=""
                width={220}
                height={220}
                className="size-52 mx-auto"
              />
              <h1 className="text-3xl font-bold mt-6 text-balance">Welcome to your consultation</h1>
              <p className="text-slate-500 mt-3 text-pretty">
                A licensed Ghanaian doctor is ready to see you. No account needed — this session is
                just for you, right now.
              </p>
            </div>
            <div className="p-3 bg-brand-soft rounded-2xl text-xs text-brand/90 font-medium mb-4">
              ✓ Payment confirmed · Session <span className="font-mono">{sessionId}</span>
            </div>
            <button
              onClick={() => setStep("language")}
              className="w-full bg-brand text-white py-4 rounded-2xl font-bold shadow-lg shadow-brand/20 text-base"
            >
              Continue →
            </button>
          </div>
        )}

        {step === "language" && (
          <div className="flex-1 flex flex-col p-6">
            <h1 className="text-xl font-bold mt-2">Choose your language</h1>
            <p className="text-sm text-slate-500 mt-1 mb-6">
              We'll match you with a doctor who speaks it.
            </p>
            <div className="grid grid-cols-2 gap-3 flex-1 content-start">
              {languages.map((l) => (
                <button
                  key={l.code}
                  onClick={() => setLang(l.code)}
                  className={cn(
                    "p-4 rounded-2xl text-left border-2 min-h-[76px] transition-colors",
                    lang === l.code
                      ? "border-brand bg-brand-soft"
                      : "border-border hover:border-slate-300",
                  )}
                >
                  <p className={cn("font-bold text-sm", lang === l.code && "text-brand")}>
                    {l.label}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-0.5">{l.sub}</p>
                </button>
              ))}
            </div>
            <button
              onClick={() => setStep("type")}
              className="w-full bg-brand text-white py-4 rounded-2xl font-bold shadow-lg shadow-brand/20 mt-6"
            >
              Continue →
            </button>
          </div>
        )}

        {step === "type" && (
          <div className="flex-1 flex flex-col p-6">
            <h1 className="text-xl font-bold mt-2">How would you like to consult?</h1>
            <p className="text-sm text-slate-500 mt-1 mb-6">Pick what works best for you.</p>
            <div className="space-y-3 flex-1">
              {[
                {
                  id: "video",
                  icon: Video,
                  title: "Video consultation",
                  desc: "See and speak with the doctor.",
                },
                {
                  id: "audio",
                  icon: Phone,
                  title: "Audio consultation",
                  desc: "Voice only — uses less data.",
                },
                {
                  id: "callback",
                  icon: PhoneOutgoing,
                  title: "Call me",
                  desc: "The doctor will call you through Neem. Best for weak internet.",
                },
              ].map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setType(opt.id)}
                  className={cn(
                    "w-full p-5 rounded-2xl border-2 flex items-start gap-4 text-left transition-colors",
                    type === opt.id
                      ? "border-brand bg-brand-soft"
                      : "border-border hover:border-slate-300",
                  )}
                >
                  <div
                    className={cn(
                      "size-11 rounded-xl grid place-items-center shrink-0",
                      type === opt.id ? "bg-brand text-white" : "bg-slate-100 text-slate-500",
                    )}
                  >
                    <opt.icon className="size-5" />
                  </div>
                  <div>
                    <p className="font-bold">{opt.title}</p>
                    <p className="text-xs text-slate-500 mt-1">{opt.desc}</p>
                  </div>
                </button>
              ))}
            </div>
            <button
              disabled={!type}
              onClick={() => setStep("waiting")}
              className="w-full bg-brand text-white py-4 rounded-2xl font-bold shadow-lg shadow-brand/20 mt-6 disabled:opacity-40"
            >
              Enter waiting room →
            </button>
          </div>
        )}

        {step === "waiting" && (
          <div className="flex-1 flex flex-col p-8 text-center">
            <div className="chip bg-brand/10 text-brand mx-auto">
              <span className="size-1.5 rounded-full bg-brand animate-pulse" />
              Finding a doctor
            </div>
            <div className="flex-1 flex flex-col items-center justify-center">
              <img
                src={waitingIllustration}
                alt=""
                width={200}
                height={200}
                className="size-48 mb-6 animate-pulse"
              />
              <h2 className="text-2xl font-bold">Just a moment...</h2>
              <p className="text-slate-500 mt-2 max-w-xs text-pretty">
                We're matching you with a doctor who speaks your language.
              </p>
              <div className="mt-8 grid grid-cols-2 gap-3 w-full">
                <div className="p-3 rounded-2xl bg-slate-50 border border-border">
                  <p className="text-[10px] font-bold text-slate-400 uppercase">Queue</p>
                  <p className="text-lg font-bold text-brand">You're next</p>
                </div>
                <div className="p-3 rounded-2xl bg-slate-50 border border-border">
                  <p className="text-[10px] font-bold text-slate-400 uppercase">Wait</p>
                  <p className="text-lg font-bold">~2 min</p>
                </div>
              </div>
            </div>
            <button
              onClick={() => setStep("call")}
              className="w-full bg-brand text-white py-4 rounded-2xl font-bold shadow-lg shadow-brand/20"
            >
              Join now (demo)
            </button>
          </div>
        )}

        {step === "call" && (
          <div className="flex-1 flex flex-col bg-slate-950 text-white relative">
            <img
              src={doctorAma}
              alt="Dr. Ama Boateng"
              className="absolute inset-0 size-full object-cover opacity-95"
              width={512}
              height={512}
            />
            <div className="absolute inset-0 bg-gradient-to-b from-slate-950/60 via-transparent to-slate-950/80" />
            <div className="relative p-4 flex items-center justify-between">
              <div className="chip bg-red-500 text-white">
                <span className="size-1.5 rounded-full bg-white animate-pulse" />
                Live · 08:42
              </div>
              <div className="chip bg-white/20 text-white backdrop-blur-md">HD</div>
            </div>
            <div className="relative flex-1" />
            <div className="relative p-4">
              <div className="mb-4 flex justify-end">
                <div className="w-28 aspect-[3/4] rounded-2xl overflow-hidden border-2 border-white/30 shadow-xl">
                  <img
                    src={patientVideo}
                    alt="You"
                    className="size-full object-cover"
                    width={200}
                    height={266}
                  />
                </div>
              </div>
              <div className="p-4 rounded-3xl bg-white/10 backdrop-blur-xl border border-white/15">
                <div className="flex items-center gap-3 mb-4">
                  <img
                    src={doctorAma}
                    alt="Dr. Ama"
                    className="size-11 rounded-full border-2 border-white/50 object-cover"
                    width={44}
                    height={44}
                  />
                  <div>
                    <p className="font-bold text-sm">Dr. Ama Boateng</p>
                    <p className="text-[11px] text-white/70">MDC-44291-GH · General Practice</p>
                  </div>
                </div>
                <div className="grid grid-cols-5 gap-2">
                  <CallButton onClick={() => setMuted(!muted)} active={muted} icon={muted ? MicOff : Mic} label="Mic" />
                  <CallButton onClick={() => setCamOff(!camOff)} active={camOff} icon={camOff ? VideoOff : Video} label="Cam" />
                  <CallButton icon={MessageSquare} label="Chat" />
                  <CallButton icon={ImageIcon} label="Upload" />
                  <CallButton
                    onClick={() => setStep("complete")}
                    icon={PhoneOff}
                    label="End"
                    danger
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {step === "complete" && (
          <div className="flex-1 flex flex-col p-6 overflow-y-auto">
            <div className="size-16 rounded-full bg-brand/10 grid place-items-center mx-auto mt-4">
              <Check className="size-8 text-brand" />
            </div>
            <h1 className="text-2xl font-bold text-center mt-4">Consultation complete</h1>
            <p className="text-sm text-slate-500 text-center mt-1">
              Your prescription is ready at the pharmacy.
            </p>

            <div className="mt-6 p-5 rounded-2xl border border-border bg-slate-50">
              <div className="flex items-center gap-3 mb-3">
                <img
                  src={doctorAma}
                  alt=""
                  width={40}
                  height={40}
                  className="size-10 rounded-full object-cover"
                />
                <div>
                  <p className="font-bold text-sm">Dr. Ama Boateng</p>
                  <p className="text-[10px] text-slate-500">Digitally signed · MDC-44291-GH</p>
                </div>
              </div>
              <p className="text-xs font-bold text-slate-400 uppercase mb-2">Summary</p>
              <p className="text-sm">
                Suspected uncomplicated malaria. RDT positive. Prescribed antimalarial course; return
                if fever persists past 48 hours.
              </p>
            </div>

            <div className="mt-4 space-y-2">
              {[
                { drug: "Artemether-Lumefantrine 20/120mg", dose: "4 tabs BID × 3 days" },
                { drug: "Paracetamol 500mg", dose: "2 tabs q6h PRN fever" },
              ].map((r) => (
                <div key={r.drug} className="p-3 rounded-xl bg-white border border-border">
                  <p className="font-bold text-sm">{r.drug}</p>
                  <p className="text-xs text-slate-500">{r.dose}</p>
                </div>
              ))}
            </div>

            <button className="mt-6 w-full flex items-center justify-center gap-2 bg-medical text-white py-4 rounded-2xl font-bold">
              <Download className="size-4" /> Download prescription
            </button>
            <button
              onClick={() => setStep("feedback")}
              className="mt-3 w-full bg-brand text-white py-4 rounded-2xl font-bold"
            >
              Leave feedback →
            </button>
          </div>
        )}

        {step === "feedback" && (
          <div className="flex-1 flex flex-col p-6">
            <h1 className="text-2xl font-bold mt-4">How was your consultation?</h1>
            <p className="text-sm text-slate-500 mt-1">Your feedback helps improve care.</p>
            <div className="flex justify-center gap-2 mt-8">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setRating(n)}
                  aria-label={`Rate ${n} stars`}
                  className="p-2"
                >
                  <Star
                    className={cn(
                      "size-10 transition-colors",
                      n <= rating ? "fill-warning text-warning" : "text-slate-300",
                    )}
                  />
                </button>
              ))}
            </div>
            <textarea
              placeholder="Any comments? (optional)"
              className="mt-6 w-full min-h-32 p-4 rounded-2xl border border-border resize-none focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand text-sm"
            />
            <button
              onClick={() => setStep("done")}
              className="mt-auto w-full bg-brand text-white py-4 rounded-2xl font-bold"
            >
              Submit feedback
            </button>
          </div>
        )}

        {step === "done" && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <div className="size-20 rounded-full bg-brand/10 grid place-items-center">
              <Check className="size-10 text-brand" />
            </div>
            <h1 className="text-3xl font-bold mt-6">Thank you!</h1>
            <p className="text-slate-500 mt-3 max-w-xs text-pretty">
              Please return to the pharmacist to collect your medicines. Get well soon.
            </p>
            <Link
              to="/"
              className="mt-10 text-sm font-semibold text-brand"
            >
              Close session
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function CallButton({
  icon: Icon,
  label,
  onClick,
  active,
  danger,
}: {
  icon: React.ElementType;
  label: string;
  onClick?: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={cn(
        "flex flex-col items-center gap-1.5 py-2 rounded-2xl transition-colors",
        danger
          ? "bg-red-500 text-white hover:bg-red-600"
          : active
            ? "bg-white text-slate-900"
            : "bg-white/10 text-white hover:bg-white/20",
      )}
    >
      <Icon className="size-5" />
      <span className="text-[10px] font-semibold">{label}</span>
    </button>
  );
}
