/**
 * Dragging sessions between groups and group headers to reorder the groups, in the sidebar and
 * the desktop home (2026-11-07). The host marks what can move and where it can land:
 *
 *   data-drag-session="<id>"   a session's card (drop it on a group: anchor it there; on
 *                              another row: put it before or after that row, line between rows);
 *                              data-drag-axis="x" when the cards sit side by side
 *   data-drag-group="<key>"    a group's header (drop it between groups: reorder them)
 *   data-drag-label="…"        what the floating label says while it moves
 *   data-group-key="<key>"     a group's block ("" for "Otras"); data-group-axis="x" when the
 *                              groups sit side by side (before/after by the left/right half)
 *
 * Mouse and trackpad only (a touch scrolls, the phone rows keep their menu), the main button
 * without modifiers (a right click or ctrl-click opens the menu), and only past DRAG_SLOP_PX, so
 * a click still opens the session and a click after a drag is swallowed. A press anywhere on a
 * row, card or header drags it, its title too (2026-11-07, user report: the drag did not always
 * start, text got selected instead): list.css makes everything carrying these
 * attributes unselectable, and a native drag (an image, a link) never starts from it. Escape
 * cancels, and the rest of that press moves nothing. A move without the button down (its
 * release was lost: outside the window, a dialog) ends the press without dropping anything. The
 * drop target is the element under the pointer (the label has pointer-events: none), so a
 * wheel or the edge of a scrolling list (auto-scroll) moves the list meanwhile.
 */

import { Z_INDEX } from './constants.js';

/** How far the pointer moves before a press becomes a drag. */
export const DRAG_SLOP_PX = 6;
/** Near this many pixels from a scrolling list's top or bottom edge, the list scrolls. */
const EDGE_PX = 40;
const EDGE_STEP_PX = 12;

export type DragSource =
  | { kind: 'session'; id: string; el: HTMLElement }
  | { kind: 'group'; key: string; el: HTMLElement };

export interface DropTarget {
  /** The group's key, null for "Otras". */
  key: string | null;
  el: HTMLElement;
  /** A header dropped before or after this group, or a session before or after `row`. */
  place: 'before' | 'after';
  /** A session dropped on another session's row: it goes before or after it. */
  row?: { id: string; el: HTMLElement };
}

export interface ListDragOptions {
  /** False: presses are left alone (phone rows, groups off). */
  enabled: () => boolean;
  /** A drag began (the host may show extra drop zones). */
  start: (source: DragSource) => void;
  /** It was dropped on a group (not called on Escape or outside every group). */
  drop: (source: DragSource, target: DropTarget) => void;
  /** It ended, dropped or not. */
  end: () => void;
  /**
   * Whether a session can go before or after another row of group `key` (null: "Otras");
   * false: only its group counts (the sort menu orders the rows). Default: never.
   */
  rows?: (key: string | null) => boolean;
}

const TARGET_CLASSES = ['ut-drop-target', 'ut-drop-before', 'ut-drop-after'];
const ROW_CLASSES = ['ut-drop-row-before', 'ut-drop-row-after'];

export class ListDragController {
  private pending: { x: number; y: number; pointerId: number; source: DragSource } | null = null;
  private active = false;
  private target: DropTarget | null = null;
  private ghost: HTMLElement | null = null;
  private scroller: HTMLElement | null = null;
  private edgeFrame = 0;
  private lastY = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly options: ListDragOptions
  ) {}

  connect(): void {
    this.host.addEventListener('pointerdown', this.onDown);
  }

  disconnect(): void {
    this.host.removeEventListener('pointerdown', this.onDown);
    this.finish(false);
  }

  /** A drag is under way (past the slop). */
  get dragging(): boolean {
    return this.active;
  }

  private onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    // A press still pending had its release lost: a new press means the button went up.
    if (this.pending) this.finish(false);
    if (!this.options.enabled()) return;
    const origin = e.target instanceof Element ? e.target : null;
    if (!origin || origin.closest('input, textarea, select, [contenteditable]')) return;
    const el = origin.closest<HTMLElement>('[data-drag-session], [data-drag-group]');
    if (!el || !this.host.contains(el)) return;
    const session = el.getAttribute('data-drag-session');
    const group = el.getAttribute('data-drag-group');
    const source: DragSource | null = session
      ? { kind: 'session', id: session, el }
      : group
        ? { kind: 'group', key: group, el }
        : null;
    if (!source) return;
    this.pending = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, source };
    document.addEventListener('pointermove', this.onMove, true);
    document.addEventListener('pointerup', this.onUp, true);
    document.addEventListener('pointercancel', this.onCancel, true);
    // An image or a link inside the row must not start the browser's own drag instead.
    document.addEventListener('dragstart', preventDefault, true);
  };

  private onMove = (e: PointerEvent) => {
    const pending = this.pending;
    if (!pending || e.pointerId !== pending.pointerId) return;
    // The button is up but no release came (2026-11-07: let go outside the window, over a
    // dialog): hovering must not drag the old press around, nor the next click drop it.
    if (!(e.buttons & 1)) {
      this.finish(false);
      return;
    }
    // After Escape the button is still down: moving on must not start the drag again.
    if (this.cancelled) return;
    if (!this.active) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) <= DRAG_SLOP_PX) return;
      this.begin(pending.source);
    }
    e.preventDefault();
    this.lastY = e.clientY;
    if (this.ghost) {
      this.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
    }
    this.setTarget(this.targetAt(e, pending.source));
    this.edgeScroll();
  };

  private onUp = (e: PointerEvent) => {
    if (!this.pending || e.pointerId !== this.pending.pointerId) return;
    const wasActive = this.active;
    if (wasActive) this.setTarget(this.targetAt(e, this.pending.source));
    this.finish(wasActive);
  };

  private onCancel = () => this.finish(false);

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !this.active) return;
    e.preventDefault();
    e.stopPropagation();
    // The button is still down: its release must not open what is under it.
    this.cancelled = true;
    this.cleanUp();
  };

  /** Escape was pressed: the release that follows is swallowed. */
  private cancelled = false;

  private begin(source: DragSource) {
    this.active = true;
    source.el.classList.add('ut-drag-source');
    document.body.classList.add('ut-list-dragging');
    window.getSelection?.()?.removeAllRanges();
    document.addEventListener('selectstart', preventDefault, true);
    window.addEventListener('keydown', this.onKey, true);
    this.scroller = scrollParent(source.el);
    const ghost = document.createElement('div');
    ghost.className = 'ut-drag-ghost';
    ghost.setAttribute('data-testid', 'list-drag-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.zIndex = String(Z_INDEX.LIST_DRAG_GHOST);
    ghost.textContent = source.el.getAttribute('data-drag-label') ?? '';
    document.body.appendChild(ghost);
    this.ghost = ghost;
    this.options.start(source);
  }

  /** The group under the pointer that `source` can land on. */
  private targetAt(e: PointerEvent, source: DragSource): DropTarget | null {
    const under = e.target instanceof Element ? e.target : null;
    const el = under?.closest<HTMLElement>('[data-group-key]');
    if (!el || !this.host.contains(el)) return null;
    const raw = el.getAttribute('data-group-key') ?? '';
    const key = raw === '' ? null : raw;
    if (source.kind === 'session') {
      const rowEl = under?.closest<HTMLElement>('[data-drag-session]');
      const id = rowEl?.getAttribute('data-drag-session');
      if (rowEl && id && id !== source.id && el.contains(rowEl) && this.options.rows?.(key)) {
        const rect = rowEl.getBoundingClientRect();
        const before =
          rowEl.getAttribute('data-drag-axis') === 'x'
            ? e.clientX < rect.left + rect.width / 2
            : e.clientY < rect.top + rect.height / 2;
        return { key, el, place: before ? 'before' : 'after', row: { id, el: rowEl } };
      }
      return { key, el, place: 'after' };
    }
    if (key === source.key) return null;
    // "Otras" stays last: a header dropped on it goes just above it.
    if (key === null) return { key, el, place: 'before' };
    const rect = el.getBoundingClientRect();
    const sideways = el.getAttribute('data-group-axis') === 'x';
    const before = sideways
      ? e.clientX < rect.left + rect.width / 2
      : e.clientY < rect.top + rect.height / 2;
    return { key, el, place: before ? 'before' : 'after' };
  }

  private setTarget(target: DropTarget | null) {
    const before = this.target;
    if (before) {
      before.el.classList.remove(...TARGET_CLASSES);
      before.row?.el.classList.remove(...ROW_CLASSES);
    }
    this.target = target;
    if (!target || !this.pending) return;
    const source = this.pending.source;
    if (source.kind === 'group') {
      target.el.classList.add(target.place === 'before' ? 'ut-drop-before' : 'ut-drop-after');
      return;
    }
    // The line between rows where it goes; the group lit only when it leaves its own.
    if (target.row) {
      target.row.el.classList.add(
        target.place === 'before' ? 'ut-drop-row-before' : 'ut-drop-row-after'
      );
    }
    if (!target.row || source.el.closest('[data-group-key]') !== target.el) {
      target.el.classList.add('ut-drop-target');
    }
  }

  /** Near a scrolling list's edge: keep scrolling while the pointer stays there. */
  private edgeScroll() {
    const scroller = this.scroller;
    if (!scroller || this.edgeFrame || typeof requestAnimationFrame === 'undefined') return;
    const step = () => {
      this.edgeFrame = 0;
      if (!this.active) return;
      const rect = scroller.getBoundingClientRect();
      const delta =
        this.lastY < rect.top + EDGE_PX
          ? -EDGE_STEP_PX
          : this.lastY > rect.bottom - EDGE_PX
            ? EDGE_STEP_PX
            : 0;
      if (!delta || rect.height <= EDGE_PX * 2) return;
      scroller.scrollTop += delta;
      this.edgeFrame = requestAnimationFrame(step);
    };
    this.edgeFrame = requestAnimationFrame(step);
  }

  private finish(drop: boolean) {
    const source = this.pending?.source;
    const target = this.target;
    const swallow = this.active || this.cancelled;
    this.cleanUp();
    document.removeEventListener('pointermove', this.onMove, true);
    document.removeEventListener('pointerup', this.onUp, true);
    document.removeEventListener('pointercancel', this.onCancel, true);
    document.removeEventListener('dragstart', preventDefault, true);
    this.pending = null;
    this.cancelled = false;
    if (swallow) swallowNextClick();
    if (drop && source && target) this.options.drop(source, target);
  }

  /** Back to how it was before the drag (the press itself may still be down). */
  private cleanUp() {
    if (!this.active) return;
    this.active = false;
    this.setTarget(null);
    this.pending?.source.el.classList.remove('ut-drag-source');
    document.body.classList.remove('ut-list-dragging');
    document.removeEventListener('selectstart', preventDefault, true);
    window.removeEventListener('keydown', this.onKey, true);
    if (this.edgeFrame && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.edgeFrame);
    }
    this.edgeFrame = 0;
    this.ghost?.remove();
    this.ghost = null;
    this.scroller = null;
    this.options.end();
  }
}

function preventDefault(e: Event) {
  e.preventDefault();
}

/** The click the browser sends after a drag's release opens nothing. */
function swallowNextClick() {
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('click', swallow, true);
  };
  window.addEventListener('click', swallow, true);
  setTimeout(() => window.removeEventListener('click', swallow, true), 0);
}

/** The nearest ancestor that scrolls vertically. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}
