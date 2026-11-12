/**
 * Clipboard Manager Component
 *
 * Handles clipboard operations including:
 * - Reading from system clipboard
 * - Maintaining clipboard history
 * - Providing paste preview
 * - Showing images on the clipboard in the history (only their text can be pasted)
 *
 * Mobile-optimized with touch-friendly interface and 44px minimum touch targets.
 */
import { html, LitElement, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { createLogger } from '../utils/logger.js';
import './modal-wrapper.js';
import { type IconName, icon } from './icons.js';

const logger = createLogger('clipboard-manager');

interface ClipboardItem {
  id: string;
  content: string;
  type: 'text' | 'image';
  timestamp: number;
  preview?: string;
  size?: number;
}

export interface ClipboardManagerCallbacks {
  onPaste?: (content: string) => void;
}

@customElement('clipboard-manager')
export class ClipboardManager extends LitElement {
  protected readonly i18n = new LocaleController(this);

  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) visible = false;
  @property({ type: Object }) callbacks: ClipboardManagerCallbacks | null = null;
  @property({ type: Boolean }) showHistory = false;

  @state() private clipboardHistory: ClipboardItem[] = [];
  @state() private currentClipboard: string = '';
  @state() private isReading = false;
  @state() private error: string | null = null;

  private readonly MAX_HISTORY_ITEMS = 20;
  private readonly MAX_PREVIEW_LENGTH = 200;
  private readonly STORAGE_KEY = 'untether-clipboard-history';

  connectedCallback() {
    super.connectedCallback();
    this.loadClipboardHistory();

    // Read current clipboard when component is opened
    if (this.visible) {
      this.readCurrentClipboard();
    }
  }

  updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);

    if (changedProperties.has('visible') && this.visible) {
      this.readCurrentClipboard();
      this.error = null;
    }
  }

  private async readCurrentClipboard() {
    // 2026-11-10: a text read earlier stayed shown and pasteable when the clipboard now held
    // an image or the permission was denied.
    this.currentClipboard = '';
    if (!navigator.clipboard) {
      this.error = t('clipboard.apiUnavailable');
      return;
    }

    this.isReading = true;
    this.error = null;

    try {
      // Try to read text first
      try {
        const text = await navigator.clipboard.readText();
        if (text?.trim()) {
          this.currentClipboard = text;
          this.addToHistory(text, 'text');
        }
      } catch (textError) {
        logger.debug('Failed to read clipboard text:', textError);
      }

      // Try to read other formats if supported
      if ('read' in navigator.clipboard) {
        try {
          const clipboardItems = await navigator.clipboard.read();
          for (const item of clipboardItems) {
            // Handle images
            for (const type of item.types) {
              if (type.startsWith('image/')) {
                const blob = await item.getType(type);
                this.addToHistory(
                  t('clipboard.imageItem', { type }),
                  'image',
                  undefined,
                  blob.size
                );
                break;
              }
            }
          }
        } catch (readError) {
          logger.debug('Failed to read complex clipboard data:', readError);
        }
      }
    } catch (error) {
      logger.error('Failed to read clipboard:', error);
      this.error = t('clipboard.readFailed');
    } finally {
      this.isReading = false;
    }
  }

  private addToHistory(
    content: string,
    type: ClipboardItem['type'],
    preview?: string,
    size?: number
  ) {
    // Don't add empty or duplicate content
    if (!content || content === this.clipboardHistory[0]?.content) {
      return;
    }

    const item: ClipboardItem = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      content,
      type,
      timestamp: Date.now(),
      preview:
        preview ||
        (content.length > this.MAX_PREVIEW_LENGTH
          ? `${content.substring(0, this.MAX_PREVIEW_LENGTH)}...`
          : content),
      size,
    };

    // Add to beginning and limit history size
    this.clipboardHistory = [item, ...this.clipboardHistory.slice(0, this.MAX_HISTORY_ITEMS - 1)];
    this.saveClipboardHistory();
  }

  private loadClipboardHistory() {
    try {
      const saved = localStorage.getItem(this.STORAGE_KEY);
      if (saved) {
        this.clipboardHistory = JSON.parse(saved);
      }
    } catch (error) {
      logger.warn('Failed to load clipboard history:', error);
      this.clipboardHistory = [];
    }
  }

  private saveClipboardHistory() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.clipboardHistory));
    } catch (error) {
      logger.warn('Failed to save clipboard history:', error);
    }
  }

  private async handlePasteCurrent() {
    if (!this.currentClipboard) {
      await this.readCurrentClipboard();
    }

    if (this.currentClipboard && this.callbacks?.onPaste) {
      this.callbacks.onPaste(this.currentClipboard);
      this.handleClose();
    }
  }

  private handlePasteFromHistory(item: ClipboardItem) {
    if (item.type === 'text' && this.callbacks?.onPaste) {
      this.callbacks.onPaste(item.content);
      this.handleClose();
    } else if (item.type === 'image') {
      // Image pasting from history isn't supported
      this.error = t('clipboard.imageHistoryUnsupported');
    }
  }

  private handleClearHistory() {
    this.clipboardHistory = [];
    this.saveClipboardHistory();
  }

  private handleRemoveHistoryItem(itemId: string) {
    this.clipboardHistory = this.clipboardHistory.filter((item) => item.id !== itemId);
    this.saveClipboardHistory();
  }

  private handleClose() {
    this.visible = false;
    this.showHistory = false;
    this.error = null;
    this.dispatchEvent(new CustomEvent('close'));
  }

  /** "You can also use Ctrl+V to paste directly", with the shortcut rendered as a key cap. */
  private renderShortcutHint() {
    const [before, after = ''] = t('clipboard.shortcutHint', { key: '\u0000' }).split('\u0000');
    return html`${before}<kbd class="px-1.5 py-0.5 bg-bg-tertiary border border-border rounded-rem text-xs">Ctrl+V</kbd>${after}`;
  }

  private formatTimestamp(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60000) {
      // Less than 1 minute
      return t('clipboard.justNow');
    } else if (diff < 3600000) {
      // Less than 1 hour
      const minutes = Math.floor(diff / 60000);
      return t('clipboard.minutesAgo', { n: minutes });
    } else if (diff < 86400000) {
      // Less than 1 day
      const hours = Math.floor(diff / 3600000);
      return t('clipboard.hoursAgo', { n: hours });
    } else {
      const days = Math.floor(diff / 86400000);
      return t('clipboard.daysAgo', { n: days });
    }
  }

  private formatSize(bytes?: number): string {
    if (!bytes) return '';

    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${Math.round(bytes / (1024 * 1024))}MB`;
  }

  private getTypeIcon(type: ClipboardItem['type']): IconName {
    switch (type) {
      case 'text':
        return 'fileText';
      default:
        return 'copy';
    }
  }

  render() {
    // If not visible, return empty to avoid any rendering
    if (!this.visible) {
      return html``;
    }

    return html`
      <modal-wrapper
        .visible=${this.visible}
        .closeOnBackdrop=${true}
        .closeOnEscape=${true}
        .contentClass=${'ut-dialog ut-dialog--md clipboard-manager-modal ssh-dialog'}
        .ariaLabel=${t('clipboard.title')}
        placement="sheet"
        style="z-index: 1050;"
        @close=${this.handleClose}
      >
        <div>
          <!-- Header -->
          <div class="ut-dialog-header">
            <div class="flex items-center justify-between gap-2 min-w-0">
              <div class="flex items-center gap-2 min-w-0">
                <span class="inline-flex text-text-muted">${icon('copy')}</span>
                <h2 class="m-0 text-title font-semibold text-text-bright truncate">
                  ${this.showHistory ? t('clipboard.historyTitle') : t('clipboard.title')}
                </h2>
              </div>
              <div class="flex items-center gap-2">
                ${
                  !this.showHistory && this.clipboardHistory.length > 0
                    ? html`
                  <button
                    type="button"
                    class="ut-btn ut-btn--ghost ut-btn--sm"
                    @click=${() => {
                      this.showHistory = true;
                    }}
                  >
                    ${t('clipboard.history', { n: this.clipboardHistory.length })}
                  </button>
                `
                    : ''
                }
                <button
                  type="button"
                  class="ut-icon-btn"
                  data-modal-close
                  @click=${this.handleClose}
                  title=${`${t('common.close')} (⎋)`}
                  aria-label=${t('common.close')}
                >
                  ${icon('x')}
                </button>
              </div>
            </div>
          </div>

          <!-- Content -->
          <div class="ssh-body">
            ${
              this.error
                ? html`
              <div class="cf-callout cf-callout--error mb-4 ut-surface--panel ut-surface--material">
                <div class="flex items-start gap-3">
                  <span class="inline-flex mt-0.5">${icon('alert')}</span>
                  <div>
                    <p class="text-status-error font-medium">${t('clipboard.error')}</p>
                    <p class="text-caption mt-1">${this.error}</p>
                  </div>
                </div>
              </div>
            `
                : ''
            }

            ${
              !this.showHistory
                ? html`
              <!-- Current Clipboard -->
              <div>
                <div class="mb-4">
                  <h3 class="m-0 mb-2 px-1 ut-section-label flex items-center gap-2">
                    ${t('clipboard.current')}
                    ${
                      this.isReading
                        ? html`
                      <div class="w-3 h-3 border-2 border-text-dim border-t-transparent rounded-pill animate-spin"></div>
                    `
                        : ''
                    }
                  </h3>
                  
                  ${
                    this.currentClipboard
                      ? html`
                    <div class="bg-bg-tertiary rounded-card p-3 mb-3">
                      <pre class="m-0 text-[12px] text-text whitespace-pre-wrap break-all font-mono">${this.currentClipboard.length > 300 ? `${this.currentClipboard.substring(0, 300)}...` : this.currentClipboard}</pre>
                    </div>
                    
                    <button
                      type="button"
                      id="clipboard-paste-current-button"
                      class="ut-btn ut-btn--primary ut-btn--lg w-full justify-center"
                      @click=${this.handlePasteCurrent}
                    >
                      ${icon('send')}
                      ${t('clipboard.pasteCurrent')}
                    </button>
                  `
                      : html`
                    <div class="bg-bg-tertiary rounded-card p-6 text-center">
                      <p class="text-text-muted mb-3">${t('clipboard.noContent')}</p>
                      <button
                        type="button"
                        class="ut-btn ut-btn--secondary"
                        @click=${this.readCurrentClipboard}
                        ?disabled=${this.isReading}
                      >
                        ${this.isReading ? t('clipboard.reading') : t('clipboard.refresh')}
                      </button>
                    </div>
                  `
                  }
                </div>
                
                <!-- Quick paste instructions (a keyboard shortcut: not on touch screens) -->
                <div class="clipboard-shortcut-hint border-t border-border pt-4">
                  <p class="m-0 text-caption text-text-dim text-center">
                    ${this.renderShortcutHint()}
                  </p>
                </div>
              </div>
            `
                : html`
              <!-- Clipboard History -->
              <div>
                <div class="flex items-center justify-between mb-4">
                  <button
                    type="button"
                    class="ut-btn ut-btn--ghost ut-btn--sm"
                    @click=${() => {
                      this.showHistory = false;
                    }}
                  >
                    ${icon('chevronLeft')}
                    ${t('clipboard.backToCurrent')}
                  </button>
                  
                  ${
                    this.clipboardHistory.length > 0
                      ? html`
                    <button
                      type="button"
                      class="ut-btn ut-btn--danger-ghost ut-btn--sm"
                      @click=${this.handleClearHistory}
                    >
                      ${t('clipboard.clearAll')}
                    </button>
                  `
                      : ''
                  }
                </div>
                
                ${
                  this.clipboardHistory.length > 0
                    ? html`
                  <div class="space-y-2">
                    ${this.clipboardHistory.map(
                      (item) => html`
                      <div class="bg-bg-elevated border border-border rounded-card p-3 hover:border-border-strong transition-colors group">
                        <div class="flex items-start justify-between gap-3">
                          <div class="flex items-start gap-3 flex-1 min-w-0">
                            <span class="flex-shrink-0 mt-0.5 text-text-muted inline-flex">${icon(this.getTypeIcon(item.type))}</span>
                            <div class="flex-1 min-w-0">
                              <div class="flex items-center justify-between gap-2 mb-1">
                                <span class="text-caption tnum text-text-dim">${this.formatTimestamp(item.timestamp)}</span>
                                ${
                                  item.size
                                    ? html`
                                  <span class="text-caption tnum text-text-dim">${this.formatSize(item.size)}</span>
                                `
                                    : ''
                                }
                              </div>
                              <pre class="m-0 text-[12px] text-text whitespace-pre-wrap break-all font-mono leading-relaxed">${item.preview}</pre>
                            </div>
                          </div>
                          
                          <div class="flex items-center gap-1 flex-shrink-0">
                            <button
                              type="button"
                              data-testid="clipboard-history-paste"
                              class="ut-icon-btn opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                              @click=${() => this.handlePasteFromHistory(item)}
                              title=${t('clipboard.pasteItem')}
                              aria-label=${t('clipboard.pasteItem')}
                            >
                              ${icon('send')}
                            </button>
                            <button
                              type="button"
                              class="ut-icon-btn opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-status-error"
                              @click=${() => this.handleRemoveHistoryItem(item.id)}
                              title=${t('clipboard.removeItem')}
                              aria-label=${t('clipboard.removeItem')}
                            >
                              ${icon('x')}
                            </button>
                          </div>
                        </div>
                      </div>
                    `
                    )}
                  </div>
                `
                    : html`
                  <div class="text-center py-8">
                    <div class="mb-3 text-text-dim inline-flex">${icon('copy', 32)}</div>
                    <p class="text-text-muted mb-2">${t('clipboard.noHistory')}</p>
                    <p class="text-sm text-text-muted">${t('clipboard.noHistoryHint')}</p>
                  </div>
                `
                }
              </div>
            `
            }
          </div>
        </div>
      </modal-wrapper>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'clipboard-manager': ClipboardManager;
  }
}
