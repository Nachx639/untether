import { html, nothing } from 'lit';
import { type MessageKey, t } from '../../i18n/index.js';
import { authClient } from '../../services/auth-client.js';
import {
  CHORD_MS,
  chordAfterCtrlX,
  isCtrlX,
  isModifierOnly,
  QUEUE_SUBMIT_KEYS,
  SEND_NOW_KEYS,
} from '../../utils/agent-chords.js';
import { getPlatformName } from '../../utils/browser-shortcuts.js';
import { caretTapDiagnostics } from '../../utils/caret-tap-diagnostics.js';
import { DictationController, dictationErrorKey } from '../../utils/dictation.js';
import { focusDiagnostics } from '../../utils/focus-diagnostics.js';
import { openCopilot } from '../copilot-sheet.js';
import { type IconName, icon } from '../icons.js';
import type { MacFilePicker, MacPickedFile } from '../mac-file-picker.js';
import { saveDraft } from './composer-storage.js';
import { TerminalChatQuickPrompts } from './quick-prompts-panel.js';
import { type AttachSource, deviceFileLabel, HAND_TYPING_MS, logger } from './shared.js';
import { slashCommandsFor } from './slash-commands.js';
import '../mac-file-picker.js';

/** The composer's chrome: field, attachments, dictation, slash commands, + sheet, desktop card. */
export abstract class TerminalChatComposer extends TerminalChatQuickPrompts {
  /** Whether the field holds something to send (text, or an image). */
  protected get hasContent(): boolean {
    return !this.composerEmpty || this.attachments.items.length > 0;
  }

  protected get dictating(): boolean {
    return this.dictation !== 'idle';
  }

  /**
   * The phone composer (phone-spec §3.5): [+] [capsule] [primary slot]. The slot is the mic
   * while there is nothing to send and Send (filled) once there is; with nothing to send an
   * "Enter" ghost button types a bare Enter, so no filled Send ever does nothing.
   */
  protected renderComposer() {
    const recording = this.dictating;
    const desktop = this.desktop;
    return html`
      <div class="chat-view-container" @click=${this.handleContainerClick}>
        ${this.renderSlashList()}
        ${this.renderScreenMenu()} ${this.renderQuickPrompts()} ${this.renderPromptEditor()}
        ${this.renderDictationNote()}
        <div
          class="chat-input-container ut-surface--material ut-surface--well"
          @click=${(e: Event) => e.stopPropagation()}
          @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
        >
          ${
            desktop
              ? html`<button
                  class="ut-surface--badge round-button attach-button"
                  id="chat-attach-button"
                  data-testid="composer-attach"
                  title=${t('chat.attach')}
                  aria-label=${t('chat.attach')}
                  aria-haspopup="menu"
                  aria-expanded=${this.attachMenuOpen ? 'true' : 'false'}
                  @click=${this.toggleAttachMenu}
                >
                  ${icon('image', 18)}
                </button>`
              : html`<button
            class="ut-surface--badge round-button plus-button attach-button"
            data-testid="composer-plus"
            title=${t('chat.attach')}
            aria-label=${t('chat.attach')}
            aria-haspopup="dialog"
            aria-expanded=${this.plusOpen ? 'true' : 'false'}
            @pointerdown=${(e: Event) => e.preventDefault()}
            @mousedown=${(e: Event) => e.preventDefault()}
            @pointerup=${this.quickPromptTap(this.openPlus, true)}
            @click=${this.quickPromptTap(this.openPlus, true)}
          >
            ${icon('plus', 22)}
          </button>`
          }
          <div class="composer-capsule ${recording ? 'recording' : ''}">
            ${
              this.attachments.items.length > 0
                ? html`<chat-attachment-strip
                    .items=${this.attachments.items}
                    @attachment-remove=${(e: CustomEvent<{ id: string }>) => this.attachments.remove(e.detail.id)}
                    @attachment-retry=${(e: CustomEvent<{ id: string }>) => this.attachments.retry(e.detail.id)}
                  ></chat-attachment-strip>`
                : nothing
            }
            <!-- Autocorrect is intentional; spellcheck stays off because commands may contain secrets. -->
            <textarea
              id="chat-input-field"
              class="chat-input composer-input"
              rows="1"
              placeholder=${t('chat.composerPlaceholder')}
              dir="auto"
              autocomplete="off"
              autocorrect="on"
              autocapitalize="sentences"
              spellcheck="true"
              enterkeyhint="send"
              @keydown=${this.handleInputKeydown}
              @input=${this.handleInput}
              @paste=${this.handleComposerPaste}
              @focus=${this.announceComposerFocus}
              @pointerdown=${this.caretTaps.pointerdown}
              @pointerup=${this.caretTaps.pointerup}
            ></textarea>
            ${recording ? this.renderRecording() : nothing}
          </div>
          ${recording ? nothing : desktop ? this.renderDesktopSlot() : this.renderPrimarySlot()}
        </div>
        ${desktop ? this.renderAttachMenu() : this.renderPlusSheet()}
        <mac-file-picker
          @mac-files-picked=${(e: CustomEvent<{ files: MacPickedFile[] }>) => this.addMacFiles(e.detail.files)}
        ></mac-file-picker>
      </div>
    `;
  }

  /**
   * Where an attachment comes from (user report: the phone's picker could not reach a PDF on
   * the Mac). Photos and the device's files go through the session view's file inputs
   * (`composer-attach`); the Mac's files are picked here and need no upload.
   */
  protected attachFrom(source: AttachSource) {
    if (source === 'mac') {
      void this.shadowRoot?.querySelector<MacFilePicker>('mac-file-picker')?.show();
      return;
    }
    this.dispatchEvent(
      new CustomEvent<{ source: AttachSource }>('composer-attach', {
        detail: { source },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Picked on the Mac: chips like uploaded files, sent as their absolute paths. */
  addMacFiles(files: MacPickedFile[]) {
    if (files.length === 0) return;
    this.attachments.addPaths(files);
    this.showDictationNote('');
  }

  /** The three attach choices, the device's own files named after the device. */
  protected attachChoices(): Array<{
    source: AttachSource;
    id: string;
    iconName: IconName;
    label: string;
  }> {
    return [
      {
        source: 'media',
        id: 'chat-attach-photo',
        iconName: 'image',
        label: t('attach.photoVideo'),
      },
      {
        source: 'device',
        id: 'chat-attach-device-file',
        iconName: 'fileText',
        label: deviceFileLabel(),
      },
      {
        source: 'mac',
        id: 'chat-attach-mac-file',
        iconName: 'monitor',
        label: t('attach.fromMac'),
      },
    ];
  }

  protected toggleAttachMenu = () => {
    this.attachMenuOpen = !this.attachMenuOpen;
  };

  protected closeAttachMenu = () => {
    this.attachMenuOpen = false;
  };

  /** Desktop: the attach choices as a small menu over the attach button. */
  protected renderAttachMenu() {
    const pick = (source: AttachSource) => () => {
      this.closeAttachMenu();
      this.attachFrom(source);
    };
    return html`<dialog
      class="attach-popover"
      id="chat-attach-menu"
      aria-label=${t('chat.attach')}
      @cancel=${(e: Event) => {
        e.preventDefault();
        this.closeAttachMenu();
      }}
      @click=${(e: Event) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) this.closeAttachMenu();
      }}
      @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
    >
      <div class="attach-popover-items" role="menu">
        ${this.attachChoices().map(
          (choice) => html`<button
            class="ut-surface--badge attach-popover-item"
            id=${choice.id}
            role="menuitem"
            @click=${pick(choice.source)}
          >
            ${icon(choice.iconName, 18)}<span>${choice.label}</span>
          </button>`
        )}
      </div>
    </dialog>`;
  }

  /** Opens the desktop attach menu above its button (top layer: no container clips it). */
  protected syncAttachMenu() {
    const menu = this.shadowRoot?.querySelector<HTMLDialogElement>('#chat-attach-menu');
    if (!menu) return;
    if (this.attachMenuOpen && !menu.open) {
      const button = this.shadowRoot?.querySelector<HTMLElement>('#chat-attach-button');
      const rect = button?.getBoundingClientRect();
      if (rect) {
        menu.style.left = `${Math.max(8, rect.left)}px`;
        menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
      }
      try {
        if (typeof menu.showModal === 'function') menu.showModal();
        else menu.setAttribute('open', '');
      } catch {
        menu.setAttribute('open', '');
      }
      // No room above (the composer near the top of a short window): open below the button
      // instead of off screen (verifier, 2026-10-14).
      if (rect && rect.top - menu.offsetHeight - 6 < 8) {
        menu.style.bottom = 'auto';
        menu.style.top = `${rect.bottom + 6}px`;
      } else {
        menu.style.top = '';
      }
      menu.querySelector<HTMLElement>('.attach-popover-item')?.focus({ preventScroll: true });
    } else if (!this.attachMenuOpen && menu.open) {
      if (typeof menu.close === 'function') menu.close();
      else menu.removeAttribute('open');
    }
  }

  /** Desktop: the mic while there is nothing to send, and Send, disabled until there is. */
  protected renderDesktopSlot() {
    return html`${
      this.hasContent
        ? nothing
        : html`<button
            class="ut-surface--badge round-button mic-button"
            data-testid="dictate-button"
            aria-pressed="false"
            title=${t('chat.dictate')}
            aria-label=${t('chat.dictate')}
            @click=${this.toggleDictation}
          >
            ${icon('mic', 18)}
          </button>`
    }<button
        class="ut-surface--badge send-button"
        @click=${this.handleSend}
        ?disabled=${!this.hasContent || this.attachments.busy || this.replyInFlight}
        aria-label=${t('chat.send')}
        title=${t('chat.send')}
        data-testid="chat-send-button"
      >
        ${icon('send', 16)}
      </button>`;
  }

  /** Mic or Enter while empty; Send (filled primary) once there is something to send. */
  protected renderPrimarySlot() {
    if (this.hasContent) {
      return html`<button
        class="ut-surface--badge send-button"
        @click=${this.handleSend}
        ?disabled=${this.attachments.busy || this.replyInFlight}
        aria-label=${t('chat.send')}
        title=${t('chat.send')}
        data-testid="chat-send-button"
      >
        ${icon('send', 20)}
      </button>`;
    }
    return html`<button
        class="ut-surface--badge round-button enter-button"
        data-testid="chat-enter-button"
        aria-label=${t('phone.sendEnter')}
        title=${t('phone.sendEnter')}
        ?disabled=${this.replyInFlight}
        @pointerdown=${(e: Event) => e.preventDefault()}
        @mousedown=${(e: Event) => e.preventDefault()}
        @pointerup=${this.quickPromptTap(this.sendEnter)}
        @click=${this.quickPromptTap(this.sendEnter)}
      >
        ${icon('cornerDownLeft', 20)}
      </button>
      <button
        class="ut-surface--badge round-button mic-button"
        data-testid="dictate-button"
        aria-pressed="false"
        title=${t('chat.dictate')}
        aria-label=${t('chat.dictate')}
        @click=${this.toggleDictation}
      >
        ${icon('mic', 22)}
      </button>`;
  }

  /**
   * A bare Enter for the terminal (Claude's "press Enter to continue"). Never into a menu on
   * screen: Enter would confirm its highlighted option, whatever it is.
   */
  protected sendEnter = () => {
    const menu = this.menuOnScreen();
    if (menu || this.claudeWaiting) {
      if (menu) this.showMenuFirst(menu);
      else this.showDictationNote(t('screenMenu.pickFirst'));
      return;
    }
    this.onSend?.('\r');
  };

  /** The recording capsule in place of the field: cancel · level · mm:ss · stop. */
  protected renderRecording() {
    const state = this.dictation;
    const seconds = this.dictationStartedAt
      ? Math.max(0, Math.floor((Date.now() - this.dictationStartedAt) / 1000))
      : 0;
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const busy = state === 'starting' || state === 'transcribing';
    const label =
      state === 'starting'
        ? t('dictation.starting')
        : state === 'transcribing'
          ? t('dictation.transcribing')
          : '';
    const bars = this.levelHistory.length ? this.levelHistory : [0];
    return html`<div class="rec" data-state=${state} role="group" data-testid="recording-capsule">
      <button
        class="ut-surface--badge round-button rec-cancel"
        aria-label=${t('common.cancel')}
        title=${t('common.cancel')}
        data-testid="recording-cancel"
        @click=${this.cancelDictation}
      >
        ${icon('x', 20)}
      </button>
      ${
        label
          ? html`<span class="rec-label" role="status">${label}</span>`
          : html`<span class="rec-meter" aria-hidden="true">
              ${bars.map((level) => html`<span style="height: ${Math.round(4 + level * 20)}px"></span>`)}
            </span>
            <span class="visually-hidden" role="status">${
              state === 'listening' ? t('dictation.listening') : t('dictation.recording')
            }</span>`
      }
      ${state === 'transcribing' ? nothing : html`<span class="rec-time">${clock}</span>`}
      <button
        class="ut-surface--badge round-button rec-stop"
        data-testid="dictate-button"
        aria-pressed="true"
        title=${t('chat.stopDictation')}
        aria-label=${t('chat.stopDictation')}
        ?disabled=${busy}
        @click=${this.toggleDictation}
      >
        ${state === 'transcribing' ? html`<span class="mic-spinner" aria-hidden="true"></span>` : icon('check', 20)}
      </button>
    </div>`;
  }

  protected cancelDictation = () => {
    this.dictationController.cancel();
  };

  /** The slash commands offered while typing "/" (the composer only: the desktop field never fills them). */
  protected renderSlashList() {
    if (this.slashMatches.length === 0) return nothing;
    return html`<div class="slash-list" role="listbox">
      ${this.slashMatches.map(
        ([command, description]) =>
          html`<button
            role="option"
            @pointerdown=${(e: Event) => e.preventDefault()}
            @mousedown=${(e: Event) => e.preventDefault()}
            @pointerup=${this.quickPromptTap(() => this.pickSlashCommand(command))}
            @click=${this.quickPromptTap(() => this.pickSlashCommand(command))}
          >
            <strong dir="ltr">${command}</strong><span>${t(description)}</span>
          </button>`
      )}
    </div>`;
  }

  protected openPlus = () => {
    this.plusOpen = true;
  };

  protected closePlus = () => {
    this.plusOpen = false;
    this.closeDialog(this.shadowRoot?.querySelector<HTMLDialogElement>('.plus-sheet'));
  };

  /**
   * The + sheet: attach, talk with Claude, the quick replies (on a phone on its side, where
   * their row is hidden) and their editor. Always in the DOM, opened as a modal bottom sheet.
   */
  protected renderPlusSheet() {
    const item = (action: () => void) => this.quickPromptTap(action);
    const attach = (source: AttachSource) => () => {
      this.closePlus();
      this.attachFrom(source);
    };
    const talk = () => {
      this.closePlus();
      // Within the tap: iOS lets the microphone and audio start only from a gesture.
      if (this.sessionId) openCopilot({ mode: 'session', sessionId: this.sessionId });
    };
    const togglePrompts = () => {
      this.promptsOpen = !this.promptsOpen;
      this.closePlus();
    };
    const edit = () => {
      this.closePlus();
      this.openPromptEditor();
    };
    const search = () => {
      const view = this.chatView();
      this.closePlus();
      view?.openSearchNow?.();
    };
    // The phone has no Ctrl key here for Claude Code's send chords (user report, 2026-10-14).
    const chord = (keys: readonly string[]) => () => {
      this.closePlus();
      this.submitComposer(keys);
    };
    const chords = this.plusOpen && this.takesSendChords;
    const offered = this.quickPromptsOffered() || this.promptsOnRequest;
    const talkable = this.plusOpen && Boolean(this.sessionId);
    const searchable = this.plusOpen && this.chatView()?.canSearch === true;
    return html`<dialog
      class="sheet action-sheet plus-sheet"
      aria-label=${t('chat.attach')}
      tabindex="-1"
      @cancel=${(e: Event) => {
        e.preventDefault();
        this.closePlus();
      }}
      @click=${(e: Event) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) this.closePlus();
      }}
      @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
    >
      <div class="action-group" id="chat-attach-menu" role="group" aria-label=${t('chat.attach')}>
        <div class="sheet-grabber" data-sheet-handle aria-hidden="true"></div>
        ${this.attachChoices().map(
          (choice) => html`<button
            class="ut-surface--badge action-item"
            id=${choice.id}
            data-testid=${choice.source === 'media' ? 'composer-attach' : nothing}
            @pointerup=${item(attach(choice.source))}
            @click=${item(attach(choice.source))}
          >
            ${icon(choice.iconName, 20)}${choice.label}
          </button>`
        )}
      </div>
      <div class="action-group" ?hidden=${!chords}>
        ${
          chords
            ? html`<button
                class="ut-surface--badge action-item"
                id="composer-send-now"
                data-testid="composer-send-now"
                @pointerup=${item(chord(SEND_NOW_KEYS))}
                @click=${item(chord(SEND_NOW_KEYS))}
              >
                ${icon('send', 20)}${t('phone.sendNow')}
              </button>`
            : nothing
        }
        ${
          chords && this.hasContent
            ? html`<button
                class="ut-surface--badge action-item"
                id="composer-queue-send"
                data-testid="composer-queue-send"
                @pointerup=${item(chord(QUEUE_SUBMIT_KEYS))}
                @click=${item(chord(QUEUE_SUBMIT_KEYS))}
              >
                ${icon('clock', 20)}${t('phone.queueSend')}
              </button>`
            : nothing
        }
      </div>
      <div class="action-group" ?hidden=${!(talkable || searchable || offered)}>
        ${
          talkable
            ? html`<button class="ut-surface--badge action-item" id="composer-talk" data-testid="composer-talk" @pointerup=${item(talk)} @click=${item(talk)}>
                ${icon('mic', 20)}${t('copilot.open')}
              </button>`
            : nothing
        }
        ${
          searchable
            ? html`<button class="ut-surface--badge action-item" data-testid="composer-search" @pointerup=${item(search)} @click=${item(search)}>
                ${icon('search', 20)}${t('chat.search')}
              </button>`
            : nothing
        }
        ${
          this.promptsOnRequest && this.quickPromptsOffered()
            ? html`<button
                class="ut-surface--badge action-item prompts-toggle ${this.promptsOpen ? 'open' : ''}"
                data-testid="quick-prompts-toggle"
                aria-label=${t('prompts.rowLabel')}
                aria-expanded=${this.promptsOpen ? 'true' : 'false'}
                aria-controls="quick-prompts-row"
                @pointerdown=${(e: Event) => e.preventDefault()}
                @mousedown=${(e: Event) => e.preventDefault()}
                @pointerup=${item(togglePrompts)}
                @click=${item(togglePrompts)}
              >
                ${icon('sparkles', 20)}${t('prompts.rowLabel')}
              </button>`
            : nothing
        }
        ${
          offered
            ? html`<button class="ut-surface--badge action-item" data-testid="composer-edit-prompts" @pointerup=${item(edit)} @click=${item(edit)}>
                ${icon('pencil', 20)}${t('prompts.edit')}
              </button>`
            : nothing
        }
      </div>
      <div class="action-group">
        <button class="ut-surface--badge action-item cancel" @click=${this.closePlus}>${t('common.cancel')}</button>
      </div>
    </dialog>`;
  }

  /** The desktop chat: its own transcript of the terminal's output and a one-line field. */
  protected renderDesktop() {
    return html`
      <div class="chat-view-container" @click=${this.handleContainerClick}>
        <div class="chat-messages-container">
          ${
            this.messages.length === 0
              ? html`
                ${this.renderEmptyState()}
              `
              : this.messages.map((msg) => this.renderMessage(msg))
          }
        </div>
        <!-- Chat input area (WhatsApp style) -->
        <div 
          class="chat-input-container ut-surface--material ut-surface--well"
          @click=${(e: Event) => e.stopPropagation()}
          @keydown=${(e: KeyboardEvent) => e.stopPropagation()}
        >
          <!-- Autocorrect is intentional; spellcheck stays off because commands may contain secrets. -->
          <input
            id="chat-input-field"
            type="text"
            class="chat-input"
            placeholder=${t('chat.commandPlaceholder')}
            autocomplete="off"
            autocorrect="on"
            autocapitalize="off"
            spellcheck="false"
            @keydown=${this.handleInputKeydown}
            @input=${this.handleInput}
            @focus=${() => logger.log('Input focused')}
            @blur=${() => logger.log('Input blurred')}
          />
          <button
            class="ut-surface--badge keyboard-dismiss-button"
            @click=${this.handleDismissKeyboard}
            title=${t('chat.hideKeyboard')}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 5H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z"/>
              <path d="M12 19l-4 3v-3h-4v-2h16v2h-4v3z" opacity="0.5"/>
            </svg>
          </button>
          <button
            class="ut-surface--badge send-button"
            @click=${this.handleSend}
            ?disabled=${this.composerEmpty}
            aria-label=${t('chat.send')}
            data-testid="chat-send-button"
          >
            ${icon('send')}
          </button>
        </div>
      </div>
    `;
  }

  /**
   * The mic is DICTATION (speech to text into the box, you still press send). On iOS, Safari
   * and Chrome alike, it records and the Mac transcribes (whisper.cpp); elsewhere it uses the
   * browser's recognizer. Every state and failure is shown under the box (2026-10-02).
   */
  protected dictationController = new DictationController({
    getText: () => this.inputElement?.value ?? '',
    setText: (value) => {
      const input = this.inputElement as HTMLTextAreaElement | null;
      if (!input) return;
      input.value = value;
      this.autoSize(input);
      saveDraft(this.sessionId, input.value);
      this.syncComposerEmpty();
    },
    onState: (state) => {
      const was = this.dictation;
      this.dictation = state;
      if (state !== 'idle') this.showDictationNote('');
      // The capsule's clock runs from the moment the microphone opens.
      if ((state === 'recording' || state === 'listening') && was !== state) {
        this.dictationStartedAt = Date.now();
        clearInterval(this.dictationClock);
        this.dictationClock = setInterval(() => this.requestUpdate(), 1000);
      } else if (state === 'idle' || state === 'transcribing') {
        clearInterval(this.dictationClock);
        this.dictationClock = undefined;
        if (state === 'idle') {
          this.dictationStartedAt = 0;
          this.levelHistory = [];
        }
      }
    },
    onError: (error) => this.showDictationNote(t(dictationErrorKey(error) as MessageKey)),
    authHeaders: () => authClient.getAuthHeader(),
    onLevel: (level) => {
      this.levelHistory = [...this.levelHistory, level].slice(-28);
    },
  });

  protected showDictationNote(note: string) {
    if (this.dictationNoteTimer) clearTimeout(this.dictationNoteTimer);
    this.dictationNote = note;
    if (note) this.dictationNoteTimer = setTimeout(() => (this.dictationNote = ''), 7000);
  }

  protected toggleDictation = () => {
    void this.dictationController.toggle();
  };

  /**
   * A dictation problem or a composer note ("tap one of its options"). The states themselves
   * (recording, transcribing) show in the composer's capsule, not as a banner (phone-spec §3.5).
   */
  protected renderDictationNote() {
    const text = this.dictationNote;
    if (!text) return nothing;
    return html`<div class="dictation-note error" role="alert" data-testid="dictation-note">
      ${text}
    </div>`;
  }

  protected updateSlashMatches(value: string) {
    const typed = value.trimStart();
    this.slashMatches =
      typed.startsWith('/') && !/\s/.test(typed)
        ? slashCommandsFor(this.agent)
            .filter(([command]) => command.startsWith(typed.toLowerCase()))
            .slice(0, 6)
        : [];
  }

  protected pickSlashCommand(command: string) {
    const input = this.inputElement;
    if (!input) return;
    input.value = `${command} `;
    saveDraft(this.sessionId, input.value);
    this.slashMatches = [];
    this.syncComposerEmpty();
    input.focus();
  }

  /**
   * Phone composer: queue images to go out with the next message. They upload now and show
   * as thumbnails; nothing is typed into the terminal until Send.
   */
  addAttachments(files: File[]) {
    if (files.length === 0) return;
    this.attachments.add(files);
    this.showDictationNote('');
  }

  /** A screenshot pasted into the composer joins the attachments instead of the text. */
  protected handleComposerPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    e.preventDefault();
    // The session view's document-level paste handler would upload it a second time.
    e.stopPropagation();
    this.addAttachments(files);
  };

  /**
   * A hardware key's character, typed while nothing had the focus: it starts (or continues)
   * the message here, and the composer takes the focus for the keys after it.
   */
  typeFromKeyboard(text: string): boolean {
    const input = this.inputElement;
    if (!this.composerOnly || !input) return false;
    input.focus();
    // The caret after it, not a selection the next key would replace (SE simulator).
    input.setSelectionRange(input.value.length, input.value.length);
    // iOS starts writing into an element focused from a key event late: keys reaching it in
    // the meantime fire keydown and are never written ("Responde" → "RE", its "e" capitalized
    // as a sentence start; 2026-10-03, SE simulator). The composer writes them itself until
    // the keys pause.
    this.handTypingUntil = Date.now() + HAND_TYPING_MS;
    this.writeAtCaret(input, text);
    return true;
  }

  /** A key typed while iOS isn't writing into the composer yet (see typeFromKeyboard). */
  protected typeByHand(e: KeyboardEvent): boolean {
    const input = this.inputElement;
    // Option types characters ("@" on a Spanish layout); Ctrl and Cmd are shortcuts.
    if (!input || Date.now() > this.handTypingUntil || e.ctrlKey || e.metaKey) {
      return false;
    }
    if (e.key.length === 1) this.writeAtCaret(input, e.key);
    else if (e.key === 'Backspace') this.eraseAtCaret(input);
    else return false;
    e.preventDefault();
    this.handTypingUntil = Date.now() + HAND_TYPING_MS;
    return true;
  }

  /** Writes typed text at the caret, as typing would (size, draft, suggestions). */
  protected writeAtCaret(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
    const start = input.selectionStart ?? input.value.length;
    input.setRangeText(text, start, input.selectionEnd ?? start, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Erases the selection, or the character before the caret (both halves of an emoji). */
  protected eraseAtCaret(input: HTMLInputElement | HTMLTextAreaElement) {
    const end = input.selectionEnd ?? input.value.length;
    let start = input.selectionStart ?? end;
    if (start === end) {
      if (start === 0) return;
      start -= /[\uDC00-\uDFFF]/.test(input.value[start - 1]) && start > 1 ? 2 : 1;
    }
    input.setRangeText('', start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Append text (e.g. an uploaded file's path) to the composer. */
  insertText(text: string) {
    const input = this.inputElement;
    if (!input) return;
    const separator = input.value && !input.value.endsWith(' ') ? ' ' : '';
    input.value = `${input.value}${separator}${text} `;
    if (input instanceof HTMLTextAreaElement) this.autoSize(input);
    if (this.composerOnly) saveDraft(this.sessionId, input.value);
    this.syncComposerEmpty();
  }

  /** Where a tap in the text put the caret, as the phone saw it (caret-tap-diagnostics.ts). */
  protected caretTaps = caretTapDiagnostics((line) => logger.log(`composer caret tap: ${line}`));

  /** Lets the session view bring the conversation to its end as the keyboard opens. */
  protected announceComposerFocus = (event?: FocusEvent) => {
    this.dispatchEvent(new CustomEvent('composer-focus', { bubbles: true, composed: true }));
    // What iOS sees when the keyboard opens, and once it has settled (see focus-diagnostics.ts).
    const composer = event?.target as Element | undefined;
    logger.log(`composer focus: ${focusDiagnostics(composer)}`);
    setTimeout(() => logger.log(`composer focus +700ms: ${focusDiagnostics(composer)}`), 700);
  };

  protected handleInputKeydown(e: KeyboardEvent) {
    // Enter that confirms an IME conversion (Japanese, Chinese...) is not a send.
    if (e.isComposing || e.keyCode === 229) return;
    const chord = this.composerChord(e);
    if (chord) {
      e.preventDefault();
      this.submitComposer(chord);
      return;
    }
    if (e.defaultPrevented) return;
    if (this.typeByHand(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  }

  /**
   * Claude Code's chords typed in the box: Ctrl+X Ctrl+S sends the message now and Ctrl+X
   * Enter queues it, as in its own prompt; the box only knew Enter (user report, 2026-10-14).
   * Off Apple, Ctrl+X with a selection is still cut.
   */
  protected composerChord(e: KeyboardEvent): readonly string[] | null {
    if (isModifierOnly(e)) return null;
    const pending = Date.now() <= this.chordUntil;
    this.chordUntil = 0;
    if (isCtrlX(e)) {
      const input = this.inputElement;
      const cuts =
        getPlatformName() !== 'mac' && input && input.selectionStart !== input.selectionEnd;
      if (!cuts) {
        e.preventDefault();
        this.chordUntil = Date.now() + CHORD_MS;
      }
      return null;
    }
    return pending ? chordAfterCtrlX(e) : null;
  }

  /** Claude Code here (its chords are its own): not a shell, Codex or Gemini. */
  protected get takesSendChords(): boolean {
    return this.claudeSession === true || this.agent === 'claude';
  }

  protected handleDismissKeyboard() {
    // Hide keyboard - user can tap input again to refocus if needed
    if (!this.inputElement) return;
    this.inputElement.blur();
  }

  protected handleInput(e: Event) {
    // Typing by hand while dictating: stop listening so the recognizer doesn't overwrite it.
    // (Recognition results set the value directly and never fire input events.)
    if (this.dictation === 'listening') this.dictationController.cancel();
    const input = e.target as HTMLInputElement | HTMLTextAreaElement;
    if (input instanceof HTMLTextAreaElement) this.autoSize(input);
    if (this.composerOnly) {
      this.updateSlashMatches(input.value);
      saveDraft(this.sessionId, input.value);
    }
    this.syncComposerEmpty();
    if (!this.onSend) return;

    // Track when user last typed - used to pause sync during active typing
    this.lastInputTime = Date.now();

    const newValue = input.value;

    // Composer: keep editing local (autocorrect and dictation rewrite freely); send on Enter.
    if (this.composerOnly) return;

    // Update pending input for InputManager (for display sync)
    this.onPendingInputChange?.(newValue);

    // Send delta to terminal (only the difference from what we already sent)
    this.sendDeltaToTerminal(newValue);
  }

  protected sendDeltaToTerminal(newValue: string) {
    if (!this.onSend) return;

    const oldValue = this.lastSentValue;

    // Find common prefix length
    let commonLen = 0;
    while (
      commonLen < oldValue.length &&
      commonLen < newValue.length &&
      oldValue[commonLen] === newValue[commonLen]
    ) {
      commonLen++;
    }

    // Calculate how many characters to delete (backspaces needed)
    const charsToDelete = oldValue.length - commonLen;

    // Characters to add after the common prefix
    const charsToAdd = newValue.slice(commonLen);

    // Build the sequence: backspaces + new characters
    let sequence = '';

    // Send backspaces for deleted characters
    for (let i = 0; i < charsToDelete; i++) {
      sequence += '\x7f'; // DEL character (backspace)
    }

    // Send new characters
    sequence += charsToAdd;

    if (sequence) {
      this.onSend(sequence);
    }

    this.lastSentValue = newValue;
  }
}
