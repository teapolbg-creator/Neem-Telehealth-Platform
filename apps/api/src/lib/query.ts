import { z } from 'zod';

/**
 * A boolean that arrives as a query-string value.
 *
 * `z.coerce.boolean()` must never be used for this. It applies JavaScript's
 * `Boolean()`, under which the string `"false"` is `true` — so a filter the
 * caller explicitly turned off arrives at the handler turned on. That is not a
 * theoretical hazard: it silently broke the pharmacy's "All prescriptions"
 * toggle, which asked for `activeOnly=false` and kept receiving the
 * to-dispense list.
 *
 * Only the literal spellings a client would actually send are accepted.
 * Anything else is a 400, which is preferable to guessing.
 */
export const queryBoolean = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');
