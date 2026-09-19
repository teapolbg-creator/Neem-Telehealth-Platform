import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AlertCircle, CalendarClock, Check, ExternalLink, Loader2 } from "lucide-react";
import { PatientFrame, FrameMessage } from "@/components/neem/PatientFrame";
import { ApiError } from "@/lib/api-client";
import { formatMoney } from "@/features/consultation/api";
import {
  useBookNow,
  useBookingLanguages,
  useBookingPaymentStatus,
  usePatientAccount,
  usePatientClinics,
  useRequestSignInCode,
  useReserveAppointment,
  useSlots,
  useStartBookingPayment,
  useVerifySignInCode,
  type BookingIntake,
  type PatientService,
  type Slot,
} from "@/features/patient/api";

export const Route = createFileRoute("/book/$serviceCode")({
  validateSearch: (search: Record<string, unknown>): { when: "now" | "later" } => ({
    when: search.when === "later" ? "later" : "now",
  }),
  component: BookingFlow,
});

/**
 * Booking a consultation for yourself (v2).
 *
 * Four things, in the order the money demands: who you are, when you want it,
 * what the professional needs to know, and then payment. Nothing reaches a
 * professional until the server has confirmed the payment with Paystack — this
 * screen only watches.
 *
 * The steps are held here rather than in the URL because a half-filled booking
 * form is not a page anybody should be able to link to or come back to.
 */
function BookingFlow() {
  const { serviceCode } = Route.useParams();
  const { when } = Route.useSearch();

  const clinics = usePatientClinics();
  const account = usePatientAccount();

  const [slot, setSlot] = useState<Slot | null>(null);
  const [booked, setBooked] = useState<{
    consultationReference: string;
    appointmentAt: string | null;
  } | null>(null);

  const service = useMemo<PatientService | undefined>(
    () =>
      clinics.data?.clinics
        .flatMap((clinic) => clinic.services)
        .find((candidate) => candidate.code === serviceCode),
    [clinics.data, serviceCode],
  );

  if (clinics.isLoading || account.isLoading) {
    return (
      <PatientFrame back={{ to: "/book", label: "Back" }}>
        <div className="grid place-items-center py-24">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      </PatientFrame>
    );
  }

  if (!clinics.data?.enabled || !service) {
    return (
      <PatientFrame back={{ to: "/book", label: "Back" }}>
        <FrameMessage title="That is not available">
          <p>Choose from what Neem offers today.</p>
        </FrameMessage>
      </PatientFrame>
    );
  }

  const signedIn = Boolean(account.data);

  return (
    <PatientFrame back={{ to: "/book", label: "Back" }}>
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{service.name}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {formatMoney(service.price)} · paid before the consultation
        </p>
      </header>

      {!signedIn ? (
        <SignInPanel />
      ) : booked ? (
        <PaymentPanel
          reference={booked.consultationReference}
          appointmentAt={booked.appointmentAt}
          price={service.price}
        />
      ) : when === "later" && !slot ? (
        <SlotPicker serviceCode={serviceCode} onChoose={setSlot} />
      ) : (
        <DetailsForm
          service={service}
          slot={slot}
          onBooked={(result) => setBooked(result)}
          onChangeSlot={() => setSlot(null)}
        />
      )}
    </PatientFrame>
  );
}

// ---------------------------------------------------------------------------
// Who you are
// ---------------------------------------------------------------------------

/**
 * A code to an email address, and nothing else.
 *
 * No password to choose, forget or reuse. The same answer is given whether or
 * not the address is already known to Neem, so this screen never becomes a way
 * of asking whether somebody is a patient.
 */
/**
 * Which address a code was just sent to, kept for this tab only.
 *
 * On a phone the patient leaves for their mail app to read the code, and the
 * browser often reloads the page when they come back. Without this they land
 * on "Your email address" again and the code they are holding looks useless.
 * sessionStorage dies with the tab, and the entry is dropped after the code
 * could have expired anyway; the API is what actually enforces expiry.
 */
const PENDING_KEY = "neem.patient.pendingSignIn";
const PENDING_FOR_MS = 15 * 60 * 1000;

function readPending(): string | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw) as { contact?: string; sentAt?: number };
    if (!pending.contact || !pending.sentAt || Date.now() - pending.sentAt > PENDING_FOR_MS) {
      window.sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    return pending.contact;
  } catch {
    return null;
  }
}

function writePending(contact: string | null) {
  try {
    if (contact) {
      window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ contact, sentAt: Date.now() }));
    } else {
      window.sessionStorage.removeItem(PENDING_KEY);
    }
  } catch {
    // Private mode or blocked storage: the patient just re-enters their address.
  }
}

function SignInPanel() {
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);

  const requestCode = useRequestSignInCode();
  const verify = useVerifySignInCode();

  // Read after mount, not during render: the server has no sessionStorage.
  useEffect(() => {
    const pending = readPending();
    if (pending) {
      setContact(pending);
      setSent(true);
    }
  }, []);

  if (!sent) {
    return (
      <form
        className="card-soft space-y-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          const address = contact.trim();
          requestCode.mutate(address, {
            onSuccess: () => {
              writePending(address);
              setSent(true);
            },
          });
        }}
      >
        <div>
          <h2 className="font-bold">Your email address</h2>
          <p className="mt-1 text-sm leading-relaxed text-slate-600">
            We send a six-digit code. It is how you sign in, and how you come back later for
            anything a professional writes for you.
          </p>
        </div>

        <input
          type="email"
          required
          autoComplete="email"
          value={contact}
          onChange={(event) => setContact(event.target.value)}
          placeholder="you@example.com"
          className="w-full rounded-xl border border-border px-4 py-3 text-base outline-none focus:border-brand"
        />

        <ErrorNote error={requestCode.error} />

        <button
          type="submit"
          disabled={requestCode.isPending || contact.trim().length < 3}
          className="w-full rounded-xl bg-brand py-3.5 font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          {requestCode.isPending ? "Sending…" : "Send me a code"}
        </button>
      </form>
    );
  }

  return (
    <form
      className="card-soft space-y-4 p-6"
      onSubmit={(event) => {
        event.preventDefault();
        verify.mutate(
          { contact: contact.trim(), code: code.trim() },
          { onSuccess: () => writePending(null) },
        );
      }}
    >
      <div>
        <h2 className="font-bold">Enter the code</h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">
          We sent a six-digit code to {contact}. It expires shortly.
        </p>
      </div>

      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="000000"
        className="w-full rounded-xl border border-border px-4 py-3 text-center font-mono text-2xl tracking-[0.4em] outline-none focus:border-brand"
      />

      <ErrorNote error={verify.error} />

      <button
        type="submit"
        disabled={verify.isPending || code.length !== 6}
        className="w-full rounded-xl bg-brand py-3.5 font-semibold text-white hover:brightness-110 disabled:opacity-50"
      >
        {verify.isPending ? "Checking…" : "Continue"}
      </button>

      <button
        type="button"
        onClick={() => {
          writePending(null);
          setSent(false);
          setCode("");
        }}
        className="w-full py-1 text-sm font-semibold text-slate-500 hover:text-slate-900"
      >
        Use a different address
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

function SlotPicker({
  serviceCode,
  onChoose,
}: {
  serviceCode: string;
  onChoose: (slot: Slot) => void;
}) {
  const { data: slots, isLoading } = useSlots(serviceCode);

  if (isLoading) {
    return (
      <div className="card-soft grid place-items-center p-12">
        <Loader2 className="size-5 animate-spin text-brand" />
      </div>
    );
  }

  if (!slots || slots.length === 0) {
    return (
      <FrameMessage title="No times are open">
        <p>
          Nobody has published times for this over the next week. You can still ask for the next
          available professional instead.
        </p>
      </FrameMessage>
    );
  }

  const byDay = new Map<string, Slot[]>();
  for (const slot of slots) {
    const day = new Date(slot.startsAt).toLocaleDateString("en-GH", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    byDay.set(day, [...(byDay.get(day) ?? []), slot]);
  }

  return (
    <div className="space-y-6">
      <p className="text-sm leading-relaxed text-slate-600">
        Pick a time. It is held for you while you pay, and released if you do not.
      </p>

      {[...byDay.entries()].map(([day, daySlots]) => (
        <section key={day}>
          <h2 className="mb-2 text-sm font-bold text-slate-500">{day}</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {daySlots.map((slot) => (
              <button
                key={`${slot.professional.publicId}-${slot.startsAt}`}
                type="button"
                onClick={() => onChoose(slot)}
                className="rounded-xl border border-border bg-white px-3 py-3 text-left hover:border-brand"
              >
                <span className="block font-semibold tabular-nums">{timeOf(slot.startsAt)}</span>
                <span className="block truncate text-xs text-slate-500">
                  {slot.professional.fullName}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// What the professional needs to know
// ---------------------------------------------------------------------------

function DetailsForm({
  service,
  slot,
  onBooked,
  onChangeSlot,
}: {
  service: PatientService;
  slot: Slot | null;
  onBooked: (result: { consultationReference: string; appointmentAt: string | null }) => void;
  onChangeSlot: () => void;
}) {
  const languages = useBookingLanguages();
  const bookNow = useBookNow();
  const reserve = useReserveAppointment();

  const [form, setForm] = useState({
    fullName: "",
    age: "",
    sex: "FEMALE" as BookingIntake["sex"],
    phone: "",
    reason: "",
    languageCode: "en",
    type: "VIDEO" as BookingIntake["type"],
  });
  const [consents, setConsents] = useState({ remote: false, emergency: false });

  const pending = bookNow.isPending || reserve.isPending;
  const error = bookNow.error ?? reserve.error;
  const ready =
    form.fullName.trim().length > 1 &&
    Number(form.age) >= 0 &&
    form.phone.trim().length >= 9 &&
    form.reason.trim().length > 2 &&
    consents.remote &&
    consents.emergency;

  function submit(event: FormEvent) {
    event.preventDefault();

    const intake: BookingIntake = {
      serviceCode: service.code,
      languageCode: form.languageCode,
      type: form.type,
      fullName: form.fullName.trim(),
      age: Number(form.age),
      sex: form.sex,
      phone: form.phone.trim(),
      reason: form.reason.trim(),
      acceptsRemoteConsultation: true,
      readEmergencyGuidance: true,
    };

    if (slot) {
      reserve.mutate(
        {
          ...intake,
          professionalPublicId: slot.professional.publicId,
          startsAt: slot.startsAt,
        },
        {
          onSuccess: (result) =>
            onBooked({
              consultationReference: result.consultationReference,
              appointmentAt: result.startsAt,
            }),
        },
      );
      return;
    }

    bookNow.mutate(intake, {
      onSuccess: (result) =>
        onBooked({ consultationReference: result.consultationReference, appointmentAt: null }),
    });
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      {slot ? (
        <div className="card-soft flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <CalendarClock className="size-5 shrink-0 text-brand" />
            <div className="text-sm">
              <p className="font-semibold">{longTime(slot.startsAt)}</p>
              <p className="text-slate-500">with {slot.professional.fullName}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onChangeSlot}
            className="shrink-0 text-sm font-semibold text-brand hover:underline"
          >
            Change
          </button>
        </div>
      ) : null}

      <div className="card-soft space-y-4 p-6">
        <h2 className="font-bold">About you</h2>

        <Field label="Full name">
          <input
            required
            value={form.fullName}
            onChange={(event) => setForm({ ...form, fullName: event.target.value })}
            autoComplete="name"
            className="input"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Age">
            <input
              required
              inputMode="numeric"
              value={form.age}
              onChange={(event) =>
                setForm({ ...form, age: event.target.value.replace(/\D/g, "").slice(0, 3) })
              }
              className="input"
            />
          </Field>
          <Field label="Sex">
            <select
              value={form.sex}
              onChange={(event) =>
                setForm({ ...form, sex: event.target.value as BookingIntake["sex"] })
              }
              className="input"
            >
              <option value="FEMALE">Female</option>
              <option value="MALE">Male</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
        </div>

        <Field
          label="Phone number"
          hint="Only Neem sees this. The professional never gets your number."
        >
          <input
            required
            inputMode="tel"
            autoComplete="tel"
            value={form.phone}
            onChange={(event) => setForm({ ...form, phone: event.target.value })}
            placeholder="0244 000 000"
            className="input"
          />
        </Field>
      </div>

      <div className="card-soft space-y-4 p-6">
        <h2 className="font-bold">About the consultation</h2>

        <Field label="What do you need help with?">
          <textarea
            required
            rows={3}
            maxLength={500}
            value={form.reason}
            onChange={(event) => setForm({ ...form, reason: event.target.value })}
            placeholder="A few words is enough."
            className="input resize-none"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Language">
            <select
              value={form.languageCode}
              onChange={(event) => setForm({ ...form, languageCode: event.target.value })}
              className="input"
            >
              {(languages.data ?? [{ code: "en", label: "English", subtitle: null }]).map(
                (language) => (
                  <option key={language.code} value={language.code}>
                    {language.label}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label="Video or audio">
            <select
              value={form.type}
              onChange={(event) =>
                setForm({ ...form, type: event.target.value as BookingIntake["type"] })
              }
              className="input"
            >
              <option value="VIDEO">Video call</option>
              <option value="AUDIO">Audio only</option>
            </select>
          </Field>
        </div>
      </div>

      {/*
        Two checkboxes, not one. They are two separate statements — that a
        remote consultation is what you want, and that you know what to do in
        an emergency — and a single box would record neither of them honestly.
      */}
      <div className="card-soft space-y-3 p-6">
        <Consent
          checked={consents.remote}
          onChange={(checked) => setConsents({ ...consents, remote: checked })}
        >
          I understand this is a remote consultation. The professional cannot examine me in person,
          and may tell me to be seen somewhere face to face.
        </Consent>
        <Consent
          checked={consents.emergency}
          onChange={(checked) => setConsents({ ...consents, emergency: checked })}
        >
          I have read the emergency notice below. If this is an emergency I will go to a hospital or
          call 112 instead of booking.
        </Consent>
      </div>

      <ErrorNote error={error} />

      <button
        type="submit"
        disabled={!ready || pending}
        className="w-full rounded-xl bg-brand py-4 font-semibold text-white hover:brightness-110 disabled:opacity-50"
      >
        {pending ? "Just a moment…" : `Continue to payment · ${formatMoney(service.price)}`}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Paying
// ---------------------------------------------------------------------------

/**
 * The only screen that decides nothing.
 *
 * It sends the patient to Paystack, which returns them to /book/paid; until
 * then (or if they approve a prompt on a phone) it watches the server, which
 * re-verifies with the provider on every poll. Nothing the checkout tab says
 * reaches this page, and no button here can mark a consultation paid.
 */
function PaymentPanel({
  reference,
  appointmentAt,
  price,
}: {
  reference: string;
  appointmentAt: string | null;
  price: { amountMinor: number; currency: string };
}) {
  const navigate = useNavigate();
  const start = useStartBookingPayment();
  const [started, setStarted] = useState(false);

  const status = useBookingPaymentStatus(reference, { watch: started });
  const paid = status.data?.state === "ACTIVATED" || status.data?.joinedQueue === true;

  /*
   * Asked for exactly once, and a ref is what guarantees it.
   *
   * The API is idempotent — a second request returns the attempt already in
   * flight — but that answer carries no checkout link, because a link is
   * created once and not stored. Firing twice therefore loses the button the
   * patient needs. React's development mode runs effects twice on purpose, so
   * the bug appears there first; a remount would do the same in production.
   */
  const asked = useRef<string | null>(null);

  useEffect(() => {
    if (asked.current === reference) return;
    asked.current = reference;

    start.mutate(reference, { onSuccess: () => setStarted(true) });
    // `start` is a stable mutation handle; the ref above is the real guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference]);

  /*
   * An immediate booking is in the queue the moment the payment clears, and
   * the waiting room is the counter's own screen — the booking minted exactly
   * the session it runs on. A booking for a time next week waits here instead.
   */
  useEffect(() => {
    if (status.data?.joinedQueue && !appointmentAt) {
      void navigate({ to: "/patient" });
    }
  }, [status.data?.joinedQueue, appointmentAt, navigate]);

  if (paid && appointmentAt) {
    return (
      <div className="card-soft p-8 text-center">
        <div className="mx-auto grid size-14 place-items-center rounded-full bg-emerald-100">
          <Check className="size-7 text-emerald-600" />
        </div>
        <h2 className="mt-4 text-xl font-bold">Booked</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          {longTime(appointmentAt)}. Come back to Neem a few minutes before — your consultation
          opens by itself.
        </p>
        <p className="mt-4 font-mono text-xs text-slate-400">{reference}</p>
        <button
          type="button"
          onClick={() => void navigate({ to: "/account" })}
          className="mt-6 w-full rounded-xl bg-brand py-3.5 font-semibold text-white hover:brightness-110"
        >
          See my bookings
        </button>
      </div>
    );
  }

  const secondsLeft = status.data?.secondsRemaining ?? null;

  return (
    <div className="space-y-4">
      <div className="card-soft p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="font-bold">Pay to confirm</h2>
          <span className="text-xl font-bold tabular-nums">{formatMoney(price)}</span>
        </div>

        {secondsLeft !== null ? (
          <p className="mt-1 text-sm text-slate-500">
            {secondsLeft > 0
              ? `Held for ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`
              : "This booking has expired."}
          </p>
        ) : null}

        {start.data?.authorizationUrl ? (
          /*
           * Same tab: Paystack sends the patient back to /book/paid when they
           * finish, so there is no second tab to find on a phone.
           */
          <a
            href={start.data.authorizationUrl}
            rel="noreferrer"
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3.5 font-semibold text-white hover:brightness-110"
          >
            <ExternalLink className="size-4" /> Pay with Mobile Money
          </a>
        ) : start.isPending ? (
          <div className="mt-4 grid place-items-center py-6">
            <Loader2 className="size-5 animate-spin text-brand" />
          </div>
        ) : start.isSuccess ? (
          /*
           * A payment was already under way when this screen asked. Its
           * checkout link exists once and is not stored, so it cannot be
           * offered again — said plainly rather than left as a blank card.
           */
          <p className="mt-4 rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-600">
            A payment for this booking is already in progress. If you have approved it on your
            phone, this page moves on by itself.
          </p>
        ) : null}

        <ErrorNote error={start.error} />

        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          You pay on Paystack&rsquo;s page, then come straight back to Neem. Your booking is
          confirmed only once Paystack confirms the payment to us.
        </p>
      </div>

      {started ? (
        <div className="flex items-center justify-center gap-2 text-sm text-slate-500">
          <Loader2 className="size-4 animate-spin" />
          Waiting for your payment
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

function Consent({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-5 shrink-0 rounded border-border text-brand focus:ring-brand"
      />
      <span className="text-sm leading-relaxed text-slate-600">{children}</span>
    </label>
  );
}

function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;

  return (
    <p className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      {error instanceof ApiError ? error.message : "Something went wrong. Please try again."}
    </p>
  );
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GH", { hour: "2-digit", minute: "2-digit" });
}

function longTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GH", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}
