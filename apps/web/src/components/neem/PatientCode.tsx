import { useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { ApiError } from "@/lib/api-client";
import { useIssueQr, type ConsultationQr } from "@/features/consultation/api";

/**
 * The code a patient scans to open their consultation (decision D6).
 *
 * Shared by the end of "New consultation" and the consultation page, so a
 * pharmacist who has left the first can still hand the patient a code (D48).
 * Only a hash is stored, so a code can be shown exactly once; replacing it
 * mints a new one and stops the old one working.
 */
export function PatientCode({
  publicId,
  qr,
  onIssued,
}: {
  publicId: string;
  qr: ConsultationQr;
  onIssued: (qr: ConsultationQr) => void;
}) {
  const issue = useIssueQr();
  const [copied, setCopied] = useState(false);
  const [confirmingReissue, setConfirmingReissue] = useState(false);

  return (
    <div className="space-y-6 text-center">
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
                issue.mutate(publicId, {
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
          {issue.error && (
            <p className="mt-2 text-xs text-red-600">
              {issue.error instanceof ApiError
                ? issue.error.message
                : "Could not replace the code."}
            </p>
          )}
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
    </div>
  );
}
