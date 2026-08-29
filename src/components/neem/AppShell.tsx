import { Link, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { NeemLogo } from "@/components/neem/Logo";

type AppKey = "pharmacy" | "patient" | "doctor" | "admin";

const tabs: { key: AppKey; label: string; to: string; prefix: string }[] = [
  { key: "pharmacy", label: "Pharmacy", to: "/pharmacy", prefix: "/pharmacy" },
  { key: "patient", label: "Patient", to: "/patient/NM-99281", prefix: "/patient" },
  { key: "doctor", label: "Doctor", to: "/doctor", prefix: "/doctor" },
  { key: "admin", label: "Admin", to: "/admin", prefix: "/admin" },
];

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

  return (
    <div className="min-h-dvh bg-surface text-foreground">
      <nav className="sticky top-0 z-40 border-b border-border bg-white/90 backdrop-blur-md px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        <Link to="/" className="shrink-0">
          <NeemLogo className="text-xl" markClassName="size-8" />
        </Link>
        <div className="hidden sm:flex gap-1 bg-slate-100 p-1 rounded-xl">
          {tabs.map((t) => {
            const isActive = t.key === active || pathname.startsWith(t.prefix);
            return (
              <a
                key={t.key}
                href={t.to}
                className={cn(
                  "px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors",
                  isActive ? "bg-white shadow-sm text-brand" : "text-slate-500 hover:bg-white/60",
                )}
              >
                {t.label}
              </a>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden md:inline text-xs text-slate-500 font-medium">Accra, Ghana</span>
          <div className="size-8 rounded-full bg-slate-200 grid place-items-center text-xs font-bold text-slate-600">AN</div>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto p-4 sm:p-6 grid grid-cols-12 gap-6">
        {sidebar && <aside className="col-span-12 lg:col-span-3 space-y-6">{sidebar}</aside>}
        <main className={cn("col-span-12 space-y-6", sidebar ? "lg:col-span-9" : "")}>{children}</main>
      </div>
    </div>
  );
}
