import { useState } from "react";
import { FileText, Paperclip, Pill, Printer } from "lucide-react";
import type { VisitPrescription, VisitView } from "@neem/contracts";
import { Chip } from "@/components/neem/Chip";
import { inputClass } from "@/features/facility/form";
import {
  attachmentUrl,
  formatSize,
  prescriptionPdfUrl,
  useAddAttachment,
  useDispenseHere,
} from "@/features/facility/records";

/**
 * A visit's prescriptions and files, as the CHO sees them (slice 2d, D83).
 */

export function VisitPrescriptions({ visit }: { visit: VisitView }) {
  if (visit.prescriptions.length === 0) return null;
  return (
    <div className="space-y-2">
      {visit.prescriptions.map((prescription) => (
        <PrescriptionCard key={prescription.publicId} prescription={prescription} />
      ))}
    </div>
  );
}

const DISPENSABLE = ["ACTIVE", "SUBSTITUTION_APPROVED", "SUBSTITUTION_REJECTED"];

function PrescriptionCard({ prescription }: { prescription: VisitPrescription }) {
  const dispense = useDispenseHere(prescription.publicId);
  const [confirming, setConfirming] = useState(false);
  const revoked = prescription.state === "REVOKED";

  return (
    <div className="space-y-2 rounded-xl border border-border p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">
          <Pill className="size-4 text-brand" /> Prescription from {prescription.doctorName}
        </p>
        <Chip tone={revoked ? "danger" : prescription.state === "DISPENSED" ? "muted" : "brand"}>
          {revoked
            ? "Revoked: do not give"
            : prescription.state === "DISPENSED"
              ? prescription.dispensedHere
                ? "Given here"
                : "Dispensed"
              : "To collect or give"}
        </Chip>
      </div>
      <ul className="space-y-1">
        {prescription.items.map((item, index) => (
          <li key={index}>
            <span className="font-medium">
              {item.medication}
              {item.strength ? ` ${item.strength}` : ""}
              {item.form ? ` (${item.form})` : ""}
            </span>
            <span className="text-slate-600">
              {" "}
              · {item.dose}, {item.frequency}, {item.duration} · {item.quantity}
            </span>
            {item.instructions ? (
              <span className="block text-xs text-slate-500">{item.instructions}</span>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 pt-1">
        <a
          href={prescriptionPdfUrl(prescription.publicId)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          <Printer className="size-3.5" /> Print for the patient
        </a>
        {DISPENSABLE.includes(prescription.state) ? (
          confirming ? (
            <span className="inline-flex items-center gap-2 text-xs">
              Given from this facility’s stock?
              <button
                type="button"
                disabled={dispense.isPending}
                onClick={() =>
                  dispense.mutate(undefined, { onSuccess: () => setConfirming(false) })
                }
                className="rounded-lg bg-brand px-3 py-1.5 font-semibold text-white"
              >
                Yes, given
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="font-semibold text-slate-500"
              >
                No
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white"
            >
              Given here
            </button>
          )
        ) : null}
      </div>
      {dispense.error ? (
        <p className="text-xs text-red-600">
          {dispense.error instanceof Error ? dispense.error.message : "Not recorded."}
        </p>
      ) : null}
    </div>
  );
}

export function VisitAttachments({ visit, canAdd }: { visit: VisitView; canAdd: boolean }) {
  const add = useAddAttachment(visit.publicId);
  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [open, setOpen] = useState(false);
  if (visit.attachments.length === 0 && !canAdd) return null;

  return (
    <div className="space-y-2 text-sm">
      {visit.attachments.length > 0 ? (
        <ul className="space-y-1">
          {visit.attachments.map((attachment) => (
            <li key={attachment.publicId}>
              <a
                href={attachmentUrl(attachment.publicId)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 font-semibold text-brand hover:underline"
              >
                <FileText className="size-4" /> {attachment.label}
              </a>
              <span className="ml-2 text-xs text-slate-500">
                {formatSize(attachment.sizeBytes)} · {attachment.uploadedBy}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {canAdd && !open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          <Paperclip className="size-4" /> Add a file
        </button>
      ) : null}
      {open ? (
        <form
          className="space-y-2 rounded-xl border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!file) return;
            add.mutate(
              { file, label },
              {
                onSuccess: () => {
                  setOpen(false);
                  setLabel("");
                  setFile(null);
                },
              },
            );
          }}
        >
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="What is it? e.g. Malaria RDT photo, hospital letter"
            className={inputClass}
          />
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="block text-sm"
          />
          <p className="text-xs text-slate-500">A PDF or a photo. Kept encrypted.</p>
          {add.error ? (
            <p className="text-xs text-red-600">
              {add.error instanceof Error ? add.error.message : "Not uploaded."}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-slate-600"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!file || label.trim().length < 2 || add.isPending}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
            >
              Upload
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
