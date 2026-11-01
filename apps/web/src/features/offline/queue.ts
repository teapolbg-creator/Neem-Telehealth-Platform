import { useEffect, useSyncExternalStore } from "react";
import type {
  OfflineDecision,
  OfflineKey,
  OfflineWalkInInput,
  OfflineWalkInResult,
  PatientRegistration,
  PatientSummary,
  TriageCreate,
} from "@neem/contracts";
import { api, ApiError, onReachability } from "@/lib/api-client";
import { entries, importKey, seal, unseal, type EntryState, type StoredEntry } from "./store";

/**
 * Walk-ins recorded while the facility is offline (CHPS slice 4a, D88).
 *
 * One queue per browser, shared by every facility screen. A walk-in is
 * sealed on the device the moment it is saved and sent, oldest first, as
 * soon as the API answers again. The API decides everything the device
 * cannot: whether this person is already on file, and what time it really
 * was.
 */

export interface WalkInDraft {
  clientRequestId: string;
  capturedAt: string;
  registration: PatientRegistration;
  triage: (TriageCreate & { triagedAt: string }) | null;
  decision: OfflineDecision | null;
}

export interface QueueEntry {
  id: string;
  savedAt: string;
  state: EntryState;
  refusal: string | null;
  walkIn: WalkInDraft;
  /** Patients on file who may be this walk-in, while the CHO decides. */
  candidates: PatientSummary[] | null;
}

export interface SentWalkIn {
  id: string;
  fullName: string;
  patientNumber: string;
  matchedExisting: boolean;
}

export interface OfflineState {
  /** Whether the API answered the last request. */
  reachable: boolean;
  /** Whether walk-ins can be saved here: the key has come from the API. */
  canSave: boolean;
  /** The session has ended; nothing is sent until the CHO signs in again. */
  signedOut: boolean;
  syncing: boolean;
  entries: QueueEntry[];
  /** This account's walk-ins that cannot be opened until the key comes from the API. */
  locked: number;
  /** Walk-ins saved here by another account, which this one cannot open. */
  othersWaiting: number;
  /** Sent while this page has been open. */
  sent: SentWalkIn[];
}

let state: OfflineState = {
  reachable: true,
  canSave: false,
  signedOut: false,
  syncing: false,
  entries: [],
  locked: 0,
  othersWaiting: 0,
  sent: [],
};
const listeners = new Set<() => void>();
let userId: string | null = null;
let key: CryptoKey | null = null;
const candidates = new Map<string, PatientSummary[]>();
let probe: ReturnType<typeof setInterval> | null = null;

/** How often an offline device checks whether the API is back. */
const PROBE_INTERVAL_MS = 15_000;

function update(next: Partial<OfflineState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

async function reload() {
  if (!userId) return;
  const stored = (await entries.all()).sort((a, b) => a.savedAt.localeCompare(b.savedAt));
  const mine = stored.filter((entry) => entry.userId === userId);
  const opened: QueueEntry[] = [];
  if (key) {
    for (const entry of mine) {
      try {
        opened.push({
          id: entry.id,
          savedAt: entry.savedAt,
          state: entry.state,
          refusal: entry.refusal,
          walkIn: await unseal<WalkInDraft>(key, entry),
          candidates: candidates.get(entry.id) ?? null,
        });
      } catch {
        // Sealed under a key this account no longer has; counted, never opened.
      }
    }
  }
  update({
    entries: opened,
    locked: mine.length - opened.length,
    othersWaiting: stored.length - mine.length,
  });
}

async function store(walkIn: WalkInDraft, next: Pick<StoredEntry, "state" | "refusal">) {
  if (!key || !userId) throw new Error("The offline key has not been loaded.");
  const existing = (await entries.all()).find((entry) => entry.id === walkIn.clientRequestId);
  await entries.put({
    id: walkIn.clientRequestId,
    userId,
    savedAt: existing?.savedAt ?? new Date().toISOString(),
    ...next,
    ...(await seal(key, walkIn)),
  });
}

let keyRequest: Promise<void> | null = null;

/** One request at a time, however many screens ask. */
function loadKey(): Promise<void> {
  if (key || !userId) return Promise.resolve();
  keyRequest ??= (async () => {
    const forUser = userId;
    try {
      const { key: base64 } = await api.get<OfflineKey>("/facility/offline-key");
      // Signed in as someone else meanwhile: this key is not theirs.
      if (forUser !== userId) return;
      key = await importKey(base64);
      update({ canSave: true, signedOut: false });
    } catch (error) {
      if (error instanceof ApiError && error.isAuthError) update({ signedOut: true });
    } finally {
      keyRequest = null;
    }
  })();
  return keyRequest;
}

function setReachable(reachable: boolean) {
  if (reachable === state.reachable) return;
  update({ reachable });
  if (reachable) {
    if (probe) clearInterval(probe);
    probe = null;
    void loadKey().then(reload).then(syncNow);
  } else if (!probe) {
    probe = setInterval(() => {
      api.get("/health").catch(() => undefined);
    }, PROBE_INTERVAL_MS);
  }
}

/** Sends every queued walk-in, oldest first, until one cannot be sent. */
export async function syncNow(): Promise<void> {
  if (state.syncing || !key || !userId || !state.reachable) return;
  update({ syncing: true });
  try {
    for (const entry of state.entries) {
      if (entry.state !== "QUEUED") continue;
      const body: OfflineWalkInInput = {
        ...entry.walkIn,
        sentAt: new Date().toISOString(),
      };
      let result: OfflineWalkInResult;
      try {
        result = await api.post<OfflineWalkInResult>("/facility/offline/walk-ins", body);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) break;
        if (error.isAuthError) {
          update({ signedOut: true });
          break;
        }
        // Refused for a reason only the CHO can resolve; the rest still go.
        await store(entry.walkIn, { state: "REFUSED", refusal: error.message });
        continue;
      }
      if (result.outcome === "POSSIBLE_DUPLICATE") {
        candidates.set(entry.id, result.candidates);
        await store(entry.walkIn, { state: "NEEDS_DECISION", refusal: null });
        continue;
      }
      candidates.delete(entry.id);
      await entries.remove(entry.id);
      update({
        sent: [
          ...state.sent,
          {
            id: entry.id,
            fullName: entry.walkIn.registration.fullName,
            patientNumber: result.patientNumber,
            matchedExisting: result.matchedExisting,
          },
        ],
      });
    }
  } finally {
    await reload();
    update({ syncing: false });
  }
}

export async function saveWalkIn(
  registration: PatientRegistration,
  triage: WalkInDraft["triage"],
): Promise<string> {
  const now = new Date().toISOString();
  const walkIn: WalkInDraft = {
    clientRequestId: registration.clientRequestId ?? crypto.randomUUID(),
    capturedAt: now,
    registration,
    triage,
    decision: null,
  };
  await store(walkIn, { state: "QUEUED", refusal: null });
  await reload();
  void syncNow();
  return walkIn.clientRequestId;
}

async function change(id: string, edit: (walkIn: WalkInDraft) => WalkInDraft) {
  const entry = state.entries.find((candidate) => candidate.id === id);
  if (!entry) return;
  candidates.delete(id);
  await store(edit(entry.walkIn), { state: "QUEUED", refusal: null });
  await reload();
  void syncNow();
}

export const addTriage = (id: string, triage: TriageCreate) =>
  change(id, (walkIn) => ({
    ...walkIn,
    triage: { ...triage, triagedAt: new Date().toISOString() },
  }));

/** The CHO's answer to "is this someone on file?". */
export const decide = (id: string, decision: OfflineDecision) =>
  change(id, (walkIn) => ({ ...walkIn, decision }));

export async function discard(id: string) {
  candidates.delete(id);
  await entries.remove(id);
  await reload();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const SERVER_STATE = state;

/** The queue, for any facility screen. Starts it for the signed-in CHO. */
export function useOfflineQueue(currentUserId: string | null): OfflineState {
  useEffect(() => {
    if (!currentUserId || typeof indexedDB === "undefined") return;
    if (currentUserId !== userId) {
      userId = currentUserId;
      key = null;
      candidates.clear();
      update({ canSave: false, entries: [], sent: [] });
    }
    void loadKey().then(reload).then(syncNow);
  }, [currentUserId]);

  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
}

if (typeof window !== "undefined") {
  onReachability(setReachable);
  window.addEventListener("offline", () => setReachable(false));
  window.addEventListener("online", () => {
    api.get("/health").catch(() => undefined);
  });
}

/** Sends a walk-in again as it is: after a refusal, or to see its possible matches again. */
export const retry = (id: string) => change(id, (walkIn) => walkIn);
