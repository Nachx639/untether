import { customElement } from 'lit/decorators.js';
import {
  optionForTyped,
  type ScreenChoices,
  sameShownMenu,
  takesReply,
} from '../../shared/claude-screen.js';
import { type MessageKey, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { writeKeys } from '../utils/agent-chords.js';
import { composerHeightFor } from '../utils/composer-height.js';
import { shellQuotePath } from '../utils/shell-quote.js';
import type { ClaudeChatState, SentChatMessage, SentChatMessageRef } from './claude-chat-view.js';
import { TerminalChatComposer } from './terminal-chat-view/composer.js';
import {
  loadDraft,
  rememberRecentCommand,
  saveDraft,
} from './terminal-chat-view/composer-storage.js';
import { ENTER_KEYS, logger, type Outgoing } from './terminal-chat-view/shared.js';
import { terminalChatViewStyles } from './terminal-chat-view/styles.js';

export { isPaintedNoise, isSpinnerStatus } from './terminal-chat-view/chat-text.js';
export {
  loadRecentCommands,
  rememberRecentCommand,
} from './terminal-chat-view/composer-storage.js';
export type { AttachSource } from './terminal-chat-view/shared.js';
export { slashCommandsFor } from './terminal-chat-view/slash-commands.js';
export { composerHeightFor };

let sentCount = 0;

@customElement('terminal-chat-view')
export class TerminalChatView extends TerminalChatComposer {
  static styles = terminalChatViewStyles;

  connectedCallback() {
    super.connectedCallback();
    this.subscribeToTerminalOutput();
    document.addEventListener('claude-chat-state', this.handleChatState);
    this.keyboardObserver = new MutationObserver(this.syncKeyboard);
    this.keyboardObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-keyboard-visible'],
    });
    this.syncKeyboard();
  }

  disconnectedCallback() {
    document.removeEventListener('claude-chat-state', this.handleChatState);
    this.keyboardObserver?.disconnect();
    this.keyboardObserver = null;
    this.stopBottomChrome();
    clearInterval(this.dictationClock);
    clearTimeout(this.screenMenuConfirmTimer);
    for (const release of this.sheetDrags.values()) release();
    this.sheetDrags.clear();
    clearTimeout(this.longPressTimer);
    clearInterval(this.screenMenuTimer);
    this.screenMenuTimer = undefined;
    clearTimeout(this.screenMenuNoteTimer);
    this.dictationController.cancel();
    this.unsubscribeFromTerminalOutput();
    this.stopTerminalSync();
    this.clearDelayedTasks();
    this.attachments.clear();
    super.disconnectedCallback();
  }

  /** What the chat view above says: Claude busy (no quick replies) for this session. */
  private handleChatState = (e: Event) => {
    const state = (e as CustomEvent<ClaudeChatState>).detail;
    if (!state || state.sessionId !== this.sessionId) return;
    this.chatBusy = state.busy;
  };

  /**
   * --ut-bottom-chrome (phone-spec §0.5): the composer is the bar pinned to the bottom while it
   * is mounted, so toasts sit above it. Its height, kept current, and 0 when it goes.
   */
  private syncBottomChrome() {
    if (!this.composerOnly || this.bottomChromeObserver || typeof ResizeObserver === 'undefined')
      return;
    const root = document.documentElement;
    const set = () =>
      root.style.setProperty('--ut-bottom-chrome', `${Math.round(this.offsetHeight)}px`);
    this.bottomChromeObserver = new ResizeObserver(set);
    this.bottomChromeObserver.observe(this);
    set();
  }

  private stopBottomChrome() {
    if (!this.bottomChromeObserver) return;
    this.bottomChromeObserver.disconnect();
    this.bottomChromeObserver = null;
    document.documentElement.style.setProperty('--ut-bottom-chrome', '0px');
  }

  /**
   * Focus the message field (the chat's "No, and tell Claude…" option: the words go here).
   * Returns whether there was one to focus.
   */
  focusComposer(): boolean {
    const input = this.inputElement;
    if (!this.composerOnly || !input) return false;
    input.focus();
    return true;
  }

  updated(changedProperties: Map<string, unknown>) {
    this.syncScreenMenuWatch();
    // A menu read at the old width is dropped at once if the screen has none at the new one,
    // not after the two polls that ride out a redraw.
    if (changedProperties.has('ptyCols') && this.screenMenuTimer) {
      if (this.screenMenu && !this.menuOnScreen()) this.screenMenuMisses = 1;
      this.readScreenMenu();
    }
    // This view stays mounted (hidden) outside chat mode and is reused across sessions:
    // a dictation must not keep the mic on, or drop its text into another session's box.
    if (
      (changedProperties.has('active') && !this.active) ||
      (changedProperties.has('sessionId') && changedProperties.get('sessionId') !== undefined)
    ) {
      this.dictationController.cancel();
    }
    if (changedProperties.has('sessionId') && changedProperties.get('sessionId') !== undefined) {
      this.attachments.clear();
      // Half a line of the last session's output is not this one's.
      this.pendingOutputLine = '';
      // The menu read from the last session's screen is not this one's.
      this.screenMenu = null;
      this.screenMenuNote = '';
      this.screenMenuMisses = 0;
      this.pendingScreenMenu = null;
      clearTimeout(this.screenMenuConfirmTimer);
      this.answeredMenu = null;
      this.refreshScreenMenu = false;
      // The chat view drops another session's bubbles: there is nothing left to retry.
      this.failedSends.clear();
    }
    super.updated(changedProperties);
    if (changedProperties.has('messages')) {
      this.scrollToBottom();
    }
    if (this.composerOnly) this.syncBottomChrome();
    else this.stopBottomChrome();
    if (changedProperties.has('sessionId')) this.chatBusy = false;
    // A modal dialog sits in the top layer, clear of the layout's transforms and the keyboard.
    const editor = this.shadowRoot?.querySelector<HTMLDialogElement>('.prompt-editor');
    if (editor && !editor.open) this.openSheet(editor, () => this.closePromptEditor());
    const plus = this.shadowRoot?.querySelector<HTMLDialogElement>('.plus-sheet');
    if (plus && this.plusOpen && !plus.open) this.openSheet(plus, () => this.closePlus());
    else if (plus && !this.plusOpen && plus.open) this.closeDialog(plus);
    this.syncAttachMenu();
    if (changedProperties.has('subscribeToOutput') || changedProperties.has('active')) {
      this.subscribeToTerminalOutput();
    }
    // Lit reuses the composer across session switches: a draft belongs to its session, so
    // show the one this session had (kept in storage as it was typed).
    if (this.composerOnly && changedProperties.has('sessionId') && this.inputElement) {
      this.inputElement.value = loadDraft(this.sessionId);
      this.slashMatches = [];
      if (this.inputElement instanceof HTMLTextAreaElement) this.autoSize(this.inputElement);
      this.syncComposerEmpty();
    }
    // Sync input when becoming active
    if (changedProperties.has('active')) {
      if (this.active && this.composerOnly) {
        // Composer: the message is written locally and sent whole, so it never mirrors the
        // terminal's input line (which for Claude Code holds a ghost suggestion).
        this.lastSentValue = '';
        // Leaving chat mode cleared the box; the draft is still in storage.
        if (this.inputElement && !this.inputElement.value) {
          this.inputElement.value = loadDraft(this.sessionId);
          if (this.inputElement instanceof HTMLTextAreaElement) this.autoSize(this.inputElement);
          this.syncComposerEmpty();
        }
      } else if (this.active) {
        // Priority: terminal buffer > pendingInput
        if (this.getTerminalInputLine) {
          // Read from terminal buffer - it has the "truth" of what's on screen
          this.lastSentValue = '';
          if (this.inputElement) {
            this.inputElement.value = '';
          }
          this.syncFromTerminalWithRetry();
          this.syncLastSentValueFromTerminal();
        } else if (this.pendingInput && this.inputElement) {
          // Fallback to pendingInput
          this.inputElement.value = this.pendingInput;
          this.lastSentValue = this.pendingInput;
        } else {
          // No input to sync, start fresh
          this.lastSentValue = '';
          if (this.inputElement) {
            this.inputElement.value = '';
          }
        }

        this.syncComposerEmpty();
        // Start periodic sync to keep lastSentValue in sync with terminal
        this.startTerminalSync();

        // Focus the input field when chat becomes active - with delay to ensure DOM is ready
        this.scheduleDelayedTask(() => {
          if (this.inputElement && this.active && this.isConnected) {
            this.inputElement.focus();
            logger.log('Chat input focused on activation');
          }
        }, 100);
      } else {
        this.clearDelayedTasks();
        this.lastSentValue = '';
        if (this.inputElement) {
          this.inputElement.value = '';
        }
        // Stop sync when leaving chat mode
        this.stopTerminalSync();
      }
    }
    // NOTE: We intentionally do NOT sync pendingInput back to the input element here.
    // The chat input is the "source of truth" while the user is typing.
    // Syncing from pendingInput (which comes from terminal) would overwrite
    // accented characters that the terminal might not render correctly.
  }

  render() {
    return this.composerOnly ? this.renderComposer() : this.renderDesktop();
  }

  /** Types the composer's message (and image paths) into the terminal, then Enter. */
  private writeComposer(out: Outgoing) {
    const { command, paths } = out;
    const input = this.inputElement;
    // It leaves the box. A retry from the chat view leaves the box to the message being written
    // in it, unless that is this one again.
    if (!out.retry || input?.value.trim() === command) {
      // A still-listening recognizer would write the sent text back into the box.
      this.dictationController.cancel();
      if (input) {
        input.value = '';
        if (input instanceof HTMLTextAreaElement) this.autoSize(input);
      }
      saveDraft(this.sessionId, '');
      this.slashMatches = [];
      this.syncComposerEmpty();
    }
    if (!out.retry || (paths && this.attachmentPaths() === paths)) this.attachments.clear();
    if (!out.announced) this.announceSent(out);
    const writes = [paths, paths && command ? ` ${command}` : command].filter(Boolean);
    writes.forEach((data, i) => {
      if (i === 0) this.onSend?.(data);
      else setTimeout(() => this.onSend?.(data), 50 * i);
    });
    // Separate writes so the app sees Enter (or a chord) as key presses, not typed text.
    writeKeys((data) => this.onSend?.(data), out.submit ?? ENTER_KEYS, 50 * writes.length);
  }

  /**
   * A message for Claude waiting on a menu, sent through the server: an option's number (or a
   * yes/no letter) picks that option; anything else is a reply: Esc (Claude's "tell Claude what
   * to do differently"), then the text once Claude is back at its prompt. The message stays in
   * the box until the server says it was typed. When Claude turns out not to be waiting, it is
   * typed as usual.
   */
  private async sendToWaitingClaude(
    out: Outgoing,
    choices: ScreenChoices | null,
    option: number | null
  ) {
    const { command, paths } = out;
    // A retry leaves the box, and a dictation into it, to the next message.
    if (!out.retry) this.dictationController.cancel();
    const sessionId = this.sessionId;
    const [endpoint, body] =
      option !== null && choices
        ? [
            'answer',
            {
              option,
              question: choices.question,
              options: choices.options,
              key: choices.key,
            },
          ]
        : [
            'reply',
            {
              text: [paths, command].filter(Boolean).join(' '),
              question: choices?.question ?? null,
              options: choices?.options ?? null,
              key: choices?.key ?? null,
            },
          ];
    logger.log(`composer: Claude may be waiting on a menu, sent as ${endpoint}`);
    // A reply is a message of the conversation: the chat view shows it at once. An option picked
    // by its number answers the menu and is no message.
    if (endpoint === 'reply') this.announceSent(out);
    this.replyInFlight = true;
    let response: Response | null = null;
    try {
      response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
        body: JSON.stringify(body),
      });
    } catch {
      response = null;
    } finally {
      this.replyInFlight = false;
    }
    // Switched to another session meanwhile: its box is not this message's.
    if (this.sessionId !== sessionId) return;
    const input = this.inputElement;
    const unchanged = Boolean(input && input.value.trim() === command);
    if (response?.ok) {
      // Leave anything typed since the send.
      if (input && unchanged) {
        input.value = '';
        if (input instanceof HTMLTextAreaElement) this.autoSize(input);
        saveDraft(this.sessionId, '');
        this.syncComposerEmpty();
      }
      if (paths && (!out.retry || this.attachmentPaths() === paths)) this.attachments.clear();
      return;
    }
    const error = (
      response && !response.ok
        ? ((await response.json().catch(() => ({}))) as { error?: string })
        : {}
    ).error;
    if (error === 'not-waiting') {
      const menu = this.menuOnScreen();
      if (menu) {
        this.showMenuFirst(menu);
        this.announceFailed(out);
      } else if (unchanged || out.retry) {
        this.writeComposer(out);
      } else {
        // Edited while it was on its way: not typed after all, and the chat view says so.
        this.announceFailed(out);
      }
      return;
    }
    const note: MessageKey =
      error === 'busy'
        ? 'screenMenu.sending'
        : error === 'not-delivered'
          ? 'screenMenu.notDelivered'
          : response?.status === 409
            ? 'screenMenu.changed'
            : 'screenMenu.sendFailed';
    this.showDictationNote(t(note));
    this.announceFailed(out);
  }

  /**
   * Sends a message the safe way for what is on screen. A menu takes Enter as confirming its
   * highlighted option, whatever was typed: "Sí" sent to Claude's trust-folder dialog picked
   * "No, exit", a plan correction executed the plan, and Codex's update prompt would have run
   * "Update now" (2026-10-03). An option's number picks it; a reply to a waiting Claude goes
   * through the server; anything else waits for a tap on one of the options.
   */
  private send(out: Outgoing) {
    const menu = this.menuOnScreen();
    if (menu) {
      // A retry is a message again, never an option's number.
      const option = out.paths || out.retry ? null : optionForTyped(out.command, menu);
      if (option !== null) {
        void this.sendToWaitingClaude(out, menu, option);
      } else if (this.claudeWaiting && takesReply(menu)) {
        void this.sendToWaitingClaude(out, menu, null);
      } else {
        this.showMenuFirst(menu);
      }
      return;
    }
    // Claude waits on something this cannot read (or a yes/no question): the server answers.
    if (this.claudeWaiting) {
      const choices = this.getScreenText ? this.parseScreen() : null;
      const option =
        choices && !out.paths && !out.retry ? optionForTyped(out.command, choices) : null;
      void this.sendToWaitingClaude(out, choices, option);
      return;
    }
    logger.log(`composer: typed into the terminal (claudeWaiting=${this.claudeWaiting})`);
    this.writeComposer(out);
  }

  /**
   * "Retry" on a message the chat view shows as not sent (see claude-chat-view): sent again
   * the way a send would go now, never as an option's number, and whatever is being written in
   * the box stays there.
   */
  resendMessage(ref: SentChatMessageRef) {
    const failed = this.failedSends.get(ref.id);
    if (!this.composerOnly || ref.sessionId !== this.sessionId || !failed) return;
    if (this.replyInFlight) {
      this.showDictationNote(t('screenMenu.sending'));
      return;
    }
    this.send({ ...failed, id: ref.id, retry: true, startedAt: performance.now() });
  }

  /**
   * The chat view shows the message at once, "sending…", until the transcript has it: a sent
   * message showed only once Claude Code had logged it and the chat's next poll came (2026-10-03).
   */
  private announceSent(out: Outgoing) {
    out.id ??= `sent-${++sentCount}`;
    out.announced = true;
    this.failedSends.delete(out.id);
    this.dispatchEvent(
      new CustomEvent<SentChatMessage>('chat-message-sent', {
        detail: {
          sessionId: this.sessionId,
          id: out.id,
          text: [out.paths, out.command].filter(Boolean).join(' '),
          at: Date.now(),
          startedAt: out.startedAt,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** It did not go: the chat view says so and offers to send it again (resendMessage). */
  private announceFailed(out: Outgoing) {
    if (!out.announced || !out.id) return;
    this.failedSends.set(out.id, { command: out.command, paths: out.paths });
    this.dispatchEvent(
      new CustomEvent<SentChatMessageRef>('chat-message-failed', {
        detail: { sessionId: this.sessionId, id: out.id },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Shows the menu (even one hidden after an answer) with the note to tap an option. */
  protected showMenuFirst(menu: ScreenChoices) {
    if (this.menuInChat) {
      this.showDictationNote(t('screenMenu.pickFirst'));
      return;
    }
    this.answeredMenu = null;
    this.screenMenuMisses = 0;
    if (!sameShownMenu(menu, this.screenMenu)) {
      this.screenMenu = menu;
    }
    this.showScreenMenuNote(t('screenMenu.pickFirst'));
  }

  /** Uploaded images go in the message as their paths (Claude Code turns them into images). */
  private attachmentPaths(): string {
    return this.attachments.paths.map(shellQuotePath).join(' ');
  }

  protected handleSend() {
    this.submitComposer(ENTER_KEYS);
  }

  /**
   * Sends the box with `submit` after the text: Enter, or a Claude Code chord. A chord with
   * nothing in the box goes alone: Ctrl+X Ctrl+S sends the messages Claude has queued.
   */
  protected submitComposer(submit: readonly string[]) {
    const startedAt = performance.now();
    const chordAlone = () => {
      if (submit !== ENTER_KEYS) writeKeys((data) => this.onSend?.(data), submit);
    };
    // Read directly from the input element to avoid reactive binding issues
    const input = this.inputElement;
    if (!input) return;

    const command = input.value.trim();

    if (this.composerOnly) {
      if (this.attachments.busy) {
        this.showDictationNote(t('attach.waitUploads'));
        return;
      }
      if (this.attachments.hasErrors) {
        this.showDictationNote(t('attach.failedSend'));
        return;
      }
      // Typed first and in a write of their own.
      const paths = this.attachmentPaths();
      if (!command && !paths) {
        chordAlone();
        return;
      }
      // A second send while the first is on its way would answer whatever comes next.
      if (this.replyInFlight) {
        this.showDictationNote(t('screenMenu.sending'));
        return;
      }
      // The message the chat view shows as not sent, sent again from the box: the same bubble.
      const failed = [...this.failedSends].find(
        ([, sent]) => sent.command === command && sent.paths === paths
      );
      this.send({ command, paths, startedAt, id: failed?.[0], submit });
      return;
    }

    if (!command) {
      chordAlone();
      return;
    }

    // Add command to chat
    this.addMessage('command', command);
    rememberRecentCommand(command);

    // Send Enter (or the chord) to execute the command (characters were already sent via delta)
    writeKeys((data) => this.onSend?.(data), submit);

    // Clear input directly on the DOM element
    input.value = '';
    this.lastSentValue = '';
    this.composerEmpty = true;

    // Clear pending input in InputManager
    this.onPendingInputChange?.('');

    // Scroll to show the sent message
    this.scrollToBottom();
  }
}
