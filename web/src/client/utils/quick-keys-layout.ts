import { type MessageKey, t } from '../i18n/index.js';

interface QuickKeyAttributes {
  key: string;
  label: string;
  modifier?: boolean;
  toggle?: boolean;
  arrow?: boolean;
  combo?: boolean;
}

export const QUICK_KEY_DEFINITIONS = [
  { key: 'Escape', label: 'Esc' },
  { key: 'Control', label: 'Ctrl', modifier: true },
  { key: 'CtrlExpand', label: '⌃', toggle: true },
  { key: 'F', label: 'F', toggle: true },
  { key: 'Symbols', label: '#+', toggle: true },
  { key: 'Tab', label: 'Tab' },
  { key: 'shift_tab', label: '⇤' },
  { key: 'Enter', label: '↵' },
  { key: 'ArrowUp', label: '↑', arrow: true },
  { key: 'ArrowDown', label: '↓', arrow: true },
  { key: 'ArrowLeft', label: '←', arrow: true },
  { key: 'ArrowRight', label: '→', arrow: true },
  { key: 'PageUp', label: 'PgUp' },
  { key: 'PageDown', label: 'PgDn' },
  { key: 'Home', label: 'Home' },
  { key: 'Paste', label: 'Paste' },
  { key: 'End', label: 'End' },
  { key: 'Delete', label: 'Del' },
  { key: '`', label: '`' },
  { key: '~', label: '~' },
  { key: '|', label: '|' },
  { key: '/', label: '/' },
  { key: '\\', label: '\\' },
  { key: '-', label: '-' },
  { key: 'Option', label: '⌥', modifier: true },
  { key: 'Command', label: '⌘', modifier: true },
  { key: 'Ctrl+C', label: '^C', combo: true },
  { key: 'Ctrl+Z', label: '^Z', combo: true },
  // Claude Code's "send now" while it works (agent-chords.ts), for a layout that wants it in
  // one tap. Not in the ⌃ row: one more key there pushed Listo off a 390 pt phone.
  { key: 'Ctrl+X Ctrl+S', label: '^X^S', combo: true },
  { key: "'", label: "'" },
  { key: '"', label: '"' },
  { key: '{', label: '{' },
  { key: '}', label: '}' },
  { key: '[', label: '[' },
  { key: ']', label: ']' },
  { key: '(', label: '(' },
  { key: ')', label: ')' },
  { key: '@', label: '@' },
  { key: '!', label: '!' },
  { key: '>', label: '>' },
  { key: '<', label: '<' },
  { key: '&', label: '&' },
  { key: '*', label: '*' },
  { key: '$', label: '$' },
  { key: '_', label: '_' },
  { key: '=', label: '=' },
  { key: ';', label: ';' },
] as const satisfies readonly QuickKeyAttributes[];

export type QuickKeyId = (typeof QUICK_KEY_DEFINITIONS)[number]['key'];
export type QuickKeyDefinition = QuickKeyAttributes & { key: QuickKeyId };
export type QuickKeysLayout = QuickKeyId[][];

export const DEFAULT_QUICK_KEYS_LAYOUT: QuickKeysLayout = [
  [
    'Escape',
    'Control',
    'CtrlExpand',
    'F',
    'Tab',
    'shift_tab',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'PageUp',
    'PageDown',
  ],
  ['Home', 'Paste', 'End', 'Delete', '`', '~', '|', '/', '\\', '-', 'Symbols', 'Enter'],
  ['Option', 'Command', 'Ctrl+C', 'Ctrl+Z', "'", '"', '{', '}', '[', ']', '(', ')'],
];

export const COMPACT_QUICK_KEYS_LAYOUT: QuickKeysLayout = [
  [
    'Escape',
    'Control',
    'Tab',
    'shift_tab',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'PageUp',
    'PageDown',
  ],
  ['Home', 'Paste', 'End', 'Delete', 'Option', 'Command', 'Ctrl+C', 'Ctrl+Z', '/', '-'],
];

/**
 * Phones: two rows tuned for coding agents (Claude Code: Esc interrupts, ⇧Tab cycles modes,
 * @ mentions files, ! runs shell, / opens commands). Brackets and quotes stay on the iOS
 * keyboard, and the dropped third row gives the terminal about three more lines.
 */
export const PHONE_QUICK_KEYS_LAYOUT: QuickKeysLayout = [
  [
    'Escape',
    'shift_tab',
    'Tab',
    'Ctrl+C',
    'Control',
    'CtrlExpand',
    'Symbols',
    'ArrowLeft',
    'ArrowUp',
    'ArrowDown',
    'ArrowRight',
  ],
  ['Paste', '/', '@', '!', '-', '|', '~', 'Home', 'End', 'Delete', 'Enter'],
];

/**
 * Shell symbols that sit two or three taps deep on the iOS keyboard (redirects, pipes,
 * globs, variables, braces). The #+ toggle swaps them into the second row.
 */
export const SYMBOL_QUICK_KEYS: QuickKeyId[] = [
  '>',
  '<',
  '&',
  '*',
  '$',
  '_',
  '=',
  ';',
  '{',
  '}',
  '[',
  ']',
];

export const QUICK_KEYS_PRESETS = [
  { id: 'default', name: 'Default', layout: DEFAULT_QUICK_KEYS_LAYOUT },
  { id: 'compact', name: 'Compact', layout: COMPACT_QUICK_KEYS_LAYOUT },
  { id: 'phone', name: 'Claude (phone)', layout: PHONE_QUICK_KEYS_LAYOUT },
] as const;

function defaultLayout(): QuickKeysLayout {
  const shortestSide =
    typeof window === 'undefined'
      ? Number.POSITIVE_INFINITY
      : Math.min(window.screen.width, window.screen.height);
  return shortestSide < 600 ? PHONE_QUICK_KEYS_LAYOUT : DEFAULT_QUICK_KEYS_LAYOUT;
}

export const QUICK_KEYS_STORAGE_KEY = 'untether.quickKeys.v1';
export const QUICK_KEYS_LAYOUT_CHANGED_EVENT = 'untether-quick-keys-layout-changed';

const STORAGE_VERSION = 1;
const MIN_ROWS = 2;
const MAX_ROWS = 3;
const MAX_KEYS_PER_ROW = 12;
const VALID_KEY_IDS = new Set<string>(QUICK_KEY_DEFINITIONS.map(({ key }) => key));
const DEFINITION_BY_ID = new Map<QuickKeyId, QuickKeyDefinition>(
  QUICK_KEY_DEFINITIONS.map((definition) => [definition.key, definition as QuickKeyDefinition])
);

function cloneLayout(layout: QuickKeysLayout): QuickKeysLayout {
  return layout.map((row) => [...row]);
}

export function isValidQuickKeysLayout(value: unknown): value is QuickKeysLayout {
  if (!Array.isArray(value) || value.length < MIN_ROWS || value.length > MAX_ROWS) {
    return false;
  }

  const usedKeys = new Set<string>();
  for (const row of value) {
    if (!Array.isArray(row) || row.length === 0 || row.length > MAX_KEYS_PER_ROW) {
      return false;
    }

    for (const key of row) {
      if (typeof key !== 'string' || !VALID_KEY_IDS.has(key) || usedKeys.has(key)) {
        return false;
      }
      usedKeys.add(key);
    }
  }

  return true;
}

export function loadQuickKeysLayout(): QuickKeysLayout {
  try {
    const stored = localStorage.getItem(QUICK_KEYS_STORAGE_KEY);
    if (!stored) {
      return cloneLayout(defaultLayout());
    }

    const parsed = JSON.parse(stored) as { version?: unknown; rows?: unknown };
    if (parsed.version === STORAGE_VERSION && isValidQuickKeysLayout(parsed.rows)) {
      return cloneLayout(parsed.rows);
    }
  } catch {
    // Storage can be unavailable in private browsing or restricted embedded contexts.
  }

  return cloneLayout(defaultLayout());
}

export function saveQuickKeysLayout(layout: QuickKeysLayout): boolean {
  if (!isValidQuickKeysLayout(layout)) {
    return false;
  }

  try {
    localStorage.setItem(
      QUICK_KEYS_STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, rows: layout })
    );
    window.dispatchEvent(new CustomEvent(QUICK_KEYS_LAYOUT_CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
}

export function resetQuickKeysLayout(): boolean {
  try {
    localStorage.removeItem(QUICK_KEYS_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent(QUICK_KEYS_LAYOUT_CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
}

export function subscribeToQuickKeysLayout(listener: () => void): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === QUICK_KEYS_STORAGE_KEY) {
      listener();
    }
  };

  window.addEventListener(QUICK_KEYS_LAYOUT_CHANGED_EVENT, listener);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(QUICK_KEYS_LAYOUT_CHANGED_EVENT, listener);
    window.removeEventListener('storage', handleStorage);
  };
}

export function getQuickKeyDefinition(key: QuickKeyId): QuickKeyDefinition {
  const definition = DEFINITION_BY_ID.get(key);
  if (!definition) {
    throw new Error(`Unknown quick key: ${key}`);
  }
  return definition;
}

/** Keys whose label is a word get translated; key caps (Esc, Tab, Ctrl, PgUp, Del...) stay as is. */
const WORD_LABEL_KEYS: Partial<Record<string, MessageKey>> = {
  Paste: 'quickKeys.paste',
  Home: 'quickKeys.home',
  End: 'quickKeys.end',
};

/** Accessible names for keys whose cap is a glyph rather than a word. */
const ARIA_LABEL_KEYS: Partial<Record<string, MessageKey>> = {
  Symbols: 'quickKeys.symbols',
  // VoiceOver reads these caps as "caret D", "P G U P", "up arrowhead"…
  Escape: 'a11y.key.escape',
  Control: 'a11y.key.control',
  CtrlExpand: 'a11y.key.controlKeys',
  F: 'a11y.key.functionKeys',
  shift_tab: 'a11y.key.shiftTab',
  Enter: 'a11y.key.enter',
  PageUp: 'a11y.key.pageUp',
  PageDown: 'a11y.key.pageDown',
  Delete: 'a11y.key.delete',
  Option: 'a11y.key.option',
  Command: 'a11y.key.command',
  'Ctrl+X Ctrl+S': 'phone.sendNow',
};

/** What a key is for, when its name alone doesn't tell (shown in the quick keys editor). */
const HINT_KEYS: Partial<Record<string, MessageKey>> = {
  shift_tab: 'quickKeys.hint.shiftTab',
};

/** Spoken/written name plus purpose of a quick key for the editor: "Shift Tab · Cycles modes in Claude Code". */
export function getQuickKeyDescription(key: string): string | undefined {
  const name = getQuickKeyAriaLabel(key);
  const hintKey = HINT_KEYS[key];
  const hint = hintKey ? t(hintKey) : undefined;
  if (name && hint) return `${name} · ${hint}`;
  return name ?? hint;
}

/** Accessible name for a quick key, when its cap alone doesn't say what it does. */
export function getQuickKeyAriaLabel(key: string): string | undefined {
  const messageKey = ARIA_LABEL_KEYS[key];
  if (messageKey) return t(messageKey);
  // "Ctrl+C" → "Control C"
  const combo = /^Ctrl\+(.+)$/.exec(key);
  return combo ? t('a11y.key.controlCombo', { key: combo[1] }) : undefined;
}

/** The label to show for a quick key in the active language. */
export function getQuickKeyDisplayLabel(key: string, label: string): string {
  const messageKey = WORD_LABEL_KEYS[key];
  return messageKey ? t(messageKey) : label;
}

const PRESET_NAME_KEYS: Record<string, MessageKey> = {
  default: 'quickKeys.preset.default',
  compact: 'quickKeys.preset.compact',
  phone: 'quickKeys.preset.phone',
};

/** Preset name in the active language. */
export function getQuickKeysPresetName(preset: { id: string; name: string }): string {
  const messageKey = PRESET_NAME_KEYS[preset.id];
  return messageKey ? t(messageKey) : preset.name;
}

export function getHiddenQuickKeys(layout: QuickKeysLayout): QuickKeyDefinition[] {
  const visible = new Set(layout.flat());
  return QUICK_KEY_DEFINITIONS.filter(({ key }) => !visible.has(key)) as QuickKeyDefinition[];
}

/** Marks the hidden textarea that receives soft-keyboard typing for the terminal. */
export const DIRECT_KEYBOARD_INPUT_ATTRIBUTE = 'data-direct-keyboard-input';

/**
 * The control character Ctrl+<char> produces in a terminal (Ctrl+C → \x03, Ctrl+[ → ESC,
 * Ctrl+Space → NUL), or null when the character has none.
 */
export function controlCharacterFor(char: string): string | null {
  if (char === ' ') return '\x00';
  if (char === '?') return '\x7f';
  const code = char.toUpperCase().charCodeAt(0);
  if (char.length === 1 && code >= 0x40 && code <= 0x5f) {
    return String.fromCharCode(code - 0x40);
  }
  return null;
}
