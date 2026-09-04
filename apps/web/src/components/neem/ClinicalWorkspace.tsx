import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  FileText,
  Loader2,
  Lock,
  Pill,
  Plus,
  Send,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { ApiError } from "@/lib/api-client";
import {
  useCompleteConsultation,
  useCreatePrescription,
  useIssuePrescription,
  useIssueReferral,
  useIssueSummary,
  useSaveNotes,
  useWorkspace,
  type Outcome,
  type PrescriptionItemInput,
} from "@/features/clinical/api";
import { cn } from "@/lib/utils";

/**
 * The doctor's clinical workspace (spec §14–§17, §41–§50).
 *
 * Everything the doctor writes during a consultation, and the one control that
 * ends it. Three things about this screen are deliberate:
 *
 *  - **Only the doctor completes.** There is no timer here that ends anything
 *    and no auto-save that finishes the consultation for them (spec §15, §16).
 *  - **The summary is written, never generated.** Nothing pre-fills it from the
 *    notes: a document carrying the doctor's signature saying "you do not need
 *    medication" is their clinical opinion (decision D25).
 *  - **Notes stop being editable at completion.** The record is sealed and the
 *    server refuses; the screen says so rather than failing silently (D23).
 */

type Tab = "notes" | "prescribe" | "refer" | "summary";

export function ClinicalWorkspace({
  consultationPublicId,
  onCompleted,
}: {
  consultationPublicId: string;
  onCompleted: (result: { destroyAt: string | null }) => void;
}) {
  const [tab, setTab] = useState<Tab>("notes");
  const { data: workspace, isLoading, error } = useWorkspace(consultationPublicId);

  const sealed = error instanceof ApiError && error.status === 403;

  if (isLoading) {
    return (
      <div className="card-soft grid place-items-center p-12">
        <Loader2 className="size-5 animate-spin text-brand" />
      </div>
    );
  }

  if (sealed) {
    return (
      <div className="card-soft flex items-start gap-3 border-slate-200 bg-slate-50 p-6">
        <Lock className="mt-0.5 size-5 shrink-0 text-slate-400" />
        <div className="text-sm text-slate-600">
          <p className="font-bold text-slate-900">This record is sealed.</p>
          <p className="mt-1 leading-relaxed">
            The consultation has ended. Its clinical record is retained under a legal record-keeping
            obligation and can no longer be opened here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="card-soft overflow-hidden">
      <div className="flex gap-1 border-b border-border bg-slate-50 p-1.5">
        {(
          [
            { key: "notes", label: "Notes", icon: FileText },
            { key: "prescribe", label: "Prescribe", icon: Pill },
            { key: "refer", label: "Refer", icon: Send },
            { key: "summary", label: "Summary", icon: ShieldAlert },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors",
              tab === item.key
                ? "bg-white text-brand shadow-sm"
                : "text-slate-500 hover:bg-white/60",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </button>
        ))}
      </div>

      <div className="p-6">
        {tab === "notes" && (
          <NotesPanel consultationPublicId={consultationPublicId} workspace={workspace} />
        )}
        {tab === "prescribe" && <PrescribePanel consultationPublicId={consultationPublicId} />}
        {tab === "refer" && <ReferPanel consultationPublicId={consultationPublicId} />}
        {tab === "summary" && <SummaryPanel consultationPublicId={consultationPublicId} />}
      </div>

      <CompletionBar consultationPublicId={consultationPublicId} onCompleted={onCompleted} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function NotesPanel({
  consultationPublicId,
  workspace,
}: {
  consultationPublicId: string;
  workspace:
    { notes: string | null; diagnosis: string | null; treatment: string | null } | undefined;
}) {
  const save = useSaveNotes(consultationPublicId);
  const [form, setForm] = useState({
    notes: workspace?.notes ?? "",
    diagnosis: workspace?.diagnosis ?? "",
    treatment: workspace?.treatment ?? "",
  });
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  /**
   * Saves on a pause in typing.
   *
   * A five-minute consultation is not the place to remember a Save button, and
   * a dropped connection mid-consultation must not lose what was written. This
   * does not complete anything — only the doctor does that, from the bar below.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Skips the first run.
   *
   * Without this the effect fires on mount and writes the loaded values
   * straight back — a pointless write to the clinical record, and a "Saved"
   * timestamp the doctor never earned. It should say nothing until they
   * actually type something.
   */
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      save.mutate(form, { onSuccess: () => setSavedAt(new Date()) });
    }, 1200);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // `save` is a stable mutation object; including it would restart the timer
    // on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  return (
    <div className="space-y-4">
      <Field
        label="Clinical notes"
        value={form.notes}
        onChange={(notes) => setForm({ ...form, notes })}
        rows={6}
        help="What the patient described, and what you observed."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Assessment / diagnosis"
          value={form.diagnosis}
          onChange={(diagnosis) => setForm({ ...form, diagnosis })}
          rows={3}
        />
        <Field
          label="Treatment"
          value={form.treatment}
          onChange={(treatment) => setForm({ ...form, treatment })}
          rows={3}
        />
      </div>

      <p className="flex items-center gap-2 text-xs text-slate-500">
        {save.isPending ? (
          <>
            <Loader2 className="size-3 animate-spin" /> Saving…
          </>
        ) : savedAt ? (
          <>
            <Check className="size-3 text-brand" /> Saved {savedAt.toLocaleTimeString()}
          </>
        ) : (
          "Saves as you type."
        )}
      </p>

      <p className="rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">
        These notes are sealed when you complete the consultation. They are retained under a legal
        record-keeping obligation and are not readable afterwards — by you or anyone else.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prescribing
// ---------------------------------------------------------------------------

const EMPTY_ITEM: PrescriptionItemInput = {
  medication: "",
  strength: "",
  form: "",
  dose: "",
  frequency: "",
  durationText: "",
  quantity: "",
  instructions: "",
};

function PrescribePanel({ consultationPublicId }: { consultationPublicId: string }) {
  const create = useCreatePrescription(consultationPublicId);
  const issue = useIssuePrescription(consultationPublicId);

  const [items, setItems] = useState<PrescriptionItemInput[]>([{ ...EMPTY_ITEM }]);
  const [issued, setIssued] = useState<string | null>(null);

  const complete = items.every(
    (item) => item.medication && item.dose && item.frequency && item.durationText && item.quantity,
  );

  if (issued) {
    return (
      <div className="text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-full bg-brand/10">
          <Check className="size-7 text-brand" />
        </div>
        <h3 className="mt-4 font-bold">Prescription issued</h3>
        <p className="mx-auto mt-2 max-w-sm text-pretty text-sm text-slate-500">
          It is signed with your digital signature and is now with the pharmacy.
        </p>
        <p className="mt-3 font-mono text-xs text-slate-500">{issued}</p>
        <p className="mx-auto mt-4 max-w-sm text-pretty text-xs leading-relaxed text-slate-500">
          You can revoke it from your dashboard until the pharmacy dispenses it. Once dispensed it
          cannot be revoked — the medicine is with the patient.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {items.map((item, index) => (
        <div key={index} className="rounded-2xl border border-border p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-400">
              Medication {index + 1}
            </p>
            {items.length > 1 && (
              <button
                type="button"
                onClick={() => setItems(items.filter((_, i) => i !== index))}
                aria-label={`Remove medication ${index + 1}`}
                className="text-slate-400 hover:text-red-600"
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              label="Medication"
              value={item.medication}
              onChange={(v) =>
                setItems(items.map((it, i) => (i === index ? { ...it, medication: v } : it)))
              }
            />
            <Input
              label="Strength"
              value={item.strength ?? ""}
              onChange={(v) =>
                setItems(items.map((it, i) => (i === index ? { ...it, strength: v } : it)))
              }
            />
            <Input
              label="Form"
              value={item.form ?? ""}
              onChange={(v) =>
                setItems(items.map((it, i) => (i === index ? { ...it, form: v } : it)))
              }
            />
            <Input
              label="Dose"
              value={item.dose}
              onChange={(v) =>
                setItems(items.map((it, i) => (i === index ? { ...it, dose: v } : it)))
              }
            />
            <Input
              label="Frequency"
              value={item.frequency}
              onChange={(v) =>
                setItems(items.map((it, i) => (i === index ? { ...it, frequency: v } : it)))
              }
            />
            <Input
              label="Duration"
              value={item.durationText}
              onChange={(v) =>
                setItems(items.map((it, i) => (i === index ? { ...it, durationText: v } : it)))
              }
            />
            <Input
              label="Quantity"
              value={item.quantity}
              onChange={(v) =>
                setItems(items.map((it, i) => (i === index ? { ...it, quantity: v } : it)))
              }
            />
            <div className="sm:col-span-2">
              <Input
                label="Instructions"
                value={item.instructions ?? ""}
                onChange={(v) =>
                  setItems(items.map((it, i) => (i === index ? { ...it, instructions: v } : it)))
                }
              />
            </div>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() => setItems([...items, { ...EMPTY_ITEM }])}
        className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-xs font-semibold hover:bg-slate-50"
      >
        <Plus className="size-3.5" /> Add another medication
      </button>

      <ErrorNote error={create.error ?? issue.error} />

      {/*
        One action, and it both creates and signs. A draft the doctor forgets to
        issue would be stranded — the server refuses to complete over one — so
        there is no reason to expose the two steps separately.
      */}
      <button
        type="button"
        disabled={!complete || create.isPending || issue.isPending}
        onClick={() =>
          create.mutate(items, {
            onSuccess: (draft) =>
              issue.mutate(draft.publicId, { onSuccess: (rx) => setIssued(rx.publicId) }),
          })
        }
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-3.5 font-bold text-white hover:brightness-110 disabled:opacity-40"
      >
        {(create.isPending || issue.isPending) && <Loader2 className="size-4 animate-spin" />}
        Sign and send to the pharmacy
      </button>

      <p className="text-xs leading-relaxed text-slate-500">
        Signing binds your digital signature to this prescription. The pharmacy cannot change what
        you prescribe — it can only propose a substitution for you to decide.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Referral
// ---------------------------------------------------------------------------

function ReferPanel({ consultationPublicId }: { consultationPublicId: string }) {
  const refer = useIssueReferral(consultationPublicId);
  const [form, setForm] = useState({
    hospitalName: "",
    department: "",
    reasonText: "",
    urgency: "",
  });

  if (refer.isSuccess) {
    return (
      <div className="text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-full bg-brand/10">
          <Check className="size-7 text-brand" />
        </div>
        <h3 className="mt-4 font-bold">Referral issued</h3>
        <p className="mx-auto mt-2 max-w-sm text-pretty text-sm text-slate-500">
          The patient can collect it from the pharmacy. The receiving hospital can confirm it is
          genuine from the code on the document.
        </p>
      </div>
    );
  }

  const complete = form.hospitalName && form.department && form.reasonText.length > 4;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          label="Hospital"
          value={form.hospitalName}
          onChange={(hospitalName) => setForm({ ...form, hospitalName })}
        />
        <Input
          label="Department"
          value={form.department}
          onChange={(department) => setForm({ ...form, department })}
        />
      </div>

      <div>
        <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Urgency</span>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {["Routine", "Urgent", "Emergency"].map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setForm({ ...form, urgency: option })}
              aria-pressed={form.urgency === option}
              className={cn(
                "rounded-xl border-2 px-4 py-2 text-sm font-semibold transition-colors",
                form.urgency === option
                  ? option === "Routine"
                    ? "border-brand bg-brand-soft text-brand"
                    : "border-red-300 bg-red-50 text-red-700"
                  : "border-border hover:border-slate-300",
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <Field
        label="Reason for referral"
        value={form.reasonText}
        onChange={(reasonText) => setForm({ ...form, reasonText })}
        rows={5}
        help="The receiving clinician relies on this. It appears on the referral the patient carries."
      />

      <ErrorNote error={refer.error} />

      <button
        type="button"
        disabled={!complete || refer.isPending}
        onClick={() =>
          refer.mutate({
            hospitalName: form.hospitalName,
            department: form.department,
            reasonText: form.reasonText,
            ...(form.urgency ? { urgency: form.urgency } : {}),
          })
        }
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-3.5 font-bold text-white hover:brightness-110 disabled:opacity-40"
      >
        {refer.isPending && <Loader2 className="size-4 animate-spin" />}
        Issue referral
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Consultation summary (decision D25)
// ---------------------------------------------------------------------------

function SummaryPanel({ consultationPublicId }: { consultationPublicId: string }) {
  const issue = useIssueSummary(consultationPublicId);
  const [form, setForm] = useState({
    presentingComplaint: "",
    assessment: "",
    advice: "",
    safetyNetting: "",
  });

  if (issue.isSuccess) {
    return (
      <div className="text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-full bg-brand/10">
          <Check className="size-7 text-brand" />
        </div>
        <h3 className="mt-4 font-bold">Summary issued</h3>
        <p className="mx-auto mt-2 max-w-sm text-pretty text-sm text-slate-500">
          The patient can collect it from the pharmacy.
        </p>
      </div>
    );
  }

  const complete =
    form.presentingComplaint.length > 2 &&
    form.assessment.length > 2 &&
    form.advice.length > 2 &&
    form.safetyNetting.length > 2;

  return (
    <div className="space-y-4">
      <p className="rounded-xl bg-brand-soft p-3 text-xs leading-relaxed text-brand/90">
        <strong className="font-bold">Required when you give advice without medication.</strong>{" "}
        This is what the patient takes away — often the only evidence a doctor was involved.
      </p>

      <Field
        label="What the patient came in with"
        value={form.presentingComplaint}
        onChange={(presentingComplaint) => setForm({ ...form, presentingComplaint })}
        rows={2}
      />
      <Field
        label="Your assessment"
        value={form.assessment}
        onChange={(assessment) => setForm({ ...form, assessment })}
        rows={4}
        help="Including why medication was or was not needed."
      />
      <Field
        label="Advice given"
        value={form.advice}
        onChange={(advice) => setForm({ ...form, advice })}
        rows={3}
      />

      {/*
        Visually distinct because it is the clinically important part. A summary
        saying only "no medication needed" reads as an all-clear that a remote
        five-minute assessment cannot support (decision D25).
      */}
      <div className="rounded-2xl border-2 border-warning/40 bg-warning-soft p-4">
        <Field
          label="What to watch for, and when to seek care"
          value={form.safetyNetting}
          onChange={(safetyNetting) => setForm({ ...form, safetyNetting })}
          rows={3}
          help="Required. Be specific about what should bring them back or send them to hospital."
        />
      </div>

      <ErrorNote error={issue.error} />

      <button
        type="button"
        disabled={!complete || issue.isPending}
        onClick={() => issue.mutate(form)}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-3.5 font-bold text-white hover:brightness-110 disabled:opacity-40"
      >
        {issue.isPending && <Loader2 className="size-4 animate-spin" />}
        Issue summary
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Completion — the only way a consultation ends (spec §16)
// ---------------------------------------------------------------------------

const OUTCOMES: Array<{ value: Outcome; label: string; help: string }> = [
  {
    value: "ADVICE_ONLY",
    label: "Advice only",
    help: "No medication needed. Requires a consultation summary.",
  },
  { value: "PRESCRIPTION", label: "Prescription", help: "You issued a prescription." },
  { value: "REFERRAL", label: "Referral", help: "You referred them for in-person care." },
  {
    value: "EMERGENCY_REFERRAL",
    label: "Emergency referral",
    help: "They need urgent in-person care.",
  },
  { value: "OTHER", label: "Other", help: "" },
];

function CompletionBar({
  consultationPublicId,
  onCompleted,
}: {
  consultationPublicId: string;
  onCompleted: (result: { destroyAt: string | null }) => void;
}) {
  const complete = useCompleteConsultation(consultationPublicId);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  return (
    <div className="border-t border-border bg-slate-50 p-6">
      <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Outcome</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {OUTCOMES.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setOutcome(option.value)}
            aria-pressed={outcome === option.value}
            title={option.help}
            className={cn(
              "rounded-xl border-2 px-4 py-2 text-sm font-semibold transition-colors",
              outcome === option.value
                ? "border-brand bg-brand-soft text-brand"
                : "border-border bg-white hover:border-slate-300",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {outcome && (
        <p className="mt-2 text-xs text-slate-500">
          {OUTCOMES.find((option) => option.value === outcome)?.help}
        </p>
      )}

      <ErrorNote error={complete.error} />

      <button
        type="button"
        disabled={!outcome || complete.isPending}
        onClick={() =>
          outcome &&
          complete.mutate(
            { outcome },
            { onSuccess: (result) => onCompleted({ destroyAt: result.destroyAt }) },
          )
        }
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 py-3.5 font-bold text-white hover:bg-slate-800 disabled:opacity-40"
      >
        {complete.isPending && <Loader2 className="size-4 animate-spin" />}
        Complete consultation
      </button>

      <p className="mt-2 text-center text-xs text-slate-500">
        Completing seals the clinical record. Nothing else ends a consultation — not the timer, not
        the patient leaving.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function Field({
  label,
  value,
  onChange,
  rows = 3,
  help,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  help?: string;
}) {
  const id = label.toLowerCase().replace(/[^a-z]+/g, "-");

  return (
    <label htmlFor={id} className="block">
      <span className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <textarea
        id={id}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 w-full resize-y rounded-xl border border-border bg-white px-4 py-3 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
      />
      {help && <span className="mt-1 block text-xs text-slate-500">{help}</span>}
    </label>
  );
}

function Input({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = label.toLowerCase().replace(/[^a-z]+/g, "-");

  return (
    <label htmlFor={id} className="block">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
      />
    </label>
  );
}

function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;

  return (
    <div
      role="alert"
      className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
      <p className="text-sm text-red-700">
        {error instanceof ApiError ? error.message : "Something went wrong. Please try again."}
      </p>
    </div>
  );
}
