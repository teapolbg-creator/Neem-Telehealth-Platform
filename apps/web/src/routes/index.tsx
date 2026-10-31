import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
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

function Landing() {
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <nav className="w-full px-6 py-4 flex items-center justify-between max-w-7xl mx-auto">
        <NeemLogo className="text-xl" markClassName="size-10" />
        <span className="text-xs text-slate-500 font-medium hidden sm:inline">
          Telemedicine in Ghana, at your pharmacy or from your phone
        </span>
      </nav>

      {/*
        Centred in the space between the nav and the footer, so the page reads
        as a deliberate hero on a tall screen rather than content followed by a
        gap. Each portal is reached by signing in, and the patient's only by the
        one-time code a pharmacy gives them — none needs a card here.
      */}
      <main className="flex flex-1 flex-col justify-center pb-16 sm:pb-24">
        <ResumeConsultation />

        <header className="w-full max-w-4xl mx-auto px-6 pt-12 sm:pt-20 pb-10 text-center">
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
            Neem connects patients with licensed Ghanaian doctors through secure video and audio
            consultations. Book one yourself, or start a consultation at a participating pharmacy.
            Nothing to download.
          </p>
        </header>

        <section className="mx-auto w-full max-w-4xl px-6">
          <div className="card-soft flex flex-wrap items-center justify-between gap-4 p-6">
            <div>
              <h2 className="font-bold">Join the Neem network</h2>
              <p className="mt-1 text-sm text-slate-500">
                Applications are verified by a Neem administrator before activation.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <a
                href="/onboarding/doctor"
                className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110"
              >
                Apply as a health professional
              </a>
              <a
                href="/onboarding/pharmacy"
                className="rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110"
              >
                Register a pharmacy
              </a>
              <a
                href="/auth/login"
                className="rounded-xl border border-border px-5 py-2.5 text-sm font-semibold hover:bg-slate-50"
              >
                Sign in
              </a>
            </div>
          </div>
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
          {/*
            This said "Privacy-first · Session-only" and "WCAG AA" until Phase
            11. Both were claims the product could not support, sitting two
            lines below a comment forbidding exactly that.

            "Session-only" stopped being true at D23: clinical records are
            retained under legal obligation for three years, not discarded when
            the session ends. It was the original design's promise, left
            standing on the one page a patient reads before anything else.

            "WCAG AA" is a conformance claim, and no audit has been performed —
            Phase 11 ran an accessibility pass and fixed real defects, which is
            not the same thing and must not be described as if it were.

            What is left is what can be shown: no patient account exists, and
            the retention position is stated where it is explained rather than
            compressed into a badge.
          */}
          <div className="flex gap-6">
            <span>No patient accounts · No consultation recording</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
