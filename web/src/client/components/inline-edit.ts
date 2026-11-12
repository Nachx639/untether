import { css, html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { a11yBaseStyles } from '../utils/a11y-base-styles.js';
import { materialControlStyles, materialSurfaceStyles } from '../utils/material-surface-styles.js';
import { reducedMotionStyles } from '../utils/reduced-motion.js';

/**
 * Inline Edit Component
 *
 * Provides inline editing functionality with a pencil icon that appears on hover.
 * Supports keyboard shortcuts (Enter to save, Esc to cancel).
 *
 * Saving calls the `onSave(value)` property (only when the trimmed value changed); it emits
 * no events, and cancelling just closes the editor.
 */
@customElement('inline-edit')
export class InlineEdit extends LitElement {
  protected readonly i18n = new LocaleController(this);

  static override styles = [
    materialSurfaceStyles,
    reducedMotionStyles,
    a11yBaseStyles,
    css`
    :host {
      display: block;
      max-width: 100%;
      min-width: 0;
      overflow: hidden;
    }

    .display-container {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      max-width: 100%;
      min-width: 0;
    }

    .display-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      max-width: 100%;
    }

    .edit-icon {
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.2s;
      flex-shrink: 0;
      width: 1em;
      height: 1em;
    }

    /* Always show on touch devices */
    @media (hover: none) and (pointer: coarse) {
      .edit-icon {
        opacity: 0.5;
      }
    }

    :host(:hover) .edit-icon {
      opacity: 0.5;
    }

    .edit-icon:hover {
      opacity: 1 !important;
    }

    .edit-container {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      width: 100%;
    }

    input {
      background: var(--color-bg-tertiary);
      border: 1px solid var(--color-border);
      color: inherit;
      font: inherit;
      padding: 0.125rem 0.25rem;
      border-radius: var(--ut-r-rem-1);
      outline: none;
      width: 100%;
      min-width: 0;
    }

    input:focus {
      border-color: var(--color-primary);
    }

    @media (max-width: 639px) {
      input {
        font-size: 16px;
      }
    }

    .action-buttons {
      display: flex;
      gap: 0.25rem;
      flex-shrink: 0;
    }

    button {
      background: var(--ut-piece-control-fill, none);
      border: none;
      cursor: pointer;
      padding: 0.125rem;
      border-radius: var(--ut-r-rem-1);
      color: var(--color-text-muted);
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1.25rem;
      height: 1.25rem;
    }

    button:hover {
      background: var(--color-bg-tertiary);
    }

    button.save {
      color: var(--color-primary);
    }

    button.save:hover {
      /* 2026-11-10: the hover used a non-CSS property and went opaque, hiding the icon */
      background: color-mix(in srgb, var(--color-primary) 20%, transparent);
    }

    button.cancel {
      color: var(--color-status-error);
    }

    button.cancel:hover {
      /* 2026-11-10: the hover used a non-CSS property and went opaque, hiding the icon */
      background: color-mix(in srgb, var(--color-status-error) 20%, transparent);
    }
  `,
    materialControlStyles,
  ];

  @property({ type: String })
  value = '';

  @property({ type: String })
  placeholder = '';

  @property({ attribute: false })
  onSave?: (value: string) => void;

  @state()
  private isEditing = false;

  @state()
  private editValue = '';

  private inputElement?: HTMLInputElement;

  override render() {
    if (this.isEditing) {
      return html`
        <div class="edit-container">
          <input
            type="text"
            .value=${this.editValue}
            @input=${this.handleInput}
            @keydown=${this.handleKeyDown}
            placeholder=${this.placeholder}
          />
          <div class="action-buttons">
            <button class="ut-surface--control save" @click=${(e: Event) => {
              e.stopPropagation();
              this.handleSave();
            }} title=${`${t('common.save')} (Enter)`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </button>
            <button class="ut-surface--control cancel" @click=${(e: Event) => {
              e.stopPropagation();
              this.handleCancel();
            }} title=${`${t('common.cancel')} (Esc)`}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="display-container">
        <span class="display-text" title=${this.value}>${this.value}</span>
        <svg
          class="edit-icon"
          @click=${(e: Event) => {
            e.stopPropagation();
            this.startEdit();
          }}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
        </svg>
      </div>
    `;
  }

  override updated(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('isEditing') && this.isEditing) {
      // Focus input on next frame
      requestAnimationFrame(() => {
        this.inputElement = this.shadowRoot?.querySelector('input') as HTMLInputElement;
        if (this.inputElement) {
          this.inputElement.focus();
          this.inputElement.select();
        }
      });
    }
  }

  private startEdit() {
    this.editValue = this.value;
    this.isEditing = true;
  }

  private handleInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this.editValue = input.value;
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      // 2026-11-10: the Enter that confirms an IME candidate saved a half-typed name
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      this.handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      this.handleCancel();
    }
  }

  private handleSave() {
    const trimmedValue = this.editValue.trim();
    if (trimmedValue && trimmedValue !== this.value) {
      this.onSave?.(trimmedValue);
    }
    this.isEditing = false;
  }

  private handleCancel() {
    this.isEditing = false;
    this.editValue = '';
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'inline-edit': InlineEdit;
  }
}
