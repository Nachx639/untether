/**
 * Color themes: an accent color plus, in dark mode, a background tinted to match.
 * Applied as `data-accent` on <html>; styles.css maps each id to CSS variables.
 * public/index.html applies the saved accent before first paint (no flash).
 */
export interface AccentTheme {
  id: string;
  name: string;
  /** Swatch shown in the picker. */
  color: string;
}

export const ACCENT_THEMES: AccentTheme[] = [
  { id: 'untether', name: 'Untether', color: '#FF6A00' },
  { id: 'emerald', name: 'Emerald', color: '#10B981' },
  { id: 'ocean', name: 'Ocean', color: '#3B82F6' },
  { id: 'violet', name: 'Violet', color: '#8B5CF6' },
  { id: 'sunset', name: 'Sunset', color: '#FF5A5F' },
  { id: 'rose', name: 'Rose', color: '#EC4899' },
  { id: 'cyber', name: 'Cyber', color: '#22D3EE' },
  { id: 'gold', name: 'Gold', color: '#EAB308' },
  { id: 'clay', name: 'Clay', color: '#D97757' },
];

export const ACCENT_STORAGE_KEY = 'untether-accent';
/** The brand orange: what `:root` in styles.css holds when no data-accent is set. */
export const DEFAULT_ACCENT = 'untether';

export function getAccent(): string {
  try {
    const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (saved && ACCENT_THEMES.some((theme) => theme.id === saved)) return saved;
  } catch {
    // Storage blocked (private mode): fall back to the default.
  }
  return DEFAULT_ACCENT;
}

export function applyAccent(id: string): void {
  const accent = ACCENT_THEMES.some((theme) => theme.id === id) ? id : DEFAULT_ACCENT;
  document.documentElement.setAttribute('data-accent', accent);
  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, accent);
  } catch {
    // Not persisted; still applied for this page.
  }
  syncThemeColorMeta();
  window.dispatchEvent(new CustomEvent('untether-accent-changed', { detail: { accent } }));
}

/**
 * Browser chrome (iOS status bar area) and the page's own background follow the real background
 * of the style, mode and accent showing (the first frame's value was set by theme-init).
 */
export function syncThemeColorMeta(): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();
  if (!bg) return;
  if (meta) meta.setAttribute('content', bg);
  document.documentElement.style.backgroundColor = bg;
}
