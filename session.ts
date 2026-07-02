let sessionPrivkey: Uint8Array | null = null;

export function setSessionKey(privkey: Uint8Array): void {
  sessionPrivkey = privkey;
}

export function getSessionKey(): Uint8Array | null {
  return sessionPrivkey;
}

export function hasSessionKey(): boolean {
  return sessionPrivkey !== null;
}

export function clearSession(): void {
  if (sessionPrivkey) {
    sessionPrivkey.fill(0);
    sessionPrivkey = null;
  }
}

window.addEventListener('beforeunload', clearSession);
