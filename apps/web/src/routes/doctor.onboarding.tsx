import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Clock,
  FileText,
  Loader2,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { SignaturePad } from "@/components/neem/SignaturePad";
import { ApiError } from "@/lib/api-client";
import {
  useCaptureSignature,
  useDoctorProfile,
  useUploadDocument,
  type DoctorDocument,
} from "@/features/onboarding/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/doctor/onboarding")({
  component: DoctorOnboarding,
});

/**
 * Required credentials (spec §21). "Employment verification, where applicable"
 * is genuinely optional; the other three are not.
 */
const DOCUMENT_TYPES = [
  {
    code: "MDC_LICENCE",
    label: "MDC practising licence",
    help: "Your current Medical & Dental Council licence.",
    required: true,
  },
  {
    code: "GOVERNMENT_ID",
    label: "Government-issued ID",
    help: "Passport, Ghana Card or driver’s licence.",
    required: true,
  },
  {
    code: "PRACTICE_EVIDENCE",
    label: "Evidence of active clinical practice",
    help: "A letter, rota or similar showing current practice.",
    required: true,
  },
  {
    code: "EMPLOYMENT_VERIFICATION",
    label: "Employment verification",
    help: "Where applicable to your current post.",
    required: false,
  },
];

const STATUS_TONE: Record<string, "brand" | "medical" | "warning" | "muted" | "danger"> = {
  PENDING: "warning",
  UNDER_REVIEW: "medical",
  APPROVED: "medical",
  ACTIVE: "brand",
  SUSPENDED: "danger",
  EXPIRED: "danger",
  REJECTED: "danger",
};

function DoctorOnboarding() {
  const { data: profile, isLoading, error } = useDoctorProfile();

  if (isLoading) {
    return (
      <AppShell active="doctor">
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      </AppShell>
    );
  }

  if (error || !profile) {
    return (
      <AppShell active="doctor">
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {error instanceof ApiError ? error.message : "Could not load your profile."}
          </p>
        </div>
      </AppShell>
    );
  }

  const uploaded = new Set(profile.documents.map((document) => document.type));
  const requiredOutstanding = DOCUMENT_TYPES.filter(
    (type) => type.required && !uploaded.has(type.code),
  );
  const readyForReview = requiredOutstanding.length === 0 && profile.signatureCapturedAt !== null;

  return (
    <AppShell active="doctor">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Doctor onboarding</p>
        <h1 className="text-3xl font-bold tracking-tight">{profile.fullName}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Chip tone={STATUS_TONE[profile.status] ?? "muted"}>{profile.status.replace("_", " ")}</Chip>
          <span className="font-mono text-xs text-slate-500">{profile.mdcNumber}</span>
        </div>
      </header>

      <StatusBanner
        status={profile.status}
        statusReason={profile.statusReason}
        readyForReview={readyForReview}
        outstandingCount={requiredOutstanding.length}
        hasSignature={profile.signatureCapturedAt !== null}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="card-soft p-6">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-bold">Credentials</h2>
              <span className="text-xs font-semibold text-slate-500">
                {profile.documents.filter((d) => d.verified).length} of {profile.documents.length}{" "}
                verified
              </span>
            </div>
            <p className="mb-5 text-xs leading-relaxed text-slate-500">
              A Neem administrator reviews each document by hand. Neem does not check licences
              automatically with the Medical &amp; Dental Council.
            </p>

            <div className="space-y-3">
              {DOCUMENT_TYPES.map((type) => (
                <DocumentRow
                  key={type.code}
                  type={type}
                  documents={profile.documents.filter((document) => document.type === type.code)}
                />
              ))}
            </div>
          </section>

          <section className="card-soft p-6">
            <h2 className="mb-1 font-bold">Digital signature</h2>
            <p className="mb-5 text-xs leading-relaxed text-slate-500">
              Drawn once, stored encrypted, and used on every prescription and referral you issue.
              It is never published or shared.
            </p>
            <SignatureSection capturedAt={profile.signatureCapturedAt} />
          </section>
        </div>

        <aside className="space-y-6">
          <section className="card-soft p-6">
            <h2 className="mb-4 font-bold">Languages</h2>
            <div className="flex flex-wrap gap-2">
              {profile.languages.map((language) => (
                <Chip key={language.code} tone={language.isPrimary ? "brand" : "muted"}>
                  {language.label}
                  {language.isPrimary ? " · primary" : ""}
                </Chip>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              You will only be assigned consultations in a language you speak.
            </p>
          </section>

          <section className="card-soft p-6">
            <h2 className="mb-4 font-bold">Licence</h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  MDC number
                </dt>
                <dd className="mt-0.5 font-mono">{profile.mdcNumber}</dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Expires
                </dt>
                <dd className="mt-0.5">
                  {profile.mdcExpiresAt
                    ? new Date(profile.mdcExpiresAt).toLocaleDateString()
                    : "Not recorded"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Experience
                </dt>
                <dd className="mt-0.5">{profile.yearsExperience ?? "—"} years</dd>
              </div>
            </dl>
            <p className="mt-4 text-xs leading-relaxed text-slate-500">
              You must hold a valid MDC licence for as long as your account is active. Neem flags
              licences approaching expiry.
            </p>
          </section>

          {profile.subscription && (
            <section className="card-soft p-6">
              <h2 className="mb-4 font-bold">Membership</h2>
              <Chip tone={profile.subscription.status === "ACTIVE" ? "brand" : "warning"}>
                {profile.subscription.status}
              </Chip>
              <p className="mt-3 text-sm">
                Period ends {new Date(profile.subscription.periodEnd).toLocaleDateString()}
              </p>
            </section>
          )}
        </aside>
      </div>
    </AppShell>
  );
}

function StatusBanner({
  status,
  statusReason,
  readyForReview,
  outstandingCount,
  hasSignature,
}: {
  status: string;
  statusReason: string | null;
  readyForReview: boolean;
  outstandingCount: number;
  hasSignature: boolean;
}) {
  if (status === "ACTIVE") {
    return (
      <div className="card-soft flex items-start gap-3 border-brand/30 bg-brand-soft p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand" />
        <p className="text-sm text-slate-700">
          <span className="font-bold text-brand">Your account is active.</span> You can be assigned
          consultations during your confirmed shifts.
        </p>
      </div>
    );
  }

  if (status === "SUSPENDED" || status === "REJECTED" || status === "EXPIRED") {
    return (
      <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-4">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
        <div className="text-sm text-red-700">
          <p className="font-bold">Your account is {status.toLowerCase()}.</p>
          {statusReason && <p className="mt-1">{statusReason}</p>}
          <p className="mt-1">Contact Neem administration if you believe this is an error.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card-soft flex items-start gap-3 border-warning/30 bg-warning-soft p-4">
      <Clock className="mt-0.5 size-5 shrink-0 text-warning" />
      <div className="text-sm text-slate-700">
        <p className="font-bold text-warning">
          {readyForReview ? "Awaiting administrator review" : "Your application is incomplete"}
        </p>
        <p className="mt-1 leading-relaxed">
          {readyForReview
            ? "Everything required has been submitted. A Neem administrator will verify your credentials before your account is activated."
            : `Still needed: ${[
                outstandingCount > 0 ? `${outstandingCount} required document${outstandingCount > 1 ? "s" : ""}` : null,
                hasSignature ? null : "your digital signature",
              ]
                .filter(Boolean)
                .join(" and ")}.`}
        </p>
      </div>
    </div>
  );
}

function DocumentRow({
  type,
  documents,
}: {
  type: (typeof DOCUMENT_TYPES)[number];
  documents: DoctorDocument[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadDocument();
  const latest = documents[0];

  return (
    <div className="rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold">{type.label}</p>
            {type.required ? (
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Required
              </span>
            ) : (
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-300">
                Optional
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">{type.help}</p>
        </div>

        {latest ? (
          <Chip tone={latest.verified ? "brand" : "warning"}>
            {latest.verified ? "Verified" : "Awaiting review"}
          </Chip>
        ) : (
          <Chip tone="muted">Not uploaded</Chip>
        )}
      </div>

      {latest && (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
          <FileText className="size-4 shrink-0 text-slate-400" />
          <span className="text-xs text-slate-600">
            Uploaded {new Date(latest.uploadedAt).toLocaleDateString()} ·{" "}
            {Math.round(latest.sizeBytes / 1024)} KB
          </span>
        </div>
      )}

      {latest?.note && (
        <p className="mt-2 text-xs text-slate-600">
          <span className="font-semibold">Administrator note:</span> {latest.note}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) upload.mutate({ file, documentType: type.code });
          event.target.value = "";
        }}
      />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={upload.isPending}
        className={cn(
          "mt-3 inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50",
        )}
      >
        {upload.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Upload className="size-3.5" />
        )}
        {latest ? "Replace" : "Upload"} · PDF, JPEG, PNG or WebP
      </button>

      {upload.error && (
        <p className="mt-2 text-xs text-red-600">{(upload.error as Error).message}</p>
      )}
    </div>
  );
}

function SignatureSection({ capturedAt }: { capturedAt: string | null }) {
  const capture = useCaptureSignature();
  const [saved, setSaved] = useState(false);

  return (
    <>
      <SignaturePad
        existingCapturedAt={capturedAt}
        disabled={capture.isPending}
        onCapture={(dataUrl) =>
          capture.mutate(dataUrl, {
            onSuccess: () => {
              setSaved(true);
              setTimeout(() => setSaved(false), 3000);
            },
          })
        }
      />

      {saved && (
        <p className="mt-3 flex items-center gap-2 text-sm font-semibold text-brand">
          <Check className="size-4" /> Signature saved.
        </p>
      )}
      {capture.error && (
        <p className="mt-3 text-sm text-red-600">
          {capture.error instanceof ApiError ? capture.error.message : "Could not save signature."}
        </p>
      )}
    </>
  );
}
