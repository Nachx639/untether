/**
 * Keyboard capture toggle in the desktop session header (design spec 5.2, 2026-10-12).
 *
 * A borderless icon button; hovering it 400 ms opens a right-anchored popover that says
 * whether capture is on, which shortcuts go to the terminal (or work in the browser when it is
 * off) and the app shortcuts that always reach Untether (⌘B, ⌘K, ⌘,, ⌘1–9: see
 * isAppShortcut in session-view/input-manager.ts). Every string is translated
 * (keyboardCapture.*); shortcut labels come from formatShortcut (⌘ ⌥ ⌃ on a Mac).
 */
import { html, LitElement, nothing, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, type MessageKey, t } from '../i18n/index.js';
import { createLogger } from '../utils/logger.js';
import { formatShortcut } from '../utils/shortcut-label.js';
import { icon } from './icons.js';

const logger = createLogger('keyboard-capture-indicator');

/** Hover this long before the popover opens (spec 3: rich tooltips, 400 ms). */
export const CAPTURE_POPOVER_DELAY_MS = 400;

type ShortcutRow = { keys: string; label: MessageKey };

/** With capture on these reach the terminal instead of the browser. */
const CAPTURED: ShortcutRow[] = [
  { keys: 'mod+a', label: 'keyboardCapture.key.lineStart' },
  { keys: 'mod+e', label: 'keyboardCapture.key.lineEnd' },
  { keys: 'mod+w', label: 'keyboardCapture.key.deleteWord' },
  { keys: 'alt+left', label: 'keyboardCapture.key.wordLeft' },
  { keys: 'alt+right', label: 'keyboardCapture.key.wordRight' },
  { keys: 'mod+f', label: 'keyboardCapture.key.find' },
];

/** With capture off the browser keeps these. */
const BROWSER: ShortcutRow[] = [
  { keys: 'mod+a', label: 'keyboardCapture.key.selectAll' },
  { keys: 'mod+f', label: 'keyboardCapture.key.find' },
  { keys: 'mod+t', label: 'keyboardCapture.key.newTab' },
  { keys: 'mod+w', label: 'keyboardCapture.key.closeTab' },
];

/** Copy and paste work either way. */
const ALWAYS_EDIT: ShortcutRow[] = [
  { keys: 'mod+c', label: 'keyboardCapture.key.copy' },
  { keys: 'mod+v', label: 'keyboardCapture.key.paste' },
];

/** Never sent to the terminal (input-manager isAppShortcut). */
const APP: ShortcutRow[] = [
  { keys: 'mod+b', label: 'shortcuts.sidebar' },
  { keys: 'mod+k', label: 'shortcuts.palette' },
  { keys: 'mod+,', label: 'shortcuts.settings' },
  { keys: 'mod+1', label: 'shortcuts.switch' },
];

/** Section labels are sentence-case eyebrows: no trailing colon. */
const eyebrow = (text: string) => text.replace(/\s*[:：]\s*$/, '');

@customElement('keyboard-capture-indicator')
export class KeyboardCaptureIndicator extends LitElement {
  // Disable shadow DOM to use Tailwind classes
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Boolean }) active = true;
  @property({ type: Boolean }) isMobile = false;
  @state() private animating = false;
  @state() private lastCapturedShortcut = '';
  @state() private showDynamicTooltip = false;
  @state() private isHovered = false;

  private animationTimeout?: number;
  private tooltipTimeout?: number;
  private openTimeout?: number;

  connectedCallback() {
    super.connectedCallback();
    // Listen for captured shortcuts
    window.addEventListener('shortcut-captured', this.handleShortcutCaptured as EventListener);
  }

  willUpdate(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('active')) {
      logger.log(`Keyboard capture indicator updated: ${this.active ? 'ON' : 'OFF'}`);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('shortcut-captured', this.handleShortcutCaptured as EventListener);
    if (this.animationTimeout) clearTimeout(this.animationTimeout);
    if (this.tooltipTimeout) clearTimeout(this.tooltipTimeout);
    if (this.openTimeout) clearTimeout(this.openTimeout);
  }

  private handleShortcutCaptured = (event: CustomEvent) => {
    const { shortcut } = event.detail ?? {};
    this.lastCapturedShortcut = typeof shortcut === 'string' ? shortcut : '';
    this.animating = true;
    this.showDynamicTooltip = true;

    if (this.animationTimeout) clearTimeout(this.animationTimeout);
    if (this.tooltipTimeout) clearTimeout(this.tooltipTimeout);

    this.animationTimeout = window.setTimeout(() => {
      this.animating = false;
    }, 400);
    this.tooltipTimeout = window.setTimeout(() => {
      this.showDynamicTooltip = false;
    }, 3000);
  };

  private handleClick() {
    // Don't toggle local state - let parent control it
    const newActive = !this.active;
    this.dispatchEvent(
      new CustomEvent('capture-toggled', {
        detail: { active: newActive },
        bubbles: true,
        composed: true,
      })
    );
    logger.log(`Keyboard capture toggle requested: ${newActive ? 'enable' : 'disable'}`);
  }

  private scheduleOpen = () => {
    if (this.openTimeout) clearTimeout(this.openTimeout);
    this.openTimeout = window.setTimeout(() => {
      this.isHovered = true;
    }, CAPTURE_POPOVER_DELAY_MS);
  };

  private close = () => {
    if (this.openTimeout) clearTimeout(this.openTimeout);
    this.openTimeout = undefined;
    this.isHovered = false;
  };

  /** "⌘1" stands for the whole row: ⌘1–9. */
  private keyLabel(keys: string): string {
    const label = formatShortcut(keys);
    return keys === 'mod+1' ? `${label}–9` : label;
  }

  private renderGrid(rows: ShortcutRow[]) {
    return html`<div class="ut-capture-grid">
      ${rows.map(
        ({ keys, label }) => html`<div>
          <span class="ut-kbd">${this.keyLabel(keys)}</span><span>${t(label)}</span>
        </div>`
      )}
    </div>`;
  }

  private renderPopover() {
    const flash = this.showDynamicTooltip && this.lastCapturedShortcut;
    return html`
      <div class="ut-capture-popover" role="tooltip" id="keyboard-capture-popover" data-testid="keyboard-capture-popover">
        <div class="ut-capture-popover-title">
          ${this.active ? t('keyboardCapture.on') : t('keyboardCapture.off')}
        </div>
        <div class="ut-capture-popover-sub">
          ${this.active ? nothing : html`${t('keyboardCapture.browserNormal')} · `}${t('keyboardCapture.doubleTapEsc')}
        </div>
        ${
          flash
            ? html`<div class="ut-capture-popover-section ut-capture-flash" data-testid="keyboard-capture-flash">
                <span class="ut-kbd">${this.lastCapturedShortcut}</span>
                ${eyebrow(t('keyboardCapture.captured'))}
              </div>`
            : nothing
        }
        <div class="ut-capture-popover-section">
          <div class="ut-capture-popover-label">
            ${this.active ? eyebrow(t('keyboardCapture.captured')) : t('keyboardCapture.browserNormal')}
          </div>
          ${this.renderGrid([...(this.active ? CAPTURED : BROWSER), ...ALWAYS_EDIT])}
        </div>
        <div class="ut-capture-popover-section">
          <div class="ut-capture-popover-label">${eyebrow(t('keyboardCapture.appShortcuts'))}</div>
          ${this.renderGrid(APP)}
        </div>
      </div>
    `;
  }

  render() {
    if (this.isMobile) return html``;
    const label = this.active ? t('keyboardCapture.on') : t('keyboardCapture.off');
    return html`
      <div
        class="relative flex-shrink-0"
        @mouseenter=${this.scheduleOpen}
        @mouseleave=${this.close}
        @focusin=${this.scheduleOpen}
        @focusout=${this.close}
      >
        <button
          type="button"
          class="ut-icon-btn ut-capture-btn ${this.animating ? 'animating' : ''}"
          aria-label=${t('keyboardCapture.label')}
          aria-pressed=${this.active ? 'true' : 'false'}
          aria-describedby=${this.isHovered ? 'keyboard-capture-popover' : nothing}
          title=${this.isHovered ? '' : label}
          data-testid="keyboard-capture-button"
          @click=${this.handleClick}
        >
          ${icon('keyboard')}
          ${
            this.active
              ? nothing
              : html`<svg class="ut-capture-off" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">${svg`<path d="M3 3l18 18"/>`}</svg>`
          }
        </button>
        ${this.isHovered ? this.renderPopover() : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'keyboard-capture-indicator': KeyboardCaptureIndicator;
  }
}
