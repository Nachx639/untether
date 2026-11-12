/**
 * Direct Keyboard Input Manager
 *
 * Manages hidden input element and direct keyboard input for mobile devices.
 * Handles focus management, input events, quick key interactions, and IME composition.
 *
 * ## IME Support for Japanese/CJK Input
 *
 * This manager now includes full support for Input Method Editor (IME) composition,
 * which is essential for Japanese, Chinese, and Korean text input on mobile devices.
 *
 * **How IME Works:**
 * 1. User types "konnichiwa" on Japanese keyboard
 * 2. Browser shows composition UI: "こんにちは" (intermediate characters)
 * 3. User selects final text from candidates
 * 4. Browser fires `compositionend` with final text: "こんにちは"
 *
 * **Bug Fixed (GitHub #99):**
 * Previously, intermediate composition characters were sent to terminal during typing,
 * causing duplicated/garbled Japanese text. Now we properly wait for composition
 * completion before sending any text to the terminal.
 *
 * **Implementation:**
 * - `compositionstart`: Sets isComposing=true, prevents input events from sending text
 * - `compositionend`: Sends only the final composed text to terminal
 * - `input`: Skipped entirely during composition, normal handling otherwise
 */

import { t } from '../../i18n/index.js';
import { CHORD_QUICK_KEYS, writeKeys } from '../../utils/agent-chords.js';
import { Z_INDEX } from '../../utils/constants.js';
import { createLogger } from '../../utils/logger.js';
import {
  controlCharacterFor,
  DIRECT_KEYBOARD_INPUT_ATTRIBUTE,
} from '../../utils/quick-keys-layout.js';
import { type InputManager, isAppShortcut } from './input-manager.js';

const logger = createLogger('direct-keyboard-manager');

const HARDWARE_SPECIAL_KEYS: Readonly<Record<string, string>> = {
  Enter: 'enter',
  Escape: 'escape',
  ArrowUp: 'arrow_up',
  ArrowDown: 'arrow_down',
  ArrowLeft: 'arrow_left',
  ArrowRight: 'arrow_right',
  PageUp: 'page_up',
  PageDown: 'page_down',
  Home: 'home',
  End: 'end',
  Delete: 'delete',
};

export interface DirectKeyboardCallbacks {
  getShowCtrlAlpha(): boolean;
  getDisableFocusManagement(): boolean;
  /** Measure the soft keyboard now, through the layout's one calculation. */
  measureKeyboard(): void;
  getKeyboardHeight(): number;
  updateShowQuickKeys(value: boolean): void;
  toggleCtrlAlpha(): void;
  clearCtrlSequence(): void;
  getChatMode(): boolean;
  /**
   * Keyboard mode was left (2026-10-12): the lifecycle manager, the one writer of the keyboard
   * height, puts it to 0 and re-measures the viewport, as iOS may give no viewport event when
   * it hid the keyboard itself (page sent to background).
   */
  keyboardDismissed(): void;
}

/** The focused element, looking inside shadow roots (focus events only report the host). */
function deepFocus(element: Element | null): Element | null {
  let current = element;
  while (current?.shadowRoot?.activeElement) current = current.shadowRoot.activeElement;
  return current;
}

function isEditable(element: Element | null): boolean {
  if (!element) return false;
  const html = element as HTMLElement;
  return html.tagName === 'INPUT' || html.tagName === 'TEXTAREA' || html.isContentEditable === true;
}

/**
 * What a backward delete from the hidden input sends: one character, a word (Ctrl+W, as
 * Alt+Backspace does) or the line up to the cursor (Ctrl+U).
 */
const BACKWARD_DELETE_SEQUENCES: Record<string, string> = {
  deleteContentBackward: 'backspace',
  deleteWordBackward: '\x17',
  deleteSoftLineBackward: '\x15',
  deleteHardLineBackward: '\x15',
};

export class DirectKeyboardManager {
  private hiddenInput: HTMLTextAreaElement | null = null;
  private focusRetentionInterval: number | null = null;
  // While reopening the keyboard via TAP, suppress all automatic re-focus (interval,
  // focus handler, blur re-focus) so they don't make iOS think the field is already
  // focused and refuse to show the keyboard. Cleared shortly after the tap.
  private reopeningKeyboard = false;
  private keyboardReopenTimeout: ReturnType<typeof setTimeout> | null = null;
  private inputManager: InputManager | null = null;
  private sessionViewElement: HTMLElement | null = null;
  private callbacks: DirectKeyboardCallbacks | null = null;
  private showQuickKeys = false;
  private keyboardMode = false; // Track whether we're in keyboard mode
  private globalPasteHandler: ((e: Event) => void) | null = null;
  // Last touch anywhere in the page. A blur with no touch just before it means iOS itself
  // closed the keyboard (swipe down, Done); a refocus then can't bring the keyboard back.
  private lastTouchAt = 0;
  private readonly touchTracker = () => {
    this.lastTouchAt = Date.now();
  };

  // IME composition state tracking for Japanese/CJK input
  private isComposing = false;

  // Track last backspace time to avoid double-sends between keydown and input events
  private lastBackspaceTime = 0;

  private keyboardModeTimestamp = 0;
  /** Claude's chat view covers the terminal: the input stays out of iOS's reach (setUnreachable). */
  private unreachable = false;

  constructor() {
    // Add global paste listener for environments where Clipboard API doesn't work
    this.setupGlobalPasteListener();
    this.ensureHiddenInputVisible();
    if (typeof document !== 'undefined') {
      document.addEventListener('touchstart', this.touchTracker, { capture: true, passive: true });
    }
  }

  setInputManager(inputManager: InputManager): void {
    this.inputManager = inputManager;
  }

  setSessionViewElement(element: HTMLElement): void {
    this.sessionViewElement = element;
  }

  setCallbacks(callbacks: DirectKeyboardCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * 2026-10-04: while Claude's chat view covers the terminal, nothing types into it, yet this
   * input (on document.body, outside the terminal's inert subtree) was still a field iOS could
   * move to: with the chat composer focused, the owner's iPhone offered its ↑ ↓ field arrows and
   * could hand the keyboard to this invisible input (focus-diagnostics: "textarea [-9999,-9999]
   * op:0.01", no inert). Inert and disabled while covered, also across recreation; reachable
   * again as soon as the terminal shows (terminal mode, or the chat view steps aside).
   */
  setUnreachable(unreachable: boolean): void {
    if (this.unreachable === unreachable) return;
    this.unreachable = unreachable;
    if (this.hiddenInput) this.applyReachability(this.hiddenInput);
  }

  private applyReachability(input: HTMLTextAreaElement): void {
    if (this.unreachable && document.activeElement === input) input.blur();
    input.inert = this.unreachable;
    input.disabled = this.unreachable;
  }

  getShowQuickKeys(): boolean {
    return this.showQuickKeys;
  }

  setShowQuickKeys(value: boolean): void {
    this.showQuickKeys = value;
    if (!value) {
      // Clear focus retention interval
      if (this.focusRetentionInterval) {
        clearInterval(this.focusRetentionInterval);
        this.focusRetentionInterval = null;
      }

      // Blur the hidden input but don't exit keyboard mode immediately
      // Let the blur handler deal with exiting keyboard mode after checks
      if (this.hiddenInput) {
        this.hiddenInput.blur();
      }

      logger.log('Quick keys force hidden by external trigger');
    }
  }

  focusHiddenInput(forceRecreate = false): void {
    logger.log('Entering keyboard mode');

    // Enter keyboard mode
    this.keyboardMode = true;
    this.keyboardModeTimestamp = Date.now();

    // Stop any running focus-retention BEFORE focusing. The 100ms interval re-focuses
    // the input, and when it fires right before the tap iOS thinks the field is already
    // focused and refuses to show the keyboard — that's the random "TAP doesn't open the
    // keyboard" behaviour. Restart retention shortly after, once the keyboard is up.
    if (this.focusRetentionInterval) {
      clearInterval(this.focusRetentionInterval);
      this.focusRetentionInterval = null;
    }

    this.cancelKeyboardReopen();

    // Suppress automatic re-focus while iOS is showing the keyboard (TAP path only).
    if (forceRecreate) {
      this.reopeningKeyboard = true;
    }

    // Ensure input is ready and focus it synchronously (recreated when forceRecreate).
    this.ensureHiddenInputVisible(forceRecreate);

    // Restart focus retention after the keyboard has had time to appear, so it doesn't
    // steal the moment iOS uses to show the keyboard.
    if (forceRecreate) {
      this.keyboardReopenTimeout = setTimeout(() => {
        this.keyboardReopenTimeout = null;
        this.reopeningKeyboard = false;
        if (this.keyboardMode && !this.focusRetentionInterval) {
          this.startFocusRetention();
        }
      }, 500);
    } else {
      this.startFocusRetention();
    }
  }

  ensureHiddenInputVisible(forceRecreate = false): void {
    // iOS won't reopen the soft keyboard on a plain focus() of an input it considers
    // already focused — and our own blur-handler re-focuses the input ~50ms after the
    // keyboard is dismissed while the quick keys stay open. That race made the TAP
    // button reopen the keyboard only intermittently. So when the user explicitly taps
    // TAP (forceRecreate), recreate the input unconditionally: iOS treats a brand-new
    // field as fresh and reliably shows the keyboard.
    if (this.hiddenInput && forceRecreate) {
      const stale = this.hiddenInput;
      // Null it first so the stale input's blur handler won't refocus it.
      this.hiddenInput = null;
      stale.blur();
      stale.remove();
    }

    if (!this.hiddenInput) {
      this.createHiddenInput();
    } else {
      // Make sure it's in the DOM
      if (!this.hiddenInput.parentNode) {
        document.body.appendChild(this.hiddenInput);
      }
    }

    // Show quick keys immediately when entering keyboard mode
    // Don't wait for keyboard to appear - this provides immediate visual feedback
    // Skip if in chat mode (chat has its own input)
    if (this.keyboardMode && !this.showQuickKeys && !this.callbacks?.getChatMode()) {
      this.showQuickKeys = true;
      if (this.callbacks) {
        this.callbacks.updateShowQuickKeys(true);
        logger.log('Showing quick keys immediately in keyboard mode');
      }
    }

    // Now that we're in keyboard mode, focus the input synchronously
    if (this.hiddenInput && this.keyboardMode) {
      // Make sure input is visible and ready
      this.hiddenInput.style.display = 'block';
      this.hiddenInput.style.visibility = 'visible';

      // Focus synchronously - critical for iOS Safari. (When the keyboard needed
      // reopening with focus retained, the input was already recreated above, so a
      // plain focus() on the fresh field now reliably shows the keyboard.)
      this.hiddenInput.focus();

      // Set a space placeholder and position cursor at end
      // This helps iOS recognize that we want to show the keyboard
      // AND allows backspace to work by always having something to delete
      this.hiddenInput.value = ' ';
      this.hiddenInput.setSelectionRange(1, 1);

      logger.log('Focused hidden input with dummy value trick');
      // Diagnosis for real iPhones (2026-10-02: focus() sometimes produced no focus at all,
      // only the quick keys came up; the simulator never reproduced it).
      const input = this.hiddenInput;
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
        .userActivation;
      logger.log(
        `focus check: focused=${document.activeElement === input} active=${document.activeElement?.tagName} ` +
          `connected=${input.isConnected} userActivation=${activation?.isActive} ` +
          `event=${window.event?.type} rect=${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)} ` +
          `display=${style.display} visibility=${style.visibility} parent=${input.parentElement?.tagName}`
      );
    }
  }

  private createHiddenInput(): void {
    // A textarea, not <input type="text">: mobile browsers attach their AutoFill bar
    // (passwords / cards / addresses) above the keyboard for single-line inputs, which
    // cost about 60px above the quick keys in Chrome on iOS. Enter is intercepted on keydown.
    this.hiddenInput = document.createElement('textarea');
    this.hiddenInput.rows = 1;
    this.hiddenInput.wrap = 'off';
    this.hiddenInput.style.resize = 'none';
    this.hiddenInput.style.overflow = 'hidden';
    this.hiddenInput.style.position = 'absolute';

    // Hidden input that receives keyboard focus
    this.hiddenInput.style.opacity = '0.01'; // iOS needs non-zero opacity
    this.hiddenInput.style.fontSize = '16px'; // Prevent zoom on iOS
    this.hiddenInput.style.border = 'none';
    this.hiddenInput.style.outline = 'none';
    this.hiddenInput.style.background = 'transparent';
    // Fully invisible (2026-10-12): WebKit's textarea appearance and the global field styles
    // (shadow, padding) drew a faint box where the input sat while focused.
    this.hiddenInput.style.boxShadow = 'none';
    this.hiddenInput.style.webkitAppearance = 'none';
    this.hiddenInput.style.appearance = 'none';
    this.hiddenInput.style.padding = '0';
    this.hiddenInput.style.margin = '0';
    this.hiddenInput.style.width = '1px';
    this.hiddenInput.style.height = '1px';
    this.hiddenInput.style.minHeight = '0';
    this.hiddenInput.style.color = 'transparent';
    this.hiddenInput.style.caretColor = 'transparent';
    this.hiddenInput.style.cursor = 'default';
    this.hiddenInput.style.pointerEvents = 'none'; // Start with pointer events disabled
    this.hiddenInput.placeholder = '';
    this.hiddenInput.style.webkitUserSelect = 'text'; // iOS specific
    this.hiddenInput.autocapitalize = 'none'; // More explicit than 'off'
    this.hiddenInput.autocomplete = 'off';
    this.hiddenInput.setAttribute('autocorrect', 'off');
    this.hiddenInput.setAttribute('spellcheck', 'false');
    this.hiddenInput.setAttribute('data-autocorrect', 'off');
    this.hiddenInput.setAttribute('data-gramm', 'false'); // Disable Grammarly
    this.hiddenInput.setAttribute('data-ms-editor', 'false'); // Disable Microsoft Editor
    this.hiddenInput.setAttribute('data-smartpunctuation', 'false'); // Disable smart quotes/dashes
    this.hiddenInput.setAttribute('data-form-type', 'other'); // Hint this isn't a form field
    this.hiddenInput.setAttribute('inputmode', 'text'); // Allow keyboard but disable optimizations
    this.hiddenInput.setAttribute('enterkeyhint', 'done'); // Prevent iOS enter key behavior
    this.hiddenInput.setAttribute('aria-hidden', 'true');
    this.hiddenInput.setAttribute(DIRECT_KEYBOARD_INPUT_ATTRIBUTE, '');
    this.applyReachability(this.hiddenInput);

    // Set initial position based on mode
    this.updateHiddenInputPosition();

    // Handle IME composition events for Japanese/CJK input
    this.hiddenInput.addEventListener('compositionstart', () => {
      this.isComposing = true;
    });

    this.hiddenInput.addEventListener('compositionend', (e) => {
      const compositionEvent = e as CompositionEvent;
      this.isComposing = false;

      // Get the final composed text
      const finalText = compositionEvent.data || this.hiddenInput?.value || '';

      if (finalText) {
        // Don't send input to terminal if Ctrl overlay is visible
        const showCtrlAlpha = this.callbacks?.getShowCtrlAlpha() ?? false;
        if (!showCtrlAlpha && this.inputManager) {
          // Send the completed composition to terminal
          this.inputManager.sendInputText(finalText);
        }
      }

      // Reset input to placeholder space and clear composition buffer
      // Use requestAnimationFrame for iOS Safari compatibility
      requestAnimationFrame(() => {
        if (this.hiddenInput && document.activeElement === this.hiddenInput) {
          this.hiddenInput.value = ' ';
          this.hiddenInput.setSelectionRange(1, 1);
        }
      });
    });

    // Handle input events (non-composition)
    this.hiddenInput.addEventListener('input', (e) => {
      const input = e.target as HTMLTextAreaElement;
      const inputEvent = e as InputEvent;

      // Skip processing if we're in the middle of IME composition
      if (this.isComposing) {
        return;
      }

      // Don't send input to terminal if the Ctrl overlay is visible
      const showCtrlAlpha = this.callbacks?.getShowCtrlAlpha() ?? false;
      if (showCtrlAlpha) {
        return;
      }

      // Handle backspace/delete via inputType (critical for iOS key repeat)
      // On iOS, holding backspace sends repeated 'input' events with inputType='deleteContentBackward'
      // instead of repeated 'keydown' events like on desktop
      // Held long enough, iOS's backspace repeat moves on to whole words
      // (deleteWordBackward), and ⌘⌫ on a hardware keyboard deletes the line. Those
      // used to fall through: the placeholder was gone, nothing reached the terminal and,
      // with an empty field, iOS stopped repeating ("deletes a few, then stops").
      const backwardDelete = BACKWARD_DELETE_SEQUENCES[inputEvent.inputType];
      if (backwardDelete && this.inputManager) {
        const now = Date.now();
        if (inputEvent.inputType !== 'deleteContentBackward') {
          this.inputManager.sendInput(backwardDelete);
          this.lastBackspaceTime = now;
        } else if (now - this.lastBackspaceTime > 50) {
          // Skip if keydown just handled this (within 50ms) to avoid double-delete
          this.inputManager.sendInput('backspace');
          this.lastBackspaceTime = now;
        }
        // Re-add placeholder so iOS can continue generating delete events
        // Use requestAnimationFrame for iOS Safari compatibility
        requestAnimationFrame(() => {
          if (this.hiddenInput && document.activeElement === this.hiddenInput) {
            this.hiddenInput.value = ' ';
            this.hiddenInput.setSelectionRange(1, 1);
          }
        });
        return;
      }
      if (inputEvent.inputType === 'deleteContentForward' && this.inputManager) {
        this.inputManager.sendInput('delete');
        // Re-add placeholder so iOS can continue generating delete events
        // Use requestAnimationFrame for iOS Safari compatibility
        requestAnimationFrame(() => {
          if (this.hiddenInput && document.activeElement === this.hiddenInput) {
            this.hiddenInput.value = ' ';
            this.hiddenInput.setSelectionRange(0, 0);
          }
        });
        return;
      }

      // Typed characters: send exactly what this event inserted. The value is only reset to
      // the placeholder on the next animation frame, so with fast typing several input events
      // see the accumulated value — resending it turned "cue" into "ccucue".
      if (inputEvent.inputType === 'insertText' && inputEvent.data && this.inputManager) {
        this.inputManager.sendInputText(inputEvent.data);
        requestAnimationFrame(() => {
          if (this.hiddenInput && document.activeElement === this.hiddenInput) {
            this.hiddenInput.value = ' ';
            this.hiddenInput.setSelectionRange(1, 1);
          }
        });
        return;
      }

      // Any other edit that emptied the field: put the placeholder back, or the next
      // backspace has nothing to delete and iOS sends nothing at all.
      if (!input.value) {
        input.value = ' ';
        input.setSelectionRange(1, 1);
        return;
      }

      if (input.value && this.inputManager) {
        // Filter out the single placeholder space before sending. On the FIRST keystroke
        // iOS sometimes leaves the caret before the placeholder, so the typed char lands
        // ahead of it (value becomes "h " instead of " h"). Strip a leading space if
        // present, otherwise a trailing one — this fixes the "h ola" (extra space after
        // the first letter) bug without eating the user's own spaces mid-text.
        const textToSend = input.value.startsWith(' ')
          ? input.value.slice(1)
          : input.value.replace(/ $/, '');
        if (textToSend) {
          // Send each character to terminal (only for non-IME input)
          this.inputManager.sendInputText(textToSend);

          // Use requestAnimationFrame for iOS Safari compatibility
          // This prevents race conditions when typing quickly
          requestAnimationFrame(() => {
            if (this.hiddenInput && document.activeElement === this.hiddenInput) {
              // Keep a space placeholder for iOS backspace to work
              this.hiddenInput.value = ' ';
              this.hiddenInput.setSelectionRange(1, 1);
            }
          });
        } else {
          // No text to send, but still reset to maintain placeholder
          input.value = ' ';
          input.setSelectionRange(1, 1);
        }
      }
    });

    // Handle special keys
    this.hiddenInput.addEventListener('keydown', (e) => {
      // Don't process special keys if Ctrl overlay is visible
      const showCtrlAlpha = this.callbacks?.getShowCtrlAlpha() ?? false;
      if (showCtrlAlpha) {
        return;
      }

      // App shortcuts (⌘B, ⌘K, ⌘,, ⌘1–9, ⌘⇧[ ]) bubble to app.ts untouched, even before the
      // input manager is set (iPad with a Magic Keyboard, 2026-10-12).
      if (isAppShortcut(e) || this.inputManager?.isKeyboardShortcut(e)) {
        return;
      }

      const specialKey =
        e.key === 'Tab' ? (e.shiftKey ? 'shift_tab' : 'tab') : HARDWARE_SPECIAL_KEYS[e.key];
      if (specialKey) {
        e.preventDefault();
        e.stopPropagation();
        this.inputManager?.sendInput(specialKey);
      } else if (e.key === 'Backspace' && this.inputManager) {
        // Send backspace immediately on keydown for responsiveness
        // The input event handler will skip if this just fired (within 50ms)
        this.inputManager.sendInput('backspace');
        this.lastBackspaceTime = Date.now();
        // DON'T preventDefault - let browser also trigger input event for iOS key repeat
      }
    });

    // Handle focus/blur for quick keys visibility
    this.hiddenInput.addEventListener('focus', () => {
      logger.log(`Hidden input focused. Keyboard mode: ${this.keyboardMode}`);

      // Enable pointer events while focused
      if (this.hiddenInput && this.keyboardMode) {
        this.hiddenInput.style.pointerEvents = 'auto';
      }

      // If we're in keyboard mode, show quick keys immediately (skip in chat mode)
      if (this.keyboardMode && !this.callbacks?.getChatMode()) {
        this.showQuickKeys = true;
        if (this.callbacks) {
          this.callbacks.updateShowQuickKeys(true);
          logger.log('Showing quick keys due to keyboard mode');
        }

        // iOS specific: Set selection to trigger keyboard.
        // Place the caret AFTER the single-space placeholder (offset 1), matching the
        // backspace handler, so backspace continuation stays consistent on iPad.
        if (this.hiddenInput) {
          this.hiddenInput.setSelectionRange(1, 1);
        }
      } else if (!this.callbacks?.getChatMode()) {
        // Only show quick keys if keyboard is actually visible (skip in chat mode)
        const keyboardHeight = this.callbacks?.getKeyboardHeight() ?? 0;
        if (keyboardHeight > 50) {
          this.showQuickKeys = true;
          if (this.callbacks) {
            this.callbacks.updateShowQuickKeys(true);
          }
        }
      }

      // The keyboard is coming: measure it now, the way every viewport change does.
      this.callbacks?.measureKeyboard();

      // Start focus retention if not already running — but NOT while reopening the
      // keyboard via TAP (it would re-focus mid-gesture and stop iOS showing it).
      if (!this.focusRetentionInterval && !this.reopeningKeyboard) {
        this.startFocusRetention();
      }
    });

    this.hiddenInput.addEventListener('blur', (e) => {
      const _event = e as FocusEvent;

      logger.log(`Hidden input blurred. Keyboard mode: ${this.keyboardMode}`);
      logger.log(
        `Active element: ${document.activeElement?.tagName}, class: ${document.activeElement?.className}`
      );

      // If we're in keyboard mode, ALWAYS try to maintain focus
      // Only the Done button should exit keyboard mode
      if (this.keyboardMode && !this.reopeningKeyboard) {
        // 2026-10-02: refocusing after iOS closed the keyboard (swipe down, Done) or after
        // the user picked another field brought the quick keys back without a keyboard and
        // hid the Keyboard button. Only keep focus when the blur came from a tap in the page.
        // The keyboard proxy/catcher only hand focus back to this input: not another field.
        const next = deepFocus(_event.relatedTarget as Element | null);
        // Our own paste fallback field: keyboard mode stays, focus comes back after it.
        if (next && this.pasteFallback?.contains(next)) return;
        const otherField =
          isEditable(next) && !next?.matches?.('.keyboard-catcher, .keyboard-proxy');
        if (otherField || Date.now() - this.lastTouchAt > 600) {
          logger.log('Keyboard closed outside the page - leaving keyboard mode');
          this.dismissKeyboard();
          return;
        }
      }

      if (this.keyboardMode) {
        logger.log('In keyboard mode - maintaining focus');

        // Add a small delay to allow Done button to exit keyboard mode first
        setTimeout(() => {
          // Re-check keyboard mode after delay - Done button might have exited it.
          // Skip while reopening via TAP so this doesn't re-focus the stale input and
          // make iOS refuse to show the keyboard.
          if (
            !this.keyboardMode ||
            this.reopeningKeyboard ||
            !this.hiddenInput ||
            document.activeElement === this.hiddenInput
          ) {
            return;
          }
          // Focus moved into a field inside a shadow root (the chat composer): blur only saw
          // its host, so check where focus really is before taking it back.
          if (isEditable(deepFocus(document.activeElement))) {
            this.dismissKeyboard();
            return;
          }
          logger.log('Refocusing hidden input to maintain keyboard');
          this.hiddenInput.focus();
        }, 50); // 50ms delay to allow Done button processing

        // Don't exit keyboard mode or hide quick keys
        return;
      }

      // Only handle blur normally when NOT in keyboard mode
      const disableFocusManagement = this.callbacks?.getDisableFocusManagement() ?? false;
      if (!disableFocusManagement && this.showQuickKeys && this.hiddenInput) {
        // Check if focus went somewhere legitimate
        setTimeout(() => {
          const activeElement = document.activeElement;
          const isWithinComponent = this.sessionViewElement?.contains(activeElement) ?? false;

          if (!isWithinComponent && activeElement && activeElement !== document.body) {
            // Focus went somewhere outside our component
            this.showQuickKeys = false;
            if (this.callbacks) {
              this.callbacks.updateShowQuickKeys(false);
            }
            logger.log('Focus left component, hiding quick keys');

            // Clear focus retention interval
            if (this.focusRetentionInterval) {
              clearInterval(this.focusRetentionInterval);
              this.focusRetentionInterval = null;
            }
          }
        }, 100);
      }
    });

    // Add to the body for debugging (so it's always visible)
    document.body.appendChild(this.hiddenInput);
  }

  handleQuickKeyPress = async (
    key: string,
    isModifier?: boolean,
    isSpecial?: boolean,
    _isToggle?: boolean,
    _pasteText?: string
  ): Promise<void> => {
    logger.log(
      `[handleQuickKeyPress] Called with key: ${key}, isModifier: ${isModifier}, isSpecial: ${isSpecial}`
    );

    if (!this.inputManager) {
      logger.error('No input manager found');
      return;
    }
    if (isSpecial && key === 'Done') {
      // Dismiss the keyboard
      logger.log('Done button pressed - dismissing keyboard');
      // Set a flag to prevent refocus attempts
      this.dismissKeyboard();
      return;
    } else if (isModifier && key === 'Control') {
      // Just send Ctrl modifier - don't show the overlay
      // This allows using Ctrl as a modifier with physical keyboard
      return;
    } else if (key === 'CtrlFull') {
      // Toggle the full Ctrl+Alpha overlay
      if (this.callbacks) {
        this.callbacks.toggleCtrlAlpha();
      }

      const showCtrlAlpha = this.callbacks?.getShowCtrlAlpha() ?? false;
      if (showCtrlAlpha) {
        // Keep focus retention running - we want the keyboard to stay visible
        // The Ctrl+Alpha overlay should show above the keyboard
        // Don't stop focus retention or blur the input
      } else {
        // Clear the Ctrl sequence when closing
        if (this.callbacks) {
          this.callbacks.clearCtrlSequence();
        }

        // Restart focus retention when closing Ctrl overlay
        const disableFocusManagement = this.callbacks?.getDisableFocusManagement() ?? false;
        if (!disableFocusManagement && this.hiddenInput && this.showQuickKeys) {
          this.startFocusRetention();
          this.delayedRefocusHiddenInput();
        }
      }
      return;
    } else if (key === 'Paste') {
      // Handle Paste key - following iOS Safari best practices
      logger.log('Paste button pressed - attempting clipboard read');

      // Log environment details for debugging
      logger.log('Clipboard context:', {
        hasClipboard: !!navigator.clipboard,
        hasReadText: !!navigator.clipboard?.readText,
        isSecureContext: window.isSecureContext,
        protocol: window.location.protocol,
        userAgent: navigator.userAgent.includes('Safari') ? 'Safari' : 'Other',
      });

      // Check if we're in a secure context (HTTPS/localhost/PWA)
      if (window.isSecureContext && navigator.clipboard?.readText) {
        try {
          logger.log('Secure context detected - trying modern clipboard API...');
          const text = await navigator.clipboard.readText();
          logger.log('Clipboard read successful, text length:', text?.length || 0);

          if (text && this.inputManager) {
            logger.log('Sending clipboard text to terminal');
            this.inputManager.sendPastedText(text);
            return; // Success - exit early
          } else if (!text) {
            logger.warn('Clipboard is empty or contains no text');
            return;
          }
        } catch (err) {
          const error = err as Error;
          logger.warn('Clipboard API failed despite secure context:', {
            name: error?.name,
            message: error?.message,
          });
          // Continue to fallback
        }
      } else {
        logger.log(
          'Not in secure context (HTTP) - clipboard API unavailable, using textarea fallback'
        );
      }

      // Fallback: Use existing hidden input with paste event
      logger.log('Using iOS native paste fallback with existing hidden input');
      this.triggerNativePasteWithHiddenInput();
    } else if (CHORD_QUICK_KEYS.has(key)) {
      // Claude Code's send chords as one key: Ctrl+X Ctrl+S (send now), Ctrl+X Enter (queue).
      const inputManager = this.inputManager;
      writeKeys(
        (data) => void inputManager.sendControlSequence(data),
        CHORD_QUICK_KEYS.get(key) ?? []
      );
    } else if (key === 'Ctrl+A') {
      // Send Ctrl+A (start of line)
      this.inputManager.sendControlSequence('\x01');
    } else if (key === 'Ctrl+C') {
      // Send Ctrl+C (interrupt signal)
      this.inputManager.sendControlSequence('\x03');
    } else if (key === 'Ctrl+D') {
      // Send Ctrl+D (EOF)
      this.inputManager.sendControlSequence('\x04');
    } else if (key === 'Ctrl+E') {
      // Send Ctrl+E (end of line)
      this.inputManager.sendControlSequence('\x05');
    } else if (key === 'Ctrl+K') {
      // Send Ctrl+K (kill to end of line)
      this.inputManager.sendControlSequence('\x0b');
    } else if (key === 'Ctrl+L') {
      // Send Ctrl+L (clear screen)
      this.inputManager.sendControlSequence('\x0c');
    } else if (key === 'Ctrl+R') {
      // Send Ctrl+R (reverse search)
      this.inputManager.sendControlSequence('\x12');
    } else if (key === 'Ctrl+U') {
      // Send Ctrl+U (clear line)
      this.inputManager.sendControlSequence('\x15');
    } else if (key === 'Ctrl+W') {
      // Send Ctrl+W (delete word)
      this.inputManager.sendControlSequence('\x17');
    } else if (key === 'Ctrl+Z') {
      // Send Ctrl+Z (suspend signal)
      this.inputManager.sendControlSequence('\x1a');
    } else if (key.startsWith('Ctrl+') && controlCharacterFor(key.slice(5)) !== null) {
      // Any other Ctrl+<char> from the sticky Ctrl quick key
      this.inputManager.sendControlSequence(controlCharacterFor(key.slice(5)) as string);
    } else if (key === 'Option') {
      // Send ESC prefix for Option/Alt key
      this.inputManager.sendControlSequence('\x1b');
    } else if (key === 'Command') {
      // Command key doesn't have a direct terminal equivalent
      // Could potentially show a message or ignore
      return;
    } else if (key === 'Delete') {
      // Send delete key
      this.inputManager.sendInput('delete');
    } else if (key === 'Done') {
      // Safety check - Done should have been handled earlier
      this.dismissKeyboard();
      return;
    } else if (key.startsWith('F')) {
      // Handle function keys F1-F12
      const fNum = Number.parseInt(key.substring(1), 10);
      if (fNum >= 1 && fNum <= 12) {
        this.inputManager.sendInput(`f${fNum}`);
      }
    } else {
      // Map key names to proper values
      let keyToSend = key;
      if (key === 'Tab') {
        keyToSend = 'tab';
      } else if (key === 'Enter') {
        // The server writes \r for 'enter', what a terminal's Return key sends.
        keyToSend = 'enter';
      } else if (key === 'Escape') {
        keyToSend = 'escape';
      } else if (key === 'ArrowUp') {
        keyToSend = 'arrow_up';
      } else if (key === 'ArrowDown') {
        keyToSend = 'arrow_down';
      } else if (key === 'ArrowLeft') {
        keyToSend = 'arrow_left';
      } else if (key === 'ArrowRight') {
        keyToSend = 'arrow_right';
      } else if (key === 'PageUp') {
        keyToSend = 'page_up';
      } else if (key === 'PageDown') {
        keyToSend = 'page_down';
      } else if (key === 'Home') {
        keyToSend = 'home';
      } else if (key === 'End') {
        keyToSend = 'end';
      }

      // Send the key to terminal
      // For single character keys, send as text
      if (keyToSend.length === 1) {
        logger.log(`[handleQuickKeyPress] Sending single character: ${keyToSend}`);
        this.inputManager.sendInputText(keyToSend);
      } else {
        // For special keys, send as input command
        logger.log(`[handleQuickKeyPress] Sending special key: ${keyToSend.toLowerCase()}`);
        this.inputManager.sendInput(keyToSend.toLowerCase());
      }
    }

    // Always keep focus on hidden input after any key press (except Done)
    // Use requestAnimationFrame to ensure DOM has updated
    requestAnimationFrame(() => {
      const disableFocusManagement = this.callbacks?.getDisableFocusManagement() ?? false;
      if (!disableFocusManagement && this.hiddenInput && this.showQuickKeys) {
        this.hiddenInput.focus();
      }
    });
  };

  private startFocusRetention(): void {
    // 2026-11-10: each call left its predecessor's 100 ms interval running forever
    // (dismissKeyboard/cleanup only cleared the last one); always replace it.
    if (this.focusRetentionInterval) {
      clearInterval(this.focusRetentionInterval);
    }
    this.focusRetentionInterval = setInterval(() => {
      // While reopening via TAP, don't re-focus — let iOS show the keyboard first.
      if (this.reopeningKeyboard) {
        return;
      }
      const disableFocusManagement = this.callbacks?.getDisableFocusManagement() ?? false;
      const showCtrlAlpha = this.callbacks?.getShowCtrlAlpha() ?? false;

      // The paste fallback's field has the focus on purpose.
      if (this.pasteFallback) return;

      // Don't steal focus if user has text selected
      const selection = document.getSelection();
      const hasSelection = selection && selection.toString().length > 0;
      if (hasSelection) {
        return;
      }

      // In keyboard mode, always maintain focus regardless of other conditions
      if (this.keyboardMode && this.hiddenInput && document.activeElement !== this.hiddenInput) {
        logger.log('Keyboard mode: forcing focus on hidden input');
        this.hiddenInput.focus();
        return;
      }

      // Normal focus retention for quick keys
      if (
        !disableFocusManagement &&
        this.showQuickKeys &&
        this.hiddenInput &&
        document.activeElement !== this.hiddenInput &&
        !showCtrlAlpha
      ) {
        logger.log('Refocusing hidden input to maintain keyboard');
        this.hiddenInput.focus();
      }
    }, 100) as unknown as number; // More frequent checks (100ms instead of 300ms)
  }

  private cancelKeyboardReopen(): void {
    if (this.keyboardReopenTimeout) {
      clearTimeout(this.keyboardReopenTimeout);
      this.keyboardReopenTimeout = null;
    }
    this.reopeningKeyboard = false;
  }

  private delayedRefocusHiddenInput(): void {
    setTimeout(() => {
      const disableFocusManagement = this.callbacks?.getDisableFocusManagement() ?? false;
      if (!disableFocusManagement && this.hiddenInput) {
        this.hiddenInput.focus();
      }
    }, 100);
  }

  shouldRefocusHiddenInput(): boolean {
    const disableFocusManagement = this.callbacks?.getDisableFocusManagement() ?? false;
    return !disableFocusManagement && !!this.hiddenInput && this.showQuickKeys;
  }

  refocusHiddenInput(): void {
    setTimeout(() => {
      const disableFocusManagement = this.callbacks?.getDisableFocusManagement() ?? false;
      if (!disableFocusManagement && this.hiddenInput) {
        this.hiddenInput.focus();
      }
    }, 100);
  }

  startFocusRetentionPublic(): void {
    this.startFocusRetention();
  }

  delayedRefocusHiddenInputPublic(): void {
    this.delayedRefocusHiddenInput();
  }

  private updateHiddenInputPosition(): void {
    if (!this.hiddenInput) return;

    if (this.keyboardMode) {
      // In keyboard mode: position at bottom center but invisible
      this.hiddenInput.style.position = 'fixed';
      this.hiddenInput.style.bottom = '50px'; // Above quick keys
      this.hiddenInput.style.left = '50%';
      this.hiddenInput.style.transform = 'translateX(-50%)';
      this.hiddenInput.style.width = '1px';
      this.hiddenInput.style.height = '1px';
      this.hiddenInput.style.zIndex = String(Z_INDEX.TERMINAL_OVERLAY + 100);
      this.hiddenInput.style.pointerEvents = 'auto'; // Allow focus
    } else {
      // In scroll mode: position off-screen
      this.hiddenInput.style.position = 'fixed';
      this.hiddenInput.style.left = '-9999px';
      this.hiddenInput.style.top = '-9999px';
      this.hiddenInput.style.width = '1px';
      this.hiddenInput.style.height = '1px';
      this.hiddenInput.style.zIndex = '-1';
      this.hiddenInput.style.pointerEvents = 'none';
    }
  }

  /** The paste fallback sheet while it is open (see triggerNativePasteWithHiddenInput). */
  private pasteFallback: HTMLElement | null = null;

  /**
   * The clipboard could not be read (the browser refused, or iOS's Paste bubble was dismissed):
   * a small sheet with a field where iOS's own long-press Paste works, sent on to the session.
   * 2026-10-10: this used to turn the hidden keyboard input into a blank white box (its text
   * and placeholder are transparent), with an English hint nobody saw, and focus retention and
   * the keyboard's own handling moved it away as soon as it was touched. A user asked what it was.
   */
  private triggerNativePasteWithHiddenInput(): void {
    this.closePasteFallback(false);
    const sheet = document.createElement('div');
    sheet.dataset.testid = 'paste-fallback';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', t('directKeyboard.pasteHint'));
    sheet.style.cssText =
      'position:fixed;left:50%;top:22%;transform:translateX(-50%);' +
      'z-index:10000;width:min(320px, calc(100vw - 32px));box-sizing:border-box;' +
      'padding:12px;border-radius:var(--ut-r-xl);background:var(--color-bg-elevated);' +
      'box-shadow:var(--shadow-e3);display:flex;flex-direction:column;gap:10px;' +
      'font-family:var(--font-ui);';
    const field = document.createElement('textarea');
    field.rows = 2;
    field.placeholder = t('directKeyboard.pasteHint');
    field.setAttribute('autocorrect', 'off');
    field.setAttribute('autocapitalize', 'none');
    field.setAttribute('spellcheck', 'false');
    field.dataset.testid = 'paste-fallback-field';
    field.style.cssText =
      'width:100%;box-sizing:border-box;font-size:16px;padding:10px 12px;border-radius:var(--ut-r-lg);' +
      'border:1px solid var(--color-border-strong);background:var(--color-surface);' +
      'color:var(--color-text);resize:none;outline:none;' +
      '-webkit-user-select:text;user-select:text;-webkit-touch-callout:default;';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = t('common.cancel');
    cancel.style.cssText =
      'align-self:flex-end;min-height:44px;padding:0 16px;border-radius:var(--ut-r-8);border:0;' +
      'background:var(--color-bg-tertiary);color:var(--color-text);font-size:15px;' +
      'font-family:var(--font-ui);';
    field.addEventListener('paste', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      logger.log('Paste fallback received text, length:', text.length);
      if (text) this.inputManager?.sendInputText(text);
      this.closePasteFallback(true);
    });
    cancel.addEventListener('click', () => this.closePasteFallback(true));
    sheet.append(field, cancel);
    document.body.appendChild(sheet);
    this.pasteFallback = sheet;
    field.focus();
  }

  /** Closes the paste fallback; `refocus` gives the keyboard back to the session. */
  private closePasteFallback(refocus: boolean): void {
    if (!this.pasteFallback) return;
    this.pasteFallback.remove();
    this.pasteFallback = null;
    if (refocus && this.keyboardMode) this.hiddenInput?.focus();
  }

  private setupGlobalPasteListener(): void {
    // Listen for paste events anywhere in the document
    // This catches CMD+V or context menu paste when the hidden input is focused
    this.globalPasteHandler = (e: Event) => {
      const pasteEvent = e as ClipboardEvent;
      // Only handle if our hidden input is focused and we're in keyboard mode
      if (this.hiddenInput && document.activeElement === this.hiddenInput && this.showQuickKeys) {
        const clipboardData = pasteEvent.clipboardData?.getData('text/plain');
        if (clipboardData && this.inputManager) {
          logger.log('Global paste event captured, text length:', clipboardData.length);
          this.inputManager.sendInputText(clipboardData);
          pasteEvent.preventDefault();
          pasteEvent.stopPropagation();
        }
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('paste', this.globalPasteHandler);
      logger.log('Global paste listener setup for CMD+V support');
    }
  }

  /** Leave keyboard mode (hide the soft keyboard and the quick keys). */
  exitKeyboardMode(): void {
    if (this.keyboardMode || this.showQuickKeys) this.dismissKeyboard();
  }

  private dismissKeyboard(): void {
    // Exit keyboard mode
    this.keyboardMode = false;
    this.keyboardModeTimestamp = 0;
    this.cancelKeyboardReopen();

    // Hide quick keys
    this.showQuickKeys = false;
    if (this.callbacks) {
      this.callbacks.updateShowQuickKeys(false);
    }

    // Stop focus retention
    if (this.focusRetentionInterval) {
      clearInterval(this.focusRetentionInterval);
      this.focusRetentionInterval = null;
    }

    // Blur the hidden input and move it off-screen
    if (this.hiddenInput) {
      this.hiddenInput.blur();
      this.updateHiddenInputPosition();
    }

    this.callbacks?.keyboardDismissed();
    logger.log('Keyboard dismissed');
  }

  cleanup(): void {
    this.closePasteFallback(false);
    // Clear timers
    this.cancelKeyboardReopen();
    if (this.focusRetentionInterval) {
      clearInterval(this.focusRetentionInterval);
      this.focusRetentionInterval = null;
    }

    if (typeof document !== 'undefined') {
      document.removeEventListener('touchstart', this.touchTracker, { capture: true });
    }

    // Remove global paste listener
    if (this.globalPasteHandler) {
      document.removeEventListener('paste', this.globalPasteHandler);
      this.globalPasteHandler = null;
    }

    // Remove hidden input if it exists
    if (this.hiddenInput) {
      this.hiddenInput.remove();
      this.hiddenInput = null;
    }
  }

  getKeyboardMode(): boolean {
    return this.keyboardMode;
  }

  /**
   * Blur the hidden input to release keyboard focus (used when entering chat mode)
   * This completely disables the keyboard capture to allow other inputs to receive focus
   */
  blurHiddenInput(): void {
    // Exit keyboard mode completely
    this.keyboardMode = false;
    this.keyboardModeTimestamp = 0;
    this.showQuickKeys = false;
    this.cancelKeyboardReopen();

    // Stop focus retention interval - critical to prevent refocusing
    if (this.focusRetentionInterval) {
      clearInterval(this.focusRetentionInterval);
      this.focusRetentionInterval = null;
    }

    // Blur the hidden input
    if (this.hiddenInput) {
      this.hiddenInput.blur();
      this.updateHiddenInputPosition();
    }

    // Notify callbacks
    if (this.callbacks) {
      this.callbacks.updateShowQuickKeys(false);
      this.callbacks.keyboardDismissed();
    }

    logger.log('Hidden input blurred for chat mode');
  }

  isRecentlyEnteredKeyboardMode(): boolean {
    // Check if we entered keyboard mode within the last 2 seconds
    // This helps prevent iOS keyboard animation from being interrupted
    if (!this.keyboardMode) return false;

    const timeSinceEntry = Date.now() - this.keyboardModeTimestamp;
    return timeSinceEntry < 2000; // 2 seconds
  }
}
