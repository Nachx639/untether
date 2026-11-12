import { html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import {
  getLocale,
  isLocale,
  LOCALE_NAMES,
  LocaleController,
  SUPPORTED_LOCALES,
  setLocale,
  t,
} from '../i18n/index.js';

/**
 * Language selector. Each option is shown in its own language.
 * `compact` renders a small globe + select for the login screen.
 */
@customElement('language-picker')
export class LanguagePicker extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) compact = false;

  protected readonly i18n = new LocaleController(this);

  private handleChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    if (isLocale(value)) setLocale(value);
  }

  render() {
    const current = getLocale();
    const options = SUPPORTED_LOCALES.map(
      (locale) => html`
        <option value=${locale} lang=${locale} ?selected=${locale === current}>
          ${LOCALE_NAMES[locale]}
        </option>
      `
    );

    if (this.compact) {
      return html`
        <label class="inline-flex items-center gap-1.5 text-text-muted hover:text-text transition-colors">
          <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <select
            id="language-picker-compact"
            class="ut-surface--inset bg-transparent text-caption font-ui text-inherit border-none outline-none cursor-pointer py-1"
            aria-label=${t('language.label')}
            @change=${this.handleChange}
          >
            ${options}
          </select>
        </label>
      `;
    }

    return html`
      <select
        id="language-picker"
        class="ut-field ut-select w-full sm:w-auto"
        aria-label=${t('language.label')}
        @change=${this.handleChange}
      >
        ${options}
      </select>
    `;
  }
}
