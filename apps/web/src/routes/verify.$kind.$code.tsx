import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, Ban, Check, Loader2, ShieldCheck } from "lucide-react";
import { NeemLogo } from "@/components/neem/Logo";
import { ApiError } from "@/lib/api-client";
import { useVerifyDocument } from "@/features/clinical/api";

export const Route = createFileRoute("/verify/$kind/$code")({
  component: VerifyDocument,
});

/**
 * The public document verification page (spec §44).
 *
 * Reached by scanning the QR on a prescription, referral or consultation
 * summary. **No account is needed**: a pharmacist or hospital clerk holding a
 * printout must be able to check it there and then.
 *
 * It answers one question — is this document genuine — and deliberately shows
 * nothing about what the document says. No medication, no reason for referral,
 * no advice. Whoever is looking at this page is holding the document; anyone
 * who is not has no business reading its contents.
 *
 * For a prescription it also shows whether it has been revoked or already
 * dispensed, because both change what a pharmacy should do next.
 */
function VerifyDocument() {
  const { kind, code } = Route.useParams();
  const { data, isLoading, error } = useVerifyDocument(kind, code);

  return (
    <div className="grid min-h-dvh place-items-center bg-surface p-6">
      <div className="w-full max-w-md">
        <NeemLogo className="mx-auto text-xl" markClassName="size-9" />

        <div className="card-soft mt-6 p-8 text-center">
          {isLoading && <Loader2 className="mx-auto size-7 animate-spin text-brand" />}

          {error && (
            <>
              <AlertCircle className="mx-auto size-12 text-slate-300" />
              <h1 className="mt-4 text-xl font-bold">No document matches this code</h1>
              <p className="mt-2 text-pretty text-sm leading-relaxed text-slate-500">
                {error instanceof ApiError && error.status === 404
                  ? "Check the code was entered correctly. If it was scanned from a document, that document may not be genuine."
                  : "The check could not be completed. Please try again."}
              </p>
            </>
          )}

          {data && <Result result={data} />}
        </div>

        <p className="mx-auto mt-6 max-w-sm text-pretty text-center text-xs leading-relaxed text-slate-500">
          This page confirms a document was issued by Neem. It does not show what the document says
          — that is for the person holding it. Neem makes no claim of regulatory approval.
        </p>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  prescription: "Prescription",
  referral: "Referral",
  summary: "Consultation summary",
};

function Result({
  result,
}: {
  result: {
    kind: string;
    publicId: string;
    issuedAt: string;
    doctor: { fullName: string; mdcNumber: string };
    revoked?: boolean;
    dispensed?: boolean;
  };
}) {
  /**
   * A revoked prescription gets the loudest treatment on the page.
   *
   * This is the case where getting it wrong means dispensing medicine a doctor
   * has withdrawn, so it must not read as a variation of "genuine".
   */
  if (result.revoked) {
    return (
      <>
        <div className="mx-auto grid size-16 place-items-center rounded-full bg-red-100">
          <Ban className="size-8 text-red-600" />
        </div>
        <h1 className="mt-5 text-2xl font-bold text-red-700">Revoked — do not dispense</h1>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-slate-600">
          This prescription was genuine, but the issuing doctor has withdrawn it.
        </p>
        <Details result={result} />
      </>
    );
  }

  return (
    <>
      <div className="mx-auto grid size-16 place-items-center rounded-full bg-brand/10">
        <ShieldCheck className="size-8 text-brand" />
      </div>
      <h1 className="mt-5 text-2xl font-bold">Genuine</h1>
      <p className="mt-2 text-sm text-slate-500">
        This {(KIND_LABEL[result.kind] ?? "document").toLowerCase()} was issued through Neem.
      </p>

      {result.dispensed && (
        <p className="mt-4 inline-flex items-center gap-2 rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-600">
          <Check className="size-4" /> Already dispensed
        </p>
      )}

      <Details result={result} />
    </>
  );
}

function Details({
  result,
}: {
  result: {
    kind: string;
    publicId: string;
    issuedAt: string;
    doctor: { fullName: string; mdcNumber: string };
  };
}) {
  return (
    <dl className="mt-6 space-y-3 border-t border-border pt-6 text-left text-sm">
      <Row label="Document" value={KIND_LABEL[result.kind] ?? result.kind} />
      <Row label="Reference" value={result.publicId} mono />
      <Row label="Issued" value={new Date(result.issuedAt).toLocaleDateString()} />
      {/* Who signed it — the point of verifying at all. */}
      <Row label="Issuing doctor" value={result.doctor.fullName} />
      <Row label="MDC number" value={result.doctor.mdcNumber} mono />
    </dl>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className={mono ? "font-mono text-xs" : "font-semibold"}>{value}</dd>
    </div>
  );
}
