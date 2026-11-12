/**
 * Polite screen-reader announcements (VoiceOver, TalkBack) from anywhere in the app.
 *
 * One visually hidden live region in <body>, created up front: Safari only announces
 * changes to a live region that already existed, so a toast rendered with role="status"
 * on it is often silent. Shadow-DOM components use this too, since it sits outside them.
 *
 * Callers announce transitions (Claude started waiting, a toast appeared), never poll
 * results; the same text twice in a row within a few seconds is said once.
 */
const REPEAT_WINDOW_MS = 4000;

let region: HTMLElement | null = null;
let lastText = '';
let lastAt = 0;
let pending: ReturnType<typeof setTimeout> | null = null;

function liveRegion(): HTMLElement {
  if (region?.isConnected) return region;
  region = document.createElement('div');
  region.dataset.testid = 'a11y-live-region';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  region.style.cssText =
    'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';
  document.body.appendChild(region);
  return region;
}

/** Leading emoji (⏳, ✅) are decoration; VoiceOver would read them as words. */
function clean(text: string): string {
  return text.replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\s)+/u, '').trim();
}

export function announce(text: string): void {
  const message = clean(text);
  if (!message) return;
  const now = Date.now();
  if (message === lastText && now - lastAt < REPEAT_WINDOW_MS) return;
  lastText = message;
  lastAt = now;
  const target = liveRegion();
  // Empty first, then fill: a region set to its current text again is not re-announced.
  target.textContent = '';
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    target.textContent = message;
  }, 50);
}

/** Create the region early (app start) so the first announcement is not lost. */
export function ensureLiveRegion(): void {
  liveRegion();
}

/** Tests only. */
export function resetAnnouncerForTests(): void {
  region?.remove();
  region = null;
  lastText = '';
  lastAt = 0;
  if (pending) clearTimeout(pending);
  pending = null;
}
