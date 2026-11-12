/**
 * Mobile Action Bar Component
 *
 * The session's bottom toolbar on phones (phone spec 3.3, 2026-10-12): up to five evenly
 * spaced 44 px icon buttons with 11 px labels, in the thumb zone: Keyboard, Paste (long press:
 * the clipboard sheet), Files, Preview (only while the session serves a preview port) and ⋯
 * (the session's action sheet, compact-menu.ts). While the agent waits for an answer the
 * middle slots become one amber Responder pill. Hidden while the soft keyboard is up (the
 * quick keys take its place). It publishes its height as --ut-bottom-chrome for the toasts.
 */
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, type MessageKey, t } from '../i18n/index.js';
import { isSwallowingGhostClick } from '../utils/ghost-click.js';
import { createLogger } from '../utils/logger.js';
import { detectMobile } from '../utils/mobile-utils.js';
import { endsADrag, touchEndsADrag } from '../utils/pointer-drag.js';
import { deriveSessionStatus } from '../utils/session-status.js';
import type { ClipboardManagerCallbacks } from './clipboard-manager.js';
import { type IconName, icon } from './icons.js';
import { OPEN_SESSION_MENU_EVENT } from './session-view/compact-menu.js';

// Import the new components
import './clipboard-manager.js';

const logger = createLogger('mobile-action-bar');

export interface MobileActionBarCallbacks extends ClipboardManagerCallbacks {
  // The bar's own buttons (Paste, Files and its long press). The command palette that took the
  // other callbacks was never opened by any button and was removed (2026-10-20 audit).
  onPasteFromClipboard?: () => void;
  onOpenFileBrowser?: () => void;
  onUploadFile?: () => void;
  // Additional mobile-specific callbacks
  onShowKeyboard?: () => void;
  onTriggerHaptic?: (type: 'light' | 'medium' | 'heavy') => void;
}

interface ActionButton {
  id: string;
  title: MessageKey;
  icon: IconName;
  action:
    | keyof MobileActionBarCallbacks
    | 'showClipboardManager'
    | 'openPreview'
    | 'openSessionMenu';
  longPressAction?: ActionButton['action'];
}

/**
 * --ut-bottom-chrome on <html>: the height of the bar pinned to the bottom (toasts sit above
 * it). Each bottom-bar owner writes its own height while it shows, and on hide clears it only
 * if the value is still its own, so a bar taking over (quick keys for the action bar) is never
 * reset by the one leaving.
 */
export class BottomChrome {
  private last = '';

  set(px: number): void {
    const value = `${Math.round(px)}px`;
    this.last = value;
    document.documentElement.style.setProperty('--ut-bottom-chrome', value);
  }

  clear(): void {
    const root = document.documentElement.style;
    if (this.last && root.getPropertyValue('--ut-bottom-chrome') === this.last) {
      root.setProperty('--ut-bottom-chrome', '0px');
    }
    this.last = '';
  }

  /** Follows the element's height while it has one; clears when it collapses to 0. */
  sync(element: HTMLElement): void {
    const height = element.offsetHeight;
    if (height > 0) this.set(height);
    else this.clear();
  }
}

@customElement('mobile-action-bar')
export class MobileActionBar extends LitElement {
  // Disable shadow DOM to use Tailwind
  createRenderRoot() {
    return this;
  }

  @property({ type: Boolean }) visible = true;
  @property({ type: Object }) session: Session | null = null;
  @property({ type: Object }) callbacks: MobileActionBarCallbacks | null = null;
  @property({ type: Boolean }) keyboardVisible = false;

  @state() private showClipboardManager = false;
  @state() private longPressTimer: number | null = null;
  @state() private isMobile = detectMobile();
  protected readonly i18n = new LocaleController(this);

  private readonly keyboardAction: ActionButton = {
    id: 'keyboard',
    title: 'actionBar.keyboard',
    icon: 'keyboard',
    action: 'onShowKeyboard',
  };
  // Tap pastes (what a phone user wants); long press opens the clipboard manager.
  private readonly pasteAction: ActionButton = {
    id: 'clipboard',
    title: 'actionBar.paste',
    icon: 'clipboard',
    action: 'onPasteFromClipboard',
    longPressAction: 'showClipboardManager',
  };
  private readonly filesAction: ActionButton = {
    id: 'files',
    title: 'actionBar.files',
    icon: 'folder',
    action: 'onOpenFileBrowser',
    longPressAction: 'onUploadFile',
  };
  private readonly previewAction: ActionButton = {
    id: 'preview',
    title: 'preview.title',
    icon: 'eye',
    action: 'openPreview',
  };
  private readonly moreAction: ActionButton = {
    id: 'more',
    title: 'phone.more',
    icon: 'more',
    action: 'openSessionMenu',
  };

  private resizeObserver: ResizeObserver | null = null;
  private readonly bottomChrome = new BottomChrome();

  connectedCallback() {
    super.connectedCallback();

    // Ensure all modals start closed
    this.closeAllModals();

    // Listen for orientation changes
    window.addEventListener('orientationchange', this.handleOrientationChange);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.bottomChrome.sync(this));
      this.resizeObserver.observe(this);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('orientationchange', this.handleOrientationChange);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.bottomChrome.clear();

    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
    }
  }

  private handleOrientationChange = () => {
    // Small delay to let the orientation change complete
    setTimeout(() => {
      this.requestUpdate();
    }, 100);
  };

  private async triggerHaptic(type: 'light' | 'medium' | 'heavy' = 'light') {
    if (this.callbacks?.onTriggerHaptic) {
      this.callbacks.onTriggerHaptic(type);
    }

    // Fallback to native haptic feedback on supported devices
    if ('vibrate' in navigator) {
      const patterns = {
        light: [10],
        medium: [20],
        heavy: [50],
      };
      navigator.vibrate(patterns[type]);
    }
  }

  private handleButtonPress(button: ActionButton, event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();

    logger.debug(`Button pressed: ${button.id}`);
    this.triggerHaptic('light');

    // Set timer for all buttons - we'll check for long press action in the timeout
    this.longPressTimer = window.setTimeout(() => {
      // This timeout means it's a long press
      if (button.longPressAction) {
        logger.debug(`Long press action: ${button.longPressAction}`);
        this.triggerHaptic('medium');
        this.executeAction(button.longPressAction);
      }
      this.longPressTimer = null;
    }, 500); // 500ms long press
  }

  private handleButtonRelease(button: ActionButton, event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.lastPointerUp = Date.now();

    // If long press timer is still active, it's a regular tap
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
      // Unless the finger moved: iOS ends a drag that started on the button here too.
      if (endsADrag(event)) return;
      logger.debug(`Button tap: ${button.id} -> ${button.action}`);
      this.executeAction(button.action);
    } else {
      logger.debug(`Button release but no timer: ${button.id}`);
    }
  }

  private executeAction(
    action:
      | keyof MobileActionBarCallbacks
      | 'showClipboardManager'
      | 'openPreview'
      | 'openSessionMenu'
  ) {
    logger.debug(`Executing mobile action: ${action}`);

    // Handle internal actions
    switch (action) {
      case 'showClipboardManager':
        logger.debug('Toggling clipboard manager - current state:', this.showClipboardManager);
        if (this.showClipboardManager) {
          this.showClipboardManager = false;
        } else {
          this.closeAllModals();
          this.showClipboardManager = true;
        }
        return;
      case 'openPreview': {
        const sessionId = this.session?.id;
        const port = this.session?.previewPorts?.[0]?.port;
        if (sessionId) {
          window.dispatchEvent(new CustomEvent('ut-open-preview', { detail: { sessionId, port } }));
        }
        return;
      }
      case 'openSessionMenu':
        window.dispatchEvent(new CustomEvent(OPEN_SESSION_MENU_EVENT));
        return;
    }

    // Execute callback if available (only for actual callback actions)
    if (typeof action === 'string' && action.startsWith('on')) {
      const callback = this.callbacks?.[action as keyof MobileActionBarCallbacks];

      if (callback && typeof callback === 'function') {
        // Handle callbacks that require parameters
        if (action === 'onTriggerHaptic') {
          (callback as (type: 'light' | 'medium' | 'heavy') => void)('light');
        } else {
          (callback as () => void)();
        }
      }
    }
  }

  private lastKeyboardTouchEnd = 0;

  /**
   * A real (transparent) textarea covers the Keyboard button. On iPhone, once the page has
   * lost keyboard focus (after Done, or right after loading) iOS ignores a scripted focus():
   * activeElement changes but no focus event fires and the keyboard never appears, leaving
   * only the quick keys (2026-10-02, iOS 27 Safari and Chrome). A finger landing on a real
   * field always brings the keyboard up; focus then moves to the hidden terminal input with
   * the keyboard already open.
   */
  private handleKeyboardProxyFocus = (e: FocusEvent) => {
    // Focused by the end of a tap that closed a sheet above it, not a tap on this button.
    if (isSwallowingGhostClick()) {
      (e.target as HTMLElement).blur();
      return;
    }
    // The tap's click comes after focus, when the quick keys may already sit under the
    // finger (this bar hides): swallow it so it neither sends a key nor steals focus.
    const swallow = (e: Event) => this.swallowClick(e);
    document.addEventListener('click', swallow, true);
    setTimeout(() => document.removeEventListener('click', swallow, true), 700);
    this.cancelLongPress();
    this.lastKeyboardTouchEnd = Date.now();
    this.executeAction('onShowKeyboard');
  };

  /**
   * The keyboard button focuses the hidden input from touchend, like a terminal tap: in
   * Chrome on iOS (WKWebView) a focus() from pointerup sometimes left only the quick keys
   * up without the soft keyboard.
   */
  private handleKeyboardTouchEnd(button: ActionButton, e: TouchEvent) {
    if (button.action !== 'onShowKeyboard') return;
    // A scroll that started on the button ends here too: not a tap (2026-10-03).
    if (touchEndsADrag(e)) return;
    e.preventDefault();
    this.cancelLongPress();
    this.lastKeyboardTouchEnd = Date.now();
    this.executeAction(button.action);
  }

  private handleButtonClick(button: ActionButton, e: MouseEvent) {
    this.swallowClick(e);
    // Mouse or keyboard activation of the keyboard button (touch already ran on touchend).
    if (button.action === 'onShowKeyboard') {
      if (Date.now() - this.lastKeyboardTouchEnd > 700) {
        this.cancelLongPress();
        this.executeAction(button.action);
      }
      return;
    }
    // The other buttons act on pointerup; a click with no pointer gesture just before it is
    // a keyboard / VoiceOver / switch-control activation, which used to do nothing.
    if (Date.now() - this.lastPointerUp > 700) {
      this.cancelLongPress();
      this.executeAction(button.action);
    }
  }

  private lastPointerUp = 0;

  private cancelLongPress() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  // The click after a tap must not bubble to session-view: its click handler focuses the
  // session view and steals focus from the hidden input, closing the keyboard just opened.
  private swallowClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };

  private closeAllModals(): void {
    this.showClipboardManager = false;
  }

  /** The agent waits for an answer: the reply sheet, as the list rows open it. */
  private openAnswerSheet = (e: Event) => {
    this.swallowClick(e);
    const sessionId = this.session?.id;
    if (!sessionId) return;
    this.triggerHaptic('light');
    window.dispatchEvent(new CustomEvent('ut-open-answer-sheet', { detail: { sessionId } }));
  };

  render() {
    // Not while the soft keyboard is up: the quick keys (or the field) own the bottom then.
    if (!this.visible || !this.isMobile || this.keyboardVisible) {
      return html``;
    }

    const renderButton = (button: ActionButton) => html`
      <button
        type="button"
        class="ut-ab-btn ut-surface--control"
        data-testid=${`action-bar-${button.id}`}
        @pointerdown=${(e: PointerEvent) => this.handleButtonPress(button, e)}
        @pointerup=${(e: PointerEvent) => {
          if (button.action !== 'onShowKeyboard') this.handleButtonRelease(button, e);
        }}
        @pointercancel=${() => {
          this.lastPointerUp = Date.now();
          this.cancelLongPress();
        }}
        @touchend=${(e: TouchEvent) => this.handleKeyboardTouchEnd(button, e)}
        @click=${(e: MouseEvent) => this.handleButtonClick(button, e)}
        title=${button.longPressAction ? t('actionBar.longPressHint', { action: t(button.title) }) : t(button.title)}
        aria-label=${t(button.title)}
      >
        ${icon(button.icon, 22)}
        <span class="ut-ab-label" aria-hidden="true">${t(button.title)}</span>
      </button>
    `;

    const waiting = this.session ? deriveSessionStatus(this.session) === 'needs-input' : false;
    const hasPreview = Boolean(this.session?.previewPorts?.length);

    // Docked in the session view's flex column (not floating) so it never covers terminal
    // rows — the floating version sat exactly on top of Claude Code's input line.
    return html`
      <div
        class="ut-action-bar mobile-action-bar ut-surface--bar"
        role="toolbar"
        aria-label=${t('actionBar.moreActions')}
        data-testid="mobile-action-bar"
      >
        <span class="ut-ab-slot" @click=${this.swallowClick}>
          ${renderButton(this.keyboardAction)}
          <textarea
            class="keyboard-proxy"
            rows="1"
            tabindex="-1"
            aria-hidden="true"
            autocomplete="off"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            @focus=${this.handleKeyboardProxyFocus}
            style="position:absolute;inset:0;width:100%;height:100%;min-height:0;margin:0;padding:0;border:0;outline:none;resize:none;opacity:0.01;font-size:16px;color:transparent;background:transparent;caret-color:transparent;box-shadow:none;-webkit-appearance:none;appearance:none;"
          ></textarea>
        </span>
        ${renderButton(this.pasteAction)}
        ${
          waiting
            ? html`<span class="ut-ab-reply-slot">
                <button
                  type="button"
                  class="ut-ab-reply ut-surface--control"
                  data-testid="action-bar-reply"
                  @click=${this.openAnswerSheet}
                >
                  ${t('phone.reply')}
                </button>
              </span>`
            : html`${renderButton(this.filesAction)}${hasPreview ? renderButton(this.previewAction) : nothing}`
        }
        ${renderButton(this.moreAction)}
      </div>

      <!-- Clipboard Manager Modal -->
      <clipboard-manager
        .visible=${this.showClipboardManager}
        .callbacks=${this.callbacks}
        @close=${() => {
          this.showClipboardManager = false;
        }}
      ></clipboard-manager>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mobile-action-bar': MobileActionBar;
  }
}
