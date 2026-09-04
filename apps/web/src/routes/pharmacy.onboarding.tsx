import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { AlertCircle, Clock, FileText, Loader2, ShieldCheck, Upload } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  usePharmacyProfile,
  useUploadPharmacyDocument,
  type PharmacyDocument,
} from "@/features/onboarding/api";

export const Route = createFileRoute("/pharmacy/onboarding")({
  component: PharmacyOnboarding,
});

/**
 * Documents a pharmacy is asked to supply (spec §20).
 *
 * These are the categories Neem's verification workflow offers — **not** a
 * claim about what Ghanaian law requires. Which documents are sufficient is
 * Neem's operational policy, and whether a formal list exists is an open
 * question with counsel. The copy on this page says only that a person will
 * look at them (spec §78).
 */
const DOCUMENT_TYPES = [
  {
    code: "COUNCIL_REGISTRATION",
    label: "Pharmacy Council registration certificate",
    help: "The certificate for this premises, showing its registration number.",
    required: true,
  },
  {
    code: "SUPERINTENDENT_LICENCE",
    label: "Superintendent pharmacist’s practising licence",
    help: "The current practising licence of the pharmacist responsible for this premises.",
    required: true,
  },
  {
    code: "BUSINESS_REGISTRATION",
    label: "Business registration certificate",
    help: "Registrar-General certificate for the business operating the pharmacy.",
    required: false,
  },
  {
    code: "PREMISES_EVIDENCE",
    label: "Evidence of premises",
    help: "A tenancy agreement, utility bill or similar showing the address.",
    required: false,
  },
];

const STATUS_TONE: Record<string, "brand" | "medical" | "warning" | "muted" | "danger"> = {
  PENDING: "warning",
  UNDER_REVIEW: "medical",
  APPROVED: "medical",
  ACTIVE: "brand",
  SUSPENDED: "danger",
  REJECTED: "danger",
};

function PharmacyOnboarding() {
  const { data: profile, isLoading, error } = usePharmacyProfile();

  if (isLoading) {
    return (
      <AppShell active="pharmacy">
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      </AppShell>
    );
  }

  if (error || !profile) {
    return (
      <AppShell active="pharmacy">
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {error instanceof ApiError ? error.message : "Could not load your pharmacy profile."}
          </p>
        </div>
      </AppShell>
    );
  }

  const uploaded = new Set(profile.documents.map((document) => document.type));
  const requiredOutstanding = DOCUMENT_TYPES.filter(
    (type) => type.required && !uploaded.has(type.code),
  );

  return (
    <AppShell active="pharmacy">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Pharmacy verification</p>
        <h1 className="text-3xl font-bold tracking-tight">{profile.name}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Chip tone={STATUS_TONE[profile.status] ?? "muted"}>
            {profile.status.replace("_", " ")}
          </Chip>
          <span className="font-mono text-xs text-slate-500">{profile.councilRegistrationNo}</span>
        </div>
      </header>

      <StatusBanner
        status={profile.status}
        statusReason={profile.statusReason}
        outstanding={profile.outstanding}
        requiredOutstandingCount={requiredOutstanding.length}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section className="card-soft p-6">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-bold">Registration documents</h2>
              <span className="text-xs font-semibold text-slate-500">
                {profile.verifiedDocumentCount} of {profile.documentCount} verified
              </span>
            </div>
            <p className="mb-5 text-xs leading-relaxed text-slate-500">
              A Neem administrator opens and reviews each document by hand. Neem does not check
              registrations automatically with the Pharmacy Council, and makes no claim that a
              document is genuine.
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
        </div>

        <aside className="space-y-6">
          <section className="card-soft p-6">
            <h2 className="mb-4 font-bold">This pharmacy</h2>
            <dl className="space-y-3 text-sm">
              <Detail label="Council registration" value={profile.councilRegistrationNo} mono />
              <Detail label="Owner" value={profile.ownerName} />
              <Detail label="Responsible pharmacist" value={profile.responsiblePharmacistName} />
              <Detail label="Location" value={`${profile.city}, ${profile.region}`} />
              <Detail label="Phone" value={profile.phone} />
            </dl>
          </section>

          <section className="card-soft p-6">
            <h2 className="mb-2 font-bold">Why this is checked</h2>
            <p className="text-xs leading-relaxed text-slate-500">
              An active pharmacy receives prescriptions from Neem doctors and dispenses against
              them. No pharmacy is activated until an administrator has verified its documents —
              there is no automatic approval.
            </p>
          </section>
        </aside>
      </div>
    </AppShell>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className={mono ? "mt-0.5 font-mono text-xs" : "mt-0.5"}>{value}</dd>
    </div>
  );
}

function StatusBanner({
  status,
  statusReason,
  outstanding,
  requiredOutstandingCount,
}: {
  status: string;
  statusReason: string | null;
  outstanding: string[];
  requiredOutstandingCount: number;
}) {
  if (status === "ACTIVE") {
    return (
      <div className="card-soft flex items-start gap-3 border-brand/30 bg-brand-soft p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand" />
        <p className="text-sm text-slate-700">
          <span className="font-bold text-brand">This pharmacy is active.</span> You can start
          consultations and receive prescriptions.
        </p>
      </div>
    );
  }

  if (status === "SUSPENDED" || status === "REJECTED") {
    return (
      <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-4">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
        <div className="text-sm text-red-700">
          <p className="font-bold">This pharmacy is {status.toLowerCase()}.</p>
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
          {requiredOutstandingCount > 0
            ? "Your application is incomplete"
            : "Awaiting administrator review"}
        </p>
        {/*
          The list comes from the server, computed from the same rule the
          activation check enforces — so this screen and the server cannot
          disagree about what is required.
        */}
        <ul className="mt-1 space-y-1 leading-relaxed">
          {outstanding.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DocumentRow({
  type,
  documents,
}: {
  type: (typeof DOCUMENT_TYPES)[number];
  documents: PharmacyDocument[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadPharmacyDocument();
  const latest = documents[0];

  return (
    <div className="rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold">{type.label}</p>
            <span
              className={
                type.required
                  ? "text-[10px] font-bold uppercase tracking-wider text-slate-400"
                  : "text-[10px] font-bold uppercase tracking-wider text-slate-300"
              }
            >
              {type.required ? "Required" : "Optional"}
            </span>
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
            Uploaded {new Date(latest.uploadedAt).toLocaleDateString()}
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
          // Cleared so re-selecting the same file fires change again.
          event.target.value = "";
        }}
      />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={upload.isPending}
        className="mt-3 inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
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
