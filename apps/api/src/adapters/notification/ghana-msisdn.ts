/**
 * A Ghanaian mobile number in the form an SMS gateway expects.
 *
 * Shared by every SMS adapter. Extracted from the Hubtel adapter when Arkesel
 * arrived (D39): two copies of this would be two chances to get it wrong, and
 * this is the function where being wrong is worst.
 *
 * Returns null when the input cannot be made into a Ghanaian number, which
 * every caller turns into a permanent failure rather than a retry. Deliberately
 * strict: the message carries a patient's consultation reference, which is
 * their only route back to their own record (D24). A number guessed at does not
 * merely fail to arrive — it arrives at a stranger's handset.
 *
 * A test caught exactly that. The "no trunk zero" rule was `\d{9}`, which also
 * matched `024412345` — a local number one digit short — and turned it into
 * `233024412345`: not the patient's number, quite possibly somebody's.
 */
export function toGhanaMsisdn(raw: string): string | null {
  const digits = raw.replace(/[\s()+-]/g, '');
  if (!/^\d+$/.test(digits)) return null;

  // 0244123456 — the way a number is written and spoken in Ghana.
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;

  // 233244123456 — already international.
  if (/^233\d{9}$/.test(digits)) return digits;

  // 244123456 — no trunk zero, as some systems store it. The leading digit
  // must not be zero; see the note above for what that guard prevents.
  if (/^[1-9]\d{8}$/.test(digits)) return `233${digits}`;

  return null;
}
