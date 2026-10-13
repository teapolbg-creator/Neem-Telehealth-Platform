export type ProfessionalRole = {
  /** "Doctor" — for eyebrows and headings. */
  title: string;
  /** "doctor" — for use mid-sentence. */
  noun: string;
  isDoctor: boolean;
};

const DOCTOR: ProfessionalRole = { title: "Doctor", noun: "doctor", isDoctor: true };

/**
 * What the signed-in professional is, in words (v2).
 *
 * Every professional is a doctor again (D69): dietitians and personal trainers
 * were withdrawn with the weight-loss clinic, and this read the discipline off
 * the session to choose their words.
 *
 * It stays a function rather than collapsing into the strings it returns,
 * because nine screens say "{role.noun}" rather than "doctor" and that is the
 * right shape — offering another discipline again is an entry here, not a
 * sweep through the portal.
 */
export function useProfessionalRole(): ProfessionalRole {
  return DOCTOR;
}
