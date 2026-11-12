/**
 * Modal Wrapper Component
 *
 * The app's one dialog frame (design spec 3.2, 2026-10-12). Contract: put exactly ONE root
 * element inside <modal-wrapper>; that element is the dialog box.
 *
 *   <modal-wrapper .visible=${open} .ariaLabel=${t('x.title')} @close=${close}>
 *     <div>…header, body, footer…</div>
 *   </modal-wrapper>
 *
 * It used to render a backdrop + content box with a <slot>, but in light DOM a <slot> does
 * nothing: the caller's children landed beside the backdrop and the "dialog" was a 512×2 px
 * empty box (⌘K, tmux, clipboard… all broken). Now, while visible, the host itself is the
 * frame (.ut-modal-host: fixed, full screen, centers its content) and renders only the
 * backdrop; the caller's root gets the dialog role, label, test id and `contentClass` (default
 * `ut-dialog ut-dialog--md`) in place, without moving nodes (that would break the caller's
 * Lit markers). Hidden (display: none) when not visible.
 *
 * Focus: `initialFocus` (a selector) or the first [autofocus] / field / control that is not a
 * close button gets focus on open; Tab cycles inside the dialog; focus goes back to where it
 * was on close. `placement="top"` pins it at 18vh (the command palette).
 *
 * `placement="sheet"` (opt-in, phone-spec §3.2, 2026-10-12): on a phone (isPhoneScreen) the
 * dialog is a bottom content sheet with a grabber and swipe-down to close (fires `close`), and
 * on touch the sheet itself takes focus instead of a field, so the keyboard does not cover
 * the choices. On larger screens it stays the centred dialog.
 *
 * @fires close - backdrop click or Escape
 */
import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { attachSheetDrag, isPhoneScreen } from '../utils/mobile-utils.js';
import { softKeyboardTarget, watchSoftKeyboard } from '../utils/soft-keyboard.js';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const FIELD =
  'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea:not([disabled]), select:not([disabled])';

function isShown(el: HTMLElement): boolean {
  if (el.closest('[hidden]')) return false;
  const check = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
  return check ? check.call(el) : true;
}

/** Open modals, the last one on top. */
const openModals: ModalWrapper[] = [];

@customElement('modal-wrapper')
export class ModalWrapper extends LitElement {
  // Light DOM: the caller's content and Tailwind classes stay where they are.
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) visible = false;
  /** Same as `visible`, for callers that pass `.open`. */
  @property({ type: Boolean }) open = false;
  /** Extra classes on the backdrop. */
  @property({ type: String }) modalClass = '';
  /** Classes put on the caller's root element (the dialog box). */
  @property({ type: String }) contentClass = 'ut-dialog ut-dialog--md';
  @property({ type: String }) transitionName = '';
  @property({ type: String }) ariaLabel = 'Modal dialog';
  @property({ type: Boolean }) closeOnBackdrop = true;
  @property({ type: Boolean }) closeOnEscape = true;
  /** Selector of the element to focus on open (inside the dialog). */
  @property({ type: String }) initialFocus = '';
  /**
   * false: the caller keeps its own focus handling (initial focus, Tab cycle, focus return);
   * the wrapper is only the frame. The create form uses it: its folder picker opens on top
   * and must take Tab, and after "Create" focus goes to the new session, not the opener.
   */
  @property({ type: Boolean }) manageFocus = true;
  /**
   * 'top' pins the dialog near the top (command palette); 'sheet' makes it a bottom sheet on
   * phones (centred elsewhere); default centered.
   */
  @property({ type: String, reflect: true }) placement: 'center' | 'top' | 'sheet' = 'center';

  private dialogRoot: HTMLElement | null = null;
  private appliedClasses: string[] = [];
  private restoreFocusTo: HTMLElement | null = null;
  private listening = false;
  private readonly guarded = new WeakSet<HTMLElement>();
  private detachDrag: (() => void) | null = null;
  private dragRoot: HTMLElement | null = null;

  private get isOpen(): boolean {
    return this.visible || this.open;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopListening();
    this.stopSheetDrag();
    // Callers usually remove the wrapper instead of setting visible=false.
    if (this.restoreFocusTo) this.restoreFocus();
  }

  protected updated(changed: PropertyValues) {
    super.updated(changed);
    const open = this.isOpen;
    this.classList.toggle('ut-modal-host', open);
    this.toggleAttribute('hidden', !open);

    if (open) {
      this.decorateRoot();
      this.startListening();
      this.syncSheetDrag();
    } else {
      this.stopListening();
      this.stopSheetDrag();
    }

    const opened = (changed.has('visible') || changed.has('open')) && open;
    const wasOpen =
      (changed.has('visible') && changed.get('visible') === true) ||
      (changed.has('open') && changed.get('open') === true);
    if (opened && !wasOpen && this.manageFocus) {
      const active = document.activeElement;
      this.restoreFocusTo =
        active instanceof HTMLElement && active !== document.body && !this.contains(active)
          ? active
          : null;
      if (!this.hasAttribute('no-autofocus')) {
        requestAnimationFrame(() => this.focusInitial());
      }
    } else if (!open && wasOpen) {
      this.restoreFocus();
    }
  }

  /** The caller's single root element: the first element child that is not our backdrop. */
  private findRoot(): HTMLElement | null {
    for (const child of this.children) {
      if (child instanceof HTMLElement && !child.matches('[data-testid="modal-backdrop"]')) {
        return child;
      }
    }
    return null;
  }

  private decorateRoot() {
    const root = this.findRoot();
    if (root !== this.dialogRoot && this.dialogRoot) {
      this.dialogRoot.classList.remove(...this.appliedClasses);
      this.appliedClasses = [];
    }
    this.dialogRoot = root;
    if (!root) return;

    const wanted = ['min-w-0', ...this.contentClass.split(/\s+/).filter(Boolean)];
    if (wanted.includes('ut-dialog')) wanted.push('ut-surface--material');
    const stale = this.appliedClasses.filter((cls) => !wanted.includes(cls));
    if (stale.length) root.classList.remove(...stale);
    // Only track classes we added, not ones the caller already had.
    const added = wanted.filter((cls) => !root.classList.contains(cls));
    root.classList.add(...added);
    this.appliedClasses = [
      ...this.appliedClasses.filter((cls) => wanted.includes(cls)),
      ...added.filter((cls) => !this.appliedClasses.includes(cls)),
    ];

    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', this.ariaLabel);
    root.setAttribute('data-modal-content', '');
    // Callers with their own test id (the create form) keep it; the frame CSS uses the
    // data-modal-content attribute.
    if (!root.hasAttribute('data-testid')) root.setAttribute('data-testid', 'modal-content');
    root.style.setProperty('view-transition-name', this.transitionName || null);
    if (!this.guarded.has(root)) {
      // Clicks inside the dialog are not backdrop clicks.
      root.addEventListener('click', (e) => e.stopPropagation());
      this.guarded.add(root);
    }
  }

  /** Phone sheet: swipe down closes. Attached to the current root while open. */
  private syncSheetDrag() {
    const root = this.dialogRoot;
    const wanted = this.placement === 'sheet' && isPhoneScreen() ? root : null;
    if (wanted === this.dragRoot) return;
    this.stopSheetDrag();
    if (!wanted) return;
    this.dragRoot = wanted;
    const stopDrag = attachSheetDrag(wanted, {
      scroller: wanted.querySelector<HTMLElement>('[data-sheet-scroll]') ?? wanted,
      onDismiss: () => this.handleClose(),
    });
    const stopKeyboard = this.followKeyboard(wanted);
    this.detachDrag = () => {
      stopDrag();
      stopKeyboard();
    };
  }

  /**
   * iOS leaves fixed elements under the soft keyboard: while it is up the sheet sits on top
   * of it (host padding) and fits what is left, and the focused field scrolls into view.
   */
  private followKeyboard(root: HTMLElement): () => void {
    const vv = window.visualViewport;
    if (!vv) return () => {};
    const sync = () => {
      const covered = window.innerHeight - (vv.height + vv.offsetTop);
      if (covered > 80 && softKeyboardTarget()) {
        this.style.paddingBottom = `${Math.round(covered)}px`;
        root.style.maxHeight = `${Math.round(vv.height) - 8}px`;
        const active = document.activeElement;
        if (active instanceof HTMLElement && root.contains(active)) {
          requestAnimationFrame(() => active.scrollIntoView({ block: 'nearest' }));
        }
      } else {
        this.style.removeProperty('padding-bottom');
        root.style.removeProperty('max-height');
      }
    };
    // Browsers that shrink the layout viewport instead (Android, emulators): just reveal.
    const reveal = () => {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        root.contains(active) &&
        active.matches('input, textarea')
      ) {
        requestAnimationFrame(() => active.scrollIntoView({ block: 'nearest' }));
      }
    };
    vv.addEventListener('resize', sync);
    window.addEventListener('resize', reveal);
    const stopWatching = watchSoftKeyboard(sync);
    return () => {
      stopWatching();
      vv.removeEventListener('resize', sync);
      window.removeEventListener('resize', reveal);
      this.style.removeProperty('padding-bottom');
      root.style.removeProperty('max-height');
    };
  }

  private stopSheetDrag() {
    this.detachDrag?.();
    this.detachDrag = null;
    this.dragRoot = null;
  }

  /** A touch sheet opens without raising the keyboard: the sheet itself takes focus. */
  private get focusSheetRoot(): boolean {
    return (
      this.placement === 'sheet' &&
      (window.matchMedia?.('(pointer: coarse)').matches ?? false) &&
      !this.initialFocus
    );
  }

  private focusInitial() {
    const root = this.dialogRoot;
    if (!root || !this.isOpen) return;
    if (this.focusSheetRoot) {
      if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
      root.focus({ preventScroll: true });
      return;
    }
    const candidates = [
      this.initialFocus ? root.querySelector<HTMLElement>(this.initialFocus) : null,
      root.querySelector<HTMLElement>('[autofocus]'),
      [...root.querySelectorAll<HTMLElement>(FIELD)].find(isShown),
      this.focusables().find((el) => !this.isCloseButton(el)),
      this.focusables()[0],
    ];
    const target = candidates.find((el): el is HTMLElement => !!el);
    if (target) target.focus();
    else {
      if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
      root.focus();
    }
  }

  private isCloseButton(el: HTMLElement): boolean {
    return (
      el.matches('[data-modal-close], [data-testid$="close"], [id$="close-button"]') ||
      /close|cerrar|×|✕/i.test(el.getAttribute('aria-label') ?? '')
    );
  }

  private focusables(): HTMLElement[] {
    const root = this.dialogRoot;
    if (!root) return [];
    return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isShown);
  }

  private restoreFocus() {
    const target = this.restoreFocusTo;
    this.restoreFocusTo = null;
    if (target?.isConnected) {
      // After the caller's own close handling (which may move focus itself).
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) target.focus();
      });
    }
  }

  private startListening() {
    if (this.listening) return;
    document.addEventListener('keydown', this.handleKeyDown);
    this.listening = true;
    openModals.push(this);
  }

  private stopListening() {
    if (!this.listening) return;
    document.removeEventListener('keydown', this.handleKeyDown);
    this.listening = false;
    const at = openModals.indexOf(this);
    if (at >= 0) openModals.splice(at, 1);
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.isOpen) return;
    // Stacked dialogs (a picker over a form) all listen on document, the one below first:
    // only the top one acts, or one Escape closed both.
    if (openModals[openModals.length - 1] !== this) return;
    if (e.key === 'Escape' && this.closeOnEscape) {
      e.preventDefault();
      // Immediate: other document listeners (app shortcuts) must not act on it as well.
      e.stopImmediatePropagation();
      this.handleClose();
      return;
    }
    if (e.key === 'Tab' && this.manageFocus) this.trapTab(e);
  };

  private trapTab(e: KeyboardEvent) {
    const root = this.dialogRoot;
    if (!root) return;
    const items = this.focusables();
    if (!items.length) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!active || !root.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  private handleBackdropClick(e: Event) {
    if (this.closeOnBackdrop && e.target === e.currentTarget) {
      e.preventDefault();
      e.stopPropagation();
      this.handleClose();
    }
  }

  private handleClose() {
    this.dispatchEvent(new CustomEvent('close'));
  }

  render() {
    if (!this.isOpen) return nothing;
    return html`<div
      class="modal-backdrop ${this.modalClass}"
      style="position: absolute; inset: 0;"
      @click=${this.handleBackdropClick}
      data-testid="modal-backdrop"
    ></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'modal-wrapper': ModalWrapper;
  }
}
