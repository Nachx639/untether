/**
 * Clickable Path Component
 *
 * Displays a formatted path (with ~/ for home directory) that can be clicked to copy the full path.
 * Provides visual feedback with hover effects and a copy icon.
 *
 * @fires path-copied - When path is successfully copied (detail: { path: string })
 * A failed copy shows an error toast (2026-10-20: it fired a `path-copy-failed` nobody listened to).
 */
import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { toast } from '../utils/action-toast.js';
import { createLogger } from '../utils/logger.js';
import { copyToClipboard, formatPathForDisplay } from '../utils/path-utils.js';
import './copy-icon.js';

const logger = createLogger('clickable-path');

@customElement('clickable-path')
export class ClickablePath extends LitElement {
  protected readonly i18n = new LocaleController(this);

  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: String }) path = '';
  @property({ type: String }) class = '';
  @property({ type: Number }) iconSize = 12;
  /**
   * 'default': the path truncated at the end, with a copy icon. 'middle' (cards and rows,
   * 2026-10-12): mono, the folder name always visible and the middle cut ("~/Projects/…/web"),
   * the copy icon only on hover.
   */
  @property({ type: String }) variant: 'default' | 'middle' = 'default';

  private async handleClick(e: Event) {
    e.stopPropagation();
    e.preventDefault();

    if (!this.path) return;

    try {
      const success = await copyToClipboard(this.path);
      if (success) {
        logger.log('Path copied to clipboard', { path: this.path });
        this.dispatchEvent(
          new CustomEvent('path-copied', {
            detail: { path: this.path },
            bubbles: true,
            composed: true,
          })
        );
      } else {
        throw new Error('Copy command failed');
      }
    } catch (error) {
      logger.error('Failed to copy path to clipboard', { error, path: this.path });
      toast({ kind: 'error', text: t('files.copyFailed') });
    }
  }

  render() {
    if (!this.path) return html``;

    const displayPath = formatPathForDisplay(this.path);

    if (this.variant === 'middle') {
      // The tail keeps the "/" (2026-10-12): at the end of the head it was the first thing the
      // ellipsis hid, so "~/Projects/web" read "~/Pr…web" and "~/.cache" like "~.cache".
      const cut = displayPath.lastIndexOf('/');
      const head = cut > 0 ? displayPath.slice(0, cut) : '';
      const tail = cut > 0 ? displayPath.slice(cut) : displayPath;
      return html`
        <div
          class="ut-path-middle ${this.class}"
          title=${`${displayPath} · ${t('path.clickToCopy')}`}
          @click=${this.handleClick}
        >
          ${head ? html`<span class="ut-path-head">${head}</span>` : ''}<span class="ut-path-tail"
            >${tail}</span
          >
          <copy-icon size="${this.iconSize}" class="ut-path-copy"></copy-icon>
        </div>
      `;
    }

    return html`
      <div
        class="truncate cursor-pointer hover:text-text transition-colors inline-flex items-center gap-1 max-w-full ${
          this.class
        }"
        title=${t('path.clickToCopy')}
        @click=${this.handleClick}
      >
        <span class="truncate">${displayPath}</span>
        <copy-icon size="${this.iconSize}" class="flex-shrink-0"></copy-icon>
      </div>
    `;
  }
}
