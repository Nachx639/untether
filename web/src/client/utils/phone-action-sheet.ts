/**
 * The phone action sheet (phone-spec 3.2): one bottom sheet for every phone menu and confirm
 * in the list area (row ⋯, header ⋯, Apariencia), extracted from phone-session-row.ts
 * (2026-10-12). Rendered into <body>: the phone sidebar slides with a transform, which would
 * turn position:fixed into "fixed to the sidebar".
 *
 *   const sheet = new PhoneActionSheet({ label: 'qa · build' });
 *   sheet.open((s) => html`<div class="psr-sheet-group ut-surface--floating ut-surface--material">${actionItems(s, items)}</div>`);
 *
 * - A 36x5 grabber (.ut-grabber); dragging the sheet down past 30% of its height (or a fast
 *   flick) closes it, a short drag springs back (attachSheetDrag, utils/mobile-utils.ts).
 * - Backdrop tap, Escape and the separate Cancel group close it; focus is held inside and
 *   handed back to the opener (utils/sheet-a11y.ts).
 * - Touch acts on pointerup (iOS can take the first tap on a fresh button as a hover) and the
 *   click that follows is swallowed; the click finishing the tap that opened the sheet
 *   (< 500 ms) is ignored, near the bottom of the screen it lands on the sheet's own buttons.
 */
import { html, nothing, render, type TemplateResult } from 'lit';
import { type IconName, icon } from '../components/icons.js';
import { t } from '../i18n/index.js';
import { swallowNextClick } from './ghost-click.js';
import { attachSheetDrag } from './mobile-utils.js';
import { endsADrag } from './pointer-drag.js';
import { focusSheet, holdSheetFocus } from './sheet-a11y.js';

/** Clicks this soon after the sheet opened (or changed step) are the tap that did it. */
export const SHEET_GUARD_MS = 500;

export interface ActionSheetItem {
  label: string | TemplateResult;
  icon?: IconName;
  destructive?: boolean;
  /** Selected choice (Apariencia): a check at the end, aria-checked. */
  checked?: boolean;
  testId?: string;
  /** Text under the label (a quick start that is not installed). */
  note?: string;
  disabled?: boolean;
  /** Extra classes ("folder": a path, one line in mono). */
  className?: string;
  /** Steps inside the sheet (to a confirm question) keep it open. */
  keepOpen?: boolean;
  run: () => void;
}

export interface PhoneActionSheetOptions {
  /** The sheet's accessible name (its title, or what it acts on). */
  label: string;
  role?: 'dialog' | 'alertdialog';
  testId?: string;
  /** Where focus goes back on close; defaults to the focused element at open. */
  opener?: Element | null;
  onClose?: () => void;
  /** Cancel's label; null for no Cancel group. */
  cancelLabel?: string | null;
}

type Content = (sheet: PhoneActionSheet) => TemplateResult | typeof nothing;

export class PhoneActionSheet {
  private host: HTMLElement | null = null;
  private content: Content | null = null;
  private release: (() => void) | null = null;
  private openedAt = 0;
  private actedAt = 0;
  private detachDrag: (() => void) | null = null;

  constructor(private options: PhoneActionSheetOptions) {}

  get isOpen(): boolean {
    return this.host !== null;
  }

  /** The sheet element (tests, focus). */
  get element(): HTMLElement | null {
    return this.host?.querySelector<HTMLElement>('.psr-sheet') ?? null;
  }

  setOptions(options: Partial<PhoneActionSheetOptions>) {
    this.options = { ...this.options, ...options };
  }

  open(content: Content) {
    if (this.host) {
      this.content = content;
      this.draw();
      return;
    }
    const opener = this.options.opener ?? document.activeElement;
    this.openedAt = Date.now();
    this.content = content;
    this.host = document.createElement('div');
    this.host.className = 'ut-phone-sheet-host';
    document.body.appendChild(this.host);
    this.draw();
    const element = this.element;
    if (element) {
      // Swipe down to dismiss (sheets' shared drag, utils/mobile-utils.ts).
      this.detachDrag = attachSheetDrag(element, {
        onDismiss: this.close,
        scroller: element.querySelector<HTMLElement>('.vtm-sheet-list, .psr-sheet-scroll'),
      });
    }
    this.release = holdSheetFocus(element, this.close, opener);
    requestAnimationFrame(() => this.element?.classList.add('open'));
  }

  /** Draw again (state shown in the sheet changed), or switch to new content. */
  update(content?: Content) {
    if (!this.host) return;
    if (content) this.content = content;
    this.draw();
  }

  /**
   * A step inside the sheet replaced the buttons (to a confirm question): a double tap must
   * not confirm, and a screen reader starts again at the question.
   */
  step(content: Content) {
    if (!this.host) return;
    this.openedAt = Date.now();
    this.content = content;
    this.draw();
    focusSheet(this.element);
  }

  close = () => {
    if (!this.host) return;
    const host = this.host;
    this.host = null;
    this.content = null;
    this.detachDrag?.();
    this.detachDrag = null;
    render(nothing, host);
    host.remove();
    this.release?.();
    this.release = null;
    this.options.onClose?.();
  };

  /** The click that finishes the tap opening the sheet can land on the new backdrop. */
  private onBackdrop = () => {
    if (Date.now() - this.openedAt > 400) this.close();
  };

  /**
   * Event handler for a sheet button: pointerup for touch, click for mouse and keyboard.
   * Closes the sheet first unless `keepOpen`.
   */
  tap(fn: () => void, keepOpen = false): EventListenerObject {
    return {
      handleEvent: (e: Event) => {
        if (Date.now() - this.openedAt < SHEET_GUARD_MS) return;
        if (e.type === 'pointerup') {
          if ((e as PointerEvent).pointerType === 'mouse') return;
          // A scroll (or a drag of the sheet) that started on the button ends here too.
          if (endsADrag(e as PointerEvent)) return;
          this.actedAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.actedAt < 700) {
          return;
        }
        if (!keepOpen) this.close();
        fn();
      },
    };
  }

  private draw() {
    const host = this.host;
    if (!host || !this.content) return;
    const { label, role = 'dialog', testId, cancelLabel } = this.options;
    const isOpen = this.element?.classList.contains('open') ?? false;
    render(
      html`
        <div class="psr-sheet-backdrop" @click=${this.onBackdrop}></div>
        <div
          class="psr-sheet ${isOpen ? 'open' : ''}"
          role=${role}
          aria-modal="true"
          aria-label=${label}
          data-testid=${testId ?? nothing}
        >
          <div class="ut-grabber psr-sheet-grabber" data-sheet-handle aria-hidden="true"></div>
          ${this.content(this)}
          ${
            cancelLabel === null
              ? nothing
              : html`<button class="psr-sheet-cancel ut-surface--material ut-surface--action ut-surface--floating" data-testid="psr-sheet-cancel" @click=${this.close}>
                  ${cancelLabel ?? t('common.cancel')}
                </button>`
          }
        </div>
      `,
      host
    );
  }
}

/** The buttons of one sheet group: icon 20 + label, destructive in red, a check when chosen. */
export function actionItems(sheet: PhoneActionSheet, items: ActionSheetItem[]): TemplateResult {
  return html`${items.map((item) => {
    const handler = sheet.tap(item.run, item.keepOpen);
    return html`<button
      class="psr-sheet-item ${item.destructive ? 'destructive' : ''} ${item.note ? 'unavailable' : ''} ${item.className ?? ''}"
      data-testid=${item.testId ?? nothing}
      role=${item.checked === undefined ? nothing : 'menuitemradio'}
      aria-checked=${item.checked === undefined ? nothing : item.checked ? 'true' : 'false'}
      aria-disabled=${item.note ? 'true' : nothing}
      ?disabled=${item.disabled}
      @pointerup=${handler}
      @click=${handler}
    >
      ${item.icon ? html`<span class="psr-sheet-icon" aria-hidden="true">${icon(item.icon, 20)}</span>` : nothing}
      <span class="psr-sheet-label"
        ><bdi>${item.label}</bdi>${item.note ? html`<span class="psr-sheet-note">${item.note}</span>` : nothing}</span
      >
      ${item.checked ? html`<span class="psr-sheet-check" aria-hidden="true">${icon('check', 18)}</span>` : nothing}
    </button>`;
  })}`;
}

/**
 * A declarative sheet: an optional title, groups of items, Cancel. Returns the sheet so the
 * caller can close it (or tests can find it).
 */
export function openActionSheet(
  options: PhoneActionSheetOptions & {
    title?: string | TemplateResult;
    /** A question (confirm): the title reads larger. */
    question?: boolean;
    groups: ActionSheetItem[][];
  }
): PhoneActionSheet {
  const sheet = new PhoneActionSheet(options);
  sheet.open(
    (s) =>
      html`${options.groups
        .filter((group) => group.length)
        .map(
          (
            group,
            index
          ) => html`<div class="psr-sheet-group ut-surface--floating ut-surface--material">
          ${
            index === 0 && options.title
              ? html`<div class="psr-sheet-title ${options.question ? 'question' : ''}"><bdi>${options.title}</bdi></div>`
              : nothing
          }
          ${actionItems(s, group)}
        </div>`
        )}`
  );
  return sheet;
}
