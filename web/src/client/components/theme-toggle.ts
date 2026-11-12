/**
 * One appearance control (phone-spec §4.4, 2026-10-12): light / dark / system and the accent
 * swatches, the same pieces in Settings → Appearance and in the phone sheet that the header's
 * ⋯ → Apariencia opens (`openAppearanceSheet`).
 *
 *   renderThemeModes({ mode, onSelect })      segmented Claro | Oscuro | Sistema
 *   renderAccentSwatches({ accent, onSelect }) swatches + the chosen name (aria-live)
 *
 * Swatches are 28 px on a desktop and 32 px in a 5-column grid on touch (dialogs.css); the
 * chosen one has a 2 px gap and a 2 px text-bright ring. "System" is always "Sistema".
 */
import { html, nothing, render, type TemplateResult } from 'lit';
import { type MessageKey, t } from '../i18n/index.js';
import { ACCENT_THEMES, applyAccent, getAccent } from '../utils/accent-themes.js';
import { accentFixedByLook, lockedThemeMode } from '../utils/look.js';
import { attachSheetDrag } from '../utils/mobile-utils.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import { applyThemeMode, getThemeMode, type ThemeMode } from '../utils/theme-mode.js';
import { type IconName, icon } from './icons.js';

export type Theme = ThemeMode;

/** The three modes in display order, with their icon and label. */
export const THEME_MODES: ReadonlyArray<{ mode: ThemeMode; icon: IconName; label: MessageKey }> = [
  { mode: 'light', icon: 'sun', label: 'theme.light' },
  { mode: 'dark', icon: 'moon', label: 'theme.dark' },
  { mode: 'system', icon: 'monitor', label: 'theme.system' },
];

export function themeModeLabel(mode: ThemeMode): string {
  return t(THEME_MODES.find((entry) => entry.mode === mode)?.label ?? 'theme.system');
}

export function renderThemeModes(options: {
  mode: ThemeMode;
  onSelect: (mode: ThemeMode) => void;
  /** data-testid prefix of each button (Settings keeps "settings-theme-"). */
  testIdPrefix?: string;
}): TemplateResult {
  const locked = lockedThemeMode();
  const prefix = options.testIdPrefix ?? 'appearance-theme-';
  return html`<div class="ut-segmented ut-appearance-modes" role="group" aria-label=${t('appearance.title')}>
    ${THEME_MODES.map(
      (entry) => html`
        <button
          type="button"
          aria-pressed=${(locked ?? options.mode) === entry.mode ? 'true' : 'false'}
          ?disabled=${locked !== undefined}
          data-testid="${prefix}${entry.mode}"
          @click=${() => options.onSelect(entry.mode)}
        >
          ${icon(entry.icon)} ${t(entry.label)}
        </button>
      `
    )}
  </div>${locked ? html`<p class="ut-look-note" data-testid="${prefix}locked">${lookLockText(locked)}</p>` : nothing}`;
}

/** Why the mode control is off while a style that is only light or only dark is on. */
export function lookLockText(locked: 'light' | 'dark'): string {
  return t(locked === 'dark' ? 'look.forcedDark' : 'look.forcedLight');
}

export function renderAccentSwatches(options: {
  accent: string;
  onSelect: (id: string) => void;
  testIdPrefix?: string;
}): TemplateResult {
  const prefix = options.testIdPrefix ?? 'appearance-accent-';
  const fixed = accentFixedByLook();
  const [first, ...rest] = ACCENT_THEMES;
  const current = ACCENT_THEMES.find((accent) => accent.id === options.accent) ?? first;
  const swatch = (accent: (typeof ACCENT_THEMES)[number]) => html`
    <button
      type="button"
      class="st-swatch"
      style="--swatch: ${accent.color}"
      title=${t(`theme.${accent.id}` as MessageKey)}
      aria-label=${t(`theme.${accent.id}` as MessageKey)}
      aria-pressed=${options.accent === accent.id ? 'true' : 'false'}
      ?disabled=${fixed}
      data-testid="${prefix}${accent.id}"
      @click=${() => options.onSelect(accent.id)}
    ></button>
  `;
  return html`
    <div class="st-swatches" role="group" aria-label=${t('settings.accent')}>
      ${swatch(first)}
      <span class="st-swatch-divider" aria-hidden="true"></span>
      ${rest.map(swatch)}
      <span class="st-swatch-name" aria-live="polite">${t(`theme.${current.id}` as MessageKey)}</span>
    </div>
    ${fixed ? html`<p class="ut-look-note" data-testid="${prefix}fixed">${t('look.accentFixed')}</p>` : nothing}
  `;
}

/** Applies a mode and tells the rest of the app (header icon, settings, session menu). */
export function chooseThemeMode(mode: ThemeMode): void {
  applyThemeMode(mode);
  window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: mode } }));
}

let sheetHost: HTMLElement | null = null;
let releaseSheet: (() => void) | null = null;

export function closeAppearanceSheet(): void {
  const host = sheetHost;
  if (!host) return;
  sheetHost = null;
  render(nothing, host);
  host.remove();
  releaseSheet?.();
  releaseSheet = null;
}

/**
 * Phones: the appearance control as a bottom content sheet (grabber, swipe down, Listo).
 * For the header's ⋯ → Apariencia and theme-toggle-icon on a phone.
 */
export function openAppearanceSheet(opener: Element | null = document.activeElement): void {
  closeAppearanceSheet();
  const host = document.createElement('div');
  document.body.appendChild(host);
  sheetHost = host;
  let mode = getThemeMode();
  let accent = getAccent();
  const paint = () => {
    if (sheetHost !== host) return;
    render(
      html`
        <div class="p-sheet-backdrop" @click=${closeAppearanceSheet}></div>
        <div
          class="p-sheet ut-appearance-sheet ut-surface--floating ut-surface--material ut-surface--fixed"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ut-appearance-title"
          data-testid="appearance-sheet"
        >
          <div class="ut-grabber" data-sheet-handle aria-hidden="true"></div>
          <div class="p-sheet-header" data-sheet-handle>
            <span></span>
            <h2 id="ut-appearance-title" class="p-sheet-title">${t('appearance.title')}</h2>
            <button
              type="button"
              class="p-sheet-text-btn p-sheet-text-btn--end ut-surface--control"
              data-testid="appearance-sheet-done"
              @click=${closeAppearanceSheet}
            >
              ${t('phone.settings.done')}
            </button>
          </div>
          <div class="p-sheet-body ut-appearance-body">
            <p class="ut-section-label">${t('phone.appearance.mode')}</p>
            ${renderThemeModes({
              mode,
              onSelect: (next) => {
                mode = next;
                chooseThemeMode(next);
                paint();
              },
            })}
            <p class="ut-section-label">${t('settings.accent')}</p>
            ${renderAccentSwatches({
              accent,
              onSelect: (id) => {
                accent = id;
                applyAccent(id);
                paint();
              },
            })}
          </div>
        </div>
      `,
      host
    );
  };
  paint();
  const sheet = host.querySelector<HTMLElement>('.p-sheet');
  if (!sheet) return;
  const releaseFocus = holdSheetFocus(sheet, closeAppearanceSheet, opener);
  const detachDrag = attachSheetDrag(sheet, { onDismiss: closeAppearanceSheet });
  releaseSheet = () => {
    releaseFocus();
    detachDrag();
  };
  requestAnimationFrame(() => sheet.classList.add('open'));
}
