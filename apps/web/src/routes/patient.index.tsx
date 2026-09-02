import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import type { PatientSessionView } from "@neem/contracts";
import {
  AlertCircle,
  Check,
  Loader2,
  Lock,
  Phone,
  PhoneOutgoing,
  Star,
  Video,
} from "lucide-react";
import { NeemLogo } from "@/components/neem/Logo";
import { CallStage } from "@/components/neem/CallStage";
import { ApiError } from "@/lib/api-client";
import {
  useJoinPatientMedia,
  useLeavePatientMedia,
  usePatientTimer,
} from "@/features/media/api";
import {
  usePatientComplaintCategories,
  usePatientLanguages,
  usePatientSession,
  useSelectLanguage,
  useSelectMode,
  useRequestRefund,
  useSubmitFeedback,
  useSubmitIdentity,
} from "@/features/consultation/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/patient/")({
  component: PatientPortal,
});

/**
 * The patient consultation portal (spec §71, §72).
 *
 * Phone-first, no account, as few fields as the clinical record needs. The
 * server decides which step comes next and returns it as `step`, so the client
 * cannot skip ahead — and a refresh resumes exactly where the patient was.
 *
 * Deliberately absent: queue position, waiting-list mechanics, doctor ratings
 * or scores. The patient sees their own status, never the platform's internals.
 */
function PatientPortal() {
  const { data: session, isLoading, error } = usePatientSession();

  if (isLoading) {
    return (
      <PhoneFrame>
        <div className="grid flex-1 place-items-center">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      </PhoneFrame>
    );
  }

  if (error || !session) {
    return (
      <PhoneFrame>
        <div className="flex flex-1 flex-col justify-center p-8 text-center">
          <AlertCircle className="mx-auto size-10 text-slate-300" />
          <h1 className="mt-4 text-xl font-bold">Session ended</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            {error instanceof ApiError
              ? error.message
              : "Please ask the pharmacy for a new consultation code."}
          </p>
        </div>
      </PhoneFrame>
    );
  }

  return (
    <PhoneFrame pharmacyName={session.pharmacyName}>
      {session.step === "IDENTITY" && <IdentityStep />}
      {session.step === "LANGUAGE" && <LanguageStep />}
      {session.step === "MODE" && <ModeStep />}
      {session.step === "WAITING" && <WaitingStep session={session} />}
      {session.step === "IN_CONSULTATION" && <InConsultationStep session={session} />}
      {session.step === "COMPLETE" && <CompleteStep session={session} />}
      {session.step === "CLOSED" && <ClosedStep session={session} />}
    </PhoneFrame>
  );
}

/**
 * The phone frame from the original prototype: full-screen on a phone, framed
 * on a desktop so the layout can be reviewed at its real proportions.
 */
function PhoneFrame({
  children,
  pharmacyName,
}: {
  children: React.ReactNode;
  pharmacyName?: string;
}) {
  return (
    <div className="grid min-h-dvh place-items-center bg-slate-950 p-0 sm:p-6">
      <div className="relative flex min-h-dvh w-full max-w-md flex-col overflow-hidden bg-white text-slate-900 sm:h-[820px] sm:min-h-0 sm:rounded-[3rem] sm:border-8 sm:border-slate-900 sm:shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-3 text-[10px] font-bold text-slate-500">
          <span className="truncate">{pharmacyName ?? "Neem"}</span>
          <span className="chip inline-flex items-center gap-1 bg-brand/10 text-brand">
            <Lock className="size-3" /> Secure
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

function IdentityStep() {
  const submit = useSubmitIdentity();
  const [form, setForm] = useState({
    fullName: "",
    age: "",
    sex: "" as "" | "FEMALE" | "MALE" | "OTHER",
    phone: "",
    paymentPhone: "",
  });
  const [differentPayer, setDifferentPayer] = useState(false);

  const fieldErrors = submit.error instanceof ApiError ? submit.error.fieldErrors : {};
  const complete = form.fullName && form.age && form.sex && form.phone;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate({
          fullName: form.fullName,
          age: Number(form.age),
          sex: form.sex as "FEMALE" | "MALE" | "OTHER",
          phone: form.phone,
          ...(differentPayer && form.paymentPhone ? { paymentPhone: form.paymentPhone } : {}),
        } as never);
      }}
      className="flex flex-1 flex-col overflow-y-auto p-6"
      noValidate
    >
      <NeemLogo className="mx-auto mt-2 text-lg" markClassName="size-8" />

      <h1 className="mt-6 text-2xl font-bold">Your details</h1>
      <p className="mt-1 text-sm leading-relaxed text-slate-500">
        The doctor needs these to advise you safely and to write a prescription if one is needed.
      </p>

      <div className="mt-6 space-y-4">
        <Field
          label="Full name"
          value={form.fullName}
          onChange={(value) => setForm({ ...form, fullName: value })}
          error={fieldErrors.fullName}
          autoComplete="name"
        />

        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Age"
            type="number"
            inputMode="numeric"
            value={form.age}
            onChange={(value) => setForm({ ...form, age: value })}
            error={fieldErrors.age}
          />
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Sex</span>
            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
              {(["FEMALE", "MALE", "OTHER"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setForm({ ...form, sex: option })}
                  className={cn(
                    "rounded-xl border-2 py-2.5 text-xs font-bold transition-colors",
                    form.sex === option
                      ? "border-brand bg-brand-soft text-brand"
                      : "border-border text-slate-500",
                  )}
                >
                  {option === "FEMALE" ? "F" : option === "MALE" ? "M" : "Other"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <Field
          label="Your phone number"
          value={form.phone}
          onChange={(value) => setForm({ ...form, phone: value })}
          error={fieldErrors.phone}
          inputMode="tel"
          autoComplete="tel"
          help="For example 024 000 0000."
        />

        {/* Spec §36 — paying from another number is explicitly allowed. */}
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={differentPayer}
            onChange={(event) => setDifferentPayer(event.target.checked)}
            className="mt-0.5 size-4 accent-[var(--brand)]"
          />
          <span className="text-slate-600">Someone paid with a different number</span>
        </label>

        {differentPayer && (
          <Field
            label="Number used to pay"
            value={form.paymentPhone}
            onChange={(value) => setForm({ ...form, paymentPhone: value })}
            error={fieldErrors.paymentPhone}
            inputMode="tel"
          />
        )}
      </div>

      <ErrorNotice error={submit.error} />

      {/*
        What happens to what the patient just typed, in their own words. This
        is the one place they are told, before they type it.

        Rewritten for decision D23: this promised deletion at the end of the
        consultation, which Ghanaian record-keeping law does not permit. The
        wording below claims only what the code does. The full notice, naming
        the lawful basis and the retention period, is with counsel (G7d).
      */}
      <p className="mt-5 rounded-2xl bg-brand-soft p-3 text-xs leading-relaxed text-brand/90">
        Your record is kept private and sealed — no doctor or pharmacy can open it after this
        consultation. Only a prescription, if the doctor issues one, is shared.
      </p>

      <button
        type="submit"
        disabled={!complete || submit.isPending}
        className="mt-auto flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 pt-4 font-bold text-white shadow-lg shadow-brand/20 disabled:opacity-40"
      >
        {submit.isPending && <Loader2 className="size-4 animate-spin" />}
        Continue
      </button>
    </form>
  );
}

function LanguageStep() {
  const { data: languages } = usePatientLanguages();
  const select = useSelectLanguage();
  const [chosen, setChosen] = useState<string | null>(null);

  return (
    <div className="flex flex-1 flex-col p-6">
      <h1 className="mt-2 text-xl font-bold">Choose your language</h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">
        You will only be matched with a doctor who speaks it.
      </p>

      <div className="grid flex-1 content-start grid-cols-2 gap-3">
        {(languages ?? []).map((language) => (
          <button
            key={language.code}
            type="button"
            onClick={() => setChosen(language.code)}
            className={cn(
              "min-h-[76px] rounded-2xl border-2 p-4 text-left transition-colors",
              chosen === language.code
                ? "border-brand bg-brand-soft"
                : "border-border hover:border-slate-300",
            )}
          >
            <p className={cn("text-sm font-bold", chosen === language.code && "text-brand")}>
              {language.label}
            </p>
            {language.subtitle && (
              <p className="mt-0.5 text-[11px] text-slate-500">{language.subtitle}</p>
            )}
          </button>
        ))}
      </div>

      <ErrorNotice error={select.error} />

      <button
        type="button"
        disabled={!chosen || select.isPending}
        onClick={() => chosen && select.mutate({ languageCode: chosen })}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 font-bold text-white shadow-lg shadow-brand/20 disabled:opacity-40"
      >
        {select.isPending && <Loader2 className="size-4 animate-spin" />}
        Continue
      </button>
    </div>
  );
}

function ModeStep() {
  const select = useSelectMode();
  const [chosen, setChosen] = useState<"AUDIO" | "VIDEO" | "CALL_ME" | null>(null);

  const options = [
    { id: "VIDEO", icon: Video, title: "Video consultation", desc: "See and speak with the doctor." },
    { id: "AUDIO", icon: Phone, title: "Audio consultation", desc: "Voice only — uses less data." },
    {
      id: "CALL_ME",
      icon: PhoneOutgoing,
      title: "Call me",
      desc: "The doctor calls you through Neem. Best for a weak connection.",
    },
  ] as const;

  return (
    <div className="flex flex-1 flex-col p-6">
      <h1 className="mt-2 text-xl font-bold">How would you like to consult?</h1>
      <p className="mb-6 mt-1 text-sm text-slate-500">Choose what works best for you.</p>

      <div className="flex-1 space-y-3">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setChosen(option.id)}
            className={cn(
              "flex w-full items-start gap-4 rounded-2xl border-2 p-5 text-left transition-colors",
              chosen === option.id
                ? "border-brand bg-brand-soft"
                : "border-border hover:border-slate-300",
            )}
          >
            <div
              className={cn(
                "grid size-11 shrink-0 place-items-center rounded-xl",
                chosen === option.id ? "bg-brand text-white" : "bg-slate-100 text-slate-500",
              )}
            >
              <option.icon className="size-5" />
            </div>
            <div>
              <p className="font-bold">{option.title}</p>
              <p className="mt-1 text-xs text-slate-500">{option.desc}</p>
            </div>
          </button>
        ))}
      </div>

      <ErrorNotice error={select.error} />

      <button
        type="button"
        disabled={!chosen || select.isPending}
        onClick={() => chosen && select.mutate({ type: chosen })}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 font-bold text-white shadow-lg shadow-brand/20 disabled:opacity-40"
      >
        {select.isPending && <Loader2 className="size-4 animate-spin" />}
        Enter waiting room
      </button>
    </div>
  );
}

function WaitingStep({ session }: { session: PatientSessionView }) {
  const minutes = Math.floor((session.waitingSinceSeconds ?? 0) / 60);
  const seconds = (session.waitingSinceSeconds ?? 0) % 60;

  return (
    <div className="flex flex-1 flex-col p-8 text-center">
      <div className="chip mx-auto bg-brand/10 text-brand">
        <span className="size-1.5 animate-pulse rounded-full bg-brand" />
        Finding a doctor
      </div>

      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="grid size-24 place-items-center rounded-full bg-brand/10">
          <Loader2 className="size-10 animate-spin text-brand" />
        </div>

        <h2 className="mt-6 text-2xl font-bold">Just a moment…</h2>
        <p className="mt-2 max-w-xs text-pretty text-slate-500">
          We are matching you with a doctor who speaks {session.language?.label ?? "your language"}.
        </p>

        {/*
          Elapsed time only. No queue position and no estimate: the patient is
          told their own status, not the platform's internals (spec §72), and an
          estimate we cannot honour is worse than none.
        */}
        <div className="mt-8 grid w-full grid-cols-2 gap-3">
          <div className="rounded-2xl border border-border bg-slate-50 p-3">
            <p className="text-[10px] font-bold uppercase text-slate-400">Waiting</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums">
              {minutes}:{String(seconds).padStart(2, "0")}
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-slate-50 p-3">
            <p className="text-[10px] font-bold uppercase text-slate-400">Consultation</p>
            <p className="mt-0.5 text-lg font-bold capitalize">
              {session.type?.replace("_", " ").toLowerCase() ?? "—"}
            </p>
          </div>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-slate-500">
        Please stay on this screen. You can put your phone down — it will update on its own.
      </p>
    </div>
  );
}

/**
 * The consultation itself (spec §14, §32, §33).
 *
 * A Call Me consultation has no room to join — the doctor places a telephone
 * call — so that case gets its own screen rather than an empty video stage.
 */
function InConsultationStep({ session }: { session: PatientSessionView }) {
  const doctorName = session.doctor?.fullName ?? "Your doctor";

  if (session.type === "CALL_ME") {
    return <AwaitingCallStep doctorName={doctorName} />;
  }

  return <PatientCallStep session={session} doctorName={doctorName} />;
}

function PatientCallStep({
  session,
  doctorName,
}: {
  session: PatientSessionView;
  doctorName: string;
}) {
  const join = useJoinPatientMedia();
  const leave = useLeavePatientMedia();
  const { data: timer } = usePatientTimer(true);
  const [left, setLeft] = useState(false);

  // Guarded against React's double-invoke in development and against a
  // re-render mid-request: joining twice would mint a second credential and
  // leave the first one dangling.
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    join.mutate();
  }, [join]);

  if (left) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <h2 className="text-xl font-bold">You have left the consultation</h2>
        <p className="mt-2 max-w-xs text-pretty text-sm text-slate-500">
          Please speak to the pharmacist if you still need to see the doctor.
        </p>
      </div>
    );
  }

  return (
    <CallStage
      session={join.data ?? null}
      timer={timer ?? null}
      role="PATIENT"
      remoteName={doctorName}
      joining={join.isPending}
      error={
        join.isError
          ? join.error instanceof ApiError
            ? join.error.message
            : "The connection could not be started."
          : null
      }
      onRetryJoin={() => join.mutate()}
      leaveLabel="Leave"
      onLeave={() => {
        leave.mutate();
        setLeft(true);
      }}
    />
  );
}

/**
 * Call Me: the patient waits for the phone to ring.
 *
 * No number is shown here, because the patient is never given the doctor's
 * (spec §33).
 */
function AwaitingCallStep({ doctorName }: { doctorName: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <div className="grid size-20 place-items-center rounded-full bg-brand/10">
        <PhoneOutgoing className="size-10 text-brand" />
      </div>
      <h2 className="mt-6 text-2xl font-bold">{doctorName} will call you</h2>
      <p className="mt-2 max-w-xs text-pretty text-slate-500">
        Keep your phone nearby. The call will show as coming from Neem.
      </p>
      <p className="mt-6 max-w-xs text-xs leading-relaxed text-slate-400">
        Your number is never shared with the doctor, and theirs is never shared
        with you.
      </p>
    </div>
  );
}

function CompleteStep({ session }: { session: PatientSessionView }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <div className="grid size-20 place-items-center rounded-full bg-brand/10">
        <Check className="size-10 text-brand" />
      </div>
      <h1 className="mt-6 text-3xl font-bold">Consultation complete</h1>
      <p className="mt-3 max-w-xs text-pretty text-slate-500">
        Please return to the pharmacist. Get well soon.
      </p>

      {/*
        The consultation reference (decision D24).

        This is the patient's only route back to their own record: Neem keeps
        no patient profile, so nothing can be found by name or phone number.
        It works like a shop receipt — you need no account to buy something,
        and the receipt is how the purchase is found again.

        Prominent rather than tucked away, because a patient who loses it has
        no other way to identify their record.
      */}
      <div className="mt-8 w-full max-w-xs rounded-2xl border border-border bg-slate-50 p-4">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Your consultation reference
        </p>
        {/*
          `select-all` so one tap copies the whole thing, and no `break-all`:
          the groups of four are what make it transcribable, and splitting one
          across a line is exactly the confusion the format exists to avoid.
        */}
        <p className="mt-1.5 select-all font-mono text-base font-bold tracking-wide text-slate-900">
          {session.consultationPublicId}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          Keep this. It is printed on any prescription you receive, and it is how your record is
          found if you ever need it.
        </p>
      </div>

      {/*
        This said "your details and everything discussed have been deleted"
        until decision D23. That is no longer true and must not be shown: a
        record is now kept, sealed, for a legally required period.

        The wording below states only what the system does, which is verifiable
        in the code. The final notice — naming the lawful basis and the
        retention period — is still with counsel (G7d) and belongs here once it
        comes back.
      */}
      <FeedbackPanel submitted={session.feedbackSubmitted} />

      <p className="mt-6 max-w-xs text-pretty text-xs leading-relaxed text-slate-400">
        Your consultation record is stored securely. No doctor or pharmacy can open it, now or at a
        future visit.
      </p>
    </div>
  );
}

const FEEDBACK_CATEGORY_LABEL = {
  COMPLIMENT: "Something went well",
  SUGGESTION: "A suggestion",
  COMPLAINT: "Something went wrong",
} as const;

/**
 * Feedback, asked once (spec §51).
 *
 * This is the only place the ratings behind a doctor's quality score are
 * produced — the queue weights the mean rating and the complaint count at half
 * that score between them, and before this existed the table was empty, so
 * that half sat neutral for everyone.
 *
 * Skippable on purpose. A patient who has just been told to go home should not
 * be made to fill in a form to see their consultation reference, and a rating
 * given to dismiss a blocking dialog is worse than no rating at all.
 */
function FeedbackPanel({ submitted }: { submitted: boolean }) {
  const [open, setOpen] = useState(false);

  if (submitted) {
    return (
      <p className="mt-8 flex items-center gap-2 text-sm font-semibold text-slate-500">
        <Check className="size-4 text-brand" /> Thank you for your feedback.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-8 rounded-xl border border-border px-5 py-2.5 text-sm font-bold hover:bg-slate-50"
      >
        Rate this consultation
      </button>
    );
  }

  return <FeedbackForm onCancel={() => setOpen(false)} />;
}

function FeedbackForm({ onCancel }: { onCancel: () => void }) {
  const submit = useSubmitFeedback();
  const [doctorRating, setDoctorRating] = useState(0);
  const [neemRating, setNeemRating] = useState(0);
  const [category, setCategory] = useState<keyof typeof FEEDBACK_CATEGORY_LABEL | null>(null);
  const [complaintCategoryCode, setComplaintCategoryCode] = useState("");
  const [comment, setComment] = useState("");

  // Only fetched when the patient actually says something went wrong.
  const { data: complaintCategories } = usePatientComplaintCategories(category === "COMPLAINT");

  const ready =
    doctorRating > 0 &&
    neemRating > 0 &&
    category !== null &&
    (category !== "COMPLAINT" || complaintCategoryCode !== "");

  return (
    <div className="mt-8 w-full max-w-xs rounded-2xl border border-border p-4 text-left">
      <h2 className="text-sm font-bold">How was it?</h2>

      {/*
        Two ratings, not one. The doctor may have been excellent on a
        connection that kept dropping, and a single score cannot say so.
      */}
      <Stars label="The doctor" value={doctorRating} onChange={setDoctorRating} />
      <Stars label="Neem" value={neemRating} onChange={setNeemRating} />

      <fieldset className="mt-4">
        <legend className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          Anything to tell us?
        </legend>
        <div className="mt-2 flex flex-col gap-1.5">
          {(
            Object.keys(FEEDBACK_CATEGORY_LABEL) as Array<keyof typeof FEEDBACK_CATEGORY_LABEL>
          ).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setCategory(key)}
              className={
                category === key
                  ? "rounded-xl border-2 border-brand bg-brand/5 px-3 py-2 text-left text-sm font-semibold"
                  : "rounded-xl border border-border px-3 py-2 text-left text-sm hover:bg-slate-50"
              }
            >
              {FEEDBACK_CATEGORY_LABEL[key]}
            </button>
          ))}
        </div>
      </fieldset>

      {category === "COMPLAINT" && (
        <label className="mt-3 block">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
            What went wrong?
          </span>
          <select
            value={complaintCategoryCode}
            onChange={(event) => setComplaintCategoryCode(event.target.value)}
            className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm"
          >
            <option value="">Choose one</option>
            {complaintCategories?.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="mt-3 block">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          In your own words (optional)
        </span>
        <textarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          rows={3}
          maxLength={2000}
          className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
        />
      </label>

      {submit.error && (
        <p className="mt-3 text-sm text-red-600">
          {submit.error instanceof ApiError
            ? submit.error.message
            : "Your feedback could not be sent."}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={!ready || submit.isPending}
          onClick={() =>
            submit.mutate({
              doctorRating,
              neemRating,
              category: category!,
              complaintCategoryCode: category === "COMPLAINT" ? complaintCategoryCode : undefined,
              comment: comment.trim() || undefined,
            })
          }
          className="flex-1 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {submit.isPending ? "Sending…" : "Send"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-slate-50"
        >
          Not now
        </button>
      </div>

      {/*
        Stated because the patient is about to walk back to the pharmacist who
        can see them, and would otherwise reasonably assume the counter reads
        this.
      */}
      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
        The doctor and the pharmacy never see this.
      </p>
    </div>
  );
}

function Stars({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="mt-3">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <div className="mt-1 flex gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            aria-label={`${label}: ${star} out of 5`}
            aria-pressed={value === star}
            onClick={() => onChange(star)}
            className="p-0.5"
          >
            <Star
              className={
                star <= value ? "size-6 fill-warning text-warning" : "size-6 text-slate-300"
              }
            />
          </button>
        ))}
      </div>
    </div>
  );
}

function ClosedStep({ session }: { session: PatientSessionView }) {
  const reason =
    session.state === "CANCELLED"
      ? "This consultation was cancelled."
      : session.state === "EXPIRED"
        ? "This consultation expired before it began."
        : session.state === "REFUND_REQUESTED"
          ? "This consultation is on hold."
          : session.state === "REFUNDED"
            ? "This consultation was refunded."
            : "This consultation has ended.";

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <AlertCircle className="size-10 text-slate-300" />
      <h1 className="mt-4 text-xl font-bold">{reason}</h1>
      <p className="mt-2 max-w-xs text-pretty text-sm text-slate-500">
        Please speak to the pharmacist if you still need to see a doctor.
      </p>

      {/*
        This is where a refund actually matters: the patient paid and no
        consultation happened. Offering it here rather than only at the counter
        means they can ask before they have walked away.
      */}
      <RefundPanel state={session.state} />
    </div>
  );
}

/**
 * Asking for the fee back (spec §41).
 *
 * Shown only where money was taken and nothing was delivered. It is a request,
 * and the copy is careful not to imply otherwise — an administrator reviews it,
 * and telling the patient a refund is on its way would be a promise Neem has
 * not made.
 */
function RefundPanel({ state }: { state: string }) {
  const request = useRequestRefund();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  // REFUND_REQUESTED means one is already with an administrator.
  if (state === "REFUND_REQUESTED" || request.isSuccess) {
    return (
      <p className="mt-8 max-w-xs text-pretty text-sm leading-relaxed text-slate-500">
        Your refund request is with Neem. Someone will review it and the pharmacy will be told the
        outcome.
      </p>
    );
  }

  if (state === "REFUNDED") {
    return (
      <p className="mt-8 max-w-xs text-pretty text-sm leading-relaxed text-slate-500">
        This consultation has been refunded.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-8 rounded-xl border border-border px-5 py-2.5 text-sm font-bold hover:bg-slate-50"
      >
        Ask for a refund
      </button>
    );
  }

  return (
    <div className="mt-8 w-full max-w-xs rounded-2xl border border-border p-4 text-left">
      <label className="block">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          What happened?
        </span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={500}
          placeholder="No doctor was available and I had to leave."
          className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
        />
      </label>

      {request.error && (
        <p className="mt-3 text-sm text-red-600">
          {request.error instanceof ApiError
            ? request.error.message
            : "The request could not be sent."}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={reason.trim().length < 3 || request.isPending}
          onClick={() => request.mutate(reason.trim())}
          className="flex-1 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40"
        >
          {request.isPending ? "Sending…" : "Send the request"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-slate-50"
        >
          Not now
        </button>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
        Neem reviews every request. This is not an automatic refund.
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  help,
  error,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  help?: string;
  error?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const id = label.toLowerCase().replace(/\s+/g, "-");

  return (
    <label htmlFor={id} className="block">
      <span className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</span>
      <input
        {...rest}
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        className={cn(
          "mt-1.5 w-full rounded-xl border bg-white px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-brand/30",
          error ? "border-red-300" : "border-border focus:border-brand",
        )}
      />
      {error ? (
        <span className="mt-1 block text-xs text-red-600">{error}</span>
      ) : help ? (
        <span className="mt-1 block text-xs text-slate-500">{help}</span>
      ) : null}
    </label>
  );
}

function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;

  return (
    <div
      role="alert"
      className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
      <p className="text-sm text-red-700">
        {error instanceof ApiError ? error.message : "Something went wrong. Please try again."}
      </p>
    </div>
  );
}
