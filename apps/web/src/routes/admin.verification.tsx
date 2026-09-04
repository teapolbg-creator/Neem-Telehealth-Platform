import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  AlertCircle,
  Building2,
  Check,
  FileText,
  Loader2,
  Search,
  Stethoscope,
  X,
} from "lucide-react";
import type { DoctorSummary, PharmacySummary } from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  useAdminDoctorDetail,
  useAdminPharmacyDetail,
  useAdminDoctors,
  useAdminPharmacies,
  useAllowedTransitions,
  useChangeStatus,
  useExpiringLicences,
  useVerifyDocument,
} from "@/features/onboarding/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/verification")({
  component: AdminVerification,
});

const STATUS_TONE: Record<string, "brand" | "medical" | "warning" | "muted" | "danger"> = {
  PENDING: "warning",
  UNDER_REVIEW: "medical",
  APPROVED: "medical",
  ACTIVE: "brand",
  SUSPENDED: "danger",
  EXPIRED: "danger",
  REJECTED: "danger",
};

/** Transitions that are adverse actions and therefore need a recorded reason. */
const REQUIRES_REASON = new Set(["SUSPENDED", "REJECTED", "EXPIRED"]);

function AdminVerification() {
  const [tab, setTab] = useState<"doctors" | "pharmacies">("doctors");
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Verification</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Every doctor and pharmacy is verified by hand before it can operate. Neem performs no
          automated licence or registration lookup.
        </p>
      </header>

      <ExpiringLicences />

      <div className="flex gap-1 rounded-xl bg-slate-100 p-1 w-fit">
        {(
          [
            { key: "doctors", label: "Doctors", icon: Stethoscope },
            { key: "pharmacies", label: "Pharmacies", icon: Building2 },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => {
              setTab(item.key);
              setSelected(null);
            }}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-colors",
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

      {/*
        Lists are paginated server-side, so a growing network quickly pushes an
        individual application off the first page. Search is how an admin
        reaches a specific doctor or pharmacy rather than scrolling for it.
      */}
      <label className="block max-w-md">
        <span className="sr-only">Search {tab === "doctors" ? "doctors" : "pharmacies"}</span>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setSelected(null);
            }}
            placeholder={
              tab === "doctors"
                ? "Search by name, MDC number or specialty"
                : "Search by name, city or Pharmacy Council number"
            }
            className="w-full rounded-xl border border-border bg-white py-2.5 pl-10 pr-4 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>
      </label>

      {tab === "doctors" ? (
        <DoctorQueue search={search} selected={selected} onSelect={setSelected} />
      ) : (
        <PharmacyQueue search={search} selected={selected} onSelect={setSelected} />
      )}
    </AppShell>
  );
}

function ExpiringLicences() {
  const { data } = useExpiringLicences();
  if (!data || data.length === 0) return null;

  return (
    <div className="card-soft border-warning/30 bg-warning-soft p-4">
      <p className="mb-2 text-sm font-bold text-warning">
        {data.length} MDC licence{data.length > 1 ? "s" : ""} approaching expiry
      </p>
      <ul className="space-y-1 text-xs text-slate-700">
        {data.map((entry) => (
          <li key={entry.publicId}>
            {entry.fullName} ({entry.mdcNumber}) —{" "}
            {entry.daysRemaining <= 0
              ? "expired"
              : `${entry.daysRemaining} day${entry.daysRemaining === 1 ? "" : "s"} remaining`}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-600">
        Request updated proof. A doctor must hold a valid licence for as long as they are active.
      </p>
    </div>
  );
}

function DoctorQueue({
  search,
  selected,
  onSelect,
}: {
  search: string;
  selected: string | null;
  onSelect: (publicId: string | null) => void;
}) {
  const { data: doctors, isLoading } = useAdminDoctors({ search });

  if (isLoading) return <LoadingCard />;
  if (!doctors?.length) {
    return (
      <EmptyCard
        message={search ? `No doctors match "${search}".` : "No doctor applications yet."}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      <div className="space-y-3 lg:col-span-2">
        {doctors.map((doctor) => (
          <button
            key={doctor.publicId}
            type="button"
            onClick={() => onSelect(doctor.publicId)}
            className={cn(
              "card-soft w-full p-4 text-left transition-colors hover:border-brand/40",
              selected === doctor.publicId && "border-brand ring-2 ring-brand/20",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{doctor.fullName}</p>
                <p className="font-mono text-xs text-slate-500">{doctor.mdcNumber}</p>
              </div>
              <Chip tone={STATUS_TONE[doctor.status] ?? "muted"}>
                {doctor.status.replace("_", " ")}
              </Chip>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {doctor.languages.map((language) => (
                <span
                  key={language.code}
                  className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600"
                >
                  {language.label}
                </span>
              ))}
            </div>

            <ReadinessRow
              verified={doctor.verifiedDocumentCount}
              total={doctor.documentCount}
              hasSignature={doctor.hasSignature}
            />
          </button>
        ))}
      </div>

      <div className="lg:col-span-3">
        {selected ? (
          <DoctorDetail publicId={selected} />
        ) : (
          <EmptyCard message="Select a doctor to review their credentials." />
        )}
      </div>
    </div>
  );
}

function ReadinessRow({
  verified,
  total,
  hasSignature,
}: {
  verified: number;
  total: number;
  hasSignature: boolean;
}) {
  return (
    <div className="mt-3 flex items-center gap-4 text-[11px] text-slate-500">
      <span className="inline-flex items-center gap-1">
        <FileText className="size-3" />
        {verified}/{total} verified
      </span>
      <span
        className={cn(
          "inline-flex items-center gap-1",
          hasSignature ? "text-brand" : "text-slate-400",
        )}
      >
        {hasSignature ? <Check className="size-3" /> : <X className="size-3" />}
        Signature
      </span>
    </div>
  );
}

function DoctorDetail({ publicId }: { publicId: string }) {
  const { data, isLoading } = useAdminDoctorDetail(publicId);
  const verify = useVerifyDocument("doctors");

  if (isLoading || !data) return <LoadingCard />;

  const doctor = data as {
    fullName: string;
    mdcNumber: string;
    mdcExpiresAt: string | null;
    specialty: string | null;
    yearsExperience: number | null;
    status: string;
    email: string;
    hasSignature: boolean;
    documents: Array<{
      id: string;
      type: string;
      uploadedAt: string;
      verified: boolean;
      note: string | null;
      sizeBytes: number;
    }>;
  };

  return (
    <div className="card-soft p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{doctor.fullName}</h2>
          <p className="text-sm text-slate-500">{doctor.email}</p>
        </div>
        <Chip tone={STATUS_TONE[doctor.status] ?? "muted"}>{doctor.status.replace("_", " ")}</Chip>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        <Detail label="MDC number" value={doctor.mdcNumber} mono />
        <Detail
          label="Licence expires"
          value={doctor.mdcExpiresAt ? new Date(doctor.mdcExpiresAt).toLocaleDateString() : "—"}
        />
        <Detail label="Experience" value={`${doctor.yearsExperience ?? "—"} years`} />
        <Detail label="Specialty" value={doctor.specialty ?? "—"} />
        <Detail label="Signature" value={doctor.hasSignature ? "Captured" : "Not captured"} />
      </dl>

      <DocumentReview kind="doctors" heading="Credential documents" documents={doctor.documents} />

      <StatusActions kind="doctors" publicId={publicId} />
    </div>
  );
}

export interface ReviewableDocument {
  id: string;
  type: string;
  uploadedAt: string;
  verified: boolean;
  note: string | null;
  sizeBytes?: number;
}

/**
 * The document review list, shared by the doctor and pharmacy queues.
 *
 * Neither account can be activated until at least one document here is marked
 * verified — the server enforces that, and this is where an administrator does
 * it. "Verified" means a person opened the file and accepted it; Neem asserts
 * nothing automatically (spec §20, §22).
 */
function DocumentReview({
  kind,
  heading,
  documents,
}: {
  kind: "doctors" | "pharmacies";
  heading: string;
  documents: ReviewableDocument[];
}) {
  const verify = useVerifyDocument(kind);
  const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

  return (
    <section className="mt-6">
      <h3 className="mb-1 text-sm font-bold">{heading}</h3>
      <p className="mb-3 text-xs text-slate-500">
        Opening a document is recorded in the audit log. This account cannot be activated until at
        least one document is verified.
      </p>

      {documents.length === 0 ? (
        <p className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">
          No documents uploaded yet.
        </p>
      ) : (
        <div className="space-y-2">
          {documents.map((document) => (
            <div key={document.id} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {document.type.replace(/_/g, " ").toLowerCase()}
                  </p>
                  <p className="text-xs text-slate-500">
                    {new Date(document.uploadedAt).toLocaleDateString()}
                    {document.sizeBytes !== undefined &&
                      ` · ${Math.round(document.sizeBytes / 1024)} KB`}
                  </p>
                </div>
                <Chip tone={document.verified ? "brand" : "warning"}>
                  {document.verified ? "Verified" : "Unverified"}
                </Chip>
              </div>

              {document.note && (
                <p className="mt-2 text-xs text-slate-600">
                  <span className="font-semibold">Note:</span> {document.note}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href={`${apiUrl}/api/v1/admin/${kind}/documents/${document.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-slate-50"
                >
                  Open document
                </a>
                {!document.verified ? (
                  <button
                    type="button"
                    onClick={() => verify.mutate({ id: document.id, verified: true })}
                    disabled={verify.isPending}
                    className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50"
                  >
                    Mark verified
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => verify.mutate({ id: document.id, verified: false })}
                    disabled={verify.isPending}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
                  >
                    Withdraw verification
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PharmacyQueue({
  search,
  selected,
  onSelect,
}: {
  search: string;
  selected: string | null;
  onSelect: (publicId: string | null) => void;
}) {
  const { data: pharmacies, isLoading } = useAdminPharmacies({ search });

  if (isLoading) return <LoadingCard />;
  if (!pharmacies?.length) {
    return (
      <EmptyCard
        message={search ? `No pharmacies match "${search}".` : "No pharmacy applications yet."}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
      <div className="space-y-3 lg:col-span-2">
        {pharmacies.map((pharmacy: PharmacySummary) => (
          <button
            key={pharmacy.publicId}
            type="button"
            onClick={() => onSelect(pharmacy.publicId)}
            className={cn(
              "card-soft w-full p-4 text-left transition-colors hover:border-brand/40",
              selected === pharmacy.publicId && "border-brand ring-2 ring-brand/20",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold">{pharmacy.name}</p>
                <p className="text-xs text-slate-500">
                  {pharmacy.city}, {pharmacy.region}
                </p>
              </div>
              <Chip tone={STATUS_TONE[pharmacy.status] ?? "muted"}>
                {pharmacy.status.replace("_", " ")}
              </Chip>
            </div>
            <p className="mt-2 font-mono text-[11px] text-slate-500">
              {pharmacy.councilRegistrationNo}
            </p>

            {/*
              Visible at a glance, as it is for doctors. A pharmacy showing
              0 verified cannot be activated — the server refuses it.
            */}
            <div className="mt-3 flex items-center gap-1 text-[11px] text-slate-500">
              <FileText className="size-3" />
              {pharmacy.verifiedDocumentCount}/{pharmacy.documentCount} verified
            </div>
          </button>
        ))}
      </div>

      <div className="lg:col-span-3">
        {selected ? (
          <PharmacyDetail publicId={selected} />
        ) : (
          <EmptyCard message="Select a pharmacy to review its registration." />
        )}
      </div>
    </div>
  );
}

/**
 * The pharmacy review panel.
 *
 * This previously showed the status buttons alone — no documents, because
 * there was no way for a pharmacy to upload any. An administrator was
 * therefore activating pharmacies without ever seeing a registration
 * certificate, which the server now refuses.
 */
function PharmacyDetail({ publicId }: { publicId: string }) {
  const { data, isLoading } = useAdminPharmacyDetail(publicId);

  if (isLoading || !data) return <LoadingCard />;

  const pharmacy = data as {
    name: string;
    councilRegistrationNo: string;
    ownerName: string;
    responsiblePharmacistName: string;
    responsiblePharmacistLicenceNo: string | null;
    addressLine1: string;
    city: string;
    region: string;
    phone: string;
    email: string;
    status: string;
    documents: ReviewableDocument[];
  };

  return (
    <div className="card-soft p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{pharmacy.name}</h2>
          <p className="text-sm text-slate-500">{pharmacy.email}</p>
        </div>
        <Chip tone={STATUS_TONE[pharmacy.status] ?? "muted"}>
          {pharmacy.status.replace("_", " ")}
        </Chip>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        <Detail label="Council registration" value={pharmacy.councilRegistrationNo} mono />
        <Detail label="Owner" value={pharmacy.ownerName} />
        <Detail label="Responsible pharmacist" value={pharmacy.responsiblePharmacistName} />
        <Detail label="Pharmacist licence" value={pharmacy.responsiblePharmacistLicenceNo ?? "—"} />
        <Detail label="Location" value={`${pharmacy.city}, ${pharmacy.region}`} />
        <Detail label="Phone" value={pharmacy.phone} />
      </dl>

      <p className="mt-5 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
        Confirm the registration with the Pharmacy Council directly before approving. Neem does not
        check it automatically, and nothing on this screen asserts a document is genuine.
      </p>

      <DocumentReview
        kind="pharmacies"
        heading="Registration documents"
        documents={pharmacy.documents}
      />

      <StatusActions kind="pharmacies" publicId={publicId} />
    </div>
  );
}

/**
 * Offers only the transitions the server's state machine permits, and requires
 * a reason for adverse actions — the same rule the API enforces (spec §96).
 */
function StatusActions({ kind, publicId }: { kind: "doctors" | "pharmacies"; publicId: string }) {
  const { data: transitions } = useAllowedTransitions(kind, publicId);
  const changeStatus = useChangeStatus(kind);
  const [pending, setPending] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  if (!transitions) return null;

  const needsReason = pending !== null && REQUIRES_REASON.has(pending);

  return (
    <section className="mt-6 border-t border-border pt-5">
      <h3 className="mb-3 text-sm font-bold">Change status</h3>

      {transitions.allowed.length === 0 ? (
        <p className="text-sm text-slate-500">
          No further transitions are available from {transitions.current}.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {transitions.allowed.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => {
                setPending(status);
                setReason("");
              }}
              className={cn(
                "rounded-xl border px-4 py-2 text-xs font-semibold transition-colors",
                pending === status
                  ? "border-brand bg-brand-soft text-brand"
                  : REQUIRES_REASON.has(status)
                    ? "border-red-200 text-red-600 hover:bg-red-50"
                    : "border-border hover:bg-slate-50",
              )}
            >
              {status.replace("_", " ")}
            </button>
          ))}
        </div>
      )}

      {pending && (
        <div className="mt-4 rounded-2xl border border-border bg-slate-50 p-4">
          <p className="text-sm font-semibold">Move to {pending.replace("_", " ")}?</p>
          {pending === "ACTIVE" && kind === "doctors" && (
            <p className="mt-1 text-xs text-slate-600">
              Activation makes this doctor eligible for consultations and lets them sign
              prescriptions. It requires at least one verified document and a captured signature.
            </p>
          )}
          {pending === "ACTIVE" && kind === "pharmacies" && (
            <p className="mt-1 text-xs text-slate-600">
              Activation lets this pharmacy initiate paid consultations.
            </p>
          )}

          {needsReason && (
            <label className="mt-3 block">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Reason (recorded in the audit log)
              </span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={2}
                className="mt-1.5 w-full resize-none rounded-xl border border-border bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </label>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={changeStatus.isPending || (needsReason && reason.trim().length === 0)}
              onClick={() =>
                changeStatus.mutate(
                  { publicId, status: pending, reason: reason.trim() || undefined },
                  { onSuccess: () => setPending(null) },
                )
              }
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              {changeStatus.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="rounded-xl border border-border px-4 py-2 text-xs font-semibold hover:bg-white"
            >
              Cancel
            </button>
          </div>

          {changeStatus.error && (
            <p className="mt-3 flex items-start gap-2 text-xs text-red-600">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              {changeStatus.error instanceof ApiError
                ? changeStatus.error.message
                : "Could not change status."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</dt>
      <dd className={cn("mt-0.5", mono && "font-mono text-xs")}>{value}</dd>
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="card-soft grid place-items-center p-16">
      <Loader2 className="size-6 animate-spin text-brand" />
    </div>
  );
}

function EmptyCard({ message }: { message: string }) {
  return (
    <div className="card-soft grid place-items-center p-16 text-center">
      <p className="text-sm text-slate-500">{message}</p>
    </div>
  );
}

export type { DoctorSummary };
