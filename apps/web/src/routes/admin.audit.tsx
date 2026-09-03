import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2, ScrollText, Search } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { api, ApiError } from "@/lib/api-client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/audit")({
  component: AdminAudit,
});

interface AuditEntry {
  id: string;
  occurredAt: string;
  action: string;
  actorType: string;
  actorId: string | null;
  entityType: string | null;
  entityId: string | null;
  outcome: string;
  metadata: unknown;
}

const PAGE_SIZE = 50;

/**
 * The audit log, paged.
 *
 * This asked for one page and stopped, so the newest fifty entries were the
 * only ones an administrator could reach — in the record that exists to answer
 * "who saw this, and when". The route was ignoring its own cursor; both halves
 * are fixed.
 *
 * The cursor is the last entry's id, which this already has in hand, so paging
 * needs nothing from the response envelope. `hasMore` is inferred the same
 * way: a full page means there is probably another, and asking for it and
 * getting nothing back is a cheap way to be wrong.
 */
function useAuditLog(filters: { action?: string; entityId?: string }) {
  return useInfiniteQuery({
    queryKey: ["admin", "audit", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (filters.action) params.set("action", filters.action);
      if (filters.entityId) params.set("entityId", filters.entityId);
      if (pageParam) params.set("cursor", pageParam);

      return api.get<AuditEntry[]>(`/admin/audit-logs?${params}`, signal);
    },
    getNextPageParam: (lastPage) =>
      lastPage.length === PAGE_SIZE ? lastPage.at(-1)?.id : undefined,
  });
}

/**
 * The audit log (spec §61).
 *
 * Append-only, and this screen only reads it — there is no edit, no delete and
 * no route behind either. An audit trail an administrator can tidy is not an
 * audit trail.
 *
 * What it deliberately does not show, because the log does not hold it: what a
 * doctor wrote, what was prescribed, what a test said. Entries carry counts,
 * identifiers and outcomes so the log records *that* something happened
 * without becoming a second copy of the record it describes (spec §61, D23).
 */
function AdminAudit() {
  const [action, setAction] = useState("");
  const [entityId, setEntityId] = useState("");
  const [applied, setApplied] = useState<{ action?: string; entityId?: string }>({});

  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useAuditLog(applied);

  const entries = data?.pages.flat() ?? [];

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Audit log</h1>
        <p className="mt-2 max-w-2xl text-pretty text-sm leading-relaxed text-slate-500">
          Every consequential action, appended and never altered. Entries record that something
          happened and to what — never the contents of a clinical record.
        </p>
      </header>

      <section className="card-soft p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Action
            </span>
            <input
              value={action}
              onChange={(event) => setAction(event.target.value)}
              placeholder="prescription.issued"
              className="mt-1 w-64 rounded-xl border border-border px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Entity id
            </span>
            <input
              value={entityId}
              onChange={(event) => setEntityId(event.target.value)}
              className="mt-1 w-72 rounded-xl border border-border px-3 py-2 font-mono text-sm"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              setApplied({
                action: action.trim() || undefined,
                entityId: entityId.trim() || undefined,
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110"
          >
            <Search className="size-4" /> Search
          </button>
          {(applied.action || applied.entityId) && (
            <button
              type="button"
              onClick={() => {
                setAction("");
                setEntityId("");
                setApplied({});
              }}
              className="rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-slate-50"
            >
              Clear
            </button>
          )}
        </div>
      </section>

      {isLoading && (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      )}

      {error && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {error instanceof ApiError ? error.message : "The audit log could not be read."}
          </p>
        </div>
      )}

      {!isLoading && entries.length === 0 && (
        <div className="card-soft p-12 text-center">
          <ScrollText className="mx-auto size-10 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">Nothing matches that search.</p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="card-soft divide-y divide-border">
          {entries.map((entry) => (
            <AuditRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}

      {hasNextPage && (
        <button
          type="button"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="mx-auto inline-flex items-center gap-2 rounded-xl border border-border px-5 py-2.5 text-sm font-bold hover:bg-slate-50 disabled:opacity-40"
        >
          {isFetchingNextPage ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Loading
            </>
          ) : (
            <>Show older entries</>
          )}
        </button>
      )}
    </AppShell>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const failed = entry.outcome === "FAILURE";

  return (
    <div className="p-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full flex-wrap items-baseline justify-between gap-3 text-left"
      >
        <div className="min-w-0">
          <code
            className={cn("font-mono text-xs font-bold", failed && "text-red-600")}
          >
            {entry.action}
          </code>
          <p className="mt-0.5 text-xs text-slate-500">
            {entry.actorType.toLowerCase()}
            {entry.entityType && ` · ${entry.entityType}`}
            {entry.entityId && ` · ${entry.entityId}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {failed && <Chip tone="danger">failure</Chip>}
          <span className="text-xs text-slate-400">
            {new Date(entry.occurredAt).toLocaleString()}
          </span>
        </div>
      </button>

      {open && (
        <pre className="mt-3 overflow-x-auto rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed">
          {JSON.stringify(entry.metadata, null, 2)}
        </pre>
      )}
    </div>
  );
}
