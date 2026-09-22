import { useSession } from "@/features/auth/use-session";

export type ProfessionalRole = {
  /** "Doctor", "Dietitian", "Personal trainer" — for eyebrows and headings. */
  title: string;
  /** "doctor", "dietitian", "personal trainer" — for use mid-sentence. */
  noun: string;
  isDoctor: boolean;
};

const ROLES: Record<"DOCTOR" | "DIETITIAN" | "TRAINER", ProfessionalRole> = {
  DOCTOR: { title: "Doctor", noun: "doctor", isDoctor: true },
  DIETITIAN: { title: "Dietitian", noun: "dietitian", isDoctor: false },
  TRAINER: { title: "Personal trainer", noun: "personal trainer", isDoctor: false },
};

/**
 * What the signed-in professional is, in words (v2).
 *
 * The professional screens were written when every professional was a
 * doctor. A dietitian or trainer uses the same screens, and should be called
 * what they are. A session from before the API reported a discipline reads as
 * a doctor, which is what every such account was.
 */
export function useProfessionalRole(): ProfessionalRole {
  const { user } = useSession();
  return ROLES[user?.discipline ?? "DOCTOR"];
}
