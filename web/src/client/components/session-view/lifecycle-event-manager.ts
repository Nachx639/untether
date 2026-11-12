/**
 * Lifecycle & Event Manager for Session View
 *
 * Manages the lifecycle events, keyboard/touch handlers, preferences, and
 * overall event coordination for the session view component.
 */

import { estimateKeyboardHeight } from '../../../shared/input-diagnostics.js';
import type { Session } from '../../../shared/types.js';
import { serverConfigService } from '../../services/server-config-service.js';
import { terminalSocketClient } from '../../services/terminal-socket-client.js';
import { CHORD_MS, isCtrlX, isModifierOnly } from '../../utils/agent-chords.js';
import {
  iosStandaloneShortfall,
  resetAppHeight,
  sessionAppHeight,
} from '../../utils/app-height.js';
import { consumeEvent } from '../../utils/event-utils.js';
import { isIMEAllowedKey } from '../../utils/ime-constants.js';
import { createLogger } from '../../utils/logger.js';
import { DIRECT_KEYBOARD_INPUT_ATTRIBUTE } from '../../utils/quick-keys-layout.js';
import { KEYBOARD_BLUR_RECHECK_MS, softKeyboardTarget } from '../../utils/soft-keyboard.js';
import { ChatKeyboardFix } from './chat-keyboard-fix.js';
import { ChatKeyboardFix2 } from './chat-keyboard-fix2.js';
import { ChatKeyboardFix3 } from './chat-keyboard-fix3.js';
import { typedInOtherField } from './input-manager.js';
import type { LifecycleEventManagerCallbacks } from './interfaces.js';

// Extend Window interface to include our custom property
declare global {
  interface Window {
    __deviceType?: 'phone' | 'tablet' | 'desktop';
  }
}

const logger = createLogger('lifecycle-event-manager');

/** Controls in the chat that keep their own keys (its search field, its buttons and links). */
const CHAT_CONTROL_SELECTOR =
  'input, textarea, select, button, a[href], [role="button"], [role="link"], [contenteditable]:not([contenteditable="false"])';

// Re-export the interface for backward compatibility
export type { LifecycleEventManagerCallbacks } from './interfaces.js';
// Moved to utils/app-height.ts (the list follows rotations with it too).
export { iosStandaloneShortfall, resetAppHeight };

// Threshold for determining when keyboard is considered visible (in pixels)
const KEYBOARD_VISIBLE_THRESHOLD = 50;
/** How often an applied keyboard gap is checked against the focus and the viewport. */
const KEYBOARD_WATCH_MS = 1000;

function isFileBrowserShortcut(e: KeyboardEvent): boolean {
  const hasSinglePrimaryModifier = e.metaKey !== e.ctrlKey;
  return hasSinglePrimaryModifier && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o';
}

/** Longest touch that still counts as a session-switching flick. */
const SESSION_SWIPE_MAX_MS = 600;

/**
 * Whether a touch began inside something a sideways drag scrolls (an element that overflows
 * horizontally with overflow-x auto/scroll) or that opts out with [data-no-swipe].
 */
export function startsInHorizontalScroller(e: Event): boolean {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.hasAttribute('data-no-swipe')) return true;
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
  }
  return false;
}

function hasTextSelection(): boolean {
  try {
    return (window.getSelection?.()?.toString().length ?? 0) > 0;
  } catch {
    return false;
  }
}

export class LifecycleEventManager {
  private callbacks: LifecycleEventManagerCallbacks | null = null;
  private session: Session | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Used for element storage via setSessionViewElement
  private sessionViewElement: HTMLElement | null = null;
  private touchStartX = 0;
  private touchStartY = 0;
  private touchStartTime = 0;
  /** The touch began where a sideways drag scrolls or selects something (see touchStartHandler). */
  private touchStartInHorizontalScroller = false;

  // Event listener tracking
  private keyboardListenerAdded = false;
  private mobileKeyboardListenerAdded = false;
  private touchListenersAdded = false;
  private visualViewportHandler: (() => void) | null = null;
  private keyboardDismissRecheck: ReturnType<typeof setTimeout> | null = null;
  private viewportTrackingHandler: (() => void) | null = null;
  private viewportTrackingTarget: 'visual' | 'window' | null = null;
  /** Experiment behind "chatKeyboardFix" in config.json (chat-keyboard-fix.ts); off by default. */
  private chatKeyboardFix: ChatKeyboardFix | null = null;
  private chatKeyboardFixUpdate: (() => void) | null = null;
  private chatKeyboardFixFocus: (() => void) | null = null;
  /** Iteration 3, behind "chatKeyboardFix2" (chat-keyboard-fix2.ts); off by default. */
  private chatKeyboardFix2: ChatKeyboardFix2 | null = null;
  private chatKeyboardFix2TouchStart: ((e: TouchEvent) => void) | null = null;
  private chatKeyboardFix2TouchEnd: ((e: TouchEvent) => void) | null = null;
  /** Iteration 4, behind "chatKeyboardFix3" (chat-keyboard-fix3.ts); off by default. */
  private chatKeyboardFix3: ChatKeyboardFix3 | null = null;
  private clickHandler: (() => void) | null = null;
  private pageshowHandler: ((e: PageTransitionEvent) => void) | null = null;

  // 2026-10-12: black band under the session after coming back to the app. iOS hides the
  // keyboard while the page sits in the background and fires no visualViewport resize on
  // return, so --app-height, --keyboard-offset and html[data-keyboard-visible] kept their
  // keyboard-open values (the column ended at ~60 % of the screen). The keyboard state now
  // lives on the instance and every return path re-measures it (resyncViewport).
  private previousKeyboardHeight = 0;
  private viewportBaseline = 0;
  private viewportBaselineWidth = 0;
  private syncingViewport = false;
  private resyncTimers: ReturnType<typeof setTimeout>[] = [];
  // 2026-11-11: the keyboard's gap with no keyboard up (home-screen app, "sometimes"). The
  // return paths above were not the only ones: a viewport resize or the hidden input's focus
  // applied whatever the numbers said with nothing editable focused, a blur with no resize left
  // the gap in place, and numbers corrected with no event after the last resync timer (1 s)
  // were never read. Now every write goes through the rule (softKeyboardTarget, see
  // soft-keyboard.ts), a blur is looked at again, and while a gap is applied it is checked
  // every KEYBOARD_WATCH_MS against the focus and the viewport.
  private blurRecheckTimers: ReturnType<typeof setTimeout>[] = [];
  private keyboardWatch: ReturnType<typeof setInterval> | null = null;
  private blurResyncHandler: (() => void) | null = null;
  private resyncFrame: number | null = null;
  private visibilityResyncHandler: (() => void) | null = null;
  private focusResyncHandler: ((e: Event) => void) | null = null;
  private orientationResyncHandler: (() => void) | null = null;

  // Touch detection results cache
  private touchCapabilityCache: {
    hasTouch: boolean;
    isCoarsePointer: boolean;
    hasFinePointer: boolean;
    hasHover: boolean;
  } | null = null;

  constructor() {
    logger.log('LifecycleEventManager initialized');
    // Initialize visualViewport height tracking for iOS Safari
    this.setupVisualViewportTracking();
  }

  /**
   * Setup visualViewport tracking to fix iOS Safari issues with fixed elements and keyboard
   * Based on: https://stackoverflow.com/questions/56351216/ios-safari-unwanted-scroll-when-keyboard-is-opened
   * And: https://mathix.dev/blog/fix-html-elements-on-top-of-the-ios-keyboard-using-html-css-js
   */
  private setupVisualViewportTracking(): void {
    const updateViewport = () => {
      // Our own synthetic resize (resyncViewport) after we already measured.
      if (this.syncingViewport) return;
      const vv = window.visualViewport;
      const ih = window.innerHeight;

      // Update app height. 2026-10-02: an iPhone home-screen web app (standalone, black-translucent
      // status bar) reports innerHeight/visualViewport short by the status bar height (812 of
      // 874), leaving a blank band under the action bar. Add that constant shortfall back, but
      // never with the keyboard up (sessionAppHeight: it covered the second quick-keys row).
      const height = `${sessionAppHeight(ih, vv ? vv.height : ih)}px`;
      document.documentElement.style.setProperty('--app-height', height);
      // iOS may pan the visual viewport (offsetTop > 0) when the keyboard opens; the phone
      // session layout is pinned to it so nothing ends up hidden above or below.
      document.documentElement.style.setProperty('--vv-top', `${vv ? vv.offsetTop : 0}px`);

      // Calculate keyboard offset for fixed elements
      // When keyboard is open: innerHeight - visualViewport.height - offsetTop gives keyboard height
      const keyboardOffset = vv ? Math.max(0, ih - vv.height - vv.offsetTop) : 0;

      // Update CSS custom property for quick keys positioning
      document.documentElement.style.setProperty('--keyboard-offset', `${keyboardOffset}px`);

      logger.debug(`Viewport updated - height: ${height}, keyboard offset: ${keyboardOffset}px`);
      this.chatKeyboardFix3?.viewportChanged();
      this.chatKeyboardFix2?.viewportChanged();
      this.chatKeyboardFix?.update();
    };

    // Set initial values
    updateViewport();
    this.viewportTrackingHandler = updateViewport;

    // Listen to visualViewport changes (iOS Safari)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewport);
      window.visualViewport.addEventListener('scroll', updateViewport);
      this.viewportTrackingTarget = 'visual';
      logger.log('VisualViewport tracking enabled for iOS Safari');
    } else {
      // Fallback for non-supporting browsers
      window.addEventListener('resize', updateViewport);
      this.viewportTrackingTarget = 'window';
      logger.log('Using fallback window resize for viewport tracking');
    }
    this.startChatKeyboardFix();
  }

  /**
   * The home-screen app's chat keyboard band experiment: it also needs the page's own scroll
   * (iOS scrolls the page for the composer) and the composer's focus. Does nothing while the
   * flag is off, and is not even asked for outside the home-screen app.
   */
  private startChatKeyboardFix(): void {
    // Iteration 4 first: while its flag is on, the older ones stand down.
    const fix3 = new ChatKeyboardFix3(async () => {
      const config = await serverConfigService.loadConfig();
      return config.chatKeyboardFix3 === true;
    });
    this.chatKeyboardFix3 = fix3;
    fix3.start();

    // Then iteration 3: while its flag is on, the older fix stands down.
    const fix2 = new ChatKeyboardFix2(async () => {
      const config = await serverConfigService.loadConfig();
      return config.chatKeyboardFix2 === true && config.chatKeyboardFix3 !== true;
    });
    this.chatKeyboardFix2 = fix2;
    this.chatKeyboardFix2TouchStart = (e) => fix2.touchStarted(e);
    this.chatKeyboardFix2TouchEnd = (e) => fix2.touchEnded(e);
    document.addEventListener('touchstart', this.chatKeyboardFix2TouchStart, {
      capture: true,
      passive: true,
    });
    // Not passive: a tap it takes over has its default (the native focus) cancelled.
    document.addEventListener('touchend', this.chatKeyboardFix2TouchEnd, {
      capture: true,
      passive: false,
    });
    fix2.refreshFlag();

    const fix = new ChatKeyboardFix(async () => {
      const config = await serverConfigService.loadConfig();
      return (
        config.chatKeyboardFix === true &&
        config.chatKeyboardFix2 !== true &&
        config.chatKeyboardFix3 !== true
      );
    });
    this.chatKeyboardFix = fix;
    this.chatKeyboardFixUpdate = () => fix.update();
    // focusout comes before focusin: look once the focus has settled.
    this.chatKeyboardFixFocus = () =>
      queueMicrotask(() => {
        fix2.focusChanged();
        fix.focusChanged();
      });
    window.addEventListener('scroll', this.chatKeyboardFixUpdate, { passive: true });
    document.addEventListener('focusin', this.chatKeyboardFixFocus);
    document.addEventListener('focusout', this.chatKeyboardFixFocus);
    fix.refreshFlag();
  }

  private stopChatKeyboardFix(): void {
    this.chatKeyboardFix3?.stop();
    this.chatKeyboardFix3 = null;
    if (this.chatKeyboardFix2TouchStart) {
      document.removeEventListener('touchstart', this.chatKeyboardFix2TouchStart, true);
      this.chatKeyboardFix2TouchStart = null;
    }
    if (this.chatKeyboardFix2TouchEnd) {
      document.removeEventListener('touchend', this.chatKeyboardFix2TouchEnd, true);
      this.chatKeyboardFix2TouchEnd = null;
    }
    this.chatKeyboardFix2?.stop();
    this.chatKeyboardFix2 = null;
    if (this.chatKeyboardFixUpdate) {
      window.removeEventListener('scroll', this.chatKeyboardFixUpdate);
      this.chatKeyboardFixUpdate = null;
    }
    if (this.chatKeyboardFixFocus) {
      document.removeEventListener('focusin', this.chatKeyboardFixFocus);
      document.removeEventListener('focusout', this.chatKeyboardFixFocus);
      this.chatKeyboardFixFocus = null;
    }
    this.chatKeyboardFix?.stop();
    this.chatKeyboardFix = null;
  }

  setSessionViewElement(element: HTMLElement): void {
    this.sessionViewElement = element;
  }

  setCallbacks(callbacks: LifecycleEventManagerCallbacks): void {
    this.callbacks = callbacks;
  }

  setSession(session: Session | null): void {
    this.session = session;
  }

  /**
   * Detect touch capabilities using multiple signals
   */
  private detectTouchCapabilities() {
    if (this.touchCapabilityCache) {
      return this.touchCapabilityCache;
    }

    const hasTouch =
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0 ||
      ((navigator as Navigator & { msMaxTouchPoints?: number }).msMaxTouchPoints ?? 0) > 0 ||
      window.matchMedia?.('(any-pointer: coarse)').matches === true;

    const isCoarsePointer = window.matchMedia('(any-pointer: coarse)').matches;
    const hasFinePointer = window.matchMedia('(any-pointer: fine)').matches;
    const hasHover = window.matchMedia('(any-hover: hover)').matches;

    this.touchCapabilityCache = {
      hasTouch,
      isCoarsePointer,
      hasFinePointer,
      hasHover,
    };

    logger.log('Touch capabilities detected:', this.touchCapabilityCache);
    return this.touchCapabilityCache;
  }

  /**
   * Determine if touch keyboard should be enabled based on capabilities and preferences
   */
  private shouldEnableTouchKeyboard(): boolean {
    // FIRST: Check if this is an iPad - always enable for iPads
    const userAgent = navigator.userAgent;
    const isIPadUserAgent =
      /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1);

    if (isIPadUserAgent) {
      logger.log('iPad detected via user agent - enabling touch keyboard');
      return true;
    }

    // Get user preference from localStorage
    const preference = localStorage.getItem('touchKeyboardPreference') || 'auto';

    if (preference === 'always') {
      return true;
    }

    if (preference === 'never') {
      return false;
    }

    // Auto mode: use smart detection
    const capabilities = this.detectTouchCapabilities();

    // Touch-first devices: has touch + coarse pointer + no hover
    const isTouchFirst =
      capabilities.hasTouch && capabilities.isCoarsePointer && !capabilities.hasHover;

    // Hybrid devices: has both touch and fine pointer (Surface, iPad with trackpad, etc)
    const isHybrid = capabilities.hasTouch && capabilities.hasFinePointer;

    // For hybrid devices, also check screen size
    const screenSize = Math.min(window.innerWidth, window.innerHeight);
    const isSmallScreen = screenSize < 1024;

    // Enable for touch-first OR hybrid with small screen
    const result = isTouchFirst || (isHybrid && isSmallScreen);

    logger.log('shouldEnableTouchKeyboard:', {
      result,
      isTouchFirst,
      isHybrid,
      isSmallScreen,
      isIPadUserAgent,
      userAgent,
      capabilities,
    });

    return result;
  }

  /**
   * Update mobile status based on current detection
   */
  private updateMobileStatus(): void {
    if (!this.callbacks) return;

    const shouldEnableTouchKeyboard = this.shouldEnableTouchKeyboard();
    const capabilities = this.detectTouchCapabilities();

    // Update device type based on screen size for layout purposes
    const screenWidth = window.innerWidth;
    const isTablet = capabilities.hasTouch && screenWidth >= 768;
    const isPhone = capabilities.hasTouch && screenWidth < 768;
    window.__deviceType = isTablet ? 'tablet' : isPhone ? 'phone' : 'desktop';

    // Update mobile status
    const wasMobile = this.callbacks.getIsMobile();
    if (wasMobile !== shouldEnableTouchKeyboard) {
      this.callbacks.setIsMobile(shouldEnableTouchKeyboard);

      // Handle transition from mobile to non-mobile
      if (!shouldEnableTouchKeyboard) {
        // Cleanup mobile features
        const directKeyboardManager = this.callbacks.getDirectKeyboardManager();
        if (directKeyboardManager) {
          directKeyboardManager.cleanup();
          this.callbacks.setShowQuickKeys(false);
        }
        // No soft keyboard on this side: nothing may keep its height.
        this.applyKeyboardState(0);
      }
      // 2026-11-11: the listeners belong to the mode (touch: the viewport's keyboard measure,
      // swipes, the hardware-keyboard handler; desktop: the key handler) and were only set up
      // as the session opened. A window crossing 1024 px (an iPad in Split View, a turned
      // tablet with a trackpad) changed the mode and kept the other mode's listeners: keys
      // went nowhere, or the soft keyboard was never measured.
      this.removeModeListeners();
      this.setupMobileFeatures(shouldEnableTouchKeyboard);
      this.setupEventListeners(shouldEnableTouchKeyboard);
    }
  }

  handleWindowResize = (): void => {
    if (!this.callbacks) return;

    // Clear cache to re-evaluate capabilities (in case of device mode changes in dev tools)
    this.touchCapabilityCache = null;

    // Update mobile status
    this.updateMobileStatus();

    // A real resize after a return can still carry stale keyboard state (2026-10-12).
    this.resyncViewport('window-resize');
  };

  keyboardHandler = (e: KeyboardEvent): void => {
    if (!this.callbacks) return;

    // Check if focus management is disabled (e.g., when overlays/modals are active)
    if (this.callbacks.getDisableFocusManagement()) {
      // Don't capture keyboard input when overlays are active
      return;
    }

    // Check if IME input is focused - block keyboard events except for editing keys
    if (document.body.getAttribute('data-ime-input-focused') === 'true') {
      if (!isIMEAllowedKey(e)) {
        return;
      }
    }

    // Native composition state covers events that arrive before our DOM marker is updated.
    if (e.isComposing || document.body.getAttribute('data-ime-composing') === 'true') {
      return;
    }

    // App shortcuts take precedence over browser/system shortcut filtering.
    if (isFileBrowserShortcut(e)) {
      consumeEvent(e);
      this.callbacks.setShowFileBrowser(true);
      return;
    }

    // Check if this is a browser shortcut we should allow before terminal input processing.
    const inputManager = this.callbacks.getInputManager();
    if (inputManager?.isKeyboardShortcut(e)) {
      // Let the browser handle this shortcut - don't call any preventDefault or stopPropagation
      return;
    }

    if (!this.session) return;

    // A field of its own (inline-edit, the ship sheet's message, the custom width…) keeps its
    // keys; the composed path sees through Shadow DOM.
    if (typedInOtherField(e)) return;
    const composedPath = e.composedPath();

    // Desktop chat mode over the agent's chat: the terminal is hidden, so typing on the page
    // starts a message in the composer rather than going into the agent's prompt unseen; the
    // chat's own controls (search, buttons) keep their keys; Esc, Ctrl+C and Claude Code's
    // send chords still reach the agent (reachesAgentUnderChat), as on a phone with a hardware
    // keyboard (2026-10-12).
    if (this.callbacks.getChatCoversTerminal?.() && !this.callbacks.getIsMobile?.()) {
      const inControl = composedPath.some(
        (target) => target instanceof HTMLElement && target.matches(CHAT_CONTROL_SELECTOR)
      );
      if (inControl) return;
      if (!this.reachesAgentUnderChat(e)) {
        this.noteChordKey(e);
        if (
          e.key.length === 1 &&
          !e.ctrlKey &&
          !e.metaKey &&
          this.callbacks.typeIntoComposer?.(e.key)
        ) {
          consumeEvent(e);
        }
        return;
      }
    }

    // Handle Escape key specially for exited sessions
    if (e.key === 'Escape' && this.session.status === 'exited') {
      this.callbacks.handleBack();
      return;
    }

    // Only prevent default for keys we're actually going to handle
    consumeEvent(e);

    this.noteChordKey(e);
    this.callbacks.handleKeyboardInput(e);
  };

  /** Until when a key completes Claude Code's chord after Ctrl+X (see reachesAgentUnderChat). */
  private chordUntil = 0;

  /** Ctrl+X opens the chord; any other key (not a lone modifier) closes it. */
  private noteChordKey(e: KeyboardEvent): void {
    if (isModifierOnly(e)) return;
    this.chordUntil = isCtrlX(e) ? Date.now() + CHORD_MS : 0;
  }

  /**
   * Keys that reach the agent though the chat covers its terminal: Esc and Ctrl+C (interrupt,
   * cancel), and Claude Code's chords to send while it works, Ctrl+X Ctrl+S (send now) and
   * Ctrl+X Enter (queue): Ctrl+X, then a Ctrl key or Enter. In the chat view only Esc and
   * Ctrl+C went through, so the chord never arrived (user report, 2026-10-14).
   */
  private reachesAgentUnderChat(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') return true;
    if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'c') return true;
    if (isCtrlX(e)) return true;
    if (Date.now() > this.chordUntil || e.metaKey || e.altKey) return false;
    return e.ctrlKey || e.key === 'Enter';
  }

  mobileHardwareKeyboardHandler = (e: KeyboardEvent): void => {
    // The hidden mobile keyboard input still needs to expose app-level hardware shortcuts.
    if (isFileBrowserShortcut(e)) {
      this.keyboardHandler(e);
      return;
    }

    // Mobile's hidden software-keyboard input owns its events. Route only hardware
    // keyboard events that originate outside editable or interactive controls.
    let fromTerminal = false;
    for (const target of e.composedPath()) {
      const isTerminalKeyboardTarget =
        target instanceof HTMLElement &&
        (target.matches('textarea.terminal-paste-input') ||
          (target.closest('ut-terminal') !== null &&
            target.matches(
              'textarea, [contenteditable]:not([contenteditable="false"]), .terminal-container, ut-terminal'
            )));
      if (isTerminalKeyboardTarget) fromTerminal = true;
      if (
        target instanceof HTMLElement &&
        ((!isTerminalKeyboardTarget &&
          target.matches(
            'input, textarea, select, button, a[href], [role="button"], [role="link"], [contenteditable]:not([contenteditable="false"]), inline-edit'
          )) ||
          target.closest?.('.monaco-editor, [data-keybinding-context], .editor-container'))
      ) {
        return;
      }
    }

    // In chat mode, typing that is not in the terminal itself goes to the composer, never the
    // terminal under the chat view: after a reconnect the session view took focus, and a
    // message typed on a hardware keyboard went into Claude's prompt unsent (2026-10-03). Esc,
    // Ctrl+C and the send chords still reach Claude (reachesAgentUnderChat); a character
    // starts the message in the composer, which then has the focus; anything else does
    // nothing here.
    // Keys from the terminal's own inputs stay there only where it shows: under Claude's chat
    // view a hidden input of it still had the focus, and took them (2026-10-03, SE simulator).
    if (
      this.callbacks?.getChatMode?.() &&
      (!fromTerminal || this.callbacks.getChatCoversTerminal?.())
    ) {
      if (this.reachesAgentUnderChat(e)) {
        this.keyboardHandler(e);
        return;
      }
      this.noteChordKey(e);
      if (
        // With Option too: it types "@", "#" or "[" on a Spanish layout (fourth review).
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        this.callbacks.typeIntoComposer?.(e.key)
      ) {
        consumeEvent(e);
      }
      return;
    }

    this.keyboardHandler(e);
  };

  touchStartHandler = (e: TouchEvent): void => {
    if (!this.callbacks) return;

    const isMobile = this.callbacks.getIsMobile();
    if (!isMobile) return;

    const touch = e.touches[0];
    this.touchStartX = touch.clientX;
    this.touchStartY = touch.clientY;
    this.touchStartTime = Date.now();
    this.touchStartInHorizontalScroller = startsInHorizontalScroller(e);
  };

  touchEndHandler = (e: TouchEvent): void => {
    if (!this.callbacks) return;

    const isMobile = this.callbacks.getIsMobile();
    if (!isMobile) return;

    const touch = e.changedTouches[0];
    const touchEndX = touch.clientX;
    const touchEndY = touch.clientY;

    // Only handle single-finger swipes (multi-touch is reserved for the system / pinch).
    if (e.changedTouches.length > 1) return;

    const deltaX = touchEndX - this.touchStartX;
    const deltaY = touchEndY - this.touchStartY;

    // Check for horizontal swipe from left edge (back gesture)
    const isSwipeRight = deltaX > 100;
    const isVerticallyStable = Math.abs(deltaY) < 100;
    const startedFromLeftEdge = this.touchStartX < 50;

    if (isSwipeRight && isVerticallyStable && startedFromLeftEdge) {
      // Trigger back navigation
      this.callbacks.handleBack();
      return;
    }

    // Switch between sessions with a clearly-horizontal swipe that does NOT start at a
    // screen edge (edges are reserved for back/system gestures). Strict thresholds keep
    // it from firing during the terminal's vertical touch-scroll.
    const viewportWidth = window.innerWidth;
    const startedFromEdge = this.touchStartX < 50 || this.touchStartX > viewportWidth - 50;
    const isStronglyHorizontal = Math.abs(deltaX) > 120 && Math.abs(deltaY) < 50;
    // A sideways drag in a row that scrolls sideways (the quick replies over the composer, a
    // code block, a table) or over selected text is that, not a session switch: one on the
    // quick replies jumped to another session and back (user report, 2026-10-14). A slow
    // drag is someone reading or selecting, not a flick.
    const deliberate =
      !this.touchStartInHorizontalScroller &&
      Date.now() - this.touchStartTime <= SESSION_SWIPE_MAX_MS &&
      !hasTextSelection();
    if (this.callbacks.switchSession && isStronglyHorizontal && !startedFromEdge && deliberate) {
      // Swipe left → next session, swipe right → previous session.
      this.callbacks.switchSession(deltaX < 0 ? 'next' : 'prev');
    }
  };

  handleClickOutside = (e: Event): void => {
    if (!this.callbacks) return;

    const showWidthSelector = this.callbacks.getShowWidthSelector();
    if (showWidthSelector) {
      const target = e.target as HTMLElement;
      const widthSelector = this.callbacks.querySelector('.width-selector-container');
      const widthButton = this.callbacks.querySelector('.width-selector-button');

      if (!widthSelector?.contains(target) && !widthButton?.contains(target)) {
        this.callbacks.setShowWidthSelector(false);
        this.callbacks.setCustomWidth('');
      }
    }
  };

  setupLifecycle(): void {
    if (!this.callbacks) return;

    // Make session-view focusable
    this.callbacks.setTabIndex(0);

    // Store click handler reference for proper cleanup
    this.clickHandler = () => {
      // Desktop chat over the agent's chat: clicks belong to the chat (its search field took
      // the focus and lost it to this at once, 2026-10-12); keys reach the composer anyway.
      if (this.callbacks?.getChatCoversTerminal?.() && !this.callbacks.getIsMobile()) return;
      if (!this.callbacks?.getDisableFocusManagement()) {
        // Don't steal focus if user has text selected - this would clear their selection
        const selection = document.getSelection();
        const hasSelection = selection && selection.toString().length > 0;
        if (!hasSelection) {
          this.callbacks?.focus();
        }
      }
    };
    this.callbacks.addEventListener('click', this.clickHandler);

    // Add click outside handler for width selector
    document.addEventListener('click', this.handleClickOutside);

    // Show loading animation if no session yet
    if (!this.session) {
      this.callbacks.startLoading();
    }

    // Use new touch detection logic
    const shouldEnableTouchKeyboard = this.shouldEnableTouchKeyboard();
    const capabilities = this.detectTouchCapabilities();

    // Update device type based on screen size for layout purposes
    const screenWidth = window.innerWidth;
    const isTablet = capabilities.hasTouch && screenWidth >= 768;
    const isPhone = capabilities.hasTouch && screenWidth < 768;
    window.__deviceType = isTablet ? 'tablet' : isPhone ? 'phone' : 'desktop';

    this.callbacks.setIsMobile(shouldEnableTouchKeyboard);

    logger.log('Touch keyboard enabled:', shouldEnableTouchKeyboard);
    logger.log('Device type:', window.__deviceType);

    // Listen for window resize to handle orientation changes and viewport size changes
    window.addEventListener('resize', this.handleWindowResize);

    // iOS/Safari freezes the page (and its WebSocket) when backgrounded and restores
    // it from the bfcache on return. The restored socket is usually dead but our
    // backoff timer was frozen too, so force an immediate reconnection.
    this.pageshowHandler = (e: PageTransitionEvent) => {
      if (e.persisted) {
        logger.log('Page restored from bfcache - forcing WebSocket reconnection');
        terminalSocketClient.forceReconnect();
      }
      // The keyboard may have gone while the page was away (2026-10-12).
      this.scheduleViewportResync('pageshow');
    };
    window.addEventListener('pageshow', this.pageshowHandler);
    this.removeResyncListeners();
    this.addResyncListeners();

    this.setupMobileFeatures(shouldEnableTouchKeyboard);
    this.setupEventListeners(shouldEnableTouchKeyboard);
  }

  /** The tallest visual viewport seen at this width, for the input diagnostics. */
  get keyboardBaseline(): number {
    return this.viewportBaseline;
  }

  /**
   * The soft keyboard's height now: the one calculation everyone goes through (2026-11-11).
   * The hidden input's focus used to write `innerHeight - viewport.height` on its own, which in
   * Chrome on iOS is ~0 with the keyboard up (innerHeight shrinks too): the quick keys and the
   * terminal got a height the rest of the layout did not have.
   */
  private keyboardHeightNow(viewport: VisualViewport): number {
    this.trackViewportBaseline(viewport);
    return estimateKeyboardHeight(window.innerHeight, viewport.height, this.viewportBaseline);
  }

  /**
   * Measures the keyboard and applies it, for a caller that knows it is coming (the hidden
   * input got the focus): the same writer as a viewport resize, without its "keyboard closed"
   * handling. Does nothing outside touch mode.
   */
  measureKeyboard(): void {
    const viewport = window.visualViewport;
    if (!viewport || !this.callbacks || !this.visualViewportHandler || this.syncingViewport) {
      return;
    }
    const keyboardHeight = this.keyboardHeightNow(viewport);
    if (keyboardHeight > 0 && this.keyboardCannotBeUp()) {
      this.forceKeyboardClosed();
      return;
    }
    this.applyKeyboardState(keyboardHeight);
  }

  /**
   * The app itself put the keyboard away (Done, chat mode taking over): no gap from now, and
   * the page height is measured again once the focus has settled.
   */
  keyboardDismissed(): void {
    this.applyKeyboardState(0);
    this.scheduleViewportResync('dismiss', true);
  }

  /** The listeners of the current mode (touch or desktop), so the other mode can set up its own. */
  private removeModeListeners(): void {
    if (this.keyboardListenerAdded) {
      document.removeEventListener('keydown', this.keyboardHandler);
      this.keyboardListenerAdded = false;
    }
    if (this.mobileKeyboardListenerAdded) {
      document.removeEventListener('keydown', this.mobileHardwareKeyboardHandler);
      this.mobileKeyboardListenerAdded = false;
    }
    if (this.touchListenersAdded) {
      document.removeEventListener('touchstart', this.touchStartHandler);
      document.removeEventListener('touchend', this.touchEndHandler);
      this.touchListenersAdded = false;
    }
    if (this.keyboardDismissRecheck) {
      clearTimeout(this.keyboardDismissRecheck);
      this.keyboardDismissRecheck = null;
    }
    if (this.visualViewportHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this.visualViewportHandler);
    }
    this.visualViewportHandler = null;
    this.stopKeyboardWatch();
  }

  /** Tallest visual viewport seen at the current width (the keyboard-down height). */
  private trackViewportBaseline(viewport: VisualViewport): void {
    if (viewport.width !== this.viewportBaselineWidth) {
      this.viewportBaselineWidth = viewport.width;
      this.viewportBaseline = viewport.height;
    }
    this.viewportBaseline = Math.max(this.viewportBaseline, viewport.height);
  }

  /**
   * The one writer of the soft keyboard state: UI state, --keyboard-height, the html/body
   * data-keyboard-visible attribute (header collapse, chat keyboard layout), the quick keys and
   * the shown/hidden events. 2026-10-12: dismissKeyboard() reset only the UI state, so after a
   * trip to the background the attribute and --app-height stayed at their keyboard-up values.
   */
  private applyKeyboardState(keyboardHeight: number): void {
    if (!this.callbacks) return;
    const previous = this.previousKeyboardHeight;
    this.callbacks.setKeyboardHeight(keyboardHeight);
    document.documentElement.style.setProperty('--keyboard-height', `${keyboardHeight}px`);
    const visible = keyboardHeight > KEYBOARD_VISIBLE_THRESHOLD ? 'true' : 'false';
    document.documentElement.setAttribute('data-keyboard-visible', visible);
    document.body.setAttribute('data-keyboard-visible', visible);

    const quickKeys = this.callbacks.querySelector('terminal-quick-keys') as
      | (HTMLElement & { keyboardHeight: number })
      | null;
    if (quickKeys) quickKeys.keyboardHeight = keyboardHeight;
    logger.log(`Visual Viewport keyboard height: ${keyboardHeight}px`);

    // Dispatch custom events that embedded apps can listen to
    if (keyboardHeight > KEYBOARD_VISIBLE_THRESHOLD && previous <= KEYBOARD_VISIBLE_THRESHOLD) {
      // Settle pass (2026-10-12): iOS can finish the keyboard (and its ^ v ✓ bar) after the
      // last resize it reports; measure again once the animation is over.
      if (!this.syncingViewport) this.scheduleViewportResync('keyboard-settle', true);
      window.dispatchEvent(
        new CustomEvent('untether:keyboard-shown', { detail: { height: keyboardHeight } })
      );
    } else if (
      keyboardHeight <= KEYBOARD_VISIBLE_THRESHOLD &&
      previous > KEYBOARD_VISIBLE_THRESHOLD
    ) {
      window.dispatchEvent(new CustomEvent('untether:keyboard-hidden', { detail: { height: 0 } }));
    }
    this.previousKeyboardHeight = keyboardHeight;
    if (keyboardHeight > 0) this.startKeyboardWatch();
    else this.stopKeyboardWatch();
  }

  /**
   * While a gap is applied: is there still something to have a keyboard for, and is the gap
   * still the viewport's? Does nothing while both hold, so an open keyboard is left alone.
   */
  private startKeyboardWatch(): void {
    if (this.keyboardWatch || !this.visualViewportHandler) return;
    this.keyboardWatch = setInterval(() => {
      const viewport = window.visualViewport;
      if (!viewport || document.hidden) return;
      if (
        this.keyboardCannotBeUp() ||
        Math.abs(this.keyboardHeightNow(viewport) - this.previousKeyboardHeight) >= 1
      ) {
        this.resyncViewport('watch');
      }
    }, KEYBOARD_WATCH_MS);
  }

  private stopKeyboardWatch(): void {
    if (this.keyboardWatch) clearInterval(this.keyboardWatch);
    this.keyboardWatch = null;
  }

  /**
   * True when no soft keyboard can be up: nothing editable has focus, or only our hidden input
   * outside keyboard mode. iOS can still report the keyboard-up viewport for a moment after a
   * return from the background (and the home-screen app a short innerHeight), so on those paths
   * focus decides, not the numbers.
   */
  private keyboardCannotBeUp(): boolean {
    const element = softKeyboardTarget();
    if (!element) return true;
    if (element.hasAttribute(DIRECT_KEYBOARD_INPUT_ATTRIBUTE)) {
      return !(this.callbacks?.getDirectKeyboardManager()?.getKeyboardMode() ?? false);
    }
    return false;
  }

  /** Keyboard state and page height for a keyboard that is not there. */
  private forceKeyboardClosed(): void {
    const root = document.documentElement;
    const vv = window.visualViewport;
    const ih = window.innerHeight;
    if (vv) this.trackViewportBaseline(vv);
    this.applyKeyboardState(0);
    const tallest = Math.max(vv?.height ?? 0, ih);
    if (this.viewportBaseline - tallest >= 150) {
      // The home-screen app right after a return: innerHeight and the visual viewport both
      // still say keyboard. Fall back to the page height the CSS / viewport-init give it.
      resetAppHeight();
    } else {
      root.style.setProperty('--app-height', `${tallest + iosStandaloneShortfall(ih)}px`);
      root.style.setProperty('--vv-top', '0px');
      root.style.setProperty('--keyboard-offset', '0px');
    }
    if (this.callbacks?.getDirectKeyboardManager()?.getShowQuickKeys()) {
      this.callbacks.getDirectKeyboardManager().exitKeyboardMode();
    }
  }

  /**
   * Re-measures every viewport-derived value from the real current viewport. 2026-10-12: on a
   * return from the background (app switch, lock) iOS fires no visualViewport resize, so the
   * layout kept the keyboard-open height and a black band filled the bottom of the screen until
   * the keyboard was opened and closed again.
   */
  resyncViewport(reason: string): void {
    if (this.syncingViewport) return;
    const root = document.documentElement;
    const before = root.style.getPropertyValue('--app-height');
    this.viewportTrackingHandler?.();
    if (this.visualViewportHandler && this.callbacks) {
      if (this.keyboardCannotBeUp()) {
        this.forceKeyboardClosed();
      } else {
        this.visualViewportHandler();
      }
    }
    const after = root.style.getPropertyValue('--app-height');
    logger.debug(`viewport resync (${reason}): --app-height ${before || 'unset'} -> ${after}`);
    if (after === before) return;
    // Everyone else that sizes itself on viewport resize (quick keys, short pane, the list's
    // tab bar, the preview panel) recomputes too; our own handlers skip this one.
    this.syncingViewport = true;
    try {
      (window.visualViewport ?? window).dispatchEvent(new Event('resize'));
    } finally {
      this.syncingViewport = false;
    }
  }

  /**
   * resyncViewport now (unless `deferFirst`) and again over the next second: right after a
   * return iOS can report stale sizes for a few hundred ms and correct them with no event.
   */
  scheduleViewportResync(reason: string, deferFirst = false): void {
    this.cancelViewportResync();
    if (!deferFirst) this.resyncViewport(reason);
    if (typeof requestAnimationFrame === 'function') {
      this.resyncFrame = requestAnimationFrame(() => {
        this.resyncFrame = null;
        this.resyncViewport(reason);
      });
    }
    for (const delay of [0, 150, 400, 1000]) {
      this.resyncTimers.push(setTimeout(() => this.resyncViewport(reason), delay));
    }
  }

  private cancelViewportResync(): void {
    for (const timer of this.resyncTimers) clearTimeout(timer);
    this.resyncTimers = [];
    if (this.resyncFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.resyncFrame);
    }
    this.resyncFrame = null;
  }

  private addResyncListeners(): void {
    this.visibilityResyncHandler = () => {
      if (document.hidden) this.cancelViewportResync();
      else this.scheduleViewportResync('visible');
    };
    // Only the window's own focus (element focus events reach a window listener in capture).
    this.focusResyncHandler = (e: Event) => {
      if (!(e.target instanceof Node)) this.scheduleViewportResync('focus');
    };
    this.orientationResyncHandler = () => this.scheduleViewportResync('orientation');
    // A field lost the focus: the keyboard goes, and iOS does not always say so with a resize.
    // Not at once: the focus may be on its way to another field (the keyboard stays up).
    this.blurResyncHandler = () => {
      this.cancelBlurRecheck();
      this.blurRecheckTimers = KEYBOARD_BLUR_RECHECK_MS.map((delay) =>
        setTimeout(() => this.resyncViewport('blur'), delay)
      );
    };
    document.addEventListener('focusout', this.blurResyncHandler);
    document.addEventListener('visibilitychange', this.visibilityResyncHandler);
    window.addEventListener('focus', this.focusResyncHandler);
    window.addEventListener('orientationchange', this.orientationResyncHandler);
  }

  private cancelBlurRecheck(): void {
    for (const timer of this.blurRecheckTimers) clearTimeout(timer);
    this.blurRecheckTimers = [];
  }

  private removeResyncListeners(): void {
    this.cancelViewportResync();
    this.cancelBlurRecheck();
    if (this.blurResyncHandler) {
      document.removeEventListener('focusout', this.blurResyncHandler);
      this.blurResyncHandler = null;
    }
    if (this.visibilityResyncHandler) {
      document.removeEventListener('visibilitychange', this.visibilityResyncHandler);
      this.visibilityResyncHandler = null;
    }
    if (this.focusResyncHandler) {
      window.removeEventListener('focus', this.focusResyncHandler);
      this.focusResyncHandler = null;
    }
    if (this.orientationResyncHandler) {
      window.removeEventListener('orientationchange', this.orientationResyncHandler);
      this.orientationResyncHandler = null;
    }
  }

  private setupMobileFeatures(isMobile: boolean): void {
    if (!this.callbacks) return;

    // Set up VirtualKeyboard API if available and on mobile
    if (isMobile && 'virtualKeyboard' in navigator) {
      // Enable overlays-content mode so keyboard doesn't resize viewport
      try {
        const nav = navigator as Navigator & { virtualKeyboard?: { overlaysContent: boolean } };
        if (nav.virtualKeyboard) {
          nav.virtualKeyboard.overlaysContent = true;
        }
        logger.log('VirtualKeyboard API: overlaysContent enabled');
      } catch (e) {
        logger.warn('Failed to set virtualKeyboard.overlaysContent:', e);
      }
    } else if (isMobile) {
      logger.log('VirtualKeyboard API not available on this device');
    }

    // Set up Visual Viewport API for Safari keyboard detection
    if (isMobile && window.visualViewport) {
      this.previousKeyboardHeight = 0;
      // Primed with the viewport as the session opens (keyboard down). Starting at 0, the first
      // measurement could be the keyboard opening itself, and in the home-screen app innerHeight
      // shrinks with it, so the keyboard was never seen: the chat composer kept its home-
      // indicator padding and floated ~50 pt above the keyboard (2026-10-03).
      this.viewportBaseline = window.visualViewport.height;
      this.viewportBaselineWidth = window.visualViewport.width;

      this.visualViewportHandler = () => {
        const viewport = window.visualViewport;
        if (!viewport || !this.callbacks || this.syncingViewport) return;
        // Safari keeps innerHeight and shrinks the visual viewport; Chrome on iOS shrinks both,
        // so innerHeight - viewport.height stays ~0 there and a keyboard closed with its own
        // button went unnoticed (2026-10-02: keyboard mode stayed on, the hidden input kept
        // stealing focus and taps showed only the quick keys). Also measure against the tallest
        // viewport seen at this width.
        const keyboardHeight = this.keyboardHeightNow(viewport);
        // The rule before the numbers: nothing to have a keyboard for, no gap (2026-11-11).
        if (keyboardHeight > 0 && this.keyboardCannotBeUp()) {
          this.forceKeyboardClosed();
          return;
        }
        const previousKeyboardHeight = this.previousKeyboardHeight;
        this.applyKeyboardState(keyboardHeight);

        // Detect keyboard dismissal (height drops to 0 or near 0)
        if (
          previousKeyboardHeight > KEYBOARD_VISIBLE_THRESHOLD &&
          keyboardHeight < KEYBOARD_VISIBLE_THRESHOLD
        ) {
          logger.log('Keyboard dismissed detected via viewport change');

          // Check if we're on mobile
          const directKeyboardManager = this.callbacks.getDirectKeyboardManager();

          if (directKeyboardManager?.getShowQuickKeys()) {
            // Check if we recently entered keyboard mode (within last 2 seconds)
            // This prevents iOS keyboard animation from being interrupted
            const isRecentlyEntered =
              directKeyboardManager.isRecentlyEnteredKeyboardMode?.() ?? false;

            if (isRecentlyEntered) {
              // Re-check once the animation window is over instead of dropping it: a quick
              // swipe-down otherwise left the quick keys up with no keyboard (2026-10-02).
              logger.log('Deferring keyboard dismissal - recently entered keyboard mode');
              if (this.keyboardDismissRecheck) clearTimeout(this.keyboardDismissRecheck);
              this.keyboardDismissRecheck = setTimeout(() => {
                this.keyboardDismissRecheck = null;
                // The same calculation: in Chrome on iOS innerHeight shrinks with the keyboard,
                // so innerHeight minus the viewport said "no keyboard" with it up.
                const vv = window.visualViewport;
                if (!vv || this.keyboardHeightNow(vv) >= KEYBOARD_VISIBLE_THRESHOLD) return;
                this.callbacks?.getDirectKeyboardManager()?.exitKeyboardMode();
              }, 2100);
            } else {
              // Leave keyboard mode entirely; only hiding the quick keys kept keyboard mode
              // on, which re-focused the input and brought them back without a keyboard.
              directKeyboardManager.exitKeyboardMode();
              logger.log('Left keyboard mode after keyboard dismissal');
            }
          }
        }
      };

      // Only listen to resize, NOT scroll
      // Scroll events cause false positives for keyboard dismissal detection
      // (iOS Safari changes viewport height when scrolling with UI hide/show)
      window.visualViewport.addEventListener('resize', this.visualViewportHandler);
    }
  }

  private setupEventListeners(isMobile: boolean): void {
    // Only add listeners if not already added
    if (!isMobile && !this.keyboardListenerAdded) {
      // Don't use capture phase - let browser handle shortcuts naturally
      document.addEventListener('keydown', this.keyboardHandler);
      this.keyboardListenerAdded = true;
    } else if (isMobile) {
      if (!this.mobileKeyboardListenerAdded) {
        document.addEventListener('keydown', this.mobileHardwareKeyboardHandler);
        this.mobileKeyboardListenerAdded = true;
      }
      if (!this.touchListenersAdded) {
        // Add touch event listeners for mobile swipe gestures
        document.addEventListener('touchstart', this.touchStartHandler, { passive: true });
        document.addEventListener('touchend', this.touchEndHandler, { passive: true });
        this.touchListenersAdded = true;
      }
    }
  }

  teardownLifecycle(): void {
    if (!this.callbacks) return;

    logger.log('SessionView disconnectedCallback called', {
      sessionId: this.session?.id,
      sessionStatus: this.session?.status,
    });

    this.callbacks.setConnected(false);

    // Reset terminal size for external terminals when leaving session view. Forwarded ones
    // (`ut` in a Mac window) too, for now: the ut-fwd that gives the window its size back once
    // it is typed into only reaches sessions started after the next app release, and without
    // the reset an older one's Mac window would keep the phone's width (2026-10-12).
    const terminalLifecycleManager = this.callbacks.getTerminalLifecycleManager();
    if (this.session && this.session.status !== 'exited' && terminalLifecycleManager) {
      logger.log('Calling resetTerminalSize for session', this.session.id);
      terminalLifecycleManager.resetTerminalSize();
    }

    // Update connection manager
    const connectionManager = this.callbacks.getConnectionManager();
    if (connectionManager) {
      connectionManager.setConnected(false);
    }

    // Cleanup terminal lifecycle manager
    if (terminalLifecycleManager) {
      terminalLifecycleManager.cleanup();
    }

    // Remove bfcache reconnection handler
    if (this.pageshowHandler) {
      window.removeEventListener('pageshow', this.pageshowHandler);
      this.pageshowHandler = null;
    }

    // Remove click outside handler
    document.removeEventListener('click', this.handleClickOutside);

    // Remove click handler
    if (this.clickHandler) {
      this.callbacks.removeEventListener('click', this.clickHandler);
      this.clickHandler = null;
    }

    // The gap does not outlive the session view: <html> kept data-keyboard-visible and
    // --keyboard-height from a keyboard left open here (2026-11-11).
    if (this.previousKeyboardHeight > 0) this.applyKeyboardState(0);
    this.removeModeListeners();

    // Cleanup direct keyboard manager
    const directKeyboardManager = this.callbacks.getDirectKeyboardManager();
    if (directKeyboardManager) {
      directKeyboardManager.cleanup();
    }

    this.removeResyncListeners();

    if (this.viewportTrackingHandler) {
      if (this.viewportTrackingTarget === 'visual' && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', this.viewportTrackingHandler);
        window.visualViewport.removeEventListener('scroll', this.viewportTrackingHandler);
      } else if (this.viewportTrackingTarget === 'window') {
        window.removeEventListener('resize', this.viewportTrackingHandler);
      }
      this.viewportTrackingHandler = null;
      this.viewportTrackingTarget = null;
      resetAppHeight();
    }
    this.stopChatKeyboardFix();

    // Remove window resize listener
    window.removeEventListener('resize', this.handleWindowResize);

    // Stop loading animation
    this.callbacks.stopLoading();

    // Cleanup stream connection if it exists
    if (connectionManager) {
      connectionManager.cleanupStreamConnection();
    }
  }

  cleanup(): void {
    logger.log('LifecycleEventManager cleanup');

    // Clean up event listeners
    document.removeEventListener('click', this.handleClickOutside);
    window.removeEventListener('resize', this.handleWindowResize);
    this.removeResyncListeners();
    if (this.pageshowHandler) {
      window.removeEventListener('pageshow', this.pageshowHandler);
      this.pageshowHandler = null;
    }

    this.removeModeListeners();

    if (this.viewportTrackingHandler) {
      if (this.viewportTrackingTarget === 'visual' && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', this.viewportTrackingHandler);
        window.visualViewport.removeEventListener('scroll', this.viewportTrackingHandler);
      } else if (this.viewportTrackingTarget === 'window') {
        window.removeEventListener('resize', this.viewportTrackingHandler);
      }
      this.viewportTrackingHandler = null;
      this.viewportTrackingTarget = null;
    }
    this.stopChatKeyboardFix();

    // Clean up click handler reference
    this.clickHandler = null;

    this.sessionViewElement = null;
    this.callbacks = null;
    this.session = null;
  }
}
