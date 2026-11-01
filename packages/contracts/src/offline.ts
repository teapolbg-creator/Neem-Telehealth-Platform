import { z } from 'zod';
import { patientRegistrationSchema, triageCreateSchema, type PatientSummary } from './patient.ts';

/**
 * Walk-ins recorded while the facility is offline (CHPS slice 4a, D88).
 *
 * The CHO's browser keeps each one encrypted on the device, with a key only
 * the API hands out, and sends it once the connection is back. The registry
 * is never copied to the device, so a duplicate check cannot happen offline:
 * it happens here, on arrival, and the CHO decides what a match means.
 */

/** Which existing patient an offline walk-in is, or that they are nobody on file. */
export const offlineDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('EXISTING'), patientNumber: z.string().trim().min(1).max(16) }),
  z.object({ kind: z.literal('NEW') }),
]);
export type OfflineDecision = z.infer<typeof offlineDecisionSchema>;

export const offlineWalkInSchema = z.object({
  clientRequestId: z.string().uuid(),
  /** The device's clock when the walk-in was registered. */
  capturedAt: z.string().datetime(),
  /** The device's clock when this was sent, so a wrong clock can be corrected. */
  sentAt: z.string().datetime(),
  registration: patientRegistrationSchema,
  triage: triageCreateSchema.extend({ triagedAt: z.string().datetime() }).nullish(),
  decision: offlineDecisionSchema.nullish(),
});
export type OfflineWalkIn = z.infer<typeof offlineWalkInSchema>;
export type OfflineWalkInInput = z.input<typeof offlineWalkInSchema>;

export type OfflineWalkInResult =
  | {
      outcome: 'SAVED';
      patientNumber: string;
      visitPublicId: string;
      /** True when the walk-in became a visit on a patient already on file. */
      matchedExisting: boolean;
    }
  | {
      /** Nothing was saved; the CHO must say who this is (`decision`). */
      outcome: 'POSSIBLE_DUPLICATE';
      candidates: PatientSummary[];
    };

/** The key the browser encrypts its offline queue with: AES-GCM, 256 bits, base64. */
export interface OfflineKey {
  key: string;
}
