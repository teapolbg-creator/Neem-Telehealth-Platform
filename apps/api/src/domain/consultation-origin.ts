/**
 * What to call where a consultation came from (v2).
 *
 * Every consultation belonged to a pharmacy until v2, so screens, PDFs and
 * messages name one freely. A patient-direct consultation has none, and the
 * honest answer is not an empty string or the word "unknown" — it is that the
 * patient booked it themselves.
 *
 * One place, so the counter service and the direct service cannot end up
 * describing the same absence in two different ways.
 */

/** Shown wherever a pharmacy name would be, for a consultation with no pharmacy. */
export const DIRECT_ORIGIN_NAME = 'Neem online';

/**
 * A CHPS consultation comes from its facility (D76); the facility is passed by
 * the callers that load it, and a consultation has a pharmacy or a facility,
 * never both.
 */
export function originName(
  pharmacy: { name: string } | null | undefined,
  facility?: { name: string } | null,
): string {
  return pharmacy?.name ?? facility?.name ?? DIRECT_ORIGIN_NAME;
}
