import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  PROTOCOL_READINGS,
  TRIAGE_CATEGORIES,
  TRIAGE_CATEGORY_INFO,
  type ProtocolComparison,
  type ProtocolReading,
  type TriageCategory,
  type TriageRuleAdmin,
  type TriageRuleCreate,
} from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { api, ApiError } from "@/lib/api-client";
import { inputClass, labelClass } from "@/features/facility/form";

export const Route = createFileRoute("/admin/triage-protocol")({
  component: TriageProtocol,
});

const KEY = ["admin", "triage-protocol"] as const;

/**
 * The approved triage protocol (slice 5c, brief §A3, D93). Neem ships with no
 * rules, and every rule names the approved document it came from. A rule that
 * changes is retired and replaced, so what a CHO was shown stays explainable.
 */
function TriageProtocol() {
  const client = useQueryClient();
  const rules = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api.get<TriageRuleAdmin[]>("/admin/triage-protocol", signal),
  });
  const retire = useMutation({
    mutationFn: (id: string) => api.post(`/admin/triage-protocol/${id}/retire`),
    onSuccess: () => client.invalidateQueries({ queryKey: KEY }),
  });

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Triage protocol</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Flags a CHO sees as they record vital signs. Enter only what a clinically approved
          protocol says, and name it. A flag prompts the CHO and changes nothing: the category and
          any emergency stay their decision.
        </p>
      </header>

      <AddRule />

      {rules.isLoading ? (
        <div className="card-soft grid place-items-center p-12">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      ) : null}
      {rules.error ? (
        <p className="text-sm text-red-600">
          {rules.error instanceof ApiError ? rules.error.message : "Rules could not be loaded."}
        </p>
      ) : null}

      {rules.data?.length === 0 ? (
        <div className="card-soft flex items-start gap-3 p-6 text-sm text-slate-600">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
          <p>
            No rules have been entered, so no flags appear. Neem does not come with any: thresholds
            have to come from an approved protocol.
          </p>
        </div>
      ) : null}

      <div className="space-y-3">
        {rules.data?.map((rule) => (
          <article
            key={rule.id}
            className="card-soft flex flex-wrap items-start justify-between gap-3 p-5"
          >
            <div className="text-sm">
              <p className="font-semibold">
                {PROTOCOL_READINGS[rule.reading]} {rule.comparison === "BELOW" ? "below" : "above"}{" "}
                {rule.threshold}
              </p>
              <p className="mt-1">
                {rule.message}
                {rule.suggestedCategory
                  ? ` Suggests ${TRIAGE_CATEGORY_INFO[rule.suggestedCategory].label}.`
                  : ""}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                From {rule.source}. Approved by {rule.approvedBy}. Entered{" "}
                {new Date(rule.createdAt).toLocaleDateString()}.
              </p>
            </div>
            {rule.retiredAt ? (
              <Chip tone="muted">Retired {new Date(rule.retiredAt).toLocaleDateString()}</Chip>
            ) : (
              <button
                type="button"
                disabled={retire.isPending}
                onClick={() => retire.mutate(rule.id)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Retire
              </button>
            )}
          </article>
        ))}
      </div>
    </AppShell>
  );
}

function AddRule() {
  const client = useQueryClient();
  const [reading, setReading] = useState<ProtocolReading | "">("");
  const [comparison, setComparison] = useState<ProtocolComparison>("BELOW");
  const [threshold, setThreshold] = useState("");
  const [category, setCategory] = useState<TriageCategory | "">("");
  const [message, setMessage] = useState("");
  const [source, setSource] = useState("");
  const [approvedBy, setApprovedBy] = useState("");

  const add = useMutation({
    mutationFn: (input: TriageRuleCreate) => api.post("/admin/triage-protocol", input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: KEY });
      setReading("");
      setThreshold("");
      setCategory("");
      setMessage("");
    },
  });
  const errors = add.error instanceof ApiError ? add.error.fieldErrors : {};

  return (
    <form
      className="card-soft space-y-3 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reading) return;
        add.mutate({
          reading,
          comparison,
          threshold: Number(threshold),
          suggestedCategory: category || null,
          message,
          source,
          approvedBy,
        });
      }}
    >
      <p className="font-bold">Add a rule from an approved protocol</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className="text-sm">
          <span className={labelClass}>Reading</span>
          <select
            value={reading}
            onChange={(event) => setReading(event.target.value as ProtocolReading)}
            className={inputClass}
          >
            <option value="">Choose</option>
            {Object.entries(PROTOCOL_READINGS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className={labelClass}>When it is</span>
          <select
            value={comparison}
            onChange={(event) => setComparison(event.target.value as ProtocolComparison)}
            className={inputClass}
          >
            <option value="BELOW">Below</option>
            <option value="ABOVE">Above</option>
          </select>
        </label>
        <label className="text-sm">
          <span className={labelClass}>This value</span>
          <input
            inputMode="decimal"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value.replace(/[^\d.]/g, ""))}
            className={inputClass}
          />
          {errors.threshold ? (
            <span className="text-xs text-red-600">{errors.threshold}</span>
          ) : null}
        </label>
        <label className="text-sm">
          <span className={labelClass}>Suggest (optional)</span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as TriageCategory)}
            className={inputClass}
          >
            <option value="">No suggestion</option>
            {TRIAGE_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {TRIAGE_CATEGORY_INFO[value].label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-sm">
        <span className={labelClass}>What the CHO is told</span>
        <input
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          className={inputClass}
        />
        {errors.message ? <span className="text-xs text-red-600">{errors.message}</span> : null}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className={labelClass}>Approved document</span>
          <input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className={inputClass}
          />
          {errors.source ? <span className="text-xs text-red-600">{errors.source}</span> : null}
        </label>
        <label className="text-sm">
          <span className={labelClass}>Approved by</span>
          <input
            value={approvedBy}
            onChange={(event) => setApprovedBy(event.target.value)}
            className={inputClass}
          />
          {errors.approvedBy ? (
            <span className="text-xs text-red-600">{errors.approvedBy}</span>
          ) : null}
        </label>
      </div>
      {add.error && Object.keys(errors).length === 0 ? (
        <p className="text-sm text-red-600">
          {add.error instanceof ApiError ? add.error.message : "Not added."}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!reading || threshold === "" || add.isPending}
        className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
      >
        Add rule
      </button>
    </form>
  );
}
