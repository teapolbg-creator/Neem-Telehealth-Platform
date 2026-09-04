import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, History, Loader2, Lock, Save } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  useSettingHistory,
  useSettings,
  useUpdateSetting,
  type Setting,
} from "@/features/analytics/api";

export const Route = createFileRoute("/admin/settings")({
  component: AdminSettings,
});

/**
 * The configuration console (spec §96).
 *
 * Everything Neem charges, splits, waits for or routes on is here rather than
 * in code — the specification forbids hard-coding business values, and until
 * now the only way to change one was to edit the database by hand.
 *
 * The rule this screen exists to enforce: **a sensitive change needs a
 * recorded reason.** Which settings are sensitive is a property of the setting
 * itself, not a list this screen keeps, so a new one is protected the moment
 * it is seeded rather than when someone remembers to update the UI.
 */
function AdminSettings() {
  const { data: settings, isLoading, error } = useSettings();

  const categories = [...new Set((settings ?? []).map((setting) => setting.category))].sort();

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Prices, revenue split, timers and routing weights. Changes take effect immediately, and
          every one is recorded with who made it.
        </p>
      </header>

      {isLoading && (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      )}

      {error && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {error instanceof ApiError ? error.message : "Settings could not be loaded."}
          </p>
        </div>
      )}

      {categories.map((category) => (
        <section key={category} className="card-soft p-6">
          <h2 className="font-bold capitalize">{category}</h2>
          <div className="mt-4 divide-y divide-border">
            {settings!
              .filter((setting) => setting.category === category)
              .map((setting) => (
                <SettingRow key={setting.key} setting={setting} />
              ))}
          </div>
        </section>
      ))}
    </AppShell>
  );
}

function SettingRow({ setting }: { setting: Setting }) {
  const update = useUpdateSetting();
  const [draft, setDraft] = useState(String(setting.value));
  const [reason, setReason] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const { data: history } = useSettingHistory(setting.key, showHistory);

  const changed = draft !== String(setting.value);
  const needsReason = setting.requiresConfirm && reason.trim().length < 3;

  const parse = (raw: string): unknown => {
    if (setting.valueType === "number") return Number(raw);
    if (setting.valueType === "boolean") return raw === "true";
    return raw;
  };

  const invalid = setting.valueType === "number" && !Number.isFinite(Number(draft));

  return (
    <div className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-xs font-bold">{setting.key}</code>
            {setting.requiresConfirm && (
              <Chip tone="warning">
                <Lock className="mr-1 inline size-3" /> needs a reason
              </Chip>
            )}
          </div>
          {setting.description && (
            <p className="mt-1 max-w-2xl text-pretty text-xs leading-relaxed text-slate-500">
              {setting.description}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {setting.valueType === "boolean" ? (
            <select
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="rounded-xl border border-border bg-white px-3 py-2 text-sm"
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              inputMode={setting.valueType === "number" ? "decimal" : "text"}
              className="w-40 rounded-xl border border-border px-3 py-2 text-right font-mono text-sm"
            />
          )}
          <button
            type="button"
            onClick={() => setShowHistory((open) => !open)}
            aria-label={`History for ${setting.key}`}
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <History className="size-4" />
          </button>
        </div>
      </div>

      {changed && (
        <div className="mt-3 rounded-2xl bg-slate-50 p-4">
          {/*
            The impact, spelled out before the change is made (spec §96). A
            revenue split or a price is not something to alter on the strength
            of a field going yellow.
          */}
          {setting.requiresConfirm && (
            <p className="text-xs leading-relaxed text-amber-900">
              <strong className="font-bold">This affects money or clinical routing.</strong> It
              applies to every consultation created after you save. Existing records keep the value
              that was in force when they were created.
            </p>
          )}

          {setting.requiresConfirm && (
            <label className="mt-3 block">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Why (recorded, required)
              </span>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
              />
            </label>
          )}

          {update.error && (
            <p className="mt-3 text-sm text-red-600">
              {update.error instanceof ApiError
                ? update.error.message
                : "The change could not be saved."}
            </p>
          )}

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={invalid || needsReason || update.isPending}
              onClick={() =>
                update.mutate(
                  {
                    key: setting.key,
                    value: parse(draft),
                    reason: reason.trim() || undefined,
                  },
                  { onSuccess: () => setReason("") },
                )
              }
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
            >
              {update.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(String(setting.value));
                setReason("");
              }}
              className="rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-slate-50"
            >
              Discard
            </button>
          </div>

          {invalid && <p className="mt-2 text-xs text-red-600">That is not a number.</p>}
        </div>
      )}

      {showHistory && (
        <div className="mt-3 rounded-2xl border border-border p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
            Change history
          </p>
          {!history || history.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">This setting has never been changed.</p>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {history.map((entry) => (
                <li key={entry.changedAt} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-mono text-xs text-slate-500">
                    {String(entry.oldValue)} → {String(entry.newValue)}
                  </span>
                  <span className="text-xs text-slate-400">
                    {new Date(entry.changedAt).toLocaleString()}
                  </span>
                  {entry.reason && <span className="text-xs text-slate-600">{entry.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
