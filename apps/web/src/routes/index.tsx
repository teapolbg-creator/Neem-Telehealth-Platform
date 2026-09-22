import { createFileRoute } from "@tanstack/react-router";
import { NeemLogo } from "@/components/neem/Logo";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <nav className="w-full px-6 py-4 flex items-center justify-between max-w-7xl mx-auto">
        <NeemLogo className="text-xl" markClassName="size-10" />
        <span className="text-xs text-slate-500 font-medium hidden sm:inline">
          Telemedicine for Ghanaian community pharmacies
        </span>
      </nav>

      {/*
        Centred in the space between the nav and the footer, so the page reads
        as a deliberate hero on a tall screen rather than content followed by a
        gap. Each portal is reached by signing in, and the patient's only by the
        one-time code a pharmacy gives them — none needs a card here.
      */}
      <main className="flex flex-1 flex-col justify-center pb-16 sm:pb-24">
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
            Neem connects patients at community pharmacies with licensed Ghanaian doctors through
            secure, session-based video and audio consultations. No downloads, no accounts.
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
