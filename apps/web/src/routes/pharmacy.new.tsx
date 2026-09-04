import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Copy,
  FlaskConical,
  Loader2,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  formatMoney,
  useCreateConsultation,
  useInitiatePayment,
  useIssueQr,
  usePaymentStatus,
  useSimulatePayment,
  type ConsultationQr,
  type CreatedConsultation,
} from "@/features/consultation/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/pharmacy/new")({
  component: NewConsultation,
});

/**
 * Starting a consultation (spec §34, business document "do not show the
 * payment QR at the beginning").
 *
 * The order is deliberate and differs from the original prototype:
 *
 *   create → collect payment → *verified* → show the QR
 *
 * The pharmacy never types the patient's name. Identity is captured on the
 * patient's own phone after they scan (spec §10, finding C2) — which is both
 * what the specification requires and better for privacy, since the counter
 * staff never handle it.
 *
 * The QR appears only once payment is verified server-side, so an unpaid
 * consultation can never reach a doctor.
 */
type Step = "create" | "payment" | "qr";

function NewConsultation() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("create");
  const [consultation, setConsultation] = useState<CreatedConsultation | null>(null);
  const [qr, setQr] = useState<ConsultationQr | null>(null);

  return (
    <AppShell active="pharmacy">
      <div className="mx-auto w-full max-w-3xl">
        <Link
          to="/pharmacy"
          className="mb-6 inline-flex items-center gap-2 text-sm text-slate-500 hover:text-brand"
        >
          <ArrowLeft className="size-4" /> Back to dashboard
        </Link>

        <Steps current={step} />

        {step === "create" && (
          <CreateStep
            onCreated={(created) => {
              setConsultation(created);
              setStep("payment");
            }}
          />
        )}

        {step === "payment" && consultation && (
          <PaymentStep
            consultation={consultation}
            onPaid={() => setStep("qr")}
            onCancel={() => navigate({ to: "/pharmacy" })}
          />
        )}

        {step === "qr" && consultation && (
          <QrStep
            consultation={consultation}
            qr={qr}
            onIssued={setQr}
            onDone={() => navigate({ to: "/pharmacy" })}
          />
        )}
      </div>
    </AppShell>
  );
}

function Steps({ current }: { current: Step }) {
  const steps: Array<{ key: Step; label: string }> = [
    { key: "create", label: "Start" },
    { key: "payment", label: "Payment" },
    { key: "qr", label: "Patient code" },
  ];
  const index = steps.findIndex((step) => step.key === current);

  return (
    <div className="mb-8 flex items-center gap-2">
      {steps.map((step, position) => {
        const done = position < index;
        const active = position === index;

        return (
          <div key={step.key} className="flex flex-1 items-center gap-2">
            <div
              className={cn(
                "grid size-8 place-items-center rounded-full border-2 text-xs font-bold",
                done
                  ? "border-brand bg-brand text-white"
                  : active
                    ? "border-brand bg-white text-brand"
                    : "border-border bg-white text-slate-400",
              )}
            >
              {done ? <Check className="size-4" /> : position + 1}
            </div>
            <span className={cn("text-xs font-semibold", active ? "text-brand" : "text-slate-500")}>
              {step.label}
            </span>
            {position < steps.length - 1 && (
              <div className={cn("h-0.5 flex-1", done ? "bg-brand" : "bg-border")} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CreateStep({ onCreated }: { onCreated: (created: CreatedConsultation) => void }) {
  const create = useCreateConsultation();
  const [promotionCode, setPromotionCode] = useState("");

  return (
    <div className="card-soft space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-bold">Start a consultation</h1>
        <p className="mt-1 text-sm text-slate-500">
          The patient enters their own details on their phone after scanning the code.
        </p>
      </div>

      {/*
        Explains the change from the old flow. Counter staff who used the
        prototype will expect to type a name here, and the reason they no
        longer do is worth saying rather than leaving as an absence.
      */}
      <div className="flex items-start gap-3 rounded-2xl border border-medical/20 bg-medical/5 p-4">
        <Smartphone className="mt-0.5 size-5 shrink-0 text-medical" />
        <p className="text-xs leading-relaxed text-slate-600">
          <span className="font-bold text-medical">No patient details are needed here.</span> The
          patient types their name, age, sex and phone number privately on their own phone. You will
          see them once the consultation is live.
        </p>
      </div>

      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
          Promotional code
        </span>
        <input
          type="text"
          value={promotionCode}
          onChange={(event) => setPromotionCode(event.target.value.toUpperCase())}
          placeholder="Optional"
          className="mt-1.5 w-full rounded-xl border border-border bg-white px-4 py-3 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
      </label>

      <ErrorNotice error={create.error} />

      <button
        type="button"
        disabled={create.isPending}
        onClick={() =>
          create.mutate(promotionCode ? { promotionCode } : {}, { onSuccess: onCreated })
        }
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3.5 font-semibold text-white hover:brightness-110 disabled:opacity-50"
      >
        {create.isPending && <Loader2 className="size-4 animate-spin" />}
        Continue to payment
      </button>
    </div>
  );
}

function PaymentStep({
  consultation,
  onPaid,
  onCancel,
}: {
  consultation: CreatedConsultation;
  onPaid: () => void;
  onCancel: () => void;
}) {
  const initiate = useInitiatePayment();
  const simulate = useSimulatePayment();
  const [started, setStarted] = useState(false);
  const [payerPhone, setPayerPhone] = useState("");

  const status = usePaymentStatus(consultation.publicId, started);
  const view = status.data;

  // Payment is confirmed by the server verifying with the provider, never by
  // anything the browser observed (spec §34).
  useEffect(() => {
    if (view?.consultationState === "ACTIVATED") onPaid();
  }, [view?.consultationState, onPaid]);

  const remaining = view?.secondsRemaining ?? consultation.secondsRemaining ?? 0;
  const expired = remaining <= 0;

  return (
    <div className="card-soft space-y-6 p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Collect payment</h1>
          <p className="mt-1 text-sm text-slate-500">
            The consultation opens only after payment is confirmed.
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs font-bold uppercase text-slate-400">Amount</p>
          <p className="text-2xl font-bold text-brand">{formatMoney(consultation.net)}</p>
          {consultation.discount.amountMinor > 0 && (
            <p className="text-xs text-slate-500">
              {formatMoney(consultation.price)} less {formatMoney(consultation.discount)}
            </p>
          )}
        </div>
      </div>

      <div
        className={cn(
          "flex items-center justify-between rounded-2xl border p-4",
          expired ? "border-red-200 bg-red-50" : "border-border bg-slate-50",
        )}
      >
        <span className="text-sm font-semibold">
          {expired ? "Payment window closed" : "Time remaining to pay"}
        </span>
        <span
          className={cn("font-mono text-lg font-bold", expired ? "text-red-600" : "text-brand")}
        >
          {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
        </span>
      </div>

      {!started ? (
        <>
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Mobile Money number
            </span>
            <input
              type="tel"
              inputMode="tel"
              value={payerPhone}
              onChange={(event) => setPayerPhone(event.target.value)}
              placeholder="024 000 0000"
              className="mt-1.5 w-full rounded-xl border border-border bg-white px-4 py-3 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
            <span className="mt-1 block text-xs text-slate-500">
              Optional. The patient may also pay from a different number.
            </span>
          </label>

          <ErrorNotice error={initiate.error} />

          <button
            type="button"
            disabled={initiate.isPending || expired}
            onClick={() =>
              initiate.mutate(
                { publicId: consultation.publicId, payerPhone: payerPhone || undefined },
                { onSuccess: () => setStarted(true) },
              )
            }
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand py-3.5 font-semibold text-white hover:brightness-110 disabled:opacity-50"
          >
            {initiate.isPending && <Loader2 className="size-4 animate-spin" />}
            Request payment
          </button>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 rounded-2xl border border-border bg-slate-50 p-4">
            <Loader2 className="size-5 animate-spin text-brand" />
            <div>
              <p className="text-sm font-semibold">
                {view?.paymentStatus === "SUCCESS" ? "Payment confirmed" : "Waiting for payment"}
              </p>
              <p className="text-xs text-slate-500">
                Neem checks with the payment provider directly. This updates on its own.
              </p>
            </div>
          </div>

          {/*
            Mock mode is stated plainly rather than hidden. Nothing has been
            charged, and the screen must not imply otherwise (spec §93).
          */}
          {view?.isMockProvider && (
            <div className="rounded-2xl border border-warning/30 bg-warning-soft p-4">
              <p className="flex items-center gap-2 text-xs font-bold text-warning">
                <FlaskConical className="size-4" /> Mock payment provider
              </p>
              <p className="mt-1 text-xs leading-relaxed text-slate-600">
                No money has moved. A real provider is connected in Phase 7. Use the buttons below
                to simulate what the provider would report.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={simulate.isPending}
                  onClick={() =>
                    simulate.mutate({ publicId: consultation.publicId, outcome: "SUCCESS" })
                  }
                  className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Simulate successful payment
                </button>
                <button
                  type="button"
                  disabled={simulate.isPending}
                  onClick={() =>
                    simulate.mutate({ publicId: consultation.publicId, outcome: "FAILED" })
                  }
                  className="rounded-lg border border-border bg-white px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                >
                  Simulate failure
                </button>
              </div>
            </div>
          )}

          {view?.canRetry && view.consultationState === "PAYMENT_FAILED" && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-bold text-red-700">Payment did not go through</p>
              <p className="mt-1 text-xs text-red-700">
                The patient can try again while time remains.
              </p>
              <button
                type="button"
                onClick={() => setStarted(false)}
                className="mt-3 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white"
              >
                Try again
              </button>
            </div>
          )}
        </>
      )}

      <button type="button" onClick={onCancel} className="text-sm font-semibold text-slate-500">
        Cancel and return to dashboard
      </button>
    </div>
  );
}

function QrStep({
  consultation,
  qr,
  onIssued,
  onDone,
}: {
  consultation: CreatedConsultation;
  qr: ConsultationQr | null;
  onIssued: (qr: ConsultationQr) => void;
  onDone: () => void;
}) {
  const issue = useIssueQr();
  const [copied, setCopied] = useState(false);
  const [confirmingReissue, setConfirmingReissue] = useState(false);

  /**
   * The code can be rendered exactly once, at issue, because only its hash is
   * stored. So it is minted on arrival here and held in memory.
   *
   * Guarded by a ref rather than `isIdle`: the mutation is asynchronous, so
   * `isIdle` is still true when React re-runs this effect. A second call would
   * mint a new token AND revoke the one already on screen — handing the
   * patient a QR code that stopped working the instant it appeared.
   */
  const issueStarted = useRef(false);

  useEffect(() => {
    if (qr || issueStarted.current) return;

    issueStarted.current = true;
    issue.mutate(consultation.publicId, { onSuccess: onIssued });
  }, [qr, issue, consultation.publicId, onIssued]);

  if (!qr) {
    return (
      <div className="card-soft grid place-items-center p-16">
        <Loader2 className="size-6 animate-spin text-brand" />
        <ErrorNotice error={issue.error} />
      </div>
    );
  }

  return (
    <div className="card-soft space-y-6 p-8 text-center">
      <Chip tone="brand" pulse className="mx-auto">
        Payment confirmed · consultation active
      </Chip>

      <div>
        <h1 className="text-2xl font-bold">Ask the patient to scan this code</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
          They use their own phone camera. The consultation opens in their browser — nothing to
          install. They enter their details there, privately.
        </p>
      </div>

      <div className="mx-auto w-fit rounded-3xl border-2 border-dashed border-border bg-slate-50 p-6">
        <img
          src={qr.qrDataUrl}
          alt="Consultation QR code"
          width={280}
          height={280}
          className="rounded-2xl bg-white p-3"
        />
      </div>

      <div className="mx-auto max-w-md space-y-3">
        <div className="flex items-center justify-center gap-2 text-sm">
          <span className="text-slate-500">Or open this link:</span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(qr.url);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-1 font-mono text-xs text-slate-700 hover:bg-slate-200"
          >
            <Copy className="size-3" />
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>

        <p className="text-xs leading-relaxed text-slate-500">
          This code works once and expires at{" "}
          {new Date(qr.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
        </p>
      </div>

      {/*
        Re-issuing invalidates the code the patient may already be holding, so
        it asks first (decision D6). This is also the "patient lost their
        phone" path, and every issue is audited.
      */}
      {confirmingReissue ? (
        <div className="mx-auto max-w-md rounded-2xl border border-warning/30 bg-warning-soft p-4 text-left">
          <p className="text-sm font-bold text-warning">Replace this code?</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">
            The code above will stop working immediately. Only do this if the patient cannot use it
            — for example if they lost their phone.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={issue.isPending}
              onClick={() =>
                issue.mutate(consultation.publicId, {
                  onSuccess: (next) => {
                    onIssued(next);
                    setConfirmingReissue(false);
                  },
                })
              }
              className="rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              Replace code
            </button>
            <button
              type="button"
              onClick={() => setConfirmingReissue(false)}
              className="rounded-lg border border-border bg-white px-4 py-2 text-xs font-semibold"
            >
              Keep current code
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirmingReissue(true)}
          className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-brand"
        >
          <RefreshCw className="size-3.5" /> Patient cannot scan? Issue a new code
        </button>
      )}

      <div className="flex justify-center gap-3 pt-2">
        <Link
          to="/pharmacy/consultations/$publicId"
          params={{ publicId: consultation.publicId }}
          className="rounded-xl bg-brand px-6 py-3 font-semibold text-white hover:brightness-110"
        >
          Monitor this consultation
        </Link>
        <button
          type="button"
          onClick={onDone}
          className="rounded-xl border border-border bg-white px-6 py-3 font-semibold"
        >
          Back to dashboard
        </button>
      </div>
    </div>
  );
}

function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
      <p className="text-sm text-red-700">
        {error instanceof ApiError ? error.message : "Something went wrong. Please try again."}
      </p>
    </div>
  );
}
