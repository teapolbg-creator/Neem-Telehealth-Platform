import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { LogOut, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { NeemLogo } from "@/components/neem/Logo";
import { useLogout, useSession } from "@/features/auth/use-session";

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
const NAV: Record<AppKey, { label: string; to: string }[]> = {
  pharmacy: [
    { label: "Dashboard", to: "/pharmacy" },
    { label: "New consultation", to: "/pharmacy/new" },
  ],
  doctor: [{ label: "Dashboard", to: "/doctor" }],
  admin: [{ label: "Overview", to: "/admin" }],
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
  const { user, isLoading } = useSession();
  const logout = useLogout();
  const navigate = useNavigate();

  const navItems = NAV[active] ?? [];
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

        {navItems.length > 1 && (
          <div className="hidden sm:flex gap-1 bg-slate-100 p-1 rounded-xl">
            {navItems.map((item) => {
              const isActive =
                item.to === pathname || (item.to !== "/" && pathname.startsWith(`${item.to}/`));
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors",
                    isActive ? "bg-white shadow-sm text-brand" : "text-slate-500 hover:bg-white/60",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-3">
          {isLoading ? (
            <div className="size-8 rounded-full bg-slate-100 animate-pulse" aria-hidden />
          ) : user ? (
            <>
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
                  logout.mutate(undefined, {
                    onSettled: () => void navigate({ to: "/auth/login" }),
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
