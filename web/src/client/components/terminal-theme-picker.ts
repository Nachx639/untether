/**
 * Terminal theme picker (design spec 5.3, 2026-10-12): a settings card whose Mode row holds an
 * [Auto | Fixed] segmented control. Auto: two more rows in the card, Dark → select and Light → select, each with a live 64×36 preview of the
 * theme Auto switches to. Fixed: a Dark | Light tab over a grid of preview cards (a radiogroup;
 * the other tab's cards stay in the DOM, hidden, so arrows and Home/End cover every theme).
 *
 * Self-contained: reads and writes TerminalPreferencesManager, announces every change on
 * window (TERMINAL_THEME_CHANGED_EVENT, which terminals and session cards listen to) and
 * fires `theme-change` (detail: the selected id) for a parent that propagates it further.
 * Used by Settings → Appearance and the session's terminal settings dialog.
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import {
  TERMINAL_THEME_CHANGED_EVENT,
  TerminalPreferencesManager,
} from '../utils/terminal-preferences.js';
import {
  ANSI_COLOR_KEYS,
  type AutoThemePair,
  type ConcreteTerminalThemeId,
  getTerminalTheme,
  isThemeOfAppearance,
  type TerminalAppearance,
  type TerminalColors,
  type TerminalTheme,
  type TerminalThemeId,
  themesByAppearance,
} from '../utils/terminal-themes.js';
import { icon } from './icons.js';

/** "Auto" is translated; named themes (Dracula, Nord, Classic Dark) are not. */
export function terminalThemeName(theme: { id: string; name: string }): string {
  return theme.id === 'auto' ? t('appearance.auto') : theme.name;
}

/** Radio order of the fixed themes: dark ones, then light ones, as the tabs show them. */
function radioOrder(): TerminalThemeId[] {
  return [
    ...themesByAppearance('dark').map((theme) => theme.id),
    ...themesByAppearance('light').map((theme) => theme.id),
  ];
}

/** Which tab a theme lives in (Auto: the tab of the theme the app is showing now). */
function appearanceOf(id: TerminalThemeId): TerminalAppearance {
  if (id === 'auto') {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }
  return isThemeOfAppearance(id, 'light') ? 'light' : 'dark';
}

@customElement('terminal-theme-picker')
export class TerminalThemePicker extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);
  private readonly prefs = TerminalPreferencesManager.getInstance();

  /** Accessible name of the radiogroup (the visible section label, when there is one). */
  @property({ type: String }) label = '';

  @state() private value: TerminalThemeId = this.prefs.getTheme();
  @state() private pair: AutoThemePair = this.prefs.getAutoThemePair();
  /** The Fixed grid's Dark | Light tab; follows the selected theme until clicked. */
  @state() private tab: TerminalAppearance | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.syncFromPrefs();
    window.addEventListener(TERMINAL_THEME_CHANGED_EVENT, this.syncFromPrefs);
  }

  disconnectedCallback() {
    window.removeEventListener(TERMINAL_THEME_CHANGED_EVENT, this.syncFromPrefs);
    super.disconnectedCallback();
  }

  /** Another picker (header dialog vs Settings) or the session menu changed it. */
  private syncFromPrefs = () => {
    this.value = this.prefs.getTheme();
    this.pair = this.prefs.getAutoThemePair();
  };

  private announce() {
    window.dispatchEvent(new CustomEvent(TERMINAL_THEME_CHANGED_EVENT, { detail: this.value }));
  }

  private select(id: TerminalThemeId, focus = false) {
    if (id !== this.value) {
      this.value = id;
      this.prefs.setTheme(id);
      this.announce();
      this.dispatchEvent(
        new CustomEvent<TerminalThemeId>('theme-change', {
          detail: id,
          bubbles: true,
          composed: true,
        })
      );
    }
    if (focus) {
      void this.updateComplete.then(() => {
        this.querySelector<HTMLElement>(`[data-theme-id="${id}"]`)?.focus();
      });
    }
  }

  private pairWith(appearance: TerminalAppearance, id: string) {
    if (!isThemeOfAppearance(id, appearance)) return;
    this.prefs.setAutoTheme(appearance, id);
    this.pair = this.prefs.getAutoThemePair();
    this.announce();
  }

  /** Radiogroup keys (WAI-ARIA APG): arrows move and select, Home/End jump to the ends. */
  private handleKeydown(e: KeyboardEvent) {
    // The Auto pairing selects sit inside the group: their arrows are theirs.
    if (!(e.target as HTMLElement | null)?.closest?.('.tt-card')) return;
    const order = radioOrder();
    const index = Math.max(0, order.indexOf(this.value));
    const rtl = getComputedStyle(this).direction === 'rtl';
    let next = index;
    switch (e.key) {
      case 'ArrowRight':
        next = index + (rtl ? -1 : 1);
        break;
      case 'ArrowDown':
        next = index + 1;
        break;
      case 'ArrowLeft':
        next = index + (rtl ? 1 : -1);
        break;
      case 'ArrowUp':
        next = index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = order.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const id = order[(next + order.length) % order.length];
    // The card lands in the other tab: show that tab.
    this.tab = appearanceOf(id);
    this.select(id, true);
  }

  /** Auto ↔ Fixed: Fixed starts on the theme Auto was showing, so nothing jumps. */
  private setMode(mode: 'auto' | 'fixed') {
    if (mode === 'auto') {
      this.select('auto');
      return;
    }
    if (this.value !== 'auto') return;
    const appearance = appearanceOf('auto');
    this.tab = appearance;
    this.select(this.pair[appearance]);
  }

  private renderPreview(colors: TerminalColors, mini = false) {
    return html`
      <div
        class="tt-preview ${mini ? 'tt-preview--mini' : ''}"
        style="background:${colors.background};color:${colors.foreground}"
      >
        <div class="tt-prompt" aria-hidden="true">
          <span style="color:${colors.green}">❯</span>
          <span style="color:${colors.blue}">~/app</span><span class="tt-cursor" style="background:${colors.cursor}"></span>
        </div>
        <div class="tt-ansi" aria-hidden="true">
          ${ANSI_COLOR_KEYS.slice(0, 8).map((key) => html`<span style="background:${colors[key]}"></span>`)}
        </div>
      </div>
    `;
  }

  private renderThemeCard(theme: TerminalTheme) {
    const checked = this.value === theme.id;
    const name = terminalThemeName(theme);
    return html`
      <button
        type="button"
        role="radio"
        class="tt-card"
        aria-checked=${checked ? 'true' : 'false'}
        aria-label=${name}
        title=${theme.description}
        tabindex=${checked ? '0' : '-1'}
        data-theme-id=${theme.id}
        data-testid="terminal-theme-${theme.id}"
        @click=${() => this.select(theme.id)}
      >
        ${this.renderPreview(theme.colors)}
        <span class="tt-name">${name}</span>
        ${checked ? html`<span class="tt-check" aria-hidden="true">${icon('check', 12)}</span>` : nothing}
      </button>
    `;
  }

  private renderPairRow(appearance: TerminalAppearance) {
    const selected = this.pair[appearance];
    const colors = getTerminalTheme(selected)?.colors;
    const id = `tt-pair-${appearance}`;
    return html`
      <div class="ut-row tt-pair-row ut-surface--panel ut-surface--material">
        <label class="ut-row-label" for=${id}>
          ${t(appearance === 'dark' ? 'settings.themes.dark' : 'settings.themes.light')}
        </label>
        <div class="tt-row-control">
          <select
            id=${id}
            class="ut-field ut-select"
            data-testid="terminal-theme-auto-${appearance}"
            .value=${selected}
            @click=${(e: Event) => e.stopPropagation()}
            @change=${(e: Event) =>
              this.pairWith(
                appearance,
                (e.target as HTMLSelectElement).value as ConcreteTerminalThemeId
              )}
          >
            ${themesByAppearance(appearance).map(
              (theme) =>
                html`<option value=${theme.id} ?selected=${theme.id === selected}>
                  ${terminalThemeName(theme)}
                </option>`
            )}
          </select>
          ${colors ? this.renderPreview(colors, true) : nothing}
        </div>
      </div>
    `;
  }

  render() {
    const auto = this.value === 'auto';
    const tab = this.tab ?? appearanceOf(this.value);
    const tabButton = (appearance: TerminalAppearance) => html`
      <button
        type="button"
        role="tab"
        aria-selected=${tab === appearance ? 'true' : 'false'}
        data-testid="terminal-theme-tab-${appearance}"
        @click=${() => {
          this.tab = appearance;
        }}
      >
        ${t(appearance === 'dark' ? 'settings.themes.darkPlural' : 'settings.themes.lightPlural')}
      </button>
    `;
    return html`
      <div class="tt-picker">
        <!-- QA 2026-10-12: the same .ut-group/.ut-row card as every other settings section
             (Mode row with the hint as its description; Dark and Light rows under it). -->
        <div class="ut-group">
          <!-- Phones (phone-spec §4.4): the row stacks, a terminal icon leads it and the
               Dark / Light rows indent under it (dialogs.css; hidden on larger screens). -->
          <div class="ut-row st-row--stack tt-mode-row ut-surface--panel ut-surface--material">
            <div class="flex items-start gap-3 min-w-0">
              <span class="st-row-icon tt-mode-icon" aria-hidden="true">${icon('terminal')}</span>
              <div class="min-w-0">
                <div class="ut-row-label" id="tt-mode-label">${t('settings.themes.modeLabel')}</div>
                <p class="ut-row-desc">
                  ${auto ? t('settings.themes.autoDesc') : t('settings.themes.fixedDesc')}
                </p>
              </div>
            </div>
            <div class="tt-row-control">
              <div class="ut-segmented" role="group" aria-labelledby="tt-mode-label">
                <button
                  type="button"
                  aria-pressed=${auto ? 'true' : 'false'}
                  data-testid="terminal-theme-auto"
                  data-theme-id="auto"
                  @click=${() => this.setMode('auto')}
                >
                  ${t('settings.themes.auto')}
                </button>
                <button
                  type="button"
                  aria-pressed=${auto ? 'false' : 'true'}
                  data-testid="terminal-theme-fixed"
                  @click=${() => this.setMode('fixed')}
                >
                  ${t('settings.themes.fixed')}
                </button>
              </div>
            </div>
          </div>
          ${
            auto
              ? html`
                <div class="tt-pairing" data-testid="terminal-theme-auto-pairing">
                  ${this.renderPairRow('dark')} ${this.renderPairRow('light')}
                </div>
              `
              : nothing
          }
        </div>
        ${
          auto
            ? nothing
            : html`
              <div class="ut-segmented tt-tabs" role="tablist">
                ${tabButton('dark')} ${tabButton('light')}
              </div>
            `
        }
        <div
          class="tt-grids"
          role="radiogroup"
          aria-label=${this.label || t('terminalSettings.theme')}
          ?hidden=${auto}
          @keydown=${this.handleKeydown}
        >
          ${(['dark', 'light'] as const).map(
            (appearance) => html`
              <div class="tt-grid" role="tabpanel" ?hidden=${appearance !== tab}>
                ${themesByAppearance(appearance).map((theme) => this.renderThemeCard(theme))}
              </div>
            `
          )}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'terminal-theme-picker': TerminalThemePicker;
  }
}
