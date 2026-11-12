/**
 * Menus and popovers that stay on screen (design spec 3, 2026-10-12): position: fixed from the
 * anchor's rect, so headers with overflow: hidden never clip them; flipped above the anchor
 * when there is too little room below; clamped 8 px inside the viewport.
 *
 *   positionPopover(button, menu, { placement: 'bottom-end' });
 *   const stop = menuKeyboard(menu, { onClose: () => this.close() });
 */

export type PopoverPlacement = 'bottom-start' | 'bottom-end';

export interface PopoverOptions {
  placement?: PopoverPlacement;
  /** Gap between anchor and popover, px. */
  offset?: number;
  /** Flip above when the room below is smaller than this (px) and above has more. */
  flipBelow?: number;
  /** Viewport margin, px. */
  margin?: number;
}

export interface PopoverPosition {
  top: number;
  left: number;
  /** Where it ended up: below or above the anchor. */
  side: 'bottom' | 'top';
  /** The height it may take without leaving the screen. */
  maxHeight: number;
}

export function computePopoverPosition(
  anchor: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  { placement = 'bottom-start', offset = 6, flipBelow = 320, margin = 8 }: PopoverOptions = {}
): PopoverPosition {
  const below = viewport.height - anchor.bottom - offset - margin;
  const above = anchor.top - offset - margin;
  const side: 'bottom' | 'top' =
    below < Math.min(flipBelow, size.height) && above > below ? 'top' : 'bottom';
  const maxHeight = Math.max(0, side === 'bottom' ? below : above);
  const height = Math.min(size.height, maxHeight);
  let top = side === 'bottom' ? anchor.bottom + offset : anchor.top - offset - height;
  let left = placement === 'bottom-end' ? anchor.right - size.width : anchor.left;
  left = Math.min(left, viewport.width - margin - size.width);
  left = Math.max(margin, left);
  top = Math.max(margin, Math.min(top, viewport.height - margin - height));
  return { top: Math.round(top), left: Math.round(left), side, maxHeight: Math.round(maxHeight) };
}

/** Places `popover` (position: fixed) next to `anchor`. Call again on resize/scroll. */
export function positionPopover(
  anchor: Element,
  popover: HTMLElement,
  options: PopoverOptions = {}
): PopoverPosition {
  popover.style.position = 'fixed';
  // Measure at the natural size first.
  popover.style.maxHeight = '';
  const rect = popover.getBoundingClientRect();
  const position = computePopoverPosition(
    anchor.getBoundingClientRect(),
    { width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight },
    options
  );
  popover.style.top = `${position.top}px`;
  popover.style.left = `${position.left}px`;
  if (rect.height > position.maxHeight) popover.style.maxHeight = `${position.maxHeight}px`;
  popover.dataset.side = position.side;
  return position;
}

const ITEM_SELECTOR =
  '[role="menuitem"]:not([disabled]):not([aria-disabled="true"]), [role="menuitemradio"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])';

export interface MenuKeyboardOptions {
  onClose?: () => void;
  /** Focus the first item right away (menus opened from the keyboard). */
  focusFirst?: boolean;
}

/**
 * Arrow-key navigation for a menu: ↑ ↓ (wrapping), Home, End move between its menuitems,
 * Enter / Space activate the focused one, Esc closes. Returns a function that detaches it.
 */
export function menuKeyboard(
  container: HTMLElement,
  options: MenuKeyboardOptions = {}
): () => void {
  const items = () => [...container.querySelectorAll<HTMLElement>(ITEM_SELECTOR)];
  const focusAt = (index: number) => {
    const list = items();
    if (!list.length) return;
    const target = list[(index + list.length) % list.length];
    for (const item of list) item.toggleAttribute('data-active', item === target);
    target.focus();
  };
  const current = () => items().indexOf(document.activeElement as HTMLElement);
  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        focusAt(current() + 1);
        break;
      case 'ArrowUp':
        focusAt(current() < 0 ? -1 : current() - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(-1);
        break;
      case 'Escape':
        options.onClose?.();
        break;
      case 'Enter':
      case ' ': {
        const item = items()[current()];
        if (!item) return;
        item.click();
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  container.addEventListener('keydown', onKeyDown);
  if (options.focusFirst) focusAt(0);
  return () => container.removeEventListener('keydown', onKeyDown);
}
