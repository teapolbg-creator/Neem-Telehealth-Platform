import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { NeemLogo } from "@/components/neem/Logo";

/**
 * The frame every patient-facing screen sits in (v2).
 *
 * Phone-first, because that is the device: a single column, generous targets,
 * and nothing that needs a mouse. On a desktop it is framed at phone
 * proportions rather than stretched, so the layout can be reviewed at the size
 * it will actually be used at — the same decision the consultation portal
 * makes.
 *
 * `wide` opens it up for the one screen that benefits, the list of what is on
 * offer, where cards side by side are easier to compare than a long scroll.
 */
export function PatientFrame({
  children,
  wide,
  back,
}: {
  children: ReactNode;
  wide?: boolean;
  back?: { to: string; label: string };
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="border-b border-border bg-white">
        <div
          className={`mx-auto flex w-full items-center justify-between gap-4 px-5 py-3.5 ${
            wide ? "max-w-5xl" : "max-w-lg"
          }`}
        >
          <Link to="/book" className="shrink-0">
            <NeemLogo className="text-lg" markClassName="size-8" />
          </Link>
          {back ? (
            <Link to={back.to} className="text-sm font-semibold text-brand hover:underline">
              {back.label}
            </Link>
          ) : (
            <Link
              to="/account"
              className="text-sm font-semibold text-slate-500 hover:text-slate-900"
            >
              My care
            </Link>
          )}
        </div>
      </header>

      <main className={`mx-auto w-full flex-1 px-5 py-6 ${wide ? "max-w-5xl" : "max-w-lg"}`}>
        {children}
      </main>

      {/*
        Said on every screen rather than once at the start. A patient who is
        getting worse should not have to remember a sentence they scrolled past
        ten minutes ago (spec §72).
      */}
      <footer className="border-t border-border bg-white px-5 py-4">
        <p
          className={`mx-auto text-xs leading-relaxed text-slate-500 ${wide ? "max-w-5xl" : "max-w-lg"}`}
        >
          Neem is not for emergencies. If you have chest pain, trouble breathing, heavy bleeding, or
          you feel you may be in danger, go to the nearest hospital or call 112 now.
        </p>
      </footer>
    </div>
  );
}

/** The one thing a screen is waiting for, said plainly rather than spun. */
export function FrameMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card-soft p-8 text-center">
      <h1 className="text-xl font-bold">{title}</h1>
      {children ? (
        <div className="mt-2 text-sm leading-relaxed text-slate-600">{children}</div>
      ) : null}
    </div>
  );
}
