/**
 * OverlaysContainer Component
 *
 * Container for all overlay components in the session view.
 * Manages modals, floating buttons, and overlay states.
 */
import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Session } from '../../../shared/types.js';
import { LocaleController, t } from '../../i18n/index.js';
import type { TerminalThemeId } from '../../utils/terminal-themes.js';
import type { UIState } from './ui-state-manager.js';
import './ctrl-alpha-overlay.js';
import '../terminal-quick-keys.js';
import '../file-browser.js';
import '../file-picker.js';
import './width-selector.js';

export interface OverlaysCallbacks {
  // Ctrl+Alpha callbacks
  onCtrlKey: (letter: string) => void;
  onSendCtrlSequence: () => void;
  onClearCtrlSequence: () => void;
  onCtrlAlphaCancel: () => void;

  // Quick keys
  onQuickKeyPress: (key: string) => void;

  // File browser/picker
  onCloseFileBrowser: () => void;
  onInsertPath: (e: CustomEvent) => void;
  onFileSelected: (e: CustomEvent) => void;
  onFileError: (e: CustomEvent) => void;
  onCloseFilePicker: () => void;

  // Terminal settings
  onWidthSelect: (width: number) => void;
  onFontSizeChange: (size: number) => void;
  onThemeChange: (theme: TerminalThemeId) => void;
  onCloseWidthSelector: () => void;
}

@customElement('overlays-container')
export class OverlaysContainer extends LitElement {
  // Disable shadow DOM to use parent styles
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);
  @property({ type: Object }) session: Session | null = null;
  @property({ type: Object }) uiState: UIState | null = null;
  @property({ type: Object }) callbacks: OverlaysCallbacks | null = null;

  render() {
    if (!this.uiState || !this.callbacks) {
      return html``;
    }

    return html`
      <!-- "Session ended" is not here: this container sits above the session header (for
           the file browser and dialogs), and the badge covered the header's ⋮ menu
           (2026-10-03). session-view.ts renders <session-exited-badge> under the header. -->
      <!-- Ctrl+Alpha Overlay -->
      ${(() => {
        const visible = this.uiState.isMobile && this.uiState.showCtrlAlpha;
        return html`
          <ctrl-alpha-overlay
            .visible=${visible}
            .ctrlSequence=${this.uiState.ctrlSequence}
            .onCtrlKey=${this.callbacks.onCtrlKey}
            .onSendSequence=${this.callbacks.onSendCtrlSequence}
            .onClearSequence=${this.callbacks.onClearCtrlSequence}
            .onCancel=${this.callbacks.onCtrlAlphaCancel}
          ></ctrl-alpha-overlay>
        `;
      })()}
      
      <!-- Terminal Quick Keys (desktop only) -->
      ${
        !this.uiState.isMobile
          ? html`
            <terminal-quick-keys
              .visible=${this.uiState.showQuickKeys}
              .onKeyPress=${this.callbacks.onQuickKeyPress}
            ></terminal-quick-keys>
          `
          : ''
      }
      
      <!-- File Browser Modal -->
      <file-browser
        .visible=${this.uiState.showFileBrowser}
        .mode=${'browse'}
        .session=${this.session}
        @browser-cancel=${this.callbacks.onCloseFileBrowser}
        @insert-path=${this.callbacks.onInsertPath}
      ></file-browser>
      
      <!-- File Picker Modal -->
      <file-picker
        .visible=${this.uiState.showImagePicker}
        @file-selected=${this.callbacks.onFileSelected}
        @file-error=${this.callbacks.onFileError}
        @file-cancel=${this.callbacks.onCloseFilePicker}
      ></file-picker>
      
      <!-- Width Selector Modal -->
      <terminal-settings-modal
        .visible=${this.uiState.showWidthSelector}
        .terminalMaxCols=${this.uiState.terminalMaxCols}
        .terminalFontSize=${this.uiState.terminalFontSize}
        .terminalTheme=${this.uiState.terminalTheme}
        .customWidth=${this.uiState.customWidth}
        .isMobile=${this.uiState.isMobile}
        .onWidthSelect=${this.callbacks.onWidthSelect}
        .onFontSizeChange=${this.callbacks.onFontSizeChange}
        .onThemeChange=${this.callbacks.onThemeChange}
        .onClose=${this.callbacks.onCloseWidthSelector}
      ></terminal-settings-modal>
      
      <!-- Drag & Drop Overlay -->
      ${
        this.uiState.isDragOver
          ? html`
            <div class="fixed inset-0 bg-bg/90 backdrop-blur-sm flex items-center justify-center z-50 pointer-events-none animate-fade-in">
              <div class="bg-elevated border-2 border-dashed border-primary rounded-xl p-10 text-center max-w-md mx-4 shadow-drop-2xl animate-scale-in">
                <div class="relative mb-6">
                  <div class="w-24 h-24 mx-auto bg-gradient-to-br from-primary to-primary-light rounded-pill flex items-center justify-center shadow-glow">
                    <svg class="w-12 h-12 text-base" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
                    </svg>
                  </div>
                  <div class="absolute -bottom-2 left-1/2 transform -translate-x-1/2 w-32 h-1 bg-gradient-to-r from-transparent via-primary to-transparent opacity-50"></div>
                </div>
                <h3 class="text-2xl font-bold text-primary mb-3">${t('overlay.dropTitle')}</h3>
                <p class="text-sm text-text-muted mb-4">${t('overlay.dropDescription')}</p>
                <div class="inline-flex items-center gap-2 text-xs text-text-dim bg-bg-secondary px-4 py-2 rounded-lg">
                  <span class="opacity-75">${t('overlay.orPress')}</span>
                  <kbd class="px-2 py-1 bg-bg-tertiary border border-border rounded-rem text-primary font-mono text-xs">⌘V</kbd>
                  <span class="opacity-75">${t('overlay.toPaste')}</span>
                </div>
              </div>
            </div>
          `
          : ''
      }
    `;
  }
}
