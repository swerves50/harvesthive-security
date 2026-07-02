import { activeConfig } from '@/config/community';
const STORAGE_KEY = `${activeConfig.communityTag}:encrypted_privkey`;

export async function storePrivateKey(
  privkey: Uint8Array,
  password: string
): Promise<void> {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as unknown as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const encryptionKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310_000, hash: 'SHA-256' },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    encryptionKey,
    privkey.buffer as ArrayBuffer
  );
  const payload = {
    salt:      Array.from(salt),
    iv:        Array.from(iv),
    encrypted: Array.from(new Uint8Array(encrypted)),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export async function retrievePrivateKey(
  password: string
): Promise<Uint8Array | null> {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  try {
    const { salt, iv, encrypted } = JSON.parse(stored);
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password) as unknown as BufferSource,
      'PBKDF2',
      false,
      ['deriveKey']
    );
    const encryptionKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: new Uint8Array(salt),
        iterations: 310_000,
        hash: 'SHA-256',
      },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      encryptionKey,
      new Uint8Array(encrypted)
    );
    return new Uint8Array(decrypted);
  } catch {
    return null;
  }
}

export function storePrivateKeyUnencrypted(privkey: Uint8Array): void {
  const payload = { unencrypted: Array.from(privkey) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function retrievePrivateKeyUnencrypted(): Uint8Array | null {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  try {
    const { unencrypted } = JSON.parse(stored);
    if (!unencrypted) return null;
    return new Uint8Array(unencrypted);
  } catch {
    return null;
  }
}

export function hasStoredKey(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

export function clearStoredKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}
