import { useState } from "react";
import { ChevronDown, ShieldCheck } from "lucide-react";
import { PRIVACY_NOTICE, PRIVACY_NOTICE_VERSION } from "@neem/contracts";
import { cn } from "@/lib/utils";

/**
 * What the patient is told before they type anything about themselves (D60).
 *
 * Counsel's answer to Q9: there was no lawful-basis notice on this screen at
 * all, the pharmacy starting the consultation does not reduce the patient's
 * rights, and health information is special personal data under s.37 of Act
 * 843. The eight points are the matters s.27 of that Act requires a data
 * subject to be made aware of, and they live in `@neem/contracts` so the
 * counter and a patient booking from home are shown the same words — two
 * notices would be two different legal positions.
 *
 * **Collapsed, with the operative sentence outside.** A patient at a counter
 * with a pharmacist waiting will not read eight paragraphs, and a wall of text
 * they scroll past is not consent to anything. So the summary line and the
 * checkbox are always visible, and the full notice is one tap away, present and
 * complete for anyone who wants it. What is never hidden: that this is about
 * health information, and that reading it is their right.
 *
 * It does not pre-tick. A ticked box is not an agreement.
 */
export function PrivacyNotice({
  accepted,
  onAcceptedChange,
  error,
}: {
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
  /** Shown when the form was submitted without the box ticked. */
  error?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={cn(
        "rounded-2xl border p-4",
        error ? "border-red-300 bg-red-50/50" : "border-border bg-slate-50",
      )}
    >
      <div className="flex items-start gap-2.5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-slate-700">
            Your health information, and what happens to it
          </p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Neem holds your details to provide this consultation, to write a prescription if you
            need one, and to keep the records Ghanaian law requires. Your record is sealed
            afterwards and nobody can reopen it.
          </p>

          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="mt-2 inline-flex items-center gap-1 text-xs font-bold text-brand underline underline-offset-2"
          >
            {open ? "Hide the details" : "Read what we collect and your rights"}
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>

          {open && (
            <dl className="mt-3 space-y-2.5 border-t border-border pt-3">
              {PRIVACY_NOTICE.map((point) => (
                <div key={point.heading}>
                  <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    {point.heading}
                  </dt>
                  <dd className="mt-0.5 text-xs leading-relaxed text-slate-600">{point.body}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>

      <label className="mt-3 flex items-start gap-3 border-t border-border pt-3 text-xs">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => onAcceptedChange(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
        />
        <span className="leading-relaxed text-slate-700">
          I have read this and I agree to Neem holding and using my health information for this
          consultation.
        </span>
      </label>

      {error && <p className="mt-2 text-xs font-bold text-red-600">{error}</p>}
    </div>
  );
}

/** The version a screen submits alongside the tick, so the record names it. */
export { PRIVACY_NOTICE_VERSION };
