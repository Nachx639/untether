import { html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { LocaleController, t } from '../i18n/index.js';
import { Z_INDEX } from '../utils/constants.js';
import {
  type QuickKeyRowSizing,
  quickKeyMinWidth,
  quickKeyRowFits,
  quickKeyRowSizing,
} from '../utils/quick-key-sizing.js';
import {
  controlCharacterFor,
  DIRECT_KEYBOARD_INPUT_ATTRIBUTE,
  getQuickKeyAriaLabel,
  getQuickKeyDefinition,
  getQuickKeyDisplayLabel,
  loadQuickKeysLayout,
  PHONE_QUICK_KEYS_LAYOUT,
  type QuickKeyDefinition,
  type QuickKeyId,
  type QuickKeysLayout,
  SYMBOL_QUICK_KEYS,
  subscribeToQuickKeysLayout,
} from '../utils/quick-keys-layout.js';
import { ShortLandscapeController } from '../utils/short-landscape.js';
import { BottomChrome } from './mobile-action-bar.js';

/**
 * The phone preset as the session view shows it (phone spec 3.9, 2026-10-12): about nine keys
 * a row so each is ≥ 32 px with one readable caption size. Paste lives in the action bar; ⇤,
 * Home, End and Del move to the #+ page. A layout the user edited is shown as saved.
 */
export const SESSION_PHONE_ROWS: QuickKeysLayout = [
  [
    'Escape',
    'Tab',
    'Ctrl+C',
    'Control',
    'Symbols',
    'ArrowLeft',
    'ArrowUp',
    'ArrowDown',
    'ArrowRight',
  ],
  ['/', '@', '!', '-', '|', '~', 'CtrlExpand', 'Enter'],
];
/** Keys of the phone preset that moved to the #+ page. */
const SYMBOL_PAGE_EXTRAS: QuickKeyId[] = ['shift_tab', 'Home', 'End', 'Delete'];
/** The symbols page splits in two rows past this many keys. */
const SYMBOL_PAGE_ROW_MAX = 10;
/** A visible viewport shorter than this (keyboard up in landscape) gets one row of keys. */
export const SINGLE_ROW_MAX_VIEWPORT_PX = 420;
/** The one-time "swipe the bar" hint. */
const SWIPE_HINT_KEY = 'ut-quick-keys-swipe-hint-seen';

function sameLayout(a: QuickKeysLayout, b: QuickKeysLayout): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => row.length === b[i].length && row.every((key, j) => key === b[i][j]))
  );
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    // Storage unavailable: count the flag as set, so a hint never repeats on every open.
    return true;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // Storage unavailable (private browsing): nothing saved; readFlag then reads "seen" (2026-11-10: this said the hint showed again).
  }
}

// Common Ctrl key combinations
const CTRL_SHORTCUTS = [
  { key: 'Ctrl+D', label: '^D', combo: true, description: 'EOF/logout' },
  { key: 'Ctrl+L', label: '^L', combo: true, description: 'Clear screen' },
  { key: 'Ctrl+R', label: '^R', combo: true, description: 'Reverse search' },
  { key: 'Ctrl+W', label: '^W', combo: true, description: 'Delete word' },
  { key: 'Ctrl+U', label: '^U', combo: true, description: 'Clear line' },
  { key: 'Ctrl+A', label: '^A', combo: true, description: 'Start of line' },
  { key: 'Ctrl+E', label: '^E', combo: true, description: 'End of line' },
  { key: 'Ctrl+K', label: '^K', combo: true, description: 'Kill to EOL' },
  { key: 'CtrlFull', label: 'Ctrl…', special: true, description: 'Full Ctrl UI' },
];

// Function keys F1-F12
const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => ({
  key: `F${i + 1}`,
  label: `F${i + 1}`,
  func: true,
}));

/** Press-and-hold auto-repeat timing, close to the iOS keyboard's own backspace repeat. */
export const KEY_REPEAT_INITIAL_DELAY_MS = 400;
export const KEY_REPEAT_INTERVAL_MS = 60;
/** Horizontal finger travel on the quick-keys bar per cursor step. */
export const SWIPE_STEP_PX = 16;
/** Mouse events iOS synthesizes after a touch must not press the key a second time. */
const SYNTHETIC_MOUSE_WINDOW_MS = 800;

/** Keys that repeat while held: cursor movement and forward delete. */
function isRepeatableKey(key: string): boolean {
  return key.startsWith('Arrow') || key === 'Delete';
}

/** Two taps on Ctrl or ⌥ within this window lock the modifier instead of releasing it. */
export const MODIFIER_LOCK_WINDOW_MS = 350;
const STICKY_MODIFIERS = ['Control', 'Option'] as const;
type StickyModifier = (typeof STICKY_MODIFIERS)[number];

function isStickyModifier(key: string): key is StickyModifier {
  return (STICKY_MODIFIERS as readonly string[]).includes(key);
}

// Done button - always visible (label is translated at render time)
const DONE_BUTTON = { key: 'Done', special: true };

/** Word labels (Paste, Home, End) are translated; key caps (Esc, Tab, Ctrl...) stay as is. */
const displayLabel = getQuickKeyDisplayLabel;

@customElement('terminal-quick-keys')
export class TerminalQuickKeys extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ type: Function }) onKeyPress?: (
    key: string,
    isModifier?: boolean,
    isSpecial?: boolean,
    isToggle?: boolean,
    pasteText?: string
  ) => void;
  @property({ type: Boolean }) visible = false;
  /** Render in the layout flow (phone session view) instead of fixed above the keyboard. */
  @property({ type: Boolean }) docked = false;

  @state() private showFunctionKeys = false;
  @state() private showCtrlKeys = false;
  @state() private showSymbolKeys = false;
  @state() private viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
  /**
   * A phone on its side (utils/short-landscape.ts), 2026-10-04: the two rows of keys took
   * about 90 pt of a screen 300 pt tall, keyboard still down. Both rows go in one when they
   * fit (singleRow); an expanded row (Ctrl, symbols, F-keys) still opens as a second one.
   */
  private readonly shortLandscape = new ShortLandscapeController(this);
  @state() private singleRow = false;
  /** The bar's width inside its safe-area padding (px), once laid out; 0 before. */
  @state() private barContentWidth = 0;
  @state() private quickKeysLayout: QuickKeysLayout = loadQuickKeysLayout();
  /** The visible viewport's height (the keyboard shrinks it). */
  @state() private viewportHeight =
    typeof window === 'undefined' ? 0 : (window.visualViewport?.height ?? window.innerHeight);
  @state() private showSwipeHint = false;
  private swipeHintTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly bottomChrome = new BottomChrome();

  private keyRepeatInterval: number | null = null;
  private keyRepeatTimeout: number | null = null;
  private lastTouchAt = 0;
  /** Whether the held key has already been pressed (by the mouse or the hold timer). */
  private repeatPressed = false;
  private swipeActive = false;
  private pressedButton: HTMLElement | undefined;
  private swipeSteps = 0;
  private orientationHandler: (() => void) | null = null;
  private quickKeysLayoutUnsubscribe?: () => void;

  // Chord system state: armed modifiers, and which of them are locked by a double tap
  private activeModifiers = new Set<string>();
  private lockedModifiers = new Set<string>();
  private modifierTappedAt = new Map<string, number>();
  private intercepting = false;

  // Touch tracking for scroll detection
  private touchStartY = 0;
  private touchStartX = 0;
  private isTouchMoving = false;

  connectedCallback() {
    super.connectedCallback();
    // Check orientation on mount
    this.checkOrientation();

    // Set up orientation change listener
    this.orientationHandler = () => {
      this.checkOrientation();
    };

    window.addEventListener('resize', this.orientationHandler);
    window.addEventListener('orientationchange', this.orientationHandler);

    // Add passive touch listeners for smooth scrolling
    // We attach to the component host itself since it captures events from shadow DOM
    this.addEventListener('touchstart', this.handleDelegatedTouchStart, { passive: true });
    this.addEventListener('touchmove', this.handleDelegatedTouchMove, { passive: true });
    // Capture: the buttons stop touchend propagation
    this.addEventListener('touchend', this.releasePressedButton, { capture: true, passive: true });
    this.addEventListener('touchcancel', this.releasePressedButton, {
      capture: true,
      passive: true,
    });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.visible) this.bottomChrome.sync(this);
      });
      this.resizeObserver.observe(this);
    }
    window.visualViewport?.addEventListener('resize', this.orientationHandler);

    this.quickKeysLayout = loadQuickKeysLayout();
    this.quickKeysLayoutUnsubscribe = subscribeToQuickKeysLayout(() => {
      this.quickKeysLayout = loadQuickKeysLayout();
    });
  }

  private checkOrientation() {
    // Consider landscape if width is greater than height
    // and width is more than 600px (typical phone landscape width)
    this.viewportWidth = window.innerWidth;
    this.viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  }

  /** Padding and font for a row with these labels (Done included), so it fits the screen. */
  private getRowSizing(labels: readonly string[]): QuickKeyRowSizing {
    return quickKeyRowSizing(labels, this.rowWidth);
  }

  /**
   * Room for a row: the bar inside its safe-area padding once measured (a phone on its side
   * keeps its keys clear of the Dynamic Island), else the window.
   */
  private get rowWidth(): number {
    return this.barContentWidth > 0 ? this.barContentWidth : this.viewportWidth;
  }

  willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);
    const rows = this.getQuickKeyRows();
    const expanded = this.showCtrlKeys || this.showSymbolKeys || this.showFunctionKeys;
    const short =
      this.shortLandscape.value ||
      (this.viewportHeight > 0 && this.viewportHeight < SINGLE_ROW_MAX_VIEWPORT_PX);
    this.singleRow =
      short &&
      rows.length > 1 &&
      !expanded &&
      quickKeyRowFits(
        [...rows.flat().map((definition) => this.quickKeyLabel(definition)), t('quickKeys.done')],
        this.rowWidth
      );
  }

  private measureBar() {
    const bar = this.querySelector<HTMLElement>('.quick-keys-bar');
    if (!bar?.clientWidth) return;
    const style = getComputedStyle(bar);
    const width =
      bar.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0);
    if (width > 0 && Math.abs(width - this.barContentWidth) >= 1) this.barContentWidth = width;
  }

  private quickKeyLabel(definition: QuickKeyDefinition): string {
    return displayLabel(definition.key, definition.label);
  }

  // Delegated touch start handler (passive)
  private handleDelegatedTouchStart = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    this.touchStartY = touch.clientY;
    this.touchStartX = touch.clientX;
    this.isTouchMoving = false;
    this.lastTouchAt = Date.now();
    this.swipeActive = false;
    this.swipeSteps = 0;

    const target = e
      .composedPath()
      .find((el) => el instanceof HTMLElement && el.classList.contains('quick-key-btn')) as
      | HTMLElement
      | undefined;
    this.setPressedButton(
      e
        .composedPath()
        .find(
          (el) =>
            el instanceof HTMLElement &&
            (el.classList.contains('quick-key-btn') ||
              el.classList.contains('ctrl-shortcut-btn') ||
              el.classList.contains('func-key-btn'))
        ) as HTMLElement | undefined
    );

    // Arrows and Del repeat while held. A finger presses on release (see touchend) so a
    // swipe that starts on them doesn't press them.
    const key = target?.getAttribute('data-key');
    if (key && isRepeatableKey(key)) {
      this.startKeyRepeat(key, false);
    }
  };

  // Delegated touch move handler (passive)
  private handleDelegatedTouchMove = (e: TouchEvent) => {
    const touch = e.touches[0];
    const deltaY = Math.abs(touch.clientY - this.touchStartY);
    const deltaX = Math.abs(touch.clientX - this.touchStartX);

    // Reduced threshold from 10px to 5px for better scroll detection
    if (deltaY > 5 || deltaX > 5) {
      this.isTouchMoving = true;
      this.setPressedButton(undefined);
    }

    // A held key tolerates some finger drift before the repeat is cancelled.
    if (deltaY > 12 || deltaX > 12) {
      this.stopKeyRepeat();
    }

    // Swiping sideways along the bar moves the cursor like a trackpad: one arrow key per
    // SWIPE_STEP_PX, back and forth. The rows never scroll horizontally, so nothing fights it.
    if (!this.swipeActive && deltaX >= SWIPE_STEP_PX && deltaX > deltaY * 1.5) {
      this.swipeActive = true;
      this.hideSwipeHint(true);
      this.stopKeyRepeat();
    }
    if (this.swipeActive) {
      const steps = Math.trunc((touch.clientX - this.touchStartX) / SWIPE_STEP_PX);
      while (this.swipeSteps < steps) {
        this.swipeSteps++;
        this.onKeyPress?.('ArrowRight', false, false, false);
      }
      while (this.swipeSteps > steps) {
        this.swipeSteps--;
        this.onKeyPress?.('ArrowLeft', false, false, false);
      }
    }
  };

  private releasePressedButton = () => {
    this.setPressedButton(undefined);
  };

  /** Highlights the key under the finger until it lifts or starts a swipe. */
  private setPressedButton(button: HTMLElement | undefined) {
    if (this.pressedButton === button) return;
    this.pressedButton?.classList.remove('pressed');
    this.pressedButton = button;
    button?.classList.add('pressed');
  }

  // Keep handleTouchEnd for non-passive usage in @touchend
  private handleTouchEnd(e: TouchEvent, callback: () => void) {
    if (!this.isTouchMoving) {
      // Only preventDefault for actual taps
      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();
      callback();
    }
    // Don't preventDefault if user was scrolling - let iOS handle it naturally
    this.isTouchMoving = false;
  }

  updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    this.measureBar();
    if (changedProperties.has('visible') && !this.visible) {
      this.stopKeyRepeat();
      this.clearStickyModifiers();
      this.hideSwipeHint(false);
      this.bottomChrome.clear();
    }
    if (changedProperties.has('visible') && this.visible) {
      this.bottomChrome.sync(this);
      this.maybeShowSwipeHint();
    }
    if (
      changedProperties.has('visible') ||
      changedProperties.has('showFunctionKeys') ||
      changedProperties.has('showCtrlKeys') ||
      changedProperties.has('showSymbolKeys') ||
      changedProperties.has('singleRow') ||
      changedProperties.has('showSwipeHint') ||
      changedProperties.has('quickKeysLayout')
    ) {
      this.dispatchEvent(
        new CustomEvent('quick-keys-layout-change', {
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  private handleKeyPress(
    key: string,
    isModifier = false,
    isSpecial = false,
    isToggle = false,
    event?: Event
  ) {
    // Prevent default to avoid any focus loss
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (isToggle && key === 'F') {
      // Toggle function keys display
      this.showFunctionKeys = !this.showFunctionKeys;
      this.showCtrlKeys = false; // Hide Ctrl keys if showing
      this.showSymbolKeys = false;
      return;
    }

    if (isToggle && key === 'CtrlExpand') {
      // Toggle Ctrl shortcuts display
      this.showCtrlKeys = !this.showCtrlKeys;
      this.showFunctionKeys = false; // Hide function keys if showing
      this.showSymbolKeys = false;
      return;
    }

    if (isToggle && key === 'Symbols') {
      // Shell symbols row; stays open while typing things like 2>&1 until toggled off
      this.showSymbolKeys = !this.showSymbolKeys;
      this.showFunctionKeys = false;
      this.showCtrlKeys = false;
      return;
    }

    // If we're showing function keys and a function key is pressed, hide them
    if (this.showFunctionKeys && key.startsWith('F') && key !== 'F') {
      this.showFunctionKeys = false;
    }

    // If we're showing Ctrl keys and a Ctrl shortcut is pressed (not CtrlFull), hide them
    if (this.showCtrlKeys && key.startsWith('Ctrl+')) {
      this.showCtrlKeys = false;
    }

    // Ctrl and ⌥ are sticky: one tap arms them for the next key, a quick double tap locks
    // them until tapped again. Nothing is sent to the terminal for the modifier itself.
    if (isStickyModifier(key)) {
      this.toggleStickyModifier(key);
      return;
    }

    this.sendWithModifiers(key, isModifier, isSpecial, isToggle);
  }

  private toggleStickyModifier(key: StickyModifier) {
    const now = Date.now();
    if (this.lockedModifiers.has(key)) {
      this.lockedModifiers.delete(key);
      this.activeModifiers.delete(key);
    } else if (this.activeModifiers.has(key)) {
      if (now - (this.modifierTappedAt.get(key) ?? 0) <= MODIFIER_LOCK_WINDOW_MS) {
        this.lockedModifiers.add(key);
      } else {
        this.activeModifiers.delete(key);
      }
    } else {
      this.activeModifiers.add(key);
    }
    this.modifierTappedAt.set(key, now);
    this.syncTypedInputInterception();
    this.requestUpdate();
  }

  /** Send a key with the armed modifiers applied, then release the one-shot ones. */
  private sendWithModifiers(key: string, isModifier = false, isSpecial = false, isToggle = false) {
    const ctrl = this.activeModifiers.has('Control');
    const option = this.activeModifiers.has('Option');
    const applies = key.startsWith('Arrow') || key.length === 1;

    if ((ctrl || option) && !isToggle && key !== 'Command') {
      for (const modifier of STICKY_MODIFIERS) {
        if (!this.lockedModifiers.has(modifier)) this.activeModifiers.delete(modifier);
      }
      this.syncTypedInputInterception();
      this.requestUpdate();
    }

    if (!this.onKeyPress) return;

    if (option && applies) {
      // ⌥ is the ESC prefix (Meta): ⌥← / ⌥→ jump words, ⌥b / ⌥f / ⌥d edit by word.
      this.onKeyPress('Option', true, false);
    }
    if (ctrl && key.length === 1 && controlCharacterFor(key) !== null) {
      this.onKeyPress(`Ctrl+${key.toUpperCase()}`, true, false, false);
      return;
    }
    if (option && applies) {
      this.onKeyPress(key, false, false);
      return;
    }
    this.onKeyPress(key, isModifier, isSpecial, isToggle);
  }

  /**
   * While a modifier is armed, letters typed on the soft keyboard take it too (Ctrl, then
   * "c" on the iOS keyboard sends ^C). The typed character is caught before the hidden
   * input sees it; focus never moves, so the keyboard stays up.
   */
  private syncTypedInputInterception() {
    const armed = this.isConnected && this.visible && this.activeModifiers.size > 0;
    if (armed && !this.intercepting) {
      document.addEventListener('beforeinput', this.handleTypedInput, true);
      this.intercepting = true;
    } else if (!armed && this.intercepting) {
      document.removeEventListener('beforeinput', this.handleTypedInput, true);
      this.intercepting = false;
    }
  }

  private handleTypedInput = (event: Event) => {
    const input = event as InputEvent;
    const target = input.target as HTMLElement | null;
    if (
      !target?.hasAttribute?.(DIRECT_KEYBOARD_INPUT_ATTRIBUTE) ||
      input.inputType !== 'insertText' ||
      !input.data ||
      [...input.data].length !== 1 ||
      this.activeModifiers.size === 0
    ) {
      return;
    }
    input.preventDefault();
    input.stopImmediatePropagation();
    this.sendWithModifiers(input.data);
  };

  private clearStickyModifiers() {
    this.activeModifiers.clear();
    this.lockedModifiers.clear();
    this.syncTypedInputInterception();
  }

  private handlePasteImmediate() {
    // Always delegate to the main paste handler in direct-keyboard-manager
    // This preserves user gesture context while keeping all clipboard logic in one place
    if (this.onKeyPress) {
      this.onKeyPress('Paste', false, false);
    }
  }

  /**
   * Press the key now and keep pressing it while held: first repeat after
   * KEY_REPEAT_INITIAL_DELAY_MS, then every KEY_REPEAT_INTERVAL_MS. An armed ⌥ applies to
   * every repeat, so holding ⌥← keeps jumping words.
   */
  private startKeyRepeat(key: string, pressNow = true) {
    if (!isRepeatableKey(key)) return;

    this.stopKeyRepeat();
    this.repeatPressed = false;

    let withOption = false;
    const press = () => {
      withOption = this.activeModifiers.has('Option') && key.startsWith('Arrow');
      this.repeatPressed = true;
      this.handleKeyPress(key);
    };
    if (pressNow) press();

    const repeat = () => {
      if (!this.onKeyPress) return;
      if (withOption) {
        this.onKeyPress('Option', true, false);
        this.onKeyPress(key, false, false);
      } else {
        this.onKeyPress(key, false, false, false);
      }
    };

    this.keyRepeatTimeout = window.setTimeout(() => {
      this.keyRepeatTimeout = null;
      if (this.repeatPressed) repeat();
      else press();
      this.keyRepeatInterval = window.setInterval(repeat, KEY_REPEAT_INTERVAL_MS);
    }, KEY_REPEAT_INITIAL_DELAY_MS);
  }

  private stopKeyRepeat() {
    if (this.keyRepeatTimeout) {
      clearTimeout(this.keyRepeatTimeout);
      this.keyRepeatTimeout = null;
    }
    if (this.keyRepeatInterval) {
      clearInterval(this.keyRepeatInterval);
      this.keyRepeatInterval = null;
    }
  }

  /**
   * Once, the first time the keys show: "swipe the bar to move the cursor" (phone.swipeHint),
   * gone after the first swipe or 8 s.
   */
  private maybeShowSwipeHint() {
    if (this.showSwipeHint || readFlag(SWIPE_HINT_KEY)) return;
    this.showSwipeHint = true;
    this.swipeHintTimer = setTimeout(() => this.hideSwipeHint(true), 8000);
  }

  private hideSwipeHint(seen: boolean) {
    if (this.swipeHintTimer) clearTimeout(this.swipeHintTimer);
    this.swipeHintTimer = null;
    if (!this.showSwipeHint) return;
    this.showSwipeHint = false;
    if (seen) writeFlag(SWIPE_HINT_KEY);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopKeyRepeat();
    this.clearStickyModifiers();
    this.hideSwipeHint(false);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.bottomChrome.clear();

    // Clean up orientation listener
    if (this.orientationHandler) {
      window.removeEventListener('resize', this.orientationHandler);
      window.removeEventListener('orientationchange', this.orientationHandler);
      window.visualViewport?.removeEventListener('resize', this.orientationHandler);
      this.orientationHandler = null;
    }

    // Remove passive touch listeners
    this.removeEventListener('touchstart', this.handleDelegatedTouchStart);
    this.removeEventListener('touchmove', this.handleDelegatedTouchMove);
    this.removeEventListener('touchend', this.releasePressedButton, { capture: true });
    this.removeEventListener('touchcancel', this.releasePressedButton, { capture: true });
    this.setPressedButton(undefined);
    this.quickKeysLayoutUnsubscribe?.();
    this.quickKeysLayoutUnsubscribe = undefined;
  }

  /** The saved layout, the phone preset shown as SESSION_PHONE_ROWS. */
  private get effectiveLayout(): QuickKeysLayout {
    return sameLayout(this.quickKeysLayout, PHONE_QUICK_KEYS_LAYOUT)
      ? SESSION_PHONE_ROWS
      : this.quickKeysLayout;
  }

  private getQuickKeyRows(): QuickKeyDefinition[][] {
    return this.effectiveLayout.map((row) => row.map((key) => getQuickKeyDefinition(key)));
  }

  /**
   * The #+ page: shell symbols, then the preset keys that moved here (⇤, Home, End, Del) when
   * the layout does not show them; split in two rows when it is long.
   */
  private symbolPageRows(rows: QuickKeyDefinition[][]): QuickKeyDefinition[][] {
    const shown = new Set(this.effectiveLayout.flat());
    const keys = [
      ...SYMBOL_QUICK_KEYS.map((key) => getQuickKeyDefinition(key)),
      ...SYMBOL_PAGE_EXTRAS.filter((key) => !shown.has(key)).map((key) =>
        getQuickKeyDefinition(key)
      ),
      ...this.expandedToggle(rows, 'Symbols'),
    ];
    if (keys.length <= SYMBOL_PAGE_ROW_MAX) return [keys];
    const half = Math.ceil(keys.length / 2);
    return [keys.slice(0, half), keys.slice(half)];
  }

  /** The toggle that collapses an expanded row, when no other row still shows it. */
  private expandedToggle(
    rows: QuickKeyDefinition[][],
    key: 'CtrlExpand' | 'F' | 'Symbols'
  ): QuickKeyDefinition[] {
    const remainsVisible = [rows[0], ...rows.slice(2)].some((row) =>
      row.some((definition) => definition.key === key)
    );
    return remainsVisible ? [] : [getQuickKeyDefinition(key)];
  }

  private renderQuickKey(definition: QuickKeyDefinition, sizing: QuickKeyRowSizing) {
    const { key, modifier, combo, arrow, toggle } = definition;
    const label = this.quickKeyLabel(definition);
    const activeToggle =
      toggle &&
      ((key === 'CtrlExpand' && this.showCtrlKeys) ||
        (key === 'F' && this.showFunctionKeys) ||
        (key === 'Symbols' && this.showSymbolKeys));
    const activeModifier = modifier && isStickyModifier(key) && this.activeModifiers.has(key);
    const lockedModifier = activeModifier && this.lockedModifiers.has(key);
    const repeatable = isRepeatableKey(key);

    return html`
      <button
        type="button"
        tabindex="-1"
        class="ut-surface--badge quick-key-btn qk-key ${modifier ? 'modifier-key' : ''} ${combo ? 'combo-key' : ''} ${arrow ? 'arrow-key' : ''} ${toggle ? 'toggle-key' : ''} ${activeToggle || activeModifier ? 'active' : ''} ${lockedModifier ? 'locked' : ''}"
        style=${this.keyStyle(sizing)}
        aria-pressed=${modifier && isStickyModifier(key) ? String(Boolean(activeModifier)) : nothing}
        aria-expanded=${toggle ? String(Boolean(activeToggle)) : nothing}
        aria-label=${
          activeModifier
            ? t(lockedModifier ? 'quickKeys.modifier.locked' : 'quickKeys.modifier.once', {
                key: getQuickKeyAriaLabel(key) ?? label,
              })
            : (getQuickKeyAriaLabel(key) ?? nothing)
        }
        data-key=${key}
        ?data-modifier=${modifier}
        ?data-combo=${combo}
        ?data-arrow=${arrow}
        ?data-toggle=${toggle}
        @mousedown=${(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          if (
            repeatable &&
            event.button === 0 &&
            Date.now() - this.lastTouchAt > SYNTHETIC_MOUSE_WINDOW_MS
          ) {
            this.startKeyRepeat(key);
          }
        }}
        @mouseup=${() => {
          if (repeatable) this.stopKeyRepeat();
        }}
        @mouseleave=${() => {
          if (repeatable) this.stopKeyRepeat();
        }}
        @touchend=${(event: TouchEvent) => {
          // A quick tap on a repeatable key presses it once on release; after a hold the
          // repeat already pressed it, so releasing only stops it.
          const heldDown = repeatable && this.repeatPressed;
          if (repeatable) {
            this.stopKeyRepeat();
          }
          this.handleTouchEnd(event, () => {
            if (repeatable) {
              if (!heldDown) this.handleKeyPress(key);
            } else if (key === 'Paste') {
              this.handlePasteImmediate();
            } else {
              this.handleKeyPress(key, Boolean(modifier || combo), false, Boolean(toggle), event);
            }
          });
        }}
        @touchcancel=${() => {
          if (repeatable) {
            this.stopKeyRepeat();
          }
        }}
        @click=${(event: MouseEvent) => {
          if (event.detail !== 0 && !repeatable) {
            this.handleKeyPress(key, Boolean(modifier || combo), false, Boolean(toggle), event);
          }
        }}
      >
        ${label}
      </button>
    `;
  }

  private renderAuxiliaryKey(
    definition: {
      key: string;
      label: string;
      combo?: boolean;
      special?: boolean;
      func?: boolean;
    },
    sizing: QuickKeyRowSizing
  ) {
    const { key, label, combo, special, func } = definition;

    return html`
      <button
        type="button"
        tabindex="-1"
        aria-label=${getQuickKeyAriaLabel(key) ?? nothing}
        class="${func ? 'func-key-btn' : 'ctrl-shortcut-btn'} qk-key ${combo ? 'combo-key' : ''} ${special ? 'special-key' : ''}"
        style=${this.keyStyle(sizing)}
        data-key=${key}
        ?data-combo=${combo}
        ?data-special=${special}
        @mousedown=${(event: Event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        @touchend=${(event: TouchEvent) => {
          this.handleTouchEnd(event, () => {
            this.handleKeyPress(key, false, Boolean(special), false, event);
          });
        }}
        @click=${(event: MouseEvent) => {
          if (event.detail !== 0) {
            this.handleKeyPress(key, false, Boolean(special), false, event);
          }
        }}
      >
        ${label}
      </button>
    `;
  }

  /** One caption size and padding for the whole row (quickKeyRowSizing). */
  private keyStyle(sizing: QuickKeyRowSizing, label?: string): string {
    // Done keeps room for its word; the other keys share what is left (2026-10-12, SE 320 pt).
    const minWidth =
      label === undefined
        ? sizing.minWidthPx
        : quickKeyMinWidth(label, sizing.fontPx, sizing.paddingPx, sizing.minWidthPx);
    return `font-size: ${sizing.fontPx}px; padding-inline: ${sizing.paddingPx}px; min-width: ${minWidth}px;`;
  }

  /** Gap between the keys of a row (quickKeyRowSizing tightens it on narrow screens). */
  private rowStyle(sizing: QuickKeyRowSizing): string {
    return `gap: ${sizing.gapPx}px;`;
  }

  private renderDoneButton(sizing: QuickKeyRowSizing) {
    const doneLabel = t('quickKeys.done');
    return html`
      <button
        type="button"
        tabindex="-1"
        class="ut-surface--badge quick-key-btn qk-key qk-done special-key"
        style=${this.keyStyle(sizing, doneLabel)}
        data-key=${DONE_BUTTON.key}
        data-special
        @mousedown=${(event: Event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        @touchend=${(event: TouchEvent) => {
          this.handleTouchEnd(event, () => {
            this.handleKeyPress(DONE_BUTTON.key, false, true, false, event);
          });
        }}
        @click=${(event: MouseEvent) => {
          if (event.detail !== 0) {
            this.handleKeyPress(DONE_BUTTON.key, false, true, false, event);
          }
        }}
      >
        ${doneLabel}
      </button>
    `;
  }

  private renderStyles() {
    return html`
      <style>
        /* Quick keys container - fixed above the keyboard unless docked */
        .terminal-quick-keys-container {
          z-index: ${Z_INDEX.TERMINAL_QUICK_KEYS};
          background-color: var(--color-bg-secondary);
          width: 100%;
          max-width: 100%;
          box-sizing: border-box;
          overscroll-behavior: none;
          font-family: var(--font-ui);
          /* Allow touch events to pass through for scrolling terminal content */
          pointer-events: none;
        }

        /* The bar with the keys. On a phone on its side its keys keep clear of the Dynamic
           Island and the rounded corners (the insets are 0 upright). */
        .quick-keys-bar {
          background: transparent;
          border-top: 1px solid var(--color-border);
          padding: 4px env(safe-area-inset-right, 0px) 4px env(safe-area-inset-left, 0px);
          width: 100%;
          box-sizing: border-box;
          overflow: hidden;
          pointer-events: auto;
          /* The bar is a cursor trackpad (horizontal swipe); also stops double-tap zoom when
             double tapping Ctrl or ⌥ to lock them */
          touch-action: none;
        }
        .quick-keys-bar > div {
          display: flex;
          gap: 4px;
          width: 100%;
          box-sizing: border-box;
          padding: 0 4px;
        }
        .quick-keys-bar > div + div {
          margin-top: 6px;
        }

        /* Neutral keycaps (phone spec 3.9, 2026-10-12): a fill with a 1 px bottom shadow,
           text-colored sans captions at one size per row. Orange only for an armed or locked
           modifier, an open row toggle, and the press. */
        .qk-key {
          position: relative;
          flex: 1 1 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          height: 42px;
          min-width: 32px;
          margin: 0;
          border: 0;
          border-radius: var(--ut-r-md);
          background: var(--color-bg-tertiary);
          box-shadow: 0 1px 0 var(--color-border-strong);
          color: var(--color-text);
          font-family: var(--font-ui);
          font-weight: var(--ut-fw-medium);
          line-height: 1;
          white-space: nowrap;
          outline: none !important;
          -webkit-tap-highlight-color: transparent;
          user-select: none;
          -webkit-user-select: none;
          pointer-events: auto;
        }
        /* 44 px of finger for a 42 px key: one more px above and below. */
        .qk-key::before {
          content: '';
          position: absolute;
          inset: -1px -2px;
        }
        .qk-done {
          flex: 1.4 1 0;
          font-weight: var(--ut-fw-semibold);
        }
        .qk-key.active {
          background: var(--color-primary);
          color: var(--color-on-fill);
          box-shadow: none;
        }
        /* Locked modifier (double tap): stays on until tapped again */
        .modifier-key.active.locked {
          box-shadow: inset 0 -3px 0 var(--color-on-fill);
          text-decoration: underline;
          text-underline-offset: 3px;
        }

        /* Press feedback: iOS shows no :active state on these buttons */
        .qk-key.pressed {
          background: var(--color-primary);
          color: var(--color-on-fill);
          box-shadow: none;
          transition: none;
        }
        @media (hover: hover) {
          .qk-key:not(.active):hover {
            background: var(--color-surface-hover);
          }
        }

        .ut-qk-hint {
          padding: 6px 12px 0;
          text-align: center;
          font-size: 12px;
          line-height: 16px;
          color: var(--color-text-dim);
          pointer-events: none;
        }
      </style>
    `;
  }

  render() {
    if (!this.visible) return '';

    const rows = this.getQuickKeyRows();
    const doneLabel = t('quickKeys.done');
    const quickKeyRow = (row: QuickKeyDefinition[], withDone: boolean) => {
      const labels = row.map((definition) => this.quickKeyLabel(definition));
      const sizing = this.getRowSizing(withDone ? [...labels, doneLabel] : labels);
      return html`
        <div style=${this.rowStyle(sizing)}>
          ${row.map((definition) => this.renderQuickKey(definition, sizing))}
          ${withDone ? this.renderDoneButton(sizing) : nothing}
        </div>
      `;
    };
    const auxiliaryRow = (
      keys: ReadonlyArray<{
        key: string;
        label: string;
        combo?: boolean;
        special?: boolean;
        func?: boolean;
      }>,
      toggle: QuickKeyDefinition[]
    ) => {
      const labels = [
        ...keys.map(({ label }) => label),
        ...toggle.map((definition) => this.quickKeyLabel(definition)),
        doneLabel,
      ];
      const sizing = this.getRowSizing(labels);
      return html`
        <div style=${this.rowStyle(sizing)}>
          ${keys.map((key) => this.renderAuxiliaryKey(key, sizing))}
          ${toggle.map((definition) => this.renderQuickKey(definition, sizing))}
          ${this.renderDoneButton(sizing)}
        </div>
      `;
    };
    const symbolRows = () => {
      const page = this.symbolPageRows(rows);
      return page.map((row, index) => quickKeyRow(row, index === page.length - 1));
    };

    return html`
      <div
        class="terminal-quick-keys-container"
        dir="ltr"
        style=${
          this.docked
            ? 'position: relative;'
            : 'position: fixed !important; bottom: var(--keyboard-offset, 0px) !important; left: 0 !important; right: 0 !important;'
        }
      >
        ${
          this.showSwipeHint && !this.singleRow
            ? html`<div class="ut-qk-hint" data-testid="quick-keys-swipe-hint">${t('phone.swipeHint')}</div>`
            : nothing
        }
        <div class="quick-keys-bar">
          ${
            this.singleRow
              ? quickKeyRow(rows.flat(), true)
              : html`${quickKeyRow(rows[0], false)}
          ${
            this.showCtrlKeys
              ? auxiliaryRow(CTRL_SHORTCUTS, this.expandedToggle(rows, 'CtrlExpand'))
              : this.showSymbolKeys
                ? symbolRows()
                : this.showFunctionKeys
                  ? auxiliaryRow(FUNCTION_KEYS, this.expandedToggle(rows, 'F'))
                  : quickKeyRow(rows[1], true)
          }
          ${rows.slice(2).map((row) => quickKeyRow(row, false))}`
          }
        </div>
      </div>
      ${this.renderStyles()}
    `;
  }
}
