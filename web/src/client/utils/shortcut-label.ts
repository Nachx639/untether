/**
 * Keyboard shortcut labels for tooltips, menus and .ut-kbd hints (design spec 3).
 *   formatShortcut('mod+k')       → "⌘K" on a Mac, "Ctrl+K" elsewhere
 *   formatShortcut('mod+shift+n') → "⇧⌘N" / "Ctrl+Shift+N"
 *   formatShortcut('esc')         → "⎋" / "Esc"
 * Mac order follows the system menus: ⌃ ⌥ ⇧ ⌘, then the key.
 */

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = data?.platform || navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const MAC_MODIFIERS: Record<string, string> = {
  ctrl: '⌃',
  control: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  mod: '⌘',
  cmd: '⌘',
  meta: '⌘',
};
const OTHER_MODIFIERS: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  mod: 'Ctrl',
  cmd: 'Ctrl',
  meta: 'Win',
};
const MAC_ORDER = ['⌃', '⌥', '⇧', '⌘'];

const MAC_KEYS: Record<string, string> = {
  enter: '↵',
  return: '↵',
  esc: '⎋',
  escape: '⎋',
  backspace: '⌫',
  delete: '⌫',
  tab: '⇥',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  space: 'Space',
};
const OTHER_KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  esc: 'Esc',
  escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Del',
  tab: 'Tab',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  space: 'Space',
};

function keyLabel(key: string, mac: boolean): string {
  const lower = key.toLowerCase();
  const named = (mac ? MAC_KEYS : OTHER_KEYS)[lower];
  if (named) return named;
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

export function formatShortcut(shortcut: string, mac: boolean = isMacPlatform()): string {
  // "mod++" is the plus key itself.
  const parts = shortcut.replace(/\+\+$/, '+plus').split('+').filter(Boolean);
  const key = parts.pop() ?? '';
  const keyText = key === 'plus' ? '+' : keyLabel(key, mac);
  const table = mac ? MAC_MODIFIERS : OTHER_MODIFIERS;
  const mods = parts.map((part) => table[part.toLowerCase()] ?? part);
  if (mac) {
    mods.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
    return `${mods.join('')}${keyText}`;
  }
  return [...mods, keyText].join('+');
}
