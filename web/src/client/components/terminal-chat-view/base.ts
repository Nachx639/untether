import { LitElement } from 'lit';
import { property, query, state } from 'lit/decorators.js';
import type { ScreenChoices, ScreenLayout } from '../../../shared/claude-screen.js';
import { LocaleController, type MessageKey } from '../../i18n/index.js';
import { composerHeightFor } from '../../utils/composer-height.js';
import type { DictationState } from '../../utils/dictation.js';
import { attachSheetDrag } from '../../utils/mobile-utils.js';
import { loadCustomQuickPrompts, type QuickPrompt } from '../../utils/quick-prompts.js';
import { AttachmentQueue, type AttachmentUploader, uploadAttachment } from '../chat-attachments.js';
import type { ChatMessage, ChatViewHandle } from './shared.js';

/**
 * <terminal-chat-view>'s properties and state, shared by the layers that make it up
 * (chat-output → screen-menu → quick-prompts-panel → composer → terminal-chat-view.ts).
 */
export abstract class TerminalChatViewBase extends LitElement {
  @property() onSend?: (data: string) => void;

  @property() onPendingInputChange?: (input: string) => void;

  @property() subscribeToOutput?: (listener: (data: string) => void) => () => void;

  @property() getTerminalInputLine?: () => string;

  @property({ type: Boolean }) active = false;

  /** Render only the input bar (phones show the live terminal above it). */
  @property({ type: Boolean }) composerOnly = false;

  /**
   * With `composerOnly`: the composer under the agent's chat in a desktop browser (design spec
   * 5.2): one centred card with attach, the field and Send; no + sheet or quick replies.
   */
  @property({ type: Boolean, reflect: true }) desktop = false;

  /** A short pane (split preview on a small phone): only the essentials, no prompt chips. */
  @property({ type: Boolean }) compactChrome = false;

  /**
   * A phone on its side (utils/short-landscape.ts). With `compactChrome` the prompt chips
   * stay hidden but a button in the composer opens them as one slim row (2026-10-04): on a
   * Pro Max in landscape the chat has about 190 pt, and a row of chips always there took a
   * fifth of it.
   */
  @property({ type: Boolean }) landscape = false;

  /** The slim row of prompt chips opened from the composer (`landscape`). */
  @state() protected promptsOpen = false;

  @property({ type: String }) pendingInput = '';

  @property({ type: String }) sessionId = '';

  /** Whether the session runs Claude Code, when the parent knows; quick prompts hide only on false. */
  @property({ attribute: false }) claudeSession?: boolean;

  /** The agent the session runs ("codex", "claude", a shell…), when the parent knows. */
  @property({ attribute: false }) agent?: string;

  /**
   * The terminal's last rows. The phone composer reads them for a menu that typing cannot
   * answer (Claude Code's trust-folder dialog), whose options then replace the quick prompts.
   */
  @property({ attribute: false }) getScreenText?: () => string;

  /** The PTY's width, as the stream last said: the menu is read again at once when it changes. */
  @property({ type: Number }) ptyCols?: number;

  /** How getScreenText's lines are laid out: width, soft-wrapped rows, visible rows. */
  @property({ attribute: false }) getScreenLayout?: () => ScreenLayout | undefined;

  /** Claude Code reports it waits for the user (a permission, a plan to approve, a question). */
  @property({ attribute: false }) claudeWaiting?: boolean;

  /** The chat view above shows the menu's question and options itself: no second set here. */
  @property({ attribute: false }) menuInChat = false;

  /**
   * True while the terminal's buffer is not the live screen (a history replay being written,
   * and a moment after): no menu is read from it then.
   */
  @property({ attribute: false }) screenSettling?: () => boolean;

  /** A menu read once, not shown until a second read confirms it (SCREEN_MENU_CONFIRM_MS). */
  protected pendingScreenMenu: ScreenChoices | null = null;

  protected screenMenuConfirmTimer?: ReturnType<typeof setTimeout>;

  /** A selection menu on screen: sending text would confirm its highlighted option. */
  @state() protected screenMenu: ScreenChoices | null = null;

  @state() protected screenMenuBusy = false;

  protected screenMenuTimer?: ReturnType<typeof setInterval>;

  /** The menu just answered, ignored while the screen still shows it (it redraws first). */
  protected answeredMenu: { sessionId: string; menu: ScreenChoices; at: number } | null = null;

  /** A message on its way through the server (an answer or a reply to a waiting Claude). */
  @state() protected replyInFlight = false;

  /** Messages the chat view shows as not sent, by its bubble id, for its Retry. */
  protected failedSends = new Map<string, { command: string; paths: string }>();

  /** Polls in a row that found no menu: one miss may be Claude redrawing it. */
  protected screenMenuMisses = 0;

  /** The server said the menu changed: the next poll takes what is on screen as it is. */
  protected refreshScreenMenu = false;

  /** Why a send or a tap did nothing, shown in the menu block (outside it, it would resize). */
  @state() protected screenMenuNote = '';

  protected screenMenuNoteTimer?: ReturnType<typeof setTimeout>;

  protected outputUnsubscribe?: () => void;

  protected syncInterval?: ReturnType<typeof setInterval>;

  protected delayedTasks = new Set<ReturnType<typeof setTimeout>>();

  protected lastInputTime = 0;

  @state() protected messages: ChatMessage[] = [];

  @state() protected slashMatches: Array<[string, MessageKey]> = [];

  @state() protected composerEmpty = true;

  /** Phone composer: images to send with the next message (uploaded in the background). */
  @property({ attribute: false }) attachmentUploader?: AttachmentUploader;

  protected attachments = new AttachmentQueue(
    () => this.requestUpdate(),
    (file, onProgress, signal) =>
      (this.attachmentUploader ?? uploadAttachment)(file, onProgress, signal)
  );

  @state() protected customPrompts: QuickPrompt[] | null = loadCustomQuickPrompts();

  protected quickPromptAt = 0;

  protected longPressTimer?: ReturnType<typeof setTimeout>;

  protected longPressed = false;

  /** Working copy while the quick-prompt editor is open. */
  @state() protected editingPrompts: QuickPrompt[] | null = null;

  /** The chat above says Claude is working (claude-chat-state): no quick replies then. */
  @state() protected chatBusy = false;

  /** The + sheet (attach, talk, quick replies) is open. */
  @state() protected plusOpen = false;

  /** Desktop: the attach menu (photo, this device's file, the Mac's file) is open. */
  @state() protected attachMenuOpen = false;

  /** The docked prompt's detail shows whole. */
  @state() protected menuDetailOpen = false;

  /** When the current dictation started (Date.now()), for its mm:ss. */
  protected dictationStartedAt = 0;

  protected dictationClock?: ReturnType<typeof setInterval>;

  /** The microphone's recent levels (0-1), oldest first: the recording capsule's meter. */
  @state() protected levelHistory: number[] = [];

  protected bottomChromeObserver: ResizeObserver | null = null;

  protected sheetDrags = new Map<HTMLDialogElement, () => void>();

  /** The quick reply row being dragged in the editor, by its index. */
  protected draggingPrompt: number | null = null;

  protected readonly i18n = new LocaleController(this);

  @query('#chat-input-field')
  protected inputElement!: HTMLInputElement | HTMLTextAreaElement;

  @query('.chat-messages-container')
  protected messagesContainer!: HTMLElement;

  protected messageIdCounter = 0;

  /**
   * The soft keyboard is up (`data-keyboard-visible` on <html>). With it up on a portrait phone
   * the short pane keeps one slim row of quick replies (phone spec 4.3: the dock stays), unless
   * the visible height is tiny (2026-10-12: they vanished with the keyboard).
   */
  @state() protected keyboardUp = false;

  protected keyboardObserver: MutationObserver | null = null;

  protected syncKeyboard = () => {
    this.keyboardUp = document.documentElement.getAttribute('data-keyboard-visible') === 'true';
  };

  protected scheduleDelayedTask(task: () => void, delay: number): void {
    const timeout = setTimeout(() => {
      this.delayedTasks.delete(timeout);
      task();
    }, delay);
    this.delayedTasks.add(timeout);
  }

  protected clearDelayedTasks(): void {
    for (const timeout of this.delayedTasks) {
      clearTimeout(timeout);
    }
    this.delayedTasks.clear();
  }

  /** The chat view over this composer (a sibling in the session view), if any. */
  protected chatView(): ChatViewHandle | null {
    const root = this.getRootNode() as ParentNode;
    return (root.querySelector?.('claude-chat-view') as ChatViewHandle | null) ?? null;
  }

  @state() protected dictation: DictationState = 'idle';

  @state() protected dictationNote = '';

  protected dictationNoteTimer: ReturnType<typeof setTimeout> | null = null;

  /** A bottom sheet in the top layer, focus on its root (no field raised), drag to dismiss. */
  protected openSheet(dialog: HTMLDialogElement, onDismiss: () => void) {
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    } else {
      dialog.setAttribute('open', '');
    }
    // showModal focuses the first field and raises the keyboard over the choices.
    dialog.focus({ preventScroll: true });
    const scroller = dialog.querySelector<HTMLElement>('ol');
    this.sheetDrags.get(dialog)?.();
    this.sheetDrags.set(dialog, attachSheetDrag(dialog, { onDismiss, scroller }));
  }

  protected closeDialog(dialog: HTMLDialogElement | null | undefined) {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    this.sheetDrags.get(dialog)?.();
    this.sheetDrags.delete(dialog);
  }

  /** Until when hardware keys reaching the composer are written by it (see typeFromKeyboard). */
  protected handTypingUntil = 0;

  protected syncComposerEmpty() {
    this.composerEmpty = !this.inputElement?.value.trim();
    // Typing closes the slim row of prompts (landscape): it doesn't come back after the send.
    if (!this.composerEmpty) this.promptsOpen = false;
  }

  /** Grow the composer with its text, up to the CSS max-height (about five lines). */
  protected autoSize(textarea: HTMLTextAreaElement) {
    if (!textarea.value) {
      textarea.style.height = '';
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = `${composerHeightFor(textarea.scrollHeight, getComputedStyle(textarea))}px`;
  }

  /** Until when a key completes Claude Code's chord after Ctrl+X in the box. */
  protected chordUntil = 0;

  protected lastSentValue = '';
  // Implemented by the layers above (terminal-chat-view.ts and the modules it is made of).
  protected abstract handleSend(): void;
  protected abstract submitComposer(submit: readonly string[]): void;
  protected abstract showMenuFirst(menu: ScreenChoices): void;
  protected abstract quickPromptTap(action: () => void, opensOver?: boolean): (e: Event) => void;
  protected abstract sendDeltaToTerminal(newValue: string): void;
}
