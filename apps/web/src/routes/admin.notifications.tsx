import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Bell, Check, Loader2, RotateCcw } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  useNotificationTemplates,
  useUpdateNotificationTemplate,
  type NotificationTemplate,
} from "@/features/analytics/api";

export const Route = createFileRoute("/admin/notifications")({
  component: AdminNotifications,
});

const CHANNEL_TONE: Record<string, "brand" | "medical" | "warning" | "muted"> = {
  SMS: "brand",
  EMAIL: "medical",
  WHATSAPP: "medical",
  IN_APP: "muted",
};

/**
 * The notification catalogue (spec §58, §60, §96).
 *
 * Phase 8 built 21 templates, the list of variables each may fill, and the
 * validation that stops one carrying clinical content. **No screen ever
 * imported any of it**, so the wording of every message Neem sends could be
 * changed only by editing the database — which meant, in practice, that it
 * could not be changed.
 *
 * Two things this screen is careful about.
 *
 * **The refusal is the feature.** A body naming a dose, a medication or a
 * diagnosis is rejected by the API, and this screen shows exactly which rule
 * was broken rather than a generic failure. An administrator who is told
 * only "invalid" learns nothing and tries again with the same idea.
 *
 * **It never lists what was sent.** There is nothing to list: `notifications`
 * stores a hash, not a body (D32). This edits what *will* be said, and the
 * absence of a history is deliberate rather than missing.
 */
function AdminNotifications() {
  const templates = useNotificationTemplates();

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Notifications</h1>
        <p className="mt-2 max-w-2xl text-pretty text-sm leading-relaxed text-slate-500">
          The wording of every message Neem sends. A notification tells someone that something
          happened — never what was wrong with them, what was prescribed, or what a test said.
          Wording that reads as clinical content is refused when you save it, not when it is sent.
        </p>
      </header>

      {templates.isLoading && (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      )}

      {templates.error && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {templates.error instanceof ApiError
              ? templates.error.message
              : "The notification catalogue could not be loaded."}
          </p>
        </div>
      )}

      {templates.data?.length === 0 && (
        <div className="card-soft p-12 text-center">
          <Bell className="mx-auto size-10 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">
            No templates are seeded. Run the reference-data seed.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {templates.data?.map((template) => (
          <TemplateCard key={`${template.code}-${template.channel}`} template={template} />
        ))}
      </div>
    </AppShell>
  );
}

function TemplateCard({ template }: { template: NotificationTemplate }) {
  const [subject, setSubject] = useState(template.subject ?? "");
  const [body, setBody] = useState(template.body);
  const update = useUpdateNotificationTemplate();

  const dirty = body !== template.body || (template.subject ?? "") !== subject;

  // The API returns one entry per broken rule. Showing them together matters:
  // a body can name a dose *and* use a variable this notification cannot fill,
  // and fixing one at a time turns a single edit into three round trips.
  const problems =
    update.error instanceof ApiError && update.error.details?.length
      ? update.error.details
      : null;

  return (
    <section className="card-soft p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-sm font-bold">{template.code}</code>
            <Chip tone={CHANNEL_TONE[template.channel] ?? "muted"}>
              {template.channel.toLowerCase()}
            </Chip>
            {!template.isDefault && <Chip tone="warning">edited</Chip>}
            {!template.isActive && <Chip tone="muted">off</Chip>}
          </div>
          {template.description && (
            <p className="mt-1.5 max-w-xl text-pretty text-xs leading-relaxed text-slate-500">
              {template.description}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() =>
            update.mutate({
              code: template.code,
              channel: template.channel,
              isActive: !template.isActive,
            })
          }
          className="rounded-xl border border-border px-4 py-2 text-xs font-semibold hover:bg-slate-50"
        >
          {template.isActive ? "Turn off" : "Turn on"}
        </button>
      </div>

      {template.channel === "EMAIL" && (
        <label className="mt-4 block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Subject</span>
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
          />
        </label>
      )}

      <label className="mt-4 block">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Message</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          className="mt-1 w-full resize-y rounded-xl border border-border px-3 py-2 font-mono text-sm leading-relaxed"
        />
      </label>

      {/*
        The variables are the whole vocabulary this notification has. Anything
        else in double braces is refused, so listing them is not a convenience
        — it is the difference between writing a message and guessing at one.
      */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-slate-500">Available:</span>
        {template.variables.length === 0 ? (
          <span className="text-xs text-slate-400">none — this message takes no details</span>
        ) : (
          template.variables.map((variable) => (
            <button
              key={variable}
              type="button"
              onClick={() => setBody((current) => `${current}{{${variable}}}`)}
              className="rounded-lg bg-slate-100 px-2 py-1 font-mono text-[11px] font-semibold text-slate-600 hover:bg-slate-200"
            >
              {`{{${variable}}}`}
            </button>
          ))
        )}
      </div>

      {problems && (
        <div className="card-soft mt-4 border-red-200 bg-red-50 p-4">
          <p className="text-sm font-bold text-red-700">This wording was not saved.</p>
          <ul className="mt-2 space-y-1">
            {problems.map((problem, index) => (
              <li key={index} className="text-xs leading-relaxed text-red-700">
                {problem.issue}
              </li>
            ))}
          </ul>
        </div>
      )}

      {update.error && !problems && (
        <p className="mt-3 text-xs font-semibold text-red-600">
          {update.error instanceof ApiError ? update.error.message : "Could not save."}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!dirty || update.isPending}
          onClick={() =>
            update.mutate({
              code: template.code,
              channel: template.channel,
              body,
              ...(template.channel === "EMAIL" ? { subject: subject || null } : {}),
            })
          }
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
        >
          {update.isPending && <Loader2 className="size-4 animate-spin" />}
          Save wording
        </button>

        {dirty && (
          <button
            type="button"
            onClick={() => {
              setBody(template.body);
              setSubject(template.subject ?? "");
              update.reset();
            }}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-slate-50"
          >
            <RotateCcw className="size-3.5" /> Discard
          </button>
        )}

        {!dirty && update.isSuccess && (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand">
            <Check className="size-3.5" /> Saved
          </span>
        )}
      </div>
    </section>
  );
}
