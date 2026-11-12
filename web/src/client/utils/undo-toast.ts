/**
 * «Movida a bakery · Deshacer» (2026-11-07): after a change the user made by a gesture that
 * is easy to make by mistake (a row or a group's header dropped in the session list), a short
 * toast offers to put things back. Cmd+Z (Ctrl+Z) does the same while it shows, unless the
 * keys go to a text field or the terminal (they keep their own undo).
 *
 * 2026-11-07, first use of the list drag: «Insights…» dropped on "Otras" on purpose, and 6 s
 * later the orchestrator «Bakery» landed there too without the user wanting it; it had to be
 * put back by hand with POST /api/sessions/:id/group-pin.
 */
import { toast } from './action-toast.js';

/** How long the toast offers the undo. */
export const UNDO_TOAST_MS = 8_000;
const KEY = 'ut-undo';

let current: { run: () => void } | null = null;

/** Keys typed into a field or the terminal are theirs, never an undo of the list. */
function typingTarget(e: KeyboardEvent): boolean {
  const origin = e.composedPath()[0];
  if (!(origin instanceof Element)) return false;
  return !!origin.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
  );
}

function onKey(e: KeyboardEvent) {
  if (!current || e.defaultPrevented || e.altKey || e.shiftKey) return;
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || typingTarget(e)) return;
  e.preventDefault();
  e.stopPropagation();
  current.run();
}

/**
 * Show `text` with «Deshacer» (`label`) for UNDO_TOAST_MS; the button or Cmd+Z run `undo` once.
 * A newer offer replaces this one (only the last change can be undone). Returns its dismiss.
 */
export function offerUndo(text: string, label: string, undo: () => void): () => void {
  let done = false;
  const entry = {
    run: () => {
      if (done) return;
      done = true;
      dismiss();
      undo();
    },
  };
  let dismiss = () => {};
  const leave = () => {
    if (current !== entry) return;
    current = null;
    window.removeEventListener('keydown', onKey, true);
  };
  dismiss = toast({
    kind: 'success',
    text,
    key: KEY,
    timeoutMs: UNDO_TOAST_MS,
    action: { label, run: entry.run },
    onDismiss: leave,
  });
  // After toast(): replacing the previous offer dismissed it (and its listener) first.
  current = entry;
  window.addEventListener('keydown', onKey, true);
  return dismiss;
}
