/**
 * Browser shortcut detection utilities
 * Centralized logic for detecting browser keyboard shortcuts
 */

// Apple mobile hardware keyboards use Command even when navigator.platform is iPhone/iPad.
function isApplePlatform(): boolean {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  return platform.includes('mac') || /iphone|ipad|ipod/.test(`${platform} ${userAgent}`);
}

function isAppleMobilePlatform(): boolean {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  return (
    /iphone|ipad|ipod/.test(`${platform} ${userAgent}`) ||
    (platform === 'macintel' && navigator.maxTouchPoints > 1)
  );
}

// Constants for magic patterns
const TAB_NUMBER_REGEX = /^[0-9]$/; // Now includes 0 for Cmd+0/Ctrl+0

// Critical browser shortcuts that should never be captured
const CRITICAL_SHORTCUTS = {
  mac: {
    withCmd: {
      noModifiers: ['t', 'n', 'w', 'q', 'h', 'm', ','],
      withShift: ['t', 'n', 'a', 'z', ']', '[', 'j', 'c'],
      withAlt: ['w'],
    },
  },
  other: {
    withCtrl: {
      noModifiers: ['t', 'n', 'w', 'h'],
      withShift: ['t', 'n', 'j', 'c'],
      withAlt: ['f4'],
    },
  },
};

// Copy/paste shortcuts
const COPY_PASTE_SHORTCUTS = {
  mac: ['c', 'x', 'v'],
  other: ['c', 'x', 'v'],
};

export interface KeyboardShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Checks if a keyboard event matches a browser shortcut that should not be captured
 */
export function isBrowserShortcut(event: KeyboardShortcutEvent): boolean {
  const { key, ctrlKey, metaKey, altKey, shiftKey } = event;
  const keyLower = key.toLowerCase();

  // iOS/iPadOS reserves Command chords for browser and system actions.
  if (isAppleMobilePlatform() && metaKey && !ctrlKey) {
    return true;
  }

  // Platform-specific primary modifier
  const primaryModifier = isApplePlatform() ? metaKey : ctrlKey;
  const wrongModifier = isApplePlatform() ? ctrlKey : metaKey;

  // Early return if wrong modifier for platform
  if (wrongModifier || !primaryModifier) {
    // Special case: Alt+F4 on Windows
    if (!isApplePlatform() && altKey && !ctrlKey && !metaKey && !shiftKey && keyLower === 'f4') {
      return true;
    }
    return false;
  }

  // Check modifier combinations
  const modifierKey = shiftKey ? 'withShift' : altKey ? 'withAlt' : 'noModifiers';
  const platform = isApplePlatform() ? 'mac' : 'other';
  const shortcuts = isApplePlatform()
    ? CRITICAL_SHORTCUTS.mac.withCmd
    : CRITICAL_SHORTCUTS.other.withCtrl;

  // Check critical shortcuts
  if (shortcuts[modifierKey]?.includes(keyLower)) {
    return true;
  }

  // Check tab switching and copy/paste (only for no additional modifiers)
  if (!shiftKey && !altKey) {
    // Tab switching
    if (TAB_NUMBER_REGEX.test(key)) {
      return true;
    }
    // Copy/paste
    if (COPY_PASTE_SHORTCUTS[platform].includes(keyLower)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if this is a copy/paste shortcut
 */
export function isCopyPasteShortcut(event: KeyboardShortcutEvent): boolean {
  const { key, ctrlKey, metaKey, altKey, shiftKey } = event;
  const keyLower = key.toLowerCase();

  if (isApplePlatform()) {
    return (
      metaKey && !ctrlKey && !altKey && !shiftKey && COPY_PASTE_SHORTCUTS.mac.includes(keyLower)
    );
  } else {
    return (
      ctrlKey && !metaKey && !altKey && !shiftKey && COPY_PASTE_SHORTCUTS.other.includes(keyLower)
    );
  }
}

/**
 * Gets the platform name for display
 */
export function getPlatformName(): 'mac' | 'windows' | 'linux' {
  if (isApplePlatform()) return 'mac';
  if (navigator.platform.toLowerCase().includes('win')) return 'windows';
  return 'linux';
}

/**
 * Formats a keyboard shortcut for display based on the current platform
 */
export function formatShortcut(mac: string, other: string): string {
  return isApplePlatform() ? mac : other;
}

/**
 * Untether's own shortcuts (design spec 5.4, 2026-10-12). They use Command only (Mac, and
 * iPad with a keyboard), so Ctrl+K / Ctrl+B / Ctrl+O keep their terminal meaning everywhere.
 *   ⌘K palette   ⌘, settings   ⌘O files   ⌘B sidebar   ⌘1–9 session N   ⇧⌘N new session
 *   ? shortcut sheet (only outside text fields; the caller decides where it applies)
 * Checked before isBrowserShortcut(), which would otherwise keep ⌘, ⌘1–9 and ⇧⌘N for the
 * browser.
 */
export type AppShortcut =
  | { kind: 'palette' }
  | { kind: 'settings' }
  | { kind: 'files' }
  | { kind: 'sidebar' }
  | { kind: 'new-session' }
  | { kind: 'help' }
  | { kind: 'switch'; index: number };

export function matchAppShortcut(event: KeyboardShortcutEvent): AppShortcut | null {
  const { key, ctrlKey, metaKey, altKey, shiftKey } = event;
  if (!key) return null;
  if (!metaKey && !ctrlKey && !altKey && key === '?') return { kind: 'help' };
  if (!metaKey || ctrlKey || altKey) return null;
  const lower = key.toLowerCase();
  if (shiftKey) return lower === 'n' ? { kind: 'new-session' } : null;
  if (lower === 'k') return { kind: 'palette' };
  if (key === ',') return { kind: 'settings' };
  if (lower === 'o') return { kind: 'files' };
  if (lower === 'b') return { kind: 'sidebar' };
  if (/^[1-9]$/.test(key)) return { kind: 'switch', index: Number(key) - 1 };
  return null;
}
