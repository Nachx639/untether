/**
 * Giving a Mac-window session's PTY size back to its window when its view is left, a while
 * later.
 *
 * User reports (2026-10-14): swiping between sessions on a phone gave each session left its Mac
 * window's size at once and the phone took it back on returning, so the PTY changed width every
 * second; Claude Code repainted on each change and the part that no longer fit stayed in the
 * history as a second copy, broken at the other width. The give-back now waits a minute and
 * coming back to the session within it cancels it. The server decides whether it happens at
 * all: only for the page that owns the size, and not while another page shows the session
 * (server/pty/size-owner.ts). Locking the phone or backgrounding the app does not start this
 * timer (a locked phone runs none): the server gives the size back once the owning page has been
 * hidden or disconnected for SIZE_AWAY_GIVE_BACK_MS (pty-manager sweepSizeOwners, user report
 * 2026-10-14: the Mac window stayed at a locked phone's width). The page shown again then draws
 * the window's width scaled until it is used (a tap, a key), which takes the size again.
 */

/** How long after leaving a Mac-window session (fwd_) its size is given back to the window. */
export const FORWARDED_SIZE_GIVE_BACK_DELAY_MS = 60_000;

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Gives `sessionId`'s size back after `delay`, in place of one already waiting. */
export function scheduleSizeGiveBack(
  sessionId: string,
  giveBack: () => void,
  delay = FORWARDED_SIZE_GIVE_BACK_DELAY_MS
): void {
  cancelSizeGiveBack(sessionId);
  const timer = setTimeout(() => {
    pending.delete(sessionId);
    giveBack();
  }, delay);
  pending.set(sessionId, timer);
}

/** The session is on screen again: its size stays with this page. True if one was waiting. */
export function cancelSizeGiveBack(sessionId: string): boolean {
  const timer = pending.get(sessionId);
  if (timer === undefined) return false;
  clearTimeout(timer);
  pending.delete(sessionId);
  return true;
}

/** Sessions whose give-back is waiting (tests). */
export function pendingSizeGiveBacks(): string[] {
  return [...pending.keys()];
}

/** Forget everything (tests). */
export function resetSizeGiveBackForTests(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}
