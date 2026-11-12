/**
 * This page's id, sent with its resizes and VIEWING frames: the server keeps one owner of each
 * session's size by it (server/pty/size-owner.ts). Kept in sessionStorage, so a reload of the
 * page (or iOS bringing a home-screen app back) is still the same owner; a new tab is another.
 */

const STORAGE_KEY = 'untether.clientId';

let cached: string | null = null;

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getClientId(): string {
  if (cached) return cached;
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
  } catch {
    // Storage blocked: an id for this page's lifetime.
  }
  cached = randomId();
  try {
    sessionStorage.setItem(STORAGE_KEY, cached);
  } catch {
    // ignore
  }
  return cached;
}

/** Forget the id (tests). */
export function resetClientIdForTests(): void {
  cached = null;
}
