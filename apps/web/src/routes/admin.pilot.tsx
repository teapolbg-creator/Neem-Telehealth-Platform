import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  AlertCircle,
  Download,
  Inbox,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Search,
  Stethoscope,
  Store,
} from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  pilotExportUrl,
  usePilotApplications,
  useSetPilotStatus,
  type PilotApplication,
  type PilotFilters,
  type PilotRole,
  type PilotStatus,
} from "@/features/pilot/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/pilot")({
  component: AdminPilot,
});

const STATUS_TONE: Record<PilotStatus, "brand" | "medical" | "warning" | "muted" | "danger"> = {
  NEW: "warning",
  CONTACTED: "medical",
  ONBOARDED: "brand",
  DECLINED: "muted",
  SPAM: "danger",
};

const STATUS_LABEL: Record<PilotStatus, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  ONBOARDED: "Onboarded",
  DECLINED: "Declined",
  SPAM: "Spam",
};

const STATUSES: PilotStatus[] = ["NEW", "CONTACTED", "ONBOARDED", "DECLINED", "SPAM"];

/**
 * Pilot applications from the marketing site.
 *
 * These are people who put their name down, not accounts. The screen exists so
 * that a lead is worked rather than sitting in a table nobody opens — which is
 * why the default view is what is still waiting for a call.
 */
function AdminPilot() {
  const [role, setRole] = useState<PilotRole | undefined>(undefined);
  const [status, setStatus] = useState<PilotStatus | undefined>("NEW");
  const [search, setSearch] = useState("");

  const filters: PilotFilters = { role, status, search: search.trim() || undefined };
  const { data: applications, isLoading, error } = usePilotApplications(filters);

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Pilot applications</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Doctors and pharmacies who registered interest on the Neem website. These are
          expressions of interest, not accounts — onboarding, with credential checks, still
          happens separately. Marking someone onboarded records that it happened; it does not
          create anything.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <FilterGroup
          label="Role"
          value={role}
          onChange={setRole}
          options={[
            { key: undefined, label: "Everyone" },
            { key: "DOCTOR", label: "Doctors" },
            { key: "PHARMACY", label: "Pharmacies" },
          ]}
        />

        <FilterGroup
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { key: "NEW", label: "Waiting" },
            { key: "CONTACTED", label: "Contacted" },
            { key: "ONBOARDED", label: "Onboarded" },
            { key: undefined, label: "All" },
          ]}
        />

        <label className="relative ml-auto">
          <span className="sr-only">Search applications</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, pharmacy, town…"
            className="h-10 w-64 rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand"
          />
        </label>

        <a
          href={pilotExportUrl(filters)}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50"
        >
          <Download className="size-4" /> Export CSV
        </a>
      </div>

      {isLoading && (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      )}

      {error && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {error instanceof ApiError ? error.message : "Applications could not be loaded."}
          </p>
        </div>
      )}

      {applications?.length === 0 && (
        <div className="card-soft p-12 text-center">
          <Inbox className="mx-auto size-10 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">
            {status === "NEW"
              ? "Nobody is waiting to be called."
              : "No applications match these filters."}
          </p>
        </div>
      )}

      <div className="space-y-4">
        {applications?.map((application) => (
          <ApplicationCard key={application.publicId} application={application} />
        ))}
      </div>
    </AppShell>
  );
}

function FilterGroup<T extends string | undefined>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  options: Array<{ key: T; label: string }>;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      <div className="flex w-fit gap-1 rounded-xl bg-slate-100 p-1">
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={value === option.key}
            onClick={() => onChange(option.key)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
              value === option.key
                ? "bg-white text-brand shadow-sm"
                : "text-slate-500 hover:bg-white/60",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ApplicationCard({ application }: { application: PilotApplication }) {
  const setStatus = useSetPilotStatus();
  const [note, setNote] = useState("");

  const Icon = application.role === "DOCTOR" ? Stethoscope : Store;

  return (
    <section className="card-soft p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="size-4 text-brand" />
            <h2 className="truncate text-lg font-bold">{application.fullName}</h2>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            {application.organisation}
            {application.specialty ? ` · ${application.specialty}` : ""}
            {application.yearsOfPractice ? ` · ${application.yearsOfPractice} years` : ""}
          </p>

          {/*
            Real links, not plain text. Whoever works this list is going to
            call and email these people all day.
          */}
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <a
              href={`tel:${application.phone}`}
              className="inline-flex items-center gap-1.5 text-slate-600 hover:text-brand"
            >
              <Phone className="size-3.5" /> {application.phone}
            </a>
            <a
              href={`mailto:${application.email}`}
              className="inline-flex items-center gap-1.5 text-slate-600 hover:text-brand"
            >
              <Mail className="size-3.5" /> {application.email}
            </a>
            <span className="inline-flex items-center gap-1.5 text-slate-500">
              <MapPin className="size-3.5" /> {application.location}
            </span>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <Chip tone={STATUS_TONE[application.status]}>{STATUS_LABEL[application.status]}</Chip>
          <span className="text-[11px] text-slate-400">
            applied {new Date(application.createdAt).toLocaleDateString()}
          </span>
          <span className="font-mono text-[11px] text-slate-400">{application.publicId}</span>
        </div>
      </div>

      {application.additionalInfo && (
        <p className="mt-4 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
          {application.additionalInfo}
        </p>
      )}

      {application.statusNote && (
        <p className="mt-3 text-sm text-slate-500">
          <span className="font-semibold">Note:</span> {application.statusNote}
          {application.reviewedAt
            ? ` · ${new Date(application.reviewedAt).toLocaleDateString()}`
            : ""}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <input
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="What happened? (optional)"
          className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand"
        />

        {STATUSES.filter((option) => option !== application.status).map((option) => (
          <button
            key={option}
            type="button"
            disabled={setStatus.isPending}
            onClick={() =>
              setStatus.mutate({ publicId: application.publicId, status: option, note })
            }
            className={cn(
              "h-9 rounded-lg border px-3 text-xs font-semibold transition-colors disabled:opacity-50",
              option === "SPAM"
                ? "border-slate-200 text-slate-400 hover:bg-slate-50"
                : "border-slate-200 text-slate-600 hover:bg-slate-50",
            )}
          >
            {STATUS_LABEL[option]}
          </button>
        ))}
      </div>

      {setStatus.isError && (
        <p className="mt-3 text-sm text-red-600">
          {setStatus.error instanceof ApiError
            ? setStatus.error.message
            : "That could not be saved."}
        </p>
      )}
    </section>
  );
}
