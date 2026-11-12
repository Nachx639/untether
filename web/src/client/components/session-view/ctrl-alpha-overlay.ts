/**
 * Ctrl+Alpha Overlay Component
 *
 * Full-screen overlay for building Ctrl key sequences on mobile devices.
 * Allows users to create complex sequences like ctrl+c ctrl+c.
 */
import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { LocaleController, t } from '../../i18n/index.js';

@customElement('ctrl-alpha-overlay')
export class CtrlAlphaOverlay extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);
  @property({ type: Boolean }) visible = false;
  @property({ type: Array }) ctrlSequence: string[] = [];
  @property({ type: Function }) onCtrlKey?: (letter: string) => void;
  @property({ type: Function }) onSendSequence?: () => void;
  @property({ type: Function }) onClearSequence?: () => void;
  @property({ type: Function }) onCancel?: () => void;

  private handleCtrlKey(letter: string) {
    this.onCtrlKey?.(letter);
  }

  render() {
    if (!this.visible) return null;

    // Its own fixed backdrop, not <modal-wrapper>: nothing here depends on the wrapper's
    // one-root-element contract (checked 2026-10-12). The card uses the dialog tokens.
    return html`
      <!-- Direct backdrop -->
      <div 
        class="fixed inset-0 bg-bg/80 flex items-center justify-center p-4"
        style="z-index: 1000; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);"
        @click=${(e: Event) => {
          if (e.target === e.currentTarget) {
            this.onCancel?.();
          }
        }}
      >
        <!-- Modal content -->
        <div
          class="ut-dialog p-4 relative"
          role="dialog"
          aria-modal="true"
          aria-label="Ctrl + Key"
          style="--w: 24rem; z-index: 1001; max-height: 80vh;"
          @click=${(e: Event) => e.stopPropagation()}
        >
          <div class="text-title text-text-bright text-center mb-2 font-semibold" dir="ltr">Ctrl + Key</div>

          <!-- Help text -->
          <div class="text-xs text-text-muted text-center mb-3 opacity-70">
            ${t('ctrl.help')}
          </div>

          <!-- Current sequence display -->
          ${
            this.ctrlSequence.length > 0
              ? html`
                <div class="text-center mb-4 p-2 border border-border rounded-rem bg-bg">
                  <div class="text-xs text-text-muted mb-1">${t('ctrl.currentSequence')}</div>
                  <div class="ut-data text-text-bright font-semibold" dir="ltr">
                    ${this.ctrlSequence.map((letter) => `Ctrl+${letter}`).join(' ')}
                  </div>
                </div>
              `
              : ''
          }

          <!-- Grid of A-Z buttons -->
          <div class="grid grid-cols-6 gap-1 mb-3" dir="ltr">
            ${[
              'A',
              'B',
              'C',
              'D',
              'E',
              'F',
              'G',
              'H',
              'I',
              'J',
              'K',
              'L',
              'M',
              'N',
              'O',
              'P',
              'Q',
              'R',
              'S',
              'T',
              'U',
              'V',
              'W',
              'X',
              'Y',
              'Z',
            ].map(
              (letter) => html`
                <button
                  class="ut-surface--control font-mono text-xs transition-all cursor-pointer aspect-square flex items-center justify-center quick-start-btn py-2"
                  @click=${() => this.handleCtrlKey(letter)}
                >
                  ${letter}
                </button>
              `
            )}
          </div>

          <!-- Common shortcuts info -->
          <div class="text-xs text-text-muted text-center mb-3">
            <div>${t('ctrl.common')}</div>
          </div>

          <!-- Action buttons -->
          <div class="flex gap-2 justify-center">
            <button
              class="ut-btn ut-btn--ghost"
              @click=${() => this.onCancel?.()}
            >
              ${t('common.cancel')}
            </button>
            ${
              this.ctrlSequence.length > 0
                ? html`
                  <button
                    class="ut-btn ut-btn--ghost"
                    @click=${() => this.onClearSequence?.()}
                  >
                    ${t('ctrl.clear')}
                  </button>
                  <button
                    class="ut-btn ut-btn--primary"
                    @click=${() => this.onSendSequence?.()}
                  >
                    ${t('ctrl.send')}
                  </button>
                `
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }
}
