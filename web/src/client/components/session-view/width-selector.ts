/**
 * Terminal Settings Component
 *
 * Modal for configuring terminal width, font size, and theme.
 * Features a grid-based layout with conditional custom width input.
 */
import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { LocaleController, type MessageKey, t } from '../../i18n/index.js';
import { Z_INDEX } from '../../utils/constants.js';
import { createLogger } from '../../utils/logger.js';
import {
  COMMON_TERMINAL_WIDTHS,
  TerminalPreferencesManager,
} from '../../utils/terminal-preferences.js';
import type { TerminalThemeId } from '../../utils/terminal-themes.js';
import '../terminal-theme-picker.js';
import { formatShortcut } from '../../utils/shortcut-label.js';
import { icon } from '../icons.js';

const logger = createLogger('terminal-settings-modal');

@customElement('terminal-settings-modal')
export class TerminalSettingsModal extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  connectedCallback() {
    super.connectedCallback();

    // Load theme from TerminalPreferencesManager
    this.terminalTheme = this.preferencesManager.getTheme();
  }

  private preferencesManager = TerminalPreferencesManager.getInstance();

  @property({ type: Boolean }) visible = false;
  @property({ type: Number }) terminalMaxCols = 0;
  @property({ type: Number }) terminalFontSize = 14;

  private _terminalTheme: TerminalThemeId = 'auto';
  @property({ type: String })
  get terminalTheme(): TerminalThemeId {
    return this._terminalTheme;
  }
  set terminalTheme(value: TerminalThemeId) {
    logger.debug('Terminal theme set to:', value);
    this._terminalTheme = value;
    this.requestUpdate();
  }
  @property({ type: String }) customWidth = '';
  @property({ type: Boolean }) showCustomInput = false;
  @property({ type: Function }) onWidthSelect?: (width: number) => void;
  @property({ type: Function }) onFontSizeChange?: (size: number) => void;
  @property({ type: Function }) onThemeChange?: (theme: TerminalThemeId) => void;
  @property({ type: Function }) onClose?: () => void;
  @property({ type: Boolean }) isMobile = false;

  private handleCustomWidthInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this.customWidth = input.value;
    this.requestUpdate();
  }

  private handleCustomWidthSubmit() {
    const width = Number.parseInt(this.customWidth, 10);
    if (!Number.isNaN(width) && width >= 20 && width <= 500) {
      this.onWidthSelect?.(width);
      this.customWidth = '';
      this.showCustomInput = false;
    }
  }

  private handleClose() {
    this.showCustomInput = false;
    this.customWidth = '';
    this.onClose?.();
  }

  private handleCustomWidthKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      this.handleCustomWidthSubmit();
    } else if (e.key === 'Escape') {
      this.handleClose();
    }
  }

  private getSelectedWidthValue(): string {
    const isCustomValue =
      this.terminalMaxCols > 0 &&
      !COMMON_TERMINAL_WIDTHS.find((width) => width.value === this.terminalMaxCols);

    return isCustomValue || this.showCustomInput ? 'custom' : String(this.terminalMaxCols);
  }

  // legacy binary-mode preference removed (v3 WS + ghostty is always-on)

  updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);

    if (
      changedProperties.has('terminalMaxCols') ||
      changedProperties.has('visible') ||
      changedProperties.has('showCustomInput')
    ) {
      const widthSelect = this.querySelector('#width-select') as HTMLSelectElement | null;
      if (widthSelect) {
        widthSelect.value = this.getSelectedWidthValue();
      }
    }
  }

  render() {
    if (!this.visible) return null;

    // Debug localStorage when dialog opens
    logger.debug('Dialog opening, terminal theme:', this.terminalTheme);

    // Check if we're showing a custom value that doesn't match presets
    const isCustomValue = this.getSelectedWidthValue() === 'custom';

    return html`
      <!-- Backdrop to close on outside click -->
      <div
        class="fixed inset-0"
        style="z-index: ${Z_INDEX.MODAL_BACKDROP};"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-settings-title"
        @click=${() => this.handleClose()}
      ></div>

      <!-- Terminal settings modal -->
      <div
        class="width-selector-container ut-dialog fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 overscroll-contain animate-fade-in ut-surface--material ut-surface--fixed"
        style="--w: 480px; z-index: ${Z_INDEX.MODAL};"
      >
        <div class="ut-dialog-header">
          <h2 id="terminal-settings-title" class="text-title font-semibold text-text-bright">${t('terminalSettings.title')}</h2>
          <button
            type="button"
            class="ut-icon-btn"
            @click=${() => this.handleClose()}
            title=${`${t('common.close')} (${formatShortcut('esc')})`}
            aria-label=${t('terminalSettings.close')}
          >
            ${icon('x')}
          </button>
        </div>
        <div class="ut-dialog-body pt-1">
          
          <!-- Settings grid -->
          <div class="space-y-4">
            <!-- Width setting -->
            <div class="grid grid-cols-[96px_1fr] gap-4 items-center">
              <label for="width-select" class="ut-label mb-0">${t('terminalSettings.width')}</label>
              <select
                id="width-select"
                class="ut-select w-full cursor-pointer"
                .value=${this.getSelectedWidthValue()}
                @click=${(e: Event) => e.stopPropagation()}
                @mousedown=${(e: Event) => e.stopPropagation()}
                @change=${(e: Event) => {
                  e.stopPropagation();
                  const value = (e.target as HTMLSelectElement).value;
                  if (value === 'custom') {
                    this.showCustomInput = true;
                    this.customWidth = isCustomValue ? String(this.terminalMaxCols) : '';
                  } else {
                    this.showCustomInput = false;
                    this.customWidth = '';
                    this.onWidthSelect?.(Number.parseInt(value, 10));
                  }
                }}
              >
                <option value="0">${t('terminalSettings.fitToWindow')}</option>
                ${COMMON_TERMINAL_WIDTHS.slice(1).map(
                  (width) => html`
                    <option value=${width.value}>
                      ${t(`terminalSettings.width.${width.value}` as MessageKey)} (${width.value})
                    </option>
                  `
                )}
                <option value="custom">${t('terminalSettings.custom')}</option>
              </select>
            </div>
            
            <!-- Custom width input (conditional) -->
            ${
              this.showCustomInput
                ? html`
              <div class="grid grid-cols-[96px_1fr] gap-4 items-center">
                <div></div>
                <div class="flex gap-2">
                  <input
                    type="number"
                    min="20"
                    max="500"
                    placeholder=${t('terminalSettings.customPlaceholder')}
                    .value=${this.customWidth}
                    @input=${this.handleCustomWidthInput}
                    @keydown=${this.handleCustomWidthKeydown}
                    @click=${(e: Event) => e.stopPropagation()}
                    class="ut-field ut-field--mono flex-1"
                    autofocus
                  />
                  <button
                    class="ut-btn ut-btn--primary"
                    @click=${this.handleCustomWidthSubmit}
                    ?disabled=${
                      !this.customWidth ||
                      Number.parseInt(this.customWidth, 10) < 20 ||
                      Number.parseInt(this.customWidth, 10) > 500
                    }
                  >
                    ${t('terminalSettings.set')}
                  </button>
                </div>
              </div>
            `
                : ''
            }
          
            <!-- Font size setting -->
            <div class="grid grid-cols-[96px_1fr] gap-4 items-center">
              <span class="ut-label mb-0">${t('terminalSettings.fontSize')}</span>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="ut-btn ut-btn--secondary ut-btn--sm w-8 justify-center px-0"
                  @click=${() => this.onFontSizeChange?.(this.terminalFontSize - 1)}
                  ?disabled=${this.terminalFontSize <= 8}
                  title=${t('terminalSettings.decreaseFont')}
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd"/>
                  </svg>
                </button>
                <span class="ut-data text-text min-w-[48px] text-center">
                  ${this.terminalFontSize}px
                </span>
                <button
                  type="button"
                  class="ut-btn ut-btn--secondary ut-btn--sm w-8 justify-center px-0"
                  @click=${() => this.onFontSizeChange?.(this.terminalFontSize + 1)}
                  ?disabled=${this.terminalFontSize >= 32}
                  title=${t('terminalSettings.increaseFont')}
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/>
                  </svg>
                </button>
                <div class="flex-1"></div>
              </div>
            </div>
            
            <!-- Theme setting: preview cards (terminal-theme-picker.ts) -->
            <div class="pt-2">
              <div id="terminal-settings-theme-label" class="ut-label">
                ${t('terminalSettings.theme')}
              </div>
              <terminal-theme-picker
                .label=${t('terminalSettings.theme')}
                @click=${(e: Event) => e.stopPropagation()}
                @theme-change=${(e: CustomEvent<TerminalThemeId>) => {
                  e.stopPropagation();
                  logger.debug('Theme changed to:', e.detail);
                  this.terminalTheme = e.detail;
                  this.onThemeChange?.(e.detail);
                }}
              ></terminal-theme-picker>
            </div>
            
          </div>
        </div>
      </div>
    `;
  }
}
