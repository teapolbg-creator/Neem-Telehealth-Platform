/**
 * The device side of the offline queue (D88): walk-ins kept in IndexedDB,
 * each sealed with AES-GCM under the CHO's key.
 *
 * Only what the queue needs to work stays readable: an id, whose entry it is,
 * when it was saved and its sending state. Names, complaints and readings are
 * inside the ciphertext. The key is never written down here; it lives in
 * memory and comes from the API after sign-in.
 */

const DB_NAME = "neem-offline";
const STORE = "walk-ins";

export type EntryState = "QUEUED" | "NEEDS_DECISION" | "REFUSED";

export interface StoredEntry {
  id: string;
  userId: string;
  savedAt: string;
  state: EntryState;
  /** Why the API refused it, in its words. No patient detail. */
  refusal: string | null;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("userId", "userId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const entries = {
  all: () => run<StoredEntry[]>("readonly", (store) => store.getAll()),
  put: (entry: StoredEntry) => run("readwrite", (store) => store.put(entry)),
  remove: (id: string) => run("readwrite", (store) => store.delete(id)),
};

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

/** Imports the API's key so it can be used but never read back out. */
export function importKey(base64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(
  key: CryptoKey,
  value: unknown,
): Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv: iv.buffer, ciphertext };
}

export async function unseal<T>(key: CryptoKey, entry: StoredEntry): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(entry.iv) },
    key,
    entry.ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
