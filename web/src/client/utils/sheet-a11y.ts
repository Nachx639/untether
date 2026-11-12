/**
 * Modal behavior for the phone action sheets rendered into <body> (row actions, new-chat
 * tool/folder pickers, session switcher): focus moves into the sheet when it opens, Tab
 * stays inside it, Escape closes it, and focus returns to whatever opened it.
 *
 * Opening a sheet while typing (the terminal's hidden input or any field has focus) leaves
 * focus alone: moving it would drop the on-screen keyboard.
 */
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isTyping(element: Element | null): boolean {
  return element instanceof HTMLElement && element.matches(EDITABLE);
}

/** Focus the sheet itself so a screen reader starts with its title (its aria-label). */
export function focusSheet(sheet: HTMLElement | null): void {
  if (!sheet || isTyping(document.activeElement)) return;
  if (!sheet.hasAttribute('tabindex')) sheet.setAttribute('tabindex', '-1');
  sheet.focus({ preventScroll: true });
}

/**
 * Call right after rendering an open sheet. Returns the release function to call when it
 * closes. `opener` defaults to the focused element; pass it when the sheet was opened by a
 * gesture (long press) that left focus elsewhere.
 */
export function holdSheetFocus(
  sheet: HTMLElement | null,
  onEscape: () => void,
  opener: Element | null = document.activeElement
): () => void {
  if (!sheet) return () => {};
  const typing = isTyping(document.activeElement);
  const returnTo = opener instanceof HTMLElement && opener !== document.body ? opener : null;
  focusSheet(sheet);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!sheet.isConnected) return;
    if (e.key === 'Escape') {
      // A field that handles Escape itself (the inline rename cancels): not the sheet's.
      if (e.target instanceof Element && e.target.closest('[data-own-escape]')) return;
      e.preventDefault();
      e.stopPropagation();
      onEscape();
      return;
    }
    if (e.key !== 'Tab' || typing) return;
    const items = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === sheet || !sheet.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !sheet.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    document.removeEventListener('keydown', onKeyDown, true);
    // Only hand focus back if it was in the sheet (or dropped to <body> when it closed):
    // never pull it away from something the user moved to meanwhile.
    const active = document.activeElement;
    const focusWasInSheet = !active || active === document.body || sheet.contains(active);
    if (!typing && returnTo?.isConnected && focusWasInSheet)
      returnTo.focus({ preventScroll: true });
  };
}
