/**
 * The app's confirmation dialog, instead of window.confirm (design spec 3.3, 2026-10-12):
 * styled, translated, keyboard-first. ↵ confirms; Esc or a backdrop click cancels. Danger
 * confirmations start on Cancel and ↵ only presses the focused button, so a stray ↵ never
 * kills anything.
 *
 * On a phone (isPhoneScreen) it is an action sheet instead (phone-spec §3.2/§4.4,
 * 2026-10-12): title, body and details over a full-width 56 px confirm in one group, Cancel
 * as a separate group; a backdrop tap or a swipe down cancels; the sheet itself takes focus.
 *
 *   if (await confirmDialog({
 *     title: t('sessions.kill.confirmTitle', { name }),
 *     body: t('sessions.kill.confirmBody'),
 *     confirmLabel: t('sessions.killAll'),
 *     tone: 'danger',
 *   })) kill();
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { icon } from '../components/icons.js';
import { t } from '../i18n/index.js';
import { attachSheetDrag, isPhoneScreen } from './mobile-utils.js';
import { prefersReducedMotion } from './reduced-motion.js';
import { holdSheetFocus } from './sheet-a11y.js';
import '../components/modal-wrapper.js';

export interface ConfirmDialogOptions {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  /** Items affected (session names…): up to 6 listed, then "and N more". */
  details?: string[];
}

const MAX_DETAILS = 6;

@customElement('ut-confirm-dialog')
export class UtConfirmDialog extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) options: ConfirmDialogOptions = {
    title: '',
    confirmLabel: '',
  };
  @state() private open = true;
  /** Phone action sheet: slid in after the first frame so it animates up. */
  @state() private sheetShown = false;
  /** Set by confirmDialog(); called once with the answer. */
  resolve: (answer: boolean) => void = () => {};

  /** Decided once, when it opens: a rotation mid-question does not swap the layout. */
  private readonly asSheet = isPhoneScreen();
  private answered = false;
  private releaseFocus: (() => void) | null = null;
  private detachDrag: (() => void) | null = null;

  private answer(value: boolean) {
    if (this.answered) return;
    this.answered = true;
    this.open = false;
    this.resolve(value);
    if (this.asSheet) {
      this.sheetShown = false;
      this.detachDrag?.();
      this.releaseFocus?.();
      // After the slide-down (220 ms), unless motion is reduced.
      setTimeout(() => this.remove(), prefersReducedMotion() ? 0 : 220);
      return;
    }
    // Let modal-wrapper give focus back before leaving.
    requestAnimationFrame(() => this.remove());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.detachDrag?.();
    this.releaseFocus?.();
  }

  protected firstUpdated() {
    if (!this.asSheet) return;
    const sheet = this.querySelector<HTMLElement>('.ut-confirm-sheet');
    if (!sheet) return;
    const opener = document.activeElement;
    requestAnimationFrame(() => {
      if (this.answered) return;
      this.sheetShown = true;
      this.releaseFocus = holdSheetFocus(sheet, () => this.answer(false), opener);
    });
    this.detachDrag = attachSheetDrag(sheet, { onDismiss: () => this.answer(false) });
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    // ↵ on the Cancel button cancels (its own click); anywhere else confirms.
    if ((e.target as HTMLElement | null)?.closest('[data-confirm-cancel]')) return;
    // A danger action never goes on a stray ↵ (the phone sheet itself holds the focus): only
    // a ↵ on its own button, which clicks it natively.
    if (this.options.tone === 'danger') return;
    e.preventDefault();
    this.answer(true);
  };

  private renderDetails(shown: string[], more: number) {
    if (!shown.length) return nothing;
    return html`<ul class="ut-confirm-details">
      ${shown.map((item) => html`<li>${item}</li>`)}
      ${more > 0 ? html`<li class="more">${t('confirm.more', { n: more })}</li>` : nothing}
    </ul>`;
  }

  /** Phone: an action sheet (title/body/details + confirm | Cancel). */
  private renderSheet(shown: string[], more: number) {
    const { title, body, confirmLabel, cancelLabel, tone = 'default' } = this.options;
    const danger = tone === 'danger';
    return html`
      <div
        class="psr-sheet-backdrop"
        data-testid="modal-backdrop"
        @click=${() => this.answer(false)}
      ></div>
      <div
        class="psr-sheet ut-confirm-sheet ${this.sheetShown ? 'open' : ''}"
        role="dialog"
        aria-modal="true"
        aria-label=${title}
        tabindex="-1"
        data-testid="confirm-dialog"
        @keydown=${this.onKeyDown}
      >
        <div class="psr-sheet-group ut-surface--floating ut-surface--material">
          <div class="ut-grabber" data-sheet-handle aria-hidden="true"></div>
          <div class="ut-confirm-head" data-sheet-handle>
            <p class="ut-confirm-title">${title}</p>
            ${body ? html`<p class="ut-confirm-body">${body}</p>` : nothing}
            ${this.renderDetails(shown, more)}
          </div>
          <button
            type="button"
            class="ut-confirm-ok ${danger ? 'destructive' : ''}"
            data-confirm-ok
            @click=${() => this.answer(true)}
          >
            ${confirmLabel}
          </button>
        </div>
        <button
          type="button"
          class="psr-sheet-cancel ut-surface--floating ut-surface--material"
          data-confirm-cancel
          @click=${() => this.answer(false)}
        >
          ${cancelLabel ?? t('common.cancel')}
        </button>
      </div>
    `;
  }

  render() {
    const { title, body, confirmLabel, cancelLabel, tone = 'default', details } = this.options;
    const danger = tone === 'danger';
    const shown = details?.slice(0, MAX_DETAILS) ?? [];
    const more = (details?.length ?? 0) - shown.length;
    if (this.asSheet) return this.renderSheet(shown, more);
    return html`
      <modal-wrapper
        .visible=${this.open}
        .ariaLabel=${title}
        contentClass="ut-dialog ut-dialog--sm"
        initialFocus=${danger ? '[data-confirm-cancel]' : '[data-confirm-ok]'}
        @close=${() => this.answer(false)}
      >
        <div @keydown=${this.onKeyDown} data-testid="confirm-dialog">
          <div class="ut-dialog-header">
            <span class="flex items-center gap-2 min-w-0">
              ${
                danger
                  ? html`<span class="flex-none text-status-error">${icon('alert')}</span>`
                  : nothing
              }
              <span class="truncate">${title}</span>
            </span>
          </div>
          ${
            body || shown.length
              ? html`<div class="ut-dialog-body pt-0 text-text-muted">
                  ${body ? html`<p class="m-0">${body}</p>` : nothing}
                  ${
                    shown.length
                      ? html`<ul class="m-0 mt-3 p-0 list-none flex flex-col gap-1">
                          ${shown.map(
                            (item) => html`<li class="truncate text-text font-medium">${item}</li>`
                          )}
                          ${
                            more > 0
                              ? html`<li class="text-text-dim">${t('confirm.more', { n: more })}</li>`
                              : nothing
                          }
                        </ul>`
                      : nothing
                  }
                </div>`
              : nothing
          }
          <div class="ut-dialog-footer">
            <button
              type="button"
              class="ut-btn ut-btn--ghost"
              data-confirm-cancel
              @click=${() => this.answer(false)}
            >
              ${cancelLabel ?? t('common.cancel')}
            </button>
            <button
              type="button"
              class="ut-btn ${danger ? 'ut-btn--danger' : 'ut-btn--primary'}"
              data-confirm-ok
              @click=${() => this.answer(true)}
            >
              ${confirmLabel}
            </button>
          </div>
        </div>
      </modal-wrapper>
    `;
  }
}

/** Asks, resolves true (confirmed) or false (cancelled, Esc, backdrop). */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement('ut-confirm-dialog') as UtConfirmDialog;
    dialog.options = { ...options, title: options.title || t('confirm.defaultTitle') };
    dialog.resolve = resolve;
    document.body.appendChild(dialog);
  });
}

declare global {
  interface HTMLElementTagNameMap {
    'ut-confirm-dialog': UtConfirmDialog;
  }
}
