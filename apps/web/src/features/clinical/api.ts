import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * The clinical workflow (spec §41–§50, decisions D13, D25).
 *
 * Deliberately absent, because no route exists behind them: anything that
 * edits a prescription's items after issue, anything that lets a pharmacy
 * change what a doctor prescribed, and anything that returns a patient's past
 * consultations.
 */

// ---------------------------------------------------------------------------
// The doctor's workspace
// ---------------------------------------------------------------------------

export interface Vitals {
  bpSystolic?: number | null;
  bpDiastolic?: number | null;
  pulseBpm?: number | null;
  temperatureC?: number | null;
  weightKg?: number | null;
  spo2Percent?: number | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Pharmacy — observations (spec §50)
// ---------------------------------------------------------------------------

export interface PointOfCareTest {
  code: string;
  label: string;
  result: string;
  recordedAt: string;
}

/** What the pharmacy submits: readings only, timestamped by the server. */
export type VitalsInput = Omit<Vitals, "recordedAt">;

export interface Observations {
  /** True once the consultation ended; the record is closed to everyone (D23). */
  sealed: boolean;
  vitals: Vitals | null;
  tests: PointOfCareTest[];
}

export const observationsKey = (publicId: string) =>
  ["pharmacy", "observations", publicId] as const;

export function usePharmacyObservations(publicId: string, enabled = true) {
  return useQuery({
    queryKey: observationsKey(publicId),
    queryFn: ({ signal }) =>
      api.get<Observations>(`/pharmacy/consultations/${publicId}/observations`, signal),
    enabled,
    retry: false,
  });
}

/**
 * Vitals are appended, not edited.
 *
 * Each submission is a new reading with its own timestamp; the doctor sees the
 * latest. A correction is therefore a re-measurement, which is what a clinical
 * record should show.
 */
export function useRecordVitals(publicId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (readings: VitalsInput) =>
      api.post<{ recorded: boolean }>(`/pharmacy/consultations/${publicId}/vitals`, readings),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: observationsKey(publicId) }),
  });
}

export function useRecordTest(publicId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (test: { code: string; label: string; result: string }) =>
      api.post<{ recorded: boolean }>(`/pharmacy/consultations/${publicId}/tests`, test),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: observationsKey(publicId) }),
  });
}

export interface Workspace {
  notes: string | null;
  diagnosis: string | null;
  treatment: string | null;
  vitals: Vitals | null;
  tests: Array<{ code: string; label: string; result: string; recordedAt: string }>;
}

export const workspaceKey = (publicId: string) => ["doctor", "workspace", publicId] as const;

export function useWorkspace(publicId: string, enabled = true) {
  return useQuery({
    queryKey: workspaceKey(publicId),
    queryFn: ({ signal }) =>
      api.get<Workspace>(`/doctor/consultations/${publicId}/workspace`, signal),
    enabled,
    // A 403 here means the record is sealed, which is a settled answer rather
    // than a transient failure — retrying would just repeat it.
    retry: false,
  });
}

export function useSaveNotes(publicId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { notes?: string; diagnosis?: string; treatment?: string }) =>
      api.put<{ saved: boolean }>(`/doctor/consultations/${publicId}/notes`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceKey(publicId) }),
  });
}

// ---------------------------------------------------------------------------
// Prescribing
// ---------------------------------------------------------------------------

export interface PrescriptionItemInput {
  medication: string;
  strength?: string;
  form?: string;
  dose: string;
  frequency: string;
  durationText: string;
  quantity: string;
  instructions?: string;
}

export interface DoctorPrescription {
  publicId: string;
  state: string;
}

export const doctorPrescriptionsKey = (publicId: string) =>
  ["doctor", "prescriptions", publicId] as const;

export function useCreatePrescription(consultationPublicId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (items: PrescriptionItemInput[]) =>
      api.post<DoctorPrescription>(
        `/doctor/consultations/${consultationPublicId}/prescriptions`,
        { items },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: doctorPrescriptionsKey(consultationPublicId) }),
  });
}

/** Issuing signs the prescription and hands it to the pharmacy. */
export function useIssuePrescription(consultationPublicId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (prescriptionPublicId: string) =>
      api.post<DoctorPrescription>(`/doctor/prescriptions/${prescriptionPublicId}/issue`),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: doctorPrescriptionsKey(consultationPublicId) }),
  });
}

export function useRevokePrescription(consultationPublicId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { publicId: string; reason: string }) =>
      api.post<DoctorPrescription>(`/doctor/prescriptions/${input.publicId}/revoke`, {
        reason: input.reason,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: doctorPrescriptionsKey(consultationPublicId) }),
  });
}

// ---------------------------------------------------------------------------
// Referral and summary
// ---------------------------------------------------------------------------

export function useIssueReferral(consultationPublicId: string) {
  return useMutation({
    mutationFn: (input: {
      hospitalName: string;
      department: string;
      reasonText: string;
      urgency?: string;
    }) => api.post<{ publicId: string }>(`/doctor/consultations/${consultationPublicId}/referrals`, input),
  });
}

/**
 * The consultation summary (decision D25).
 *
 * Mandatory for an advice-only outcome. Every field is written by the doctor —
 * nothing composes it from the notes, because a document saying "you do not
 * need medication" carries their signature and is a clinical opinion.
 */
export function useIssueSummary(consultationPublicId: string) {
  return useMutation({
    mutationFn: (input: {
      presentingComplaint: string;
      assessment: string;
      advice: string;
      safetyNetting: string;
    }) => api.post<{ publicId: string }>(`/doctor/consultations/${consultationPublicId}/summary`, input),
  });
}

// ---------------------------------------------------------------------------
// Completion — the only path (spec §16)
// ---------------------------------------------------------------------------

export type Outcome =
  | "ADVICE_ONLY"
  | "PRESCRIPTION"
  | "REFERRAL"
  | "EMERGENCY_REFERRAL"
  | "OTHER";

export interface CompletionResult {
  state: "COMPLETED";
  consultationPublicId: string;
  durationSeconds: number;
  destroyAt: string | null;
  hasPrescription: boolean;
  hasReferral: boolean;
  hasSummary: boolean;
}

export function useCompleteConsultation(publicId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      outcome: Outcome;
      notes?: { notes?: string; diagnosis?: string; treatment?: string };
    }) => api.post<CompletionResult>(`/doctor/consultations/${publicId}/complete`, input),
    onSuccess: () => {
      // Completion seals the record, so the workspace query is now a 403.
      void queryClient.invalidateQueries({ queryKey: ["doctor"] });
    },
  });
}

// ---------------------------------------------------------------------------
// The pharmacy's side
// ---------------------------------------------------------------------------

export interface PharmacyPrescriptionItem {
  id: string;
  medication: string;
  strength: string | null;
  form: string | null;
  dose: string;
  frequency: string;
  durationText: string;
  quantity: string;
  instructions: string | null;
}

export interface PharmacyPrescription {
  publicId: string;
  consultationReference: string;
  state: string;
  patientName: string;
  patientAge: number;
  doctor: { fullName: string; mdcNumber: string };
  issuedAt: string | null;
  dispensedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  /** The most recent substitution on this prescription, decided or not. */
  lastSubstitution: {
    state: "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
    proposedMedication: string;
    reason: string;
    decisionNote: string | null;
    decidedAt: string | null;
  } | null;
  items: PharmacyPrescriptionItem[];
}

export const pharmacyPrescriptionsKey = ["pharmacy", "prescriptions"] as const;

export function usePharmacyPrescriptions(activeOnly = false) {
  return useQuery({
    queryKey: [...pharmacyPrescriptionsKey, activeOnly],
    queryFn: ({ signal }) =>
      api.get<PharmacyPrescription[]>(
        `/pharmacy/prescriptions?activeOnly=${activeOnly}`,
        signal,
      ),
    // A doctor may revoke while the pharmacist is looking at the screen, and
    // dispensing a revoked prescription is exactly what must not happen.
    refetchInterval: 20_000,
  });
}

export function useDispense() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (publicId: string) =>
      api.post<{ publicId: string; state: string }>(
        `/pharmacy/prescriptions/${publicId}/dispense`,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: pharmacyPrescriptionsKey }),
  });
}

/** A proposal, never a change. The issuing doctor decides (spec §47). */
export function useProposeSubstitution() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      prescriptionPublicId: string;
      itemId: string;
      medication: string;
      strength?: string;
      form?: string;
      reason: string;
    }) =>
      api.post<{ id: string; state: string }>(
        `/pharmacy/prescriptions/${input.prescriptionPublicId}/substitutions`,
        {
          itemId: input.itemId,
          medication: input.medication,
          strength: input.strength,
          form: input.form,
          reason: input.reason,
        },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: pharmacyPrescriptionsKey }),
  });
}

/**
 * A substitution proposed on one of this doctor's prescriptions.
 *
 * The prescription is stuck until it is answered — a pharmacy cannot dispense
 * against a pending proposal — so this is a work queue, not a notification.
 */
export interface PendingSubstitution {
  id: string;
  requestedAt: string;
  reason: string;
  proposed: { medication: string; strength: string | null; form: string | null };
  prescribed: {
    id: string;
    medication: string;
    strength: string | null;
    form: string | null;
    dose: string;
    frequency: string;
    durationText: string;
    quantity: string;
    instructions: string | null;
  };
  prescriptionPublicId: string;
  consultationReference: string;
  issuedAt: string | null;
  pharmacy: { name: string; city: string };
  patient: { fullName: string; age: number; sex: string };
}

export const doctorSubstitutionsKey = ["doctor", "substitutions"] as const;

export function useDoctorSubstitutions() {
  return useQuery({
    queryKey: doctorSubstitutionsKey,
    queryFn: ({ signal }) => api.get<PendingSubstitution[]>("/doctor/substitutions", signal),
    // A pharmacist is standing at a counter waiting for this answer.
    refetchInterval: 30_000,
  });
}

export function useDecideSubstitution() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; approve: boolean; note?: string }) =>
      api.post<{ id: string; approved: boolean }>(`/doctor/substitutions/${input.id}/decide`, {
        approve: input.approve,
        note: input.note,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["doctor"] }),
  });
}

// ---------------------------------------------------------------------------
// Public verification (spec §44)
// ---------------------------------------------------------------------------

export interface VerificationResult {
  kind: "prescription" | "referral" | "summary";
  genuine: true;
  publicId: string;
  issuedAt: string;
  doctor: { fullName: string; mdcNumber: string };
  state?: string;
  revoked?: boolean;
  dispensed?: boolean;
}

/**
 * Checks a document is genuine.
 *
 * Needs no account: whoever is holding a printout must be able to check it.
 * It returns nothing about what the document says.
 */
export function useVerifyDocument(kind: string, code: string) {
  return useQuery({
    queryKey: ["verify", kind, code],
    queryFn: ({ signal }) => api.get<VerificationResult>(`/verify/${kind}/${code}`, signal),
    retry: false,
  });
}
