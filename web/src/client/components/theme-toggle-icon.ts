import { html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, type MessageKey, t } from '../i18n/index.js';
import { ACCENT_THEMES, applyAccent, getAccent } from '../utils/accent-themes.js';
import { accentFixedByLook, LOOK_CHANGED_EVENT, lockedThemeMode } from '../utils/look.js';
import { isPhoneScreen } from '../utils/mobile-utils.js';
import { applyThemeMode, syncThemeMode } from '../utils/theme-mode.js';
import { icon } from './icons.js';
import { lookLockText, openAppearanceSheet, THEME_MODES, themeModeLabel } from './theme-toggle.js';

export type Theme = 'light' | 'dark' | 'system';

/**
 * Appearance button: opens a small panel with light / dark / system and the color themes; on
 * a phone the shared appearance sheet instead (theme-toggle.ts, phone-spec §4.4, 2026-10-12).
 */
@customElement('theme-toggle-icon')
export class ThemeToggleIcon extends LitElement {
  @property({ type: String })
  theme: Theme = 'system';

  @state() private open = false;
  protected readonly i18n = new LocaleController(this);
  @state() private accent = getAccent();

  private readonly STORAGE_KEY = 'untether-theme';
  private mediaQuery?: MediaQueryList;

  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();

    // Load saved theme preference
    let saved: Theme | null = null;
    try {
      saved = localStorage.getItem(this.STORAGE_KEY) as Theme | null;
    } catch {
      // Storage blocked (private mode): fall back to system.
    }
    this.theme = saved || 'system';

    // Set up system preference listener
    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.mediaQuery.addEventListener('change', this.handleSystemThemeChange);

    // Apply initial theme
    this.applyTheme();
    window.addEventListener('theme-changed', this.handleThemeChanged);
    window.addEventListener(LOOK_CHANGED_EVENT, this.handleLookChanged);
    window.addEventListener('untether-accent-changed', this.handleAccentChanged);
    this.accent = getAccent();
    document.documentElement.setAttribute('data-accent', this.accent);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.mediaQuery?.removeEventListener('change', this.handleSystemThemeChange);
    window.removeEventListener('theme-changed', this.handleThemeChanged);
    window.removeEventListener(LOOK_CHANGED_EVENT, this.handleLookChanged);
    window.removeEventListener('untether-accent-changed', this.handleAccentChanged);
    document.removeEventListener('click', this.handleOutsideClick, true);
  }

  private handleLookChanged = () => this.requestUpdate();

  // 2026-11-10: an accent picked in Settings left this panel marking the previous one.
  private handleAccentChanged = (e: Event) => {
    const accent = (e as CustomEvent<{ accent?: string }>).detail?.accent;
    this.accent = accent ?? getAccent();
  };

  /** Theme picked elsewhere (settings, session menu): keep the icon and panel in sync. */
  private handleThemeChanged = (e: Event) => {
    const theme = (e as CustomEvent<{ theme?: Theme }>).detail?.theme;
    if (theme && theme !== this.theme) this.theme = theme;
  };

  private handleOutsideClick = (e: Event) => {
    if (!e.composedPath().includes(this)) this.setOpen(false);
  };

  @state() private panelPosition = '';

  private setOpen(open: boolean) {
    if (open) {
      // Fixed position from the button: headers clip overflow, and the button can sit
      // anywhere from the left edge (phone) to the right (desktop).
      const rect = this.querySelector('button')?.getBoundingClientRect();
      if (rect) {
        // 232 px, wider with the system text size (14.5rem), never wider than the screen.
        const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const width = Math.min(Math.max(232, rootPx * 14.5), window.innerWidth - 16);
        const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
        this.panelPosition = `top: ${rect.bottom + 8}px; left: ${left}px; width: ${width}px;`;
      }
    }
    this.open = open;
    document.removeEventListener('click', this.handleOutsideClick, true);
    if (open) document.addEventListener('click', this.handleOutsideClick, true);
  }

  private selectTheme(theme: Theme) {
    this.theme = theme;
    applyThemeMode(theme);
    this.dispatchEvent(
      new CustomEvent('theme-changed', { detail: { theme }, bubbles: true, composed: true })
    );
  }

  private selectAccent(id: string) {
    this.accent = id;
    applyAccent(id);
  }

  private handleSystemThemeChange = () => {
    if (this.theme === 'system') {
      this.applyTheme();
    }
  };

  private applyTheme() {
    syncThemeMode();
  }

  private getIcon() {
    switch (this.theme) {
      case 'light':
        return icon('sun');
      case 'dark':
        return icon('moon');
      default:
        return icon('monitor');
    }
  }

  private modeLabel(): string {
    return themeModeLabel(this.theme);
  }

  private handleButton = (e: Event) => {
    if (isPhoneScreen()) {
      openAppearanceSheet(e.currentTarget as Element);
      return;
    }
    this.setOpen(!this.open);
  };

  render() {
    // "Sistema" everywhere, the same labels as Settings (one appearance control).
    const modes: Array<[Theme, string]> = THEME_MODES.map((entry) => [entry.mode, t(entry.label)]);
    const locked = lockedThemeMode();
    const accentFixed = accentFixedByLook();
    return html`
      <div class="relative">
        <button
          @click=${this.handleButton}
          class="ut-icon-btn"
          title=${`${t('appearance.title')}: ${this.modeLabel()}`}
          aria-label=${t('appearance.title')}
          aria-haspopup="dialog"
          aria-expanded=${this.open ? 'true' : 'false'}
        >
          ${this.getIcon()}
        </button>
        ${
          this.open
            ? html`
              <div
                class="appearance-panel"
                role="dialog"
                aria-label=${t('appearance.title')}
                style=${this.panelPosition}
              >
                <div class="appearance-modes">
                  ${modes.map(
                    ([mode, label]) => html`
                      <button
                        class="ut-surface--badge appearance-mode ${(locked ?? this.theme) === mode ? 'active' : ''}"
                        aria-pressed=${(locked ?? this.theme) === mode ? 'true' : 'false'}
                        ?disabled=${locked !== undefined}
                        @click=${() => this.selectTheme(mode)}
                      >
                        ${label}
                      </button>
                    `
                  )}
                </div>
                ${locked ? html`<p class="ut-look-note">${lookLockText(locked)}</p>` : ''}
                <div class="appearance-label">${t('appearance.color')}</div>
                <div class="appearance-swatches">
                  ${ACCENT_THEMES.map(
                    (accent) => html`
                      <button
                        class="ut-surface--badge appearance-swatch ${this.accent === accent.id ? 'active' : ''}"
                        style="--swatch: ${accent.color}"
                        title=${t(`theme.${accent.id}` as MessageKey)}
                        aria-label=${t(`theme.${accent.id}` as MessageKey)}
                        aria-pressed=${this.accent === accent.id ? 'true' : 'false'}
                        ?disabled=${accentFixed}
                        @click=${() => this.selectAccent(accent.id)}
                      ></button>
                    `
                  )}
                </div>
                ${accentFixed ? html`<p class="ut-look-note">${t('look.accentFixed')}</p>` : ''}
              </div>
            `
            : ''
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'theme-toggle-icon': ThemeToggleIcon;
  }
}
