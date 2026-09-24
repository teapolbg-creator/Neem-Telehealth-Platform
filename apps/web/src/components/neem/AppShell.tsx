import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LogOut, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { NeemLogo } from "@/components/neem/Logo";
import { useLogout, useSession } from "@/features/auth/use-session";
import { ApiError } from "@/lib/api-client";
import { PERMISSIONS, type Permission } from "@neem/contracts";

type AppKey = "pharmacy" | "doctor" | "admin";

/**
 * Application shell for the authenticated portals.
 *
 * The Lovable prototype rendered all four portals as tabs to anyone — a useful
 * demo device, but not a product. Navigation is now derived from the signed-in
 * principal's role, and the API independently refuses any request the shell
 * would have hidden (spec §92).
 *
 * The patient portal deliberately does not use this shell: patients have no
 * account, no navigation, and a phone-first layout of their own.
 */
/**
 * `permission`, where given, hides an item from somebody the API would refuse
 * anyway — a dietitian has no substitutions to decide (v2). Presentation only;
 * the route behind it still checks for itself.
 */
const NAV: Record<
  AppKey,
  { label: string; to: string; permission?: Permission; doctorsOnly?: boolean }[]
> = {
  pharmacy: [
    { label: "Dashboard", to: "/pharmacy" },
    { label: "New consultation", to: "/pharmacy/new" },
    { label: "Prescriptions", to: "/pharmacy/prescriptions" },
    { label: "Earnings", to: "/pharmacy/finance" },
    { label: "Verification", to: "/pharmacy/onboarding" },
  ],
  doctor: [
    { label: "Queue", to: "/doctor/queue" },
    { label: "Dashboard", to: "/doctor" },
    {
      label: "Substitutions",
      to: "/doctor/substitutions",
      permission: PERMISSIONS.SUBSTITUTION_DECIDE,
    },
    { label: "Bookable hours", to: "/doctor/availability" },
    { label: "Earnings", to: "/doctor/earnings" },
    // Every professional pays the membership fee, so every professional needs
    // somewhere to pay and renew it (operator decision, 2026-09-24).
    { label: "Membership", to: "/doctor/membership" },
    // Renamed below once the account is active: by then it is where their
    // documents and signature are kept, not a process still under way.
    { label: "Onboarding", to: "/doctor/onboarding" },
  ],
  admin: [
    { label: "Overview", to: "/admin" },
    { label: "Live queue", to: "/admin/queue" },
    { label: "Scheduling", to: "/admin/scheduling" },
    { label: "Refunds", to: "/admin/refunds" },
    { label: "Payouts", to: "/admin/payouts" },
    { label: "Professional pay", to: "/admin/professional-payouts" },
    { label: "Payroll", to: "/admin/payroll" },
    { label: "Services", to: "/admin/services" },
    { label: "Promotions", to: "/admin/promotions" },
    { label: "Verification", to: "/admin/verification" },
    { label: "Pilot", to: "/admin/pilot" },
    { label: "Quality", to: "/admin/quality" },
    { label: "Archive", to: "/admin/archive" },
    { label: "Audit", to: "/admin/audit" },
    { label: "Notifications", to: "/admin/notifications" },
    { label: "Settings", to: "/admin/settings" },
  ],
};

const ROLE_TO_APP: Record<string, AppKey> = {
  PHARMACY: "pharmacy",
  DOCTOR: "doctor",
  ADMIN: "admin",
};

export function AppShell({
  active,
  sidebar,
  children,
}: {
  active: AppKey;
  sidebar?: ReactNode;
  children: ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { user, isLoading, can } = useSession();
  const logout = useLogout();
  const navigate = useNavigate();

  const isDoctor = (user?.discipline ?? "DOCTOR") === "DOCTOR";
  const navItems = (NAV[active] ?? []).filter(
    (item) => (!item.permission || can(item.permission)) && (!item.doctorsOnly || isDoctor),
  );
  const initials = initialsFor(user?.displayName);

  // The shell renders regardless of session state; each route guards its own
  // data. Showing a signed-out banner is friendlier than a blank screen while
  // /auth/me resolves.
  const signedInApp = user ? ROLE_TO_APP[user.role] : undefined;
  const wrongPortal = Boolean(user && signedInApp && signedInApp !== active);

  return (
    <div className="min-h-dvh bg-surface text-foreground">
      <nav className="sticky top-0 z-40 border-b border-border bg-white/90 backdrop-blur-md px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        <Link to="/" className="shrink-0">
          <NeemLogo className="text-xl" markClassName="size-8" />
        </Link>

        {/*
          Scrolls rather than clips.

          The admin has ten sections and the bar overflowed a 900px viewport,
          silently hiding the last of them — including the audit log and
          settings. `min-w-0` is the part that actually does the work: a flex
          child will not shrink below its content without it, so the container
          would keep growing and push items off the end instead of scrolling.
        */}
        {navItems.length > 1 && (
          <div className="hidden min-w-0 flex-1 sm:flex justify-center overflow-x-auto">
            <div className="flex shrink-0 gap-1 bg-slate-100 p-1 rounded-xl">
              {navItems.map((item) => {
                const isActive =
                  item.to === pathname || (item.to !== "/" && pathname.startsWith(`${item.to}/`));
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={cn(
                      "px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors",
                      isActive
                        ? "bg-white shadow-sm text-brand"
                        : "text-slate-500 hover:bg-white/60",
                    )}
                  >
                    {item.to === "/doctor/onboarding" && user?.organisation?.status === "ACTIVE"
                      ? "Credentials"
                      : item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          {isLoading ? (
            <div className="size-8 rounded-full bg-slate-100 animate-pulse" aria-hidden />
          ) : user ? (
            <>
              {logout.isError && (
                <p role="alert" className="max-w-56 text-right text-xs text-red-700">
                  Not signed out.{" "}
                  {logout.error instanceof ApiError ? logout.error.message : "Please try again."}
                </p>
              )}
              <div className="hidden md:flex flex-col items-end leading-tight">
                <span className="text-xs font-semibold">{user.displayName}</span>
                <span className="text-[10px] text-slate-500 uppercase tracking-wider">
                  {user.organisation?.name ?? user.role.toLowerCase()}
                </span>
              </div>
              <div
                className="size-8 rounded-full bg-brand/10 grid place-items-center text-xs font-bold text-brand"
                aria-hidden
              >
                {initials}
              </div>
              <button
                type="button"
                onClick={() =>
                  // Navigate only once the session has actually ended. The
                  // login page sends a live session straight back.
                  logout.mutate(undefined, {
                    onSuccess: () => void navigate({ to: "/auth/login" }),
                  })
                }
                disabled={logout.isPending}
                className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="size-4" />
              </button>
            </>
          ) : (
            <Link
              to="/auth/login"
              className="text-xs font-semibold text-brand px-3 py-1.5 rounded-lg hover:bg-brand/10"
            >
              Sign in
            </Link>
          )}
        </div>
      </nav>

      {wrongPortal && (
        <div className="bg-warning-soft border-b border-warning/30 px-4 sm:px-6 py-2.5 flex items-center gap-2 text-xs text-slate-700">
          <ShieldAlert className="size-4 text-warning shrink-0" />
          <span>
            You are signed in as a {user?.role.toLowerCase()} account. This portal belongs to a
            different role, and the API will refuse its requests.
          </span>
        </div>
      )}

      <div className="max-w-7xl mx-auto p-4 sm:p-6 grid grid-cols-12 gap-6">
        {sidebar && <aside className="col-span-12 lg:col-span-3 space-y-6">{sidebar}</aside>}
        <main className={cn("col-span-12 space-y-6", sidebar ? "lg:col-span-9" : "")}>
          {children}
        </main>
      </div>
    </div>
  );
}

function initialsFor(displayName: string | undefined): string {
  if (!displayName) return "–";
  return displayName
    .replace(/^Dr\.?\s+/i, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
