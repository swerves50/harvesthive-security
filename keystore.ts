import { activeConfig } from '@/config/community';

// ─── Device-bound key encryption ───────────────────────────────────────────
//
// Replaces the old storePrivateKeyUnencrypted()/retrievePrivateKeyUnencrypted()
// pair. The nsec is encrypted at rest with a non-extractable AES-GCM key —
// a CryptoKey generated with extractable: false, which the Web Crypto API
// can still use for encrypt/decrypt, but which can never be exported as raw
// bytes, not even by our own code. The key and the ciphertext both live in
// IndexedDB (structured clone supports non-extractable CryptoKey objects
// directly — this has been solid for symmetric AES keys across all major
// browsers for years; it's only ever been flaky for asymmetric EC keys,
// which isn't what we're using here).
//
// No password, no prompt — applied automatically on every load, same as the
// old unencrypted path from the user's point of view.
//
// What this protects against: storage-at-rest theft that isn't happening
// through live page JS — a malicious browser extension scanning
// localStorage, session-replay/telemetry tools that capture storage dumps,
// disk/backup access, a stolen/synced browser profile.
//
// What this does NOT protect against: an in-page XSS vulnerability, which
// runs as the page and can call the same decrypt the app itself uses. No
// purely browser-side approach solves that. See Outstanding Issues in the
// Master Doc for the full writeup of this tradeoff.

const DB_NAME    = `${activeConfig.communityTag}-keystore`;
const DB_VERSION = 1;
const STORE_NAME = 'identity';
const RECORD_KEY = 'privkey';

// Unencrypted fallback — only used when IndexedDB itself is unavailable
// (confirmed: Firefox private browsing windows; possible: very old browsers,
// storage disabled in settings). Deliberately a different storage key than
// the old unencrypted path so a stale unencrypted copy from a previous
// HarvestHive version is never silently picked up and trusted as-is.
const FALLBACK_STORAGE_KEY = `${activeConfig.communityTag}:fallback_privkey`;

interface StoredRecord {
  cryptoKey:  CryptoKey;
  iv:         Uint8Array;
  ciphertext: Uint8Array;
}

let availabilityChecked = false;
let availabilityResult  = false;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

/**
 * Probes whether IndexedDB is actually usable in this browsing context —
 * not just whether the API exists. Firefox throws on indexedDB.open() in
 * private browsing windows rather than degrading gracefully, so a plain
 * `typeof indexedDB !== 'undefined'` check isn't enough. Result is cached
 * for the life of the page — this shouldn't change mid-session.
 */
export async function isDeviceBoundStorageAvailable(): Promise<boolean> {
  if (availabilityChecked) return availabilityResult;
  availabilityChecked = true;

  if (typeof indexedDB === 'undefined') {
    availabilityResult = false;
    return false;
  }

  try {
    const db = await openDb();
    db.close();
    availabilityResult = true;
    return true;
  } catch {
    availabilityResult = false;
    return false;
  }
}

/**
 * True if the key currently in storage was stored via the unencrypted
 * fallback rather than device-bound encryption. Callers (Settings, onboarding
 * flows) can use this to show an honest warning rather than silently
 * downgrading protection with no visible indication.
 */
export async function isUsingFallbackStorage(): Promise<boolean> {
  return !(await isDeviceBoundStorageAvailable());
}

/**
 * Stores privkey, encrypted at rest with a fresh non-extractable AES-GCM
 * key. A new wrapping key is generated on every call — this only ever runs
 * once per identity per device (onboarding, import, or recovery), so there's
 * no continuity to preserve, and a fresh key avoids any IV-reuse concerns
 * entirely.
 *
 * Returns true if device-bound encryption was used, false if it fell back
 * to unencrypted storage (IndexedDB unavailable in this browsing context).
 */
export async function storePrivateKeyDeviceBound(
  privkey: Uint8Array
): Promise<boolean> {
  const available = await isDeviceBoundStorageAvailable();
  if (!available) {
    storeFallback(privkey);
    return false;
  }

  // Best-effort request to reduce (not eliminate) Safari's 7-day
  // Intelligent Tracking Prevention storage eviction. Only requested here,
  // at the moment there's actually something worth persisting — not on
  // every app boot, which would prompt anonymous visitors for no reason.
  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }

  const db = await openDb();
  try {
    const cryptoKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable
      ['encrypt', 'decrypt']
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      privkey.buffer as ArrayBuffer
    );

    const record: StoredRecord = {
      cryptoKey,
      iv,
      ciphertext: new Uint8Array(encrypted),
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });

    // Clear any stale fallback copy from a previous session where
    // IndexedDB was unavailable — avoid two divergent copies existing.
    clearFallback();
    return true;
  } finally {
    db.close();
  }
}

/**
 * Retrieves and decrypts the stored privkey. Falls back to the unencrypted
 * store if IndexedDB is unavailable, or if IndexedDB is available but empty
 * (covers the case where a key was previously stored via fallback in a
 * browsing context where IndexedDB later becomes available).
 */
export async function retrievePrivateKeyDeviceBound(): Promise<Uint8Array | null> {
  const available = await isDeviceBoundStorageAvailable();
  if (!available) {
    return retrieveFallback();
  }

  const db = await openDb();
  try {
    const record = await new Promise<StoredRecord | undefined>((resolve, reject) => {
      const tx  = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });

    if (!record) return retrieveFallback();

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv as unknown as BufferSource },
      record.cryptoKey,
      record.ciphertext as unknown as BufferSource
    );
    return new Uint8Array(decrypted);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function hasStoredKey(): Promise<boolean> {
  const available = await isDeviceBoundStorageAvailable();
  if (available) {
    const db = await openDb();
    try {
      const count = await new Promise<number>((resolve, reject) => {
        const tx  = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
      if (count > 0) return true;
    } finally {
      db.close();
    }
  }
  return hasFallback();
}

export async function clearStoredKey(): Promise<void> {
  const available = await isDeviceBoundStorageAvailable();
  if (available) {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror    = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
  clearFallback();
}

// ─── Unencrypted fallback (IndexedDB unavailable only) ─────────────────────

function storeFallback(privkey: Uint8Array): void {
  localStorage.setItem(
    FALLBACK_STORAGE_KEY,
    JSON.stringify({ unencrypted: Array.from(privkey) })
  );
}

function retrieveFallback(): Uint8Array | null {
  const stored = localStorage.getItem(FALLBACK_STORAGE_KEY);
  if (!stored) return null;
  try {
    const { unencrypted } = JSON.parse(stored);
    if (!unencrypted) return null;
    return new Uint8Array(unencrypted);
  } catch {
    return null;
  }
}

function hasFallback(): boolean {
  return localStorage.getItem(FALLBACK_STORAGE_KEY) !== null;
}

function clearFallback(): void {
  localStorage.removeItem(FALLBACK_STORAGE_KEY);
}
