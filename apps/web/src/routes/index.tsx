import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, ClipboardList, FileText, UserPlus, Video } from "lucide-react";
import { NeemLogo } from "@/components/neem/Logo";
import { usePatientSession } from "@/features/consultation/api";

export const Route = createFileRoute("/")({
  component: Landing,
});

/**
 * A way back in, for a patient who closed the call (D72).
 *
 * The patient's session lives in a cookie that outlasts the tab, but every
 * route to it was one-way: the QR code is single-use, and the link in their
 * history is spent. A patient who shut the tab by accident had a live
 * consultation, a doctor waiting in it, and no door — so they would type the
 * one address they know, land here, and read marketing copy.
 *
 * Shown only when there is something to return to. `/patient/session` answers
 * 401 without a cookie, which is the quiet nothing this should be the rest of
 * the time.
 */
function ResumeConsultation() {
  const { data } = usePatientSession();
  if (!data || ["COMPLETE", "CLOSED"].includes(data.step)) return null;

  return (
    <section className="mx-auto w-full max-w-4xl px-6 pb-8">
      <Link
        to="/patient"
        className="card-soft flex flex-wrap items-center justify-between gap-4 border-brand/30 bg-brand/5 p-6 transition hover:border-brand/60"
      >
        <div>
          <h2 className="font-bold">Your consultation is still open</h2>
          <p className="mt-1 text-sm text-slate-600">
            At {data.pharmacyName}. Pick up where you left off.
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white">
          Rejoin <ArrowRight className="size-4" />
        </span>
      </Link>
    </section>
  );
}

/** The CHPS model, in the order a patient's visit runs. */
const VISIT_STEPS = [
  {
    icon: UserPlus,
    title: "Register",
    body: "The Community Health Officer registers the patient. No phone or ID is needed, and an estimated age is enough.",
  },
  {
    icon: ClipboardList,
    title: "Triage",
    body: "The officer records vital signs and chooses the triage category. An emergency follows the emergency protocol, not a queue.",
  },
  {
    icon: Video,
    title: "See a doctor",
    body: "If a doctor is needed, the patient sees one by video or audio on a tablet at the compound.",
  },
  {
    icon: FileText,
    title: "Record and follow up",
    body: "The doctor's advice joins the patient's record at the compound, ready for referral and follow-up.",
  },
];

function Landing() {
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <nav className="w-full px-6 py-4 flex items-center justify-between max-w-7xl mx-auto">
        <NeemLogo className="text-xl" markClassName="size-10" />
      </nav>

      {/*
        Says what the CHPS model does and nothing about where it runs. It has
        not been deployed, so this page claims no pilot, no approval and no
        partnership. Each portal is reached by signing in, and a station by
        pairing it with the compound.
      */}
      <main className="flex flex-1 flex-col justify-center pb-16 sm:pb-24">
        <ResumeConsultation />

        <header className="w-full max-w-4xl mx-auto px-6 pt-12 sm:pt-20 pb-10 text-center">
          <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance">
            A doctor's consultation,
            <br />
            <span className="text-brand">right at the compound.</span>
          </h1>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <a
              href="/auth/login"
              className="rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:brightness-110"
            >
              Sign in
            </a>
            <a
              href="/station"
              className="rounded-xl border border-border bg-white px-6 py-3 text-sm font-semibold hover:bg-slate-50"
            >
              Open a consultation station
            </a>
          </div>
        </header>

        <section aria-labelledby="visit-heading" className="mx-auto w-full max-w-6xl px-6">
          <h2 id="visit-heading" className="text-center text-xl font-bold">
            How a visit works
          </h2>
          <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {VISIT_STEPS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="card-soft p-6">
                <span className="grid size-10 place-items-center rounded-xl bg-brand/10 text-brand">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 font-bold">{title}</h3>
                <p className="mt-1 text-sm text-slate-600">{body}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t border-border bg-white">
        <div className="max-w-7xl mx-auto px-6 py-6 flex flex-wrap gap-4 justify-between items-center text-xs text-slate-500">
          {/*
            No regulatory approval or endorsement is claimed here. Neem's
            standing with Ghanaian regulators is unverified and is tracked in
            docs/compliance/ — nothing ships as fact without a document behind
            it (spec §78, decision D10).
          */}
          <span>&copy; 2026 Neem Health · Accra, Ghana</span>
          <span>The Community Health Officer and the doctor decide. Neem does not diagnose.</span>
        </div>
      </footer>
    </div>
  );
}
