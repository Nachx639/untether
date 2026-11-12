/**
 * Inline rename for the phone sheets (session switcher, a list row's ⋯): a field in place of
 * the "Rename" row, filled with the current name and focused, with Cancel / OK. Enter saves,
 * Escape cancels. It replaced window.prompt(), which iOS showed on top of the sheet with the
 * sheet half visible behind it (2026-10-04, iPhone QA).
 *
 * `save` does the API call and resolves to an error message to show, or nothing once saved.
 * The field stays open on an error. Emits `rename-done` (detail: { name }) after a save, and
 * `rename-cancel` on Cancel, Escape or an unchanged name.
 */
import { html, LitElement } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';

export type SaveName = (name: string) => Promise<string | undefined>;

@customElement('ut-rename-field')
export class RenameField extends LitElement {
  createRenderRoot() {
    return this;
  }

  private readonly i18n = new LocaleController(this);

  /** The current name: the field starts with it. */
  @property() value = '';
  /** Label above the field ("New name"). */
  @property() label = '';
  /** An empty name is a choice (e.g. "use the page title"), not a mistake. */
  @property({ type: Boolean }) allowEmpty = false;
  @property({ attribute: false }) save?: SaveName;

  @state() private error = '';
  /** While saving the input is read-only, not disabled: disabling it would drop the keyboard. */
  @state() private saving = false;
  @query('input') private input?: HTMLInputElement;

  connectedCallback() {
    super.connectedCallback();
    this.classList.add('ut-rename');
    // Escape is ours: the sheet would close on it (sheet-a11y.ts lets it through).
    this.dataset.ownEscape = '';
  }

  protected firstUpdated() {
    // Set once: a new value from a poll (Claude retitled the session) mustn't erase typing.
    if (this.input) this.input.value = this.value;
    // A microtask after the tap that opened it: still inside that gesture, so iOS shows the
    // keyboard.
    this.input?.focus();
    this.input?.select();
  }

  private finish(type: 'rename-done' | 'rename-cancel', name?: string) {
    this.dispatchEvent(
      new CustomEvent(type, { detail: name === undefined ? undefined : { name }, bubbles: true })
    );
  }

  async submit() {
    if (this.saving || !this.input) return;
    const name = this.input.value.trim();
    if (!name && !this.allowEmpty) {
      this.error = t('rename.empty');
      this.input.focus();
      return;
    }
    if (name === this.value.trim()) {
      this.finish('rename-cancel');
      return;
    }
    this.saving = true;
    this.error = '';
    let error: string | undefined;
    try {
      error = await this.save?.(name);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.saving = false;
    if (error) {
      this.error = error;
      this.input?.focus();
      return;
    }
    this.finish('rename-done', name);
  }

  cancel() {
    if (!this.saving) this.finish('rename-cancel');
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      void this.submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
    }
  };

  render() {
    void this.i18n;
    const label = this.label || t('sessions.row.renamePrompt');
    return html`<form
      class="ut-rename-form"
      @submit=${(e: Event) => {
        e.preventDefault();
        void this.submit();
      }}
    >
      <label class="ut-rename-label">
        <span>${label}</span>
        <input
          type="text"
          data-testid="rename-input"
          enterkeyhint="done"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          ?readonly=${this.saving}
          aria-invalid=${this.error ? 'true' : 'false'}
          aria-describedby="ut-rename-error"
          @input=${() => {
            if (this.error) this.error = '';
          }}
          @keydown=${this.onKeyDown}
        />
      </label>
      <div id="ut-rename-error" class="ut-rename-error" data-testid="rename-error" role="alert"
        >${this.error}</div
      >
      <div class="ut-rename-actions">
        <button type="button" data-testid="rename-cancel" ?disabled=${this.saving} @click=${() => this.cancel()}>
          ${t('common.cancel')}
        </button>
        <button type="submit" class="ut-rename-ok" data-testid="rename-ok" ?disabled=${this.saving}>
          ${t('common.ok')}
        </button>
      </div>
    </form>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ut-rename-field': RenameField;
  }
}
