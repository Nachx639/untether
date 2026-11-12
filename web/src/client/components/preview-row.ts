/**
 * One persistent dev-server preview as a list row (phone list, sidebar, mission control):
 * a preview glyph, its name (the one given, the page title or localhost:<port>), live/down,
 * a pin when pinned, and "de: <session>" — a link to that session while it still exists. The row
 * outlives its session (2026-10-03).
 *
 * Tap opens its full-screen view (/preview/<id>). The ⋯ sheet has Open, Pin/Unpin, Rename,
 * Go to the session and Delete; swiping left shows Pin/Unpin and Delete, like session rows.
 *
 * @fires ut-open-preview-view - on window, when tapped (detail: { id })
 * @fires navigate-to-session - "de: <session>" / Go to the session (detail: { sessionId })
 * @fires ut-previews-changed - on window, after pin, rename or delete
 */
import { html, LitElement, nothing, render } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { endsADrag } from '../utils/pointer-drag.js';
import {
  announcePreviewsChanged,
  deletePreview,
  type PreviewItem,
  previewLabel,
  updatePreview,
} from '../utils/preview-rows.js';
import { focusSheet, holdSheetFocus } from '../utils/sheet-a11y.js';
import { agentAvatar } from './agent-avatar.js';
import { icon } from './icons.js';
import { formatRowTime } from './phone-session-row.js';
import './rename-field.js';

const SWIPE_ACTION_PX = 84;
const SWIPE_SLOP_PX = 12;
/** Taps finishing the gesture that opened the sheet must not hit its buttons. */
const SHEET_GUARD_MS = 500;

let swipeOpenRow: PreviewRowElement | null = null;
function markSwipeOpen(row: PreviewRowElement) {
  swipeOpenRow = row;
}

@customElement('preview-row')
export class PreviewRowElement extends LitElement {
  createRenderRoot() {
    return this;
  }

  private locale = new LocaleController(this);

  @property({ attribute: false }) item!: PreviewItem;
  @property({ attribute: false }) authClient?: AuthClient;
  @property({ type: Boolean }) highlighted = false;
  /** Phone home (2026-10-12): a 56 px row with a 32 px tile, under the sessions. */
  @property({ type: Boolean }) compact = false;

  @state() private swipeX = 0;
  @state() private swiping = false;
  @state() private busy = false;
  private swipeStart: { x: number; y: number; base: number } | null = null;
  private swipeAxis: 'x' | 'y' | null = null;
  private touchActedAt = 0;
  private sheetHost: HTMLElement | null = null;
  private sheetOpenedAt = 0;
  /** The sheet's Rename row is a field (rename-field.ts). */
  private renaming = false;
  private releaseSheetFocus: (() => void) | null = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    if (swipeOpenRow === this) swipeOpenRow = null;
    // repeat() moves rows (disconnect + reconnect): only a row really gone closes its sheet.
    setTimeout(() => {
      if (!this.isConnected) this.closeSheet();
    }, 0);
  }

  closeSwipe() {
    this.swipeX = 0;
    if (swipeOpenRow === this) swipeOpenRow = null;
  }

  private authHeader(): Record<string, string> {
    return this.authClient?.getAuthHeader() ?? {};
  }

  // ---- gestures ---------------------------------------------------------------------------

  private onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    if (swipeOpenRow && swipeOpenRow !== this) swipeOpenRow.closeSwipe();
    this.swipeStart = { x: e.clientX, y: e.clientY, base: this.swipeX };
    this.swipeAxis = null;
  };

  private onMove = (e: PointerEvent) => {
    const start = this.swipeStart;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!this.swipeAxis) {
      if (Math.abs(dy) > SWIPE_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) this.swipeAxis = 'y';
      else if (Math.abs(dx) > SWIPE_SLOP_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
        this.swipeAxis = 'x';
        this.swiping = true;
      }
    }
    if (this.swipeAxis !== 'x') return;
    const width = SWIPE_ACTION_PX * 2;
    const raw = start.base + dx;
    this.swipeX = Math.min(0, raw < -width ? -width + (raw + width) / 3 : raw);
  };

  private onUp = (e: PointerEvent) => {
    const swiped = this.swipeAxis === 'x';
    const tapped = this.swipeStart !== null && this.swipeAxis === null;
    this.swipeStart = null;
    this.swipeAxis = null;
    this.swiping = false;
    if (swiped) {
      this.touchActedAt = Date.now();
      swallowNextClick();
      if (this.swipeX < -SWIPE_ACTION_PX) {
        this.swipeX = -SWIPE_ACTION_PX * 2;
        markSwipeOpen(this);
      } else {
        this.closeSwipe();
      }
      return;
    }
    // A touch tap acts on pointerup (iOS can take the first tap as a hover).
    if (tapped && e.type === 'pointerup' && e.pointerType !== 'mouse') {
      this.touchActedAt = Date.now();
      swallowNextClick();
      this.activate();
    }
  };

  private onClick = () => {
    if (Date.now() - this.touchActedAt < 700) return;
    this.activate();
  };

  private activate() {
    if (this.swipeX) {
      this.closeSwipe();
      return;
    }
    this.open();
  }

  /** Touch on pointerup (then the click is swallowed), mouse and keyboard on click. */
  private tapAction(fn: () => void, guardSheet = false) {
    return {
      handleEvent: (e: Event) => {
        e.stopPropagation();
        if (e.type === 'pointerdown') return;
        if (guardSheet && Date.now() - this.sheetOpenedAt < SHEET_GUARD_MS) return;
        if (e.type === 'pointerup') {
          if ((e as PointerEvent).pointerType === 'mouse') return;
          // A scroll that started on the button ends here too: not a tap.
          if (endsADrag(e as PointerEvent)) return;
          this.touchActedAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.touchActedAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  // ---- actions ----------------------------------------------------------------------------

  private open() {
    window.dispatchEvent(new CustomEvent('ut-open-preview-view', { detail: { id: this.item.id } }));
  }

  private goToSession() {
    if (!this.item.sessionId || !this.item.sessionAlive) return;
    this.dispatchEvent(
      new CustomEvent('navigate-to-session', {
        detail: { sessionId: this.item.sessionId },
        bubbles: true,
        composed: true,
      })
    );
  }

  async togglePin() {
    this.closeSwipe();
    const pinned = !this.item.pinned;
    const updated = await updatePreview(this.item.id, { pinned }, this.authHeader()).catch(
      () => null
    );
    if (updated) this.item = { ...this.item, pinned: updated.pinned };
    announcePreviewsChanged();
  }

  /**
   * Saves the name typed in the sheet's rename field (empty: back to the page title). Resolves
   * to the error the field shows, if the save failed.
   */
  async rename(name: string): Promise<string | undefined> {
    const updated = await updatePreview(
      this.item.id,
      { customName: name },
      this.authHeader()
    ).catch(() => null);
    if (!updated) return t('previewRows.renameFailed');
    this.item = { ...this.item, customName: updated.customName };
    announcePreviewsChanged();
    return undefined;
  }

  async remove() {
    if (this.busy) return;
    this.busy = true;
    this.closeSwipe();
    try {
      await deletePreview(this.item.id, this.authHeader());
      this.dispatchEvent(
        new CustomEvent('preview-deleted', {
          detail: { id: this.item.id },
          bubbles: true,
          composed: true,
        })
      );
      announcePreviewsChanged();
    } catch {
      this.busy = false;
    }
  }

  // ---- sheet ------------------------------------------------------------------------------

  /** Rendered into <body>: the phone sidebar slides with a transform (see phone-session-row). */
  openSheet() {
    if (this.sheetHost) return;
    this.sheetOpenedAt = Date.now();
    this.sheetHost = document.createElement('div');
    document.body.appendChild(this.sheetHost);
    this.renderSheet();
    this.releaseSheetFocus = holdSheetFocus(
      this.sheetHost.querySelector<HTMLElement>('.psr-sheet'),
      this.closeSheet,
      this.querySelector('.pvr-menu')
    );
    requestAnimationFrame(() => this.sheetHost?.querySelector('.psr-sheet')?.classList.add('open'));
  }

  private closeSheet = () => {
    if (!this.sheetHost) return;
    this.renaming = false;
    render(nothing, this.sheetHost);
    this.sheetHost.remove();
    this.sheetHost = null;
    this.releaseSheetFocus?.();
    this.releaseSheetFocus = null;
  };

  private onBackdrop = () => {
    if (Date.now() - this.sheetOpenedAt > 400) this.closeSheet();
  };

  private renderSheet() {
    if (!this.sheetHost) return;
    const item = this.item;
    const sheetAction = (fn: () => void) =>
      this.tapAction(() => {
        this.closeSheet();
        fn();
      }, true);
    // Rename stays in the sheet: its row becomes a field (rename-field.ts).
    const renameStep = this.tapAction(() => {
      this.renaming = true;
      this.renderSheet();
    }, true);
    render(
      html`
        <div class="psr-sheet-backdrop" @click=${this.onBackdrop}></div>
        <div
          class="psr-sheet"
          role="dialog"
          aria-modal="true"
          aria-label=${previewLabel(item)}
          data-testid="pvr-sheet"
        >
          <div class="psr-sheet-group ut-surface--floating ut-surface--material">
            <div class="psr-sheet-title"><bdi>${previewLabel(item)}</bdi></div>
            <button
              data-testid="pvr-sheet-open"
              @pointerup=${sheetAction(() => this.open())}
              @click=${sheetAction(() => this.open())}
            >
              ${t('previewRows.openAction')}
            </button>
            <button
              data-testid="pvr-sheet-pin"
              @pointerup=${sheetAction(() => void this.togglePin())}
              @click=${sheetAction(() => void this.togglePin())}
            >
              ${t(item.pinned ? 'previewRows.unpin' : 'previewRows.pin')}
            </button>
            ${
              this.renaming
                ? html`<ut-rename-field
                    data-testid="pvr-rename-field"
                    allowEmpty
                    .label=${t('previewRows.renamePrompt')}
                    .value=${item.customName || item.title || ''}
                    .save=${(name: string) => this.rename(name)}
                    @rename-done=${this.closeSheet}
                    @rename-cancel=${() => {
                      this.renaming = false;
                      this.renderSheet();
                      this.sheetHost
                        ?.querySelector<HTMLElement>('[data-testid="pvr-sheet-rename"]')
                        ?.focus();
                    }}
                  ></ut-rename-field>`
                : html`<button
                    data-testid="pvr-sheet-rename"
                    @pointerup=${renameStep}
                    @click=${renameStep}
                  >
                    ${t('previewRows.rename')}
                  </button>`
            }
            ${
              item.sessionId && item.sessionAlive
                ? html`<button
                    data-testid="pvr-sheet-session"
                    @pointerup=${sheetAction(() => this.goToSession())}
                    @click=${sheetAction(() => this.goToSession())}
                  >
                    ${t('previewRows.goToSession')}
                  </button>`
                : nothing
            }
            <button
              class="ut-surface--badge destructive"
              data-testid="pvr-sheet-delete"
              @pointerup=${sheetAction(() => void this.remove())}
              @click=${sheetAction(() => void this.remove())}
            >
              ${t('previewRows.delete')}
            </button>
          </div>
          <button class="psr-sheet-cancel ut-surface--floating ut-surface--material" @click=${this.onBackdrop}>${t('common.cancel')}</button>
        </div>
      `,
      this.sheetHost
    );
    focusSheet(this.sheetHost.querySelector<HTMLElement>('.psr-sheet'));
  }

  // ---- render -----------------------------------------------------------------------------

  render() {
    void this.locale;
    const item = this.item;
    if (!item) return nothing;
    const down = item.state === 'down';
    const label = previewLabel(item);
    const time = formatRowTime(new Date(item.lastOpenedAt).toISOString());
    const revealed = this.swipeX !== 0;
    const sessionLink = Boolean(item.sessionId && item.sessionAlive);
    return html`
      <div style="position: relative; overflow-x: clip; overflow-y: visible">
        <div
          class="psr-swipe-actions"
          aria-hidden=${revealed ? 'false' : 'true'}
          style="position: absolute; inset: 0 0 0 auto; display: flex; width: ${SWIPE_ACTION_PX * 2}px; ${
            revealed || this.swiping ? '' : 'visibility: hidden'
          }"
        >
          <button
            tabindex="-1"
            data-testid="pvr-swipe-pin"
            class="ut-surface--badge psr-swipe-btn"
            style="flex: 1; color: var(--color-text); background: var(--color-bg-tertiary); font-size: 15px"
            @pointerdown=${this.tapAction(() => {})}
            @pointerup=${this.tapAction(() => void this.togglePin())}
            @click=${this.tapAction(() => void this.togglePin())}
          >
            ${t(item.pinned ? 'previewRows.unpin' : 'previewRows.pin')}
          </button>
          <button
            tabindex="-1"
            data-testid="pvr-swipe-delete"
            class="ut-surface--badge psr-swipe-btn psr-swipe-btn-danger"
            style="flex: 1; color: var(--ut-text-on-solid); background: var(--color-status-error); font-size: 15px; font-weight: var(--ut-fw-semibold)"
            @pointerdown=${this.tapAction(() => {})}
            @pointerup=${this.tapAction(() => void this.remove())}
            @click=${this.tapAction(() => void this.remove())}
          >
            ${t('previewRows.delete')}
          </button>
        </div>
        <div
          class="psr pvr ut-surface--material ut-surface--ready ${this.compact ? 'pvr-compact' : ''} ${down ? 'pvr-down' : ''} ${this.highlighted ? 'pvr-highlight' : ''} ${this.busy ? 'psr-killing' : ''}"
          data-testid="preview-row"
          data-state=${item.state ?? 'unknown'}
          data-preview-id=${item.id}
          role="button"
          tabindex="0"
          aria-label=${t('previewRows.open', { name: label })}
          style="position: relative; touch-action: pan-y; ${
            this.swipeX || this.swiping
              ? `transform: translateX(${this.swipeX}px);${this.swiping ? ' transition: none;' : ''}`
              : ''
          }"
          @pointerdown=${this.onDown}
          @pointermove=${this.onMove}
          @pointerup=${this.onUp}
          @pointercancel=${this.onUp}
          @click=${this.onClick}
          @keydown=${(e: KeyboardEvent) => {
            if (e.target === e.currentTarget && e.key === 'Enter') this.activate();
          }}
        >
          ${agentAvatar({ variant: 'preview', paused: down, compact: this.compact })}
          <div class="psr-body">
            <div class="psr-top">
              <span class="psr-title" dir="auto">${label}</span>
              ${
                item.pinned
                  ? html`<span
                      class="psr-flag"
                      data-testid="pvr-pinned"
                      role="img"
                      aria-label=${t('previewRows.pinned')}
                      >${icon('pin', 12)}</span
                    >`
                  : nothing
              }
              <span class="psr-time">${time}</span>
            </div>
            <div class="pvr-meta">
              <span class="pvr-state ${down ? 'pvr-state-down' : item.state === 'live' ? 'pvr-state-live' : ''}">
                ${down ? t('previewRows.down') : item.state === 'live' ? t('previewRows.live') : t('previewRows.checking')}
              </span>
              ${
                item.sessionName
                  ? sessionLink
                    ? html`<span
                        class="pvr-from pvr-from-link"
                        role="link"
                        tabindex="0"
                        dir="auto"
                        data-testid="pvr-session-link"
                        @pointerdown=${this.tapAction(() => {})}
                        @pointerup=${this.tapAction(() => this.goToSession())}
                        @click=${this.tapAction(() => this.goToSession())}
                        @keydown=${(e: KeyboardEvent) => {
                          if (e.key !== 'Enter') return;
                          e.stopPropagation();
                          this.goToSession();
                        }}
                        >${t('previewRows.from', { name: item.sessionName })}</span
                      >`
                    : html`<span class="pvr-from" dir="auto"
                        >${t('previewRows.from', { name: item.sessionName })}</span
                      >`
                  : html`<span class="pvr-from"></span>`
              }
              ${item.customName || item.title ? html`<span class="pvr-port" dir="ltr">:${item.port}</span>` : nothing}
            </div>
          </div>
          <button
            class="ut-surface--control ut-surface--compact pvr-close pvr-menu"
            type="button"
            aria-label=${t('previewRows.actions', { name: label })}
            aria-haspopup="dialog"
            data-testid="preview-row-menu"
            @pointerdown=${this.tapAction(() => {})}
            @pointerup=${this.tapAction(() => this.openSheet())}
            @click=${this.tapAction(() => this.openSheet())}
          >
            ${icon('more', 20)}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'preview-row': PreviewRowElement;
  }
}
