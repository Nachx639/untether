import { html, nothing, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { translatePrompt, translatePromptOption } from '../../../shared/claude-prompt-text.js';
import { getLocale, t } from '../../i18n/index.js';
import { authClient } from '../../services/auth-client.js';
import { formatActivity } from '../../utils/claude-activity.js';
import { compactStatusSegments, parseClaudeStatusLine } from '../../utils/claude-status-line.js';
import { claudeWaitingLabel } from '../../utils/claude-waiting-label.js';
import { isSwallowingGhostClick, swallowNextClick } from '../../utils/ghost-click.js';
import { createLogger } from '../../utils/logger.js';
import { PhoneActionSheet } from '../../utils/phone-action-sheet.js';
import { computePopoverPosition } from '../../utils/popover-position.js';
import { VoicePlayer } from '../../utils/read-aloud-player.js';
import { modeLabel } from '../claude-mode-picker.js';
import { copilotTap } from '../copilot-sheet.js';
import { icon } from '../icons.js';
import { AGENT_TEXT, type ChatMessage, NOTE_KEYS } from './chat-types.js';
import { ClaudeChatViewBase } from './chat-view-base.js';
import {
  extractUploadedImages,
  formatDay,
  formatTime,
  isReadImage,
  localDayKey,
  looksLikeData,
  openOnTap,
  RUN_GAP_MS,
  TOOL_ICONS,
  toolVerb,
} from './formatting.js';
import {
  ALERT_ICON,
  CLOCK_ICON,
  COPY_ICON,
  SHARE_ICON,
  SPEAK_ICON,
  STOP_SPEAK_ICON,
  shareGlyph,
  speakGlyph,
} from './glyphs.js';
import { renderChatMarkdown } from './markdown.js';
import { promptT, renderPromptDock } from './prompt-dock.js';
import { baseMessageId, type PendingSent, type SendState, sentAsMessage } from './sent-messages.js';
import { canShare, canSpeak, speechLang, speechText } from './speech.js';

const logger = createLogger('claude-chat-view');

/** The chat view's rendering, search, read-aloud and message menu. */
export abstract class ClaudeChatViewUi extends ClaudeChatViewBase {
  protected jumpToLatest = () => {
    this.stickToBottom = true;
    this.showJump = false;
    this.unread = 0;
    const el = this.scroller;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el?.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  };

  /** Code block copy buttons come from markdown HTML, so they are handled by delegation. */
  protected handleBubbleClick = (e: Event) => {
    const button = (e.target as HTMLElement).closest?.('[data-copy-code]') as HTMLElement | null;
    const code = button?.parentElement?.querySelector('pre')?.textContent;
    if (button && code != null) this.copy(code, button);
  };

  protected async copy(text: string, button?: HTMLElement) {
    try {
      await navigator.clipboard.writeText(text);
      if (!button) return;
      button.classList.add('copied');
      setTimeout(() => button.classList.remove('copied'), 1500);
    } catch {
      // Clipboard denied (insecure context): the text is still selectable.
    }
  }

  /**
   * Wrap search matches inside the rendered bubbles in <mark>. Only text nodes are split
   * (built with DOM APIs, never HTML strings), so nothing in a message can inject markup.
   */
  protected highlightMatches() {
    const root = this.shadowRoot;
    if (!root) return;
    for (const mark of root.querySelectorAll('mark.hit')) {
      const parent = mark.parentNode;
      mark.replaceWith(...mark.childNodes);
      parent?.normalize();
    }
    const query = this.searchOpen ? this.searchQuery.trim() : '';
    const marks: HTMLElement[] = [];
    if (query) {
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      for (const container of root.querySelectorAll('.md')) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          if (!node.parentElement?.closest('button, .time-inline')) nodes.push(node);
        }
        for (const node of nodes) {
          const text = node.data;
          const fragment = document.createDocumentFragment();
          let last = 0;
          for (const match of text.matchAll(pattern)) {
            const start = match.index ?? 0;
            fragment.append(text.slice(last, start));
            const mark = document.createElement('mark');
            mark.className = 'hit';
            mark.textContent = match[0];
            fragment.append(mark);
            marks.push(mark);
            last = start + match[0].length;
          }
          if (last > 0) {
            fragment.append(text.slice(last));
            node.replaceWith(fragment);
          }
        }
      }
    }
    this.searchMarks = marks;
    this.searchCount = marks.length;
    if (this.scrollToMatchPending) {
      // A new query starts from the most recent match, like chat apps.
      this.scrollToMatchPending = false;
      this.searchIndex = marks.length - 1;
      this.showMatch();
    } else {
      this.searchIndex = Math.min(Math.max(this.searchIndex, 0), Math.max(marks.length - 1, 0));
      marks[this.searchIndex]?.classList.add('current');
    }
  }

  protected showMatch() {
    for (const mark of this.searchMarks) mark.classList.remove('current');
    const mark = this.searchMarks[this.searchIndex];
    if (!mark) return;
    mark.classList.add('current');
    // Reading an older match: stop following new messages until the user jumps back.
    this.markUserScroll();
    this.stickToBottom = false;
    this.showJump = true;
    mark.scrollIntoView?.({ block: 'center' });
  }

  /** Step through matches: -1 goes up to older ones, +1 down to newer ones (wrapping). */
  protected stepMatch(delta: number) {
    const count = this.searchMarks.length;
    if (!count) return;
    this.searchIndex = (this.searchIndex + delta + count) % count;
    this.showMatch();
  }

  /** Where the focus settled once a focus change is done (focusout comes before focusin). */
  protected trackFieldFocus = () => {
    queueMicrotask(() => {
      let focused = document.activeElement;
      while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
      const field =
        focused instanceof HTMLInputElement ||
        focused instanceof HTMLTextAreaElement ||
        focused instanceof HTMLSelectElement ||
        (focused as HTMLElement | null)?.isContentEditable === true;
      this.fieldFocusedElsewhere = field && !focused?.classList.contains('search-proxy');
    });
  };

  /** The field under the finger: focused by the end of a tap meant for something above it. */
  protected onSearchProxyFocus = (e: FocusEvent) => {
    if (isSwallowingGhostClick()) {
      (e.target as HTMLElement).blur();
      return;
    }
    void this.openSearch();
  };

  protected openSearch = async () => {
    this.searchOpen = true;
    await this.updateComplete;
    this.shadowRoot?.querySelector<HTMLInputElement>('.search-bar input')?.focus();
  };

  /**
   * Search opened from outside this view (the phone composer's + sheet), within the tap: the
   * field is rendered and focused at once, or iOS would not raise the keyboard for it.
   */
  openSearchNow(): void {
    this.searchOpen = true;
    this.performUpdate();
    this.shadowRoot?.querySelector<HTMLInputElement>('.search-bar input')?.focus();
  }

  /** There is a conversation to search. */
  get canSearch(): boolean {
    return this.messages.length > 0 && !this.unavailable;
  }

  protected closeSearch = () => {
    this.searchOpen = false;
    this.searchQuery = '';
    this.searchIndex = 0;
    this.searchCount = 0;
    // Removing the focused search field may fire no focusout: look again once it is gone.
    void this.updateComplete.then(this.trackFieldFocus);
  };

  protected handleSearchInput = (e: Event) => {
    this.searchQuery = (e.target as HTMLInputElement).value;
    this.scrollToMatchPending = true;
  };

  protected handleSearchKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeSearch();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.stepMatch(e.shiftKey ? 1 : -1);
    }
  };

  protected renderTop() {
    // A phone has no title bar (the session header names it): search sits in the mode row.
    if ((this.compactChrome || this.phone) && !this.searchOpen) return nothing;
    if (this.searchOpen) {
      const query = this.searchQuery.trim();
      return html`<div class="top">
        <div class="search-bar" role="search">
          <input
            type="search"
            enterkeyhint="search"
            autocapitalize="none"
            autocorrect="off"
            autocomplete="off"
            .value=${this.searchQuery}
            placeholder=${t('chat.searchPlaceholder')}
            aria-label=${t('chat.search')}
            @input=${this.handleSearchInput}
            @keydown=${this.handleSearchKey}
          />
          ${
            query
              ? html`<span class="search-count" role="status">${
                  this.searchCount
                    ? `${this.searchIndex + 1}/${this.searchCount}`
                    : t('chat.searchNoResults')
                }</span>`
              : nothing
          }
          <button
            class="ut-surface--badge search-prev"
            ?disabled=${!this.searchCount}
            aria-label=${t('chat.searchPrevious')}
            @click=${() => this.stepMatch(-1)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
          </button>
          <button
            class="ut-surface--badge search-next"
            ?disabled=${!this.searchCount}
            aria-label=${t('chat.searchNext')}
            @click=${() => this.stepMatch(1)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
          <button class="ut-surface--badge search-close" aria-label=${t('chat.searchClose')} @click=${this.closeSearch}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      </div>`;
    }
    const title = this.userTitle || this.conversationTitle;
    if (!title && !this.messages.length) return nothing;
    // The copilot acts on what it hears: not where nothing can be sent.
    const voice = !this.readOnly;
    return html`<div class="top ${voice && this.messages.length ? 'two-icons' : ''}">
      <div class="title" title=${title}>${title}</div>
      ${voice ? this.renderVoiceButton(this.messages.length > 0) : nothing}
      ${
        this.messages.length
          ? html`<button
              class="ut-surface--badge search-toggle"
              aria-label=${t('chat.search')}
              title=${t('chat.search')}
              @click=${this.openSearch}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            </button>
            <!-- A real field under the finger: iOS raises the keyboard only for a native tap,
                 not for the scripted focus() of the search field rendered after it. Not while
                 another field has the keyboard (fieldFocusedElsewhere), nor on desktop, where it
                 took the mouse's click with a text cursor over the button. -->
            ${
              this.fieldFocusedElsewhere || this.desktop
                ? nothing
                : html`<input
                    class="search-proxy"
                    tabindex="-1"
                    aria-hidden="true"
                    autocomplete="off"
                    @focus=${this.onSearchProxyFocus}
                  />`
            }`
          : nothing
      }
    </div>`;
  }

  /** «Conversar»: the voice copilot about this session (see copilot-sheet.ts). */
  protected renderVoiceButton(besideSearch: boolean) {
    const tap = copilotTap(() => ({ mode: 'session', sessionId: this.sessionId }));
    return html`<button
      class="ut-surface--badge search-toggle voice-toggle ${besideSearch ? 'beside-search' : ''}"
      id="voice-copilot-session-button"
      aria-label=${t('copilot.open')}
      title=${t('copilot.open')}
      @pointerup=${tap.pointerup}
      @click=${tap.click}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0" /><path d="M12 18v3" /></svg>
    </button>`;
  }

  protected stopSpeaking() {
    if (this.speakingId === null) return;
    this.speakingId = null;
    this.speakAbort?.abort();
    this.speakAbort = null;
    if (canSpeak()) window.speechSynthesis.cancel();
  }

  /** Read an answer aloud, or stop if it is the one being read. */
  protected toggleSpeak(message: ChatMessage) {
    const wasSpeaking = this.speakingId === message.id;
    this.stopSpeaking();
    if (wasSpeaking) return;
    const text = speechText(message.text, t('chat.codeOmitted'));
    if (!text) return;
    const lang = speechLang(text, getLocale());
    if (this.macVoice) this.speakWithMac(message.id, text, lang);
    else if (canSpeak()) this.speakOnPhone(message.id, text, lang);
  }

  /**
   * With the Mac's voice, through one <audio> element unlocked in this tap: played as media,
   * so heard on an iPhone in silent mode, which mutes the phone's own speech synthesis even
   * with the page's audio session set to playback (2026-10-03: "started" in the log, nothing
   * heard until silent mode went off).
   */
  protected speakWithMac(id: string, text: string, lang: string) {
    this.voicePlayer ??= new VoicePlayer(() => authClient.getAuthHeader());
    this.voicePlayer.unlock();
    const abort = new AbortController();
    this.speakAbort = abort;
    this.speakingId = id;
    this.voicePlayer
      .speak(text, lang, abort.signal)
      .catch((error) => logger.warn("read aloud with the Mac's voice failed", error))
      .finally(() => {
        if (abort.signal.aborted) return;
        if (this.speakAbort === abort) this.speakAbort = null;
        if (this.speakingId === id) this.speakingId = null;
      });
  }

  /** With the phone's own voice, where the Mac has none (silent in an iPhone's silent mode). */
  protected speakOnPhone(id: string, text: string, lang: string) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    const base = utterance.lang.split('-')[0];
    const voices = window.speechSynthesis.getVoices?.() ?? [];
    const voice =
      voices.find((v) => v.lang === utterance.lang) ??
      voices.find((v) => v.lang.split(/[-_]/)[0] === base);
    if (voice) utterance.voice = voice;
    const done = () => {
      if (this.speakingId === id) this.speakingId = null;
    };
    utterance.onend = done;
    utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
      // A second tap or another message cancels it on purpose.
      if (event.error !== 'interrupted' && event.error !== 'canceled') {
        logger.warn(`read aloud failed: ${event.error}`);
      }
      done();
    };
    this.speakingId = id;
    window.speechSynthesis.speak(utterance);
  }

  /** The latest answer with text: the one bubble that keeps its icons on a phone. */
  protected latestAssistantId(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (message.role === 'assistant' && message.text) return message.id;
    }
    return undefined;
  }

  /** A press held on a bubble without icons opens its menu (a scroll or a lift cancels it). */
  protected startLongPress(e: PointerEvent, message: ChatMessage, text: string) {
    if (e.button > 0) return;
    this.cancelLongPress();
    const bubble = e.currentTarget as HTMLElement;
    this.longPressStart = { x: e.clientX, y: e.clientY };
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      // The release after the hold is not a tap on what is under it.
      swallowNextClick();
      this.openMsgMenu(bubble, message, text);
    }, 500);
  }

  protected moveLongPress = (e: PointerEvent) => {
    const start = this.longPressStart;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) this.cancelLongPress();
  };

  protected cancelLongPress = () => {
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
    this.longPressStart = null;
  };

  /** A right click, or the context-menu key: the same menu. */
  protected openMsgMenuFrom(e: MouseEvent, message: ChatMessage, text: string) {
    e.preventDefault();
    this.cancelLongPress();
    this.openMsgMenu(e.currentTarget as HTMLElement, message, text);
  }

  /**
   * The bubble's copy / read aloud / share as a small menu next to it, placed with
   * popover-position inside this view (the terminal area's contain: paint makes it the
   * frame of anything fixed in it).
   */
  protected openMsgMenu(bubble: HTMLElement, message: ChatMessage, text: string) {
    if (this.phone) {
      this.openMsgSheet(bubble, message, text);
      return;
    }
    const host = this.getBoundingClientRect();
    const rect = bubble.getBoundingClientRect();
    const items = 1 + Number(this.macVoice || canSpeak()) + Number(canShare());
    const position = computePopoverPosition(
      {
        top: rect.top - host.top,
        bottom: rect.bottom - host.top,
        left: rect.left - host.left,
        right: rect.right - host.left,
      },
      { width: 220, height: items * 44 + 8 },
      { width: host.width, height: host.height },
      { placement: 'bottom-start', flipBelow: items * 44 + 24 }
    );
    this.msgMenu = { message, text, top: position.top, left: position.left };
    void this.updateComplete.then(() =>
      this.shadowRoot
        ?.querySelector<HTMLElement>('.msg-menu button')
        ?.focus({ preventScroll: true })
    );
  }

  /**
   * On a phone the long-press menu is the bottom action sheet every phone menu uses (phone
   * spec 1.4 / 3.2), with the bubble actions' own glyphs; it was a popover over the next
   * bubble with chat / external icons (2026-10-12 QA).
   */
  protected openMsgSheet(bubble: HTMLElement, message: ChatMessage, text: string) {
    this.msgSheet?.close();
    const sheet = new PhoneActionSheet({
      label: t('phone.holdForOptions'),
      testId: 'msg-sheet',
      opener: bubble,
      onClose: () => {
        if (this.msgSheet === sheet) this.msgSheet = null;
      },
    });
    this.msgSheet = sheet;
    const item = (testId: string, glyph: TemplateResult, label: string, run: () => void) => {
      const handler = sheet.tap(run);
      return html`<button
        class="ut-surface--badge psr-sheet-item"
        data-testid=${testId}
        @pointerup=${handler}
        @click=${handler}
      >
        <span class="psr-sheet-icon" aria-hidden="true">${glyph}</span>
        <span class="psr-sheet-label">${label}</span>
      </button>`;
    };
    sheet.open(
      () => html`<div class="psr-sheet-group">
        ${item('msg-sheet-copy', icon('copy', 20), t('chat.copyMessage'), () => void this.copy(text))}
        ${
          this.macVoice || canSpeak()
            ? item('msg-sheet-speak', speakGlyph(20), t('chat.readAloud'), () =>
                this.toggleSpeak(message)
              )
            : nothing
        }
        ${
          canShare()
            ? item('msg-sheet-share', shareGlyph(20), t('chat.share'), () => void this.share(text))
            : nothing
        }
      </div>`
    );
  }

  protected closeMsgMenu = () => {
    this.msgMenu = null;
  };

  protected closeMsgMenuOutside = (e: Event) => {
    if (!this.msgMenu) return;
    const menu = this.shadowRoot?.querySelector('.msg-menu');
    if (menu && e.composedPath().includes(menu)) return;
    this.msgMenu = null;
  };

  protected renderMsgMenu() {
    const menu = this.msgMenu;
    if (!menu) return nothing;
    const act = (action: () => void) => () => {
      action();
      this.msgMenu = null;
    };
    return html`<div
      class="msg-menu"
      role="menu"
      aria-label=${t('phone.holdForOptions')}
      style="top: ${menu.top}px; left: ${menu.left}px"
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          this.closeMsgMenu();
        }
      }}
    >
      <button
        role="menuitem"
        @click=${(e: Event) => {
          const button = e.currentTarget as HTMLElement;
          void this.copy(menu.text, button).then(() => (this.msgMenu = null));
        }}
      >
        ${icon('copy', 18)}${t('chat.copyMessage')}
      </button>
      ${
        this.macVoice || canSpeak()
          ? html`<button role="menuitem" @click=${act(() => this.toggleSpeak(menu.message))}>
              ${speakGlyph(18)}${t('chat.readAloud')}
            </button>`
          : nothing
      }
      ${
        canShare()
          ? html`<button role="menuitem" @click=${act(() => this.share(menu.text))}>
              ${shareGlyph(18)}${t('chat.share')}
            </button>`
          : nothing
      }
    </div>`;
  }

  protected renderActions(message: ChatMessage, text: string) {
    const speaking = this.speakingId === message.id;
    return html`<div class="msg-actions">
      <button
        class="ut-surface--badge msg-action copy-msg"
        aria-label=${t('chat.copyMessage')}
        title=${t('chat.copyMessage')}
        @click=${(e: Event) => this.copy(text, e.currentTarget as HTMLElement)}
      >
        ${COPY_ICON}
      </button>
      ${
        this.macVoice || canSpeak()
          ? html`<button
              class="ut-surface--badge msg-action speak-msg ${speaking ? 'active' : ''}"
              aria-label=${speaking ? t('chat.stopReading') : t('chat.readAloud')}
              title=${speaking ? t('chat.stopReading') : t('chat.readAloud')}
              aria-pressed=${String(speaking)}
              @click=${() => this.toggleSpeak(message)}
            >
              ${speaking ? STOP_SPEAK_ICON : SPEAK_ICON}
            </button>`
          : nothing
      }
      ${
        canShare()
          ? html`<button
              class="ut-surface--badge msg-action share-msg"
              aria-label=${t('chat.share')}
              title=${t('chat.share')}
              @click=${() => this.share(text)}
            >
              ${SHARE_ICON}
            </button>`
          : nothing
      }
    </div>`;
  }

  protected async share(text: string) {
    try {
      await navigator.share({ text });
    } catch {
      // Cancelled by the user, or not allowed here: nothing to do.
    }
  }

  /**
   * An image file Claude read (a screenshot it took, say), shown when its chip is opened:
   * the chip alone said only "Read · shot.png" (2026-10-03). Fetched on opening, not before.
   */
  protected renderReadImage(message: ChatMessage) {
    const path = message.detail;
    if (!path || !isReadImage(message)) return nothing;
    const key = `fs:${path}`;
    const url = this.imageUrls.get(key);
    if (!url) this.loadImage(key);
    return url
      ? html`<img
          class="attachment read-image"
          src=${url}
          alt=${path}
          @load=${() => this.revealToolDetail(message.id)}
          @pointerup=${openOnTap(url)}
          @click=${openOnTap(url)}
        />`
      : html`<div class="attachment placeholder read-image">${icon('image', 28)}</div>`;
  }

  /** What an Edit/MultiEdit/Write changed: removed lines red, added green (2026-10-03). */
  protected renderDiff(message: ChatMessage) {
    if (!message.diff?.length) return nothing;
    return html`<div class="diff" role="group" aria-label=${t('chat.diffLabel')}>
      ${message.diff.map((line) =>
        line === '…'
          ? html`<div class="dl gap">⋯</div>`
          : line[0] === '#'
            ? html`<div class="dl file">${line.slice(1)}</div>`
            : html`<div class="dl ${line[0] === '-' ? 'del' : line[0] === '+' ? 'add' : 'ctx'}"><span class="sign">${line[0]}</span>${line.slice(1)}</div>`
      )}
      ${message.diffMore ? html`<div class="dl gap">${t('chat.diffMore', { n: message.diffMore })}</div>` : nothing}
    </div>`;
  }

  protected renderMessage(
    message: ChatMessage,
    previous?: ChatMessage,
    sendState?: SendState,
    showTime = true
  ) {
    if (message.role === 'note') {
      const key = NOTE_KEYS[message.text];
      return html`<div class="tool note">${key ? t(key) : message.text}</div>`;
    }
    if (message.role === 'tool') {
      const expandable = !!message.detail || message.result !== undefined || !!message.diff;
      const expanded = this.expandedTools.has(message.id);
      const label = this.docked
        ? html`${icon(TOOL_ICONS[message.tool ?? ''] ?? 'command', 14)}<span class="tool-verb"
              >${toolVerb(message.tool)}</span
            >${
              message.text
                ? html`<span class="tool-target ${looksLikeData(message.text) ? 'mono' : ''}" dir="auto"
                    >${message.text}</span
                  >`
                : nothing
            }`
        : html`<strong>${message.tool}</strong>${message.text ? html` · ${message.text}` : nothing}`;
      return html`
        <button
          class="ut-surface--badge tool ${expanded ? 'open' : ''} ${message.isError ? 'error' : ''}"
          ?disabled=${!expandable}
          aria-expanded=${expandable ? String(expanded) : nothing}
          @click=${() => this.toggleTool(message.id)}
        >
          ${label}
        </button>
        ${
          expanded
            ? html`<div class="tool-detail" data-tool-id=${message.id}>
                ${message.detail ? html`<pre class="cmd">${message.detail}</pre>` : nothing}
                ${this.renderReadImage(message)}
                ${this.renderDiff(message)}
                ${
                  // With the change on screen the stock "file has been updated" adds nothing,
                  // nor "(no output)" under an image Claude read; an error always shows.
                  message.result !== undefined &&
                  !message.isError &&
                  !message.diff &&
                  !(message.result === '' && isReadImage(message))
                    ? html`<pre class="out">${message.result || t('chat.noOutput')}</pre>`
                    : message.result !== undefined && message.isError
                      ? html`<pre class="out err">${message.result || t('chat.noOutput')}</pre>`
                      : nothing
                }
              </div>`
            : nothing
        }
      `;
    }
    const first = previous?.role !== message.role;
    const { text, images } =
      message.role === 'user'
        ? extractUploadedImages(message.text)
        : { text: message.text, images: [] };
    const phone = this.phone;
    // A phone shows the icons on the latest answer (and the one being read); the others open
    // them with a long press (phone-spec §3.5).
    const actions =
      message.role === 'assistant' &&
      Boolean(text) &&
      (!phone || message.id === this.latestAssistantId() || this.speakingId === message.id);
    const held = phone && message.role === 'assistant' && Boolean(text) && !actions;
    const clock = sendState === 'sending' ? CLOCK_ICON : nothing;
    const time = formatTime(message.timestamp);
    const inlineTime =
      phone && showTime && (time || sendState === 'sending')
        ? html`<span class="time-inline">${time}${clock}</span>`
        : nothing;
    return html`
      <div class="row ${message.role} ${first ? 'first' : ''}" data-send=${sendState ?? nothing}>
        <div
          class="bubble ut-surface--material ${
            message.role === 'assistant' && text && !phone
              ? `actions-${1 + Number(canSpeak()) + Number(canShare())}`
              : ''
          } ${phone && actions ? 'with-actions' : ''}"
          @click=${this.handleBubbleClick}
          @pointerdown=${held ? (e: PointerEvent) => this.startLongPress(e, message, text) : nothing}
          @pointermove=${held ? this.moveLongPress : nothing}
          @pointerup=${held ? this.cancelLongPress : nothing}
          @pointercancel=${held ? this.cancelLongPress : nothing}
          @contextmenu=${held ? (e: MouseEvent) => this.openMsgMenuFrom(e, message, text) : nothing}
        >
          ${images.map((name) => {
            const url = this.imageUrls.get(name);
            if (!url) this.loadImage(name);
            return url
              ? html`<img
                  class="attachment"
                  src=${url}
                  alt=${t('chat.attachedImage')}
                  @load=${() => this.stickToBottom && this.scrollToBottom()}
                  @pointerup=${openOnTap(url)}
                  @click=${openOnTap(url)}
                />`
              : html`<div class="attachment placeholder">${icon('image', 28)}</div>`;
          })}
          ${
            text
              ? html`<div class="md">${unsafeHTML(renderChatMarkdown(text, t('chat.copy')))}${inlineTime}</div>`
              : inlineTime
          }
          ${actions ? this.renderActions(message, text) : nothing}
          ${phone ? nothing : html`<span class="time">${time}${clock}</span>`}
          ${held ? html`<span class="visually-hidden">${t('phone.holdForOptions')}</span>` : nothing}
          ${
            sendState === 'sending'
              ? html`<span class="visually-hidden">${t('mission.sending')}</span>`
              : nothing
          }
        </div>
      </div>
    `;
  }

  protected openTerminal = () => {
    this.dispatchEvent(
      new CustomEvent('claude-chat-open-terminal', {
        bubbles: true,
        composed: true,
      })
    );
  };

  /** Read-only: what is asked shows, but it can only be answered where the agent runs. */
  protected renderReadOnlyNote() {
    return html`<div class="read-only-note" data-testid="read-only-question">${t('chat.readOnlyQuestion')}</div>`;
  }

  /**
   * A "No, and tell Claude…" option on a phone: the composer takes the words (it sends them
   * as the reply), so it gets the focus instead of a bare answer. Elsewhere, or without a
   * composer, the option is answered as any other.
   */
  protected declineToComposer(option: string): boolean {
    if (!this.docked || this.readOnly || !/tell claude/i.test(option)) return false;
    const root = this.getRootNode() as ParentNode;
    const composer = root.querySelector?.('terminal-chat-view[composerOnly]') as
      | (HTMLElement & { focusComposer?: () => boolean })
      | null;
    return composer?.focusComposer?.() === true;
  }

  /** The prompt docked over the composer on a phone (phone-spec §3.6), or the waiting note. */
  protected renderDockedPrompt() {
    // Labelled again here (idempotent): a raw English reason must never reach the dock
    // ("Claude te necesita · permission prompt", 2026-10-12 QA).
    const reason = claudeWaitingLabel(this.waitingFor);
    const kind = reason ?? t('chat.yourInput');
    const toggle = () => {
      this.promptDetailOpen = !this.promptDetailOpen;
    };
    const readOnly = this.readOnly ? this.renderReadOnlyNote() : undefined;
    if (this.pendingQuestion) {
      const question = this.pendingQuestion;
      return renderPromptDock({
        kind,
        question: question.text,
        options: question.options,
        shown: question.options.map((option) => translatePromptOption(option, promptT)),
        readOnly,
        detailOpen: this.promptDetailOpen,
        onToggleDetail: toggle,
        pick: (index) => ({ click: () => this.answer(index) }),
      });
    }
    if (this.waitingFor && this.screenChoices && !this.justAnswered()) {
      const choices = this.screenChoices;
      const shown = translatePrompt(choices, promptT);
      return renderPromptDock({
        kind,
        question: shown.question,
        detail: choices.detail,
        options: choices.options,
        shown: shown.options,
        disabled: this.answering,
        note: this.answerNote,
        readOnly,
        detailOpen: this.promptDetailOpen,
        onToggleDetail: toggle,
        pick: (index) => ({
          click: () => {
            if (!this.declineToComposer(choices.options[index])) void this.answer(index);
          },
        }),
        onOpenTerminal: this.readOnly ? undefined : this.openTerminal,
      });
    }
    if (this.waitingFor) {
      return renderPromptDock({
        kind,
        question: this.menuTooNarrow
          ? t('chat.menuTooNarrow', { reason: kind })
          : t('chat.waiting', { reason: kind }),
        options: [],
        shown: [],
        readOnly: readOnly ?? html``,
        detailOpen: false,
        onToggleDetail: toggle,
        pick: () => ({ click: () => {} }),
        onOpenTerminal: this.readOnly ? undefined : this.openTerminal,
        testId: 'prompt-waiting',
      });
    }
    return nothing;
  }

  /** The busy strip docked over the composer on a phone: dots, what it does, time, Stop. */
  protected renderBusyStrip() {
    const text = AGENT_TEXT[this.agent];
    return html`<div class="dock-busy" role="status" data-testid="chat-busy-strip">
      <div class="typing" role="img" aria-label=${t(text.working)}><span></span><span></span><span></span></div>
      <span class="activity" data-testid="chat-activity" dir="auto"
        >${this.activity ? formatActivity(this.activity) : t(text.working)}</span
      >
      ${
        this.activity?.since
          ? html`<claude-activity-elapsed class="elapsed" since=${this.activity.since}></claude-activity-elapsed>`
          : nothing
      }
      ${
        this.readOnly
          ? nothing
          : html`<button class="ut-surface--badge stop" @click=${this.stop} aria-label=${t(text.stop)}>
              ${icon('stop', 14)}${t('phone.stop')}
            </button>`
      }
    </div>`;
  }

  /** One slot over the composer: the prompt, else the busy strip, else nothing. */
  protected renderDock() {
    const prompt = this.renderDockedPrompt();
    if (prompt !== nothing) return html`<div class="dock">${prompt}</div>`;
    if (this.busy) return html`<div class="dock">${this.renderBusyStrip()}</div>`;
    return nothing;
  }

  /** A question with its options, a menu on screen, or what the agent waits for. */
  protected renderAsking() {
    if (this.pendingQuestion) {
      return html`<div class="question">
        <div class="question-text">${this.pendingQuestion.text}</div>
        ${
          this.readOnly
            ? this.renderReadOnlyNote()
            : this.pendingQuestion.options.map(
                (option, index) =>
                  html`<button @click=${() => this.answer(index)}>${option}</button>`
              )
        }
      </div>`;
    }
    if (this.waitingFor && this.screenChoices && !this.justAnswered()) {
      return html`<div class="question">
        ${
          // What an answer approves ("Bash command", the command): the same question
          // comes for every permission.
          this.screenChoices.detail?.length
            ? html`<div class="question-detail" dir="ltr" data-testid="question-detail">
                ${this.screenChoices.detail.map((line) => html`<div>${line}</div>`)}
              </div>`
            : nothing
        }
        <div class="question-text">${this.screenChoices.question}</div>
        ${
          this.readOnly
            ? this.renderReadOnlyNote()
            : html`${
                this.answerNote
                  ? html`<div class="question-note" role="alert">${this.answerNote}</div>`
                  : nothing
              }
              ${this.screenChoices.options.map(
                (option, index) =>
                  html`<button ?disabled=${this.answering} @click=${() => this.answer(index)}>
                    ${option}
                  </button>`
              )}
              <button class="ut-surface--badge link" @click=${this.openTerminal}>${t('chat.openTerminal')}</button>`
        }
      </div>`;
    }
    if (this.waitingFor) {
      return html`<div class="waiting ${this.readOnly ? 'read-only' : ''}" role="status">
        <span
          >${
            this.menuTooNarrow
              ? t('chat.menuTooNarrow', { reason: this.waitingFor })
              : t('chat.waiting', { reason: this.waitingFor })
          }</span
        >
        ${
          this.readOnly
            ? this.renderReadOnlyNote()
            : html`<button @click=${this.openTerminal}>${t('chat.openTerminal')}</button>`
        }
      </div>`;
    }
    return nothing;
  }

  /**
   * Messages sent from the phone that the transcript does not have yet, after the conversation
   * and the question it may end with (a reply answers it), shaped like the transcript's own so
   * that its message takes their place without anything moving.
   */
  protected renderSent() {
    // The conversation's last day, as its separators go.
    let lastDay = '';
    for (let i = this.messages.length - 1; i >= 0 && !lastDay; i--) {
      const date = new Date(this.messages[i].timestamp ?? '');
      if (!Number.isNaN(date.getTime())) lastDay = localDayKey(date);
    }
    const rows = this.pendingSent
      .filter((sent) => !sent.before)
      .map((sent) => ({ message: sentAsMessage(sent), sent }));
    return this.renderRows(rows, this.messages[this.messages.length - 1], lastDay);
  }

  protected renderSendNote(pending: PendingSent) {
    if (pending.state === 'failed') {
      const tap = this.retryTap(pending.id);
      return html`<div class="send-note failed" data-testid="send-note">
        ${ALERT_ICON}<span>${t('chat.sendFailed')}</span><span aria-hidden="true">·</span>
        <button type="button" data-testid="send-retry" @pointerup=${tap} @click=${tap}>
          ${t('attach.retry')}
        </button>
      </div>`;
    }
    if (pending.state === 'unconfirmed') {
      return html`<div class="send-note" data-testid="send-note">${t('chat.notConfirmed')}</div>`;
    }
    return nothing;
  }

  /** The conversation, with the sent bubbles it went past just before the message after each. */
  protected renderMessages() {
    const placed = new Map<string, PendingSent[]>();
    for (const sent of this.pendingSent) {
      if (sent.before) placed.set(sent.before, [...(placed.get(sent.before) ?? []), sent]);
    }
    const rows = this.messages.flatMap((message) => {
      const id = baseMessageId(message.id);
      const before = placed.get(id) ?? [];
      placed.delete(id);
      return [...before.map((sent) => ({ message: sentAsMessage(sent), sent })), { message }];
    });
    return this.renderRows(rows, undefined, '');
  }

  /** Rows with a day separator wherever the local date changes (after `lastDay`). */
  protected renderRows(
    rows: Array<{ message: ChatMessage; sent?: PendingSent }>,
    previous: ChatMessage | undefined,
    lastDay: string
  ) {
    const phone = this.docked;
    // On a phone (and on desktop) the question Claude waits on is docked over the composer:
    // its tool row ("AskUserQuestion") would only say it again.
    const docked = phone && this.pendingQuestion ? this.messages[this.messages.length - 1] : null;
    const shown = docked ? rows.filter((row) => row.message !== docked) : rows;
    const out: unknown[] = [];
    const separatorFor = (message: ChatMessage) => {
      const date = message.timestamp ? new Date(message.timestamp) : null;
      const day = date && !Number.isNaN(date.getTime()) ? localDayKey(date) : '';
      const separator =
        date && day && day !== lastDay
          ? html`<div class="day" role="separator">${formatDay(date)}</div>`
          : nothing;
      if (day) lastDay = day;
      return separator;
    };
    for (let i = 0; i < shown.length; i++) {
      const { message, sent } = shown[i];
      // A phone folds a run of tool rows into "N pasos"; an error always shows.
      if (phone && message.role === 'tool' && shown[i + 1]?.message.role === 'tool') {
        let end = i;
        while (end + 1 < shown.length && shown[end + 1].message.role === 'tool') end++;
        const run = shown.slice(i, end + 1).map((row) => row.message);
        const key = run[0].id;
        const open = this.expandedSteps.has(key);
        out.push(html`${separatorFor(run[0])}<button
            class="ut-surface--badge steps"
            type="button"
            aria-expanded=${String(open)}
            data-testid="chat-steps"
            @click=${() => this.toggleSteps(key)}
          >
            <span class="chev" aria-hidden="true">${icon('chevronRight', 14)}</span>${t(
              'phone.steps',
              {
                n: run.length,
              }
            )}
          </button>`);
        for (const step of run) {
          if (open || step.isError) out.push(this.renderMessage(step, previous));
          if (!open) separatorFor(step);
          previous = step;
        }
        i = end;
        continue;
      }
      const separator = separatorFor(message);
      const row = this.renderMessage(message, previous, sent?.state, this.endsRun(shown, i));
      previous = message;
      out.push(html`${separator}${row}${sent ? this.renderSendNote(sent) : nothing}`);
    }
    return out;
  }

  /**
   * Whether a bubble shows its time on a phone: the last of a run (the same sender, the next
   * one under five minutes later; tool rows in between do not break it).
   */
  protected endsRun(rows: Array<{ message: ChatMessage }>, index: number): boolean {
    if (!this.phone) return true;
    const message = rows[index].message;
    for (let j = index + 1; j < rows.length; j++) {
      const next = rows[j].message;
      if (next.role === 'tool' || next.role === 'note') continue;
      if (next.role !== message.role) return true;
      const gap = Date.parse(next.timestamp ?? '') - Date.parse(message.timestamp ?? '');
      return !(gap >= 0 && gap < RUN_GAP_MS);
    }
    return true;
  }

  protected toggleSteps(key: string) {
    const next = new Set(this.expandedSteps);
    if (!next.delete(key)) next.add(key);
    this.expandedSteps = next;
  }

  render() {
    const phone = this.phone;
    const docked = this.docked;
    return html`
      ${this.renderTop()}
      ${phone ? this.renderPhoneRow() : nothing}
      ${this.offline ? html`<div class="offline" role="status">${t('chat.offline')}</div>` : nothing}
      <div class="scroll-area ${this.floatingMode ? 'with-mode' : ''}">
      <div
        class="scroller"
        @scroll=${this.handleScroll}
        @touchmove=${this.markUserScroll}
        @wheel=${this.markUserScroll}
      >
        ${
          !this.loaded
            ? html`<div class="empty" role="status">${t('chat.loading')}</div>`
            : this.messages.length === 0
              ? this.pendingSent.length
                ? nothing
                : html`<div class="empty">${
                    // "Send Claude a message below": there is no "below" when nothing is sent.
                    this.readOnly ? t('chat.readOnlyEmpty') : t(AGENT_TEXT[this.agent].empty)
                  }</div>`
              : this.renderMessages()
        }
        ${docked ? nothing : this.renderAsking()}
        ${this.renderSent()}
        ${
          this.busy && !docked
            ? html`<div class="busy-row">
                <div class="typing" role="img" aria-label=${t(AGENT_TEXT[this.agent].working)}><span></span><span></span><span></span></div>
                ${
                  this.activity
                    ? html`<span class="activity" data-testid="chat-activity"
                        >${AGENT_TEXT[this.agent].name} · <bdi>${formatActivity(this.activity)}</bdi>${
                          this.activity.since
                            ? html` · <claude-activity-elapsed since=${this.activity.since}></claude-activity-elapsed>`
                            : nothing
                        }</span
                      >`
                    : nothing
                }
                ${
                  this.readOnly
                    ? nothing
                    : html`<button class="ut-surface--badge stop" @click=${this.stop} aria-label=${t(AGENT_TEXT[this.agent].stop)}>${icon('stop', 14)}${t('chat.stop')}</button>`
                }
              </div>`
            : this.backgroundWait
              ? html`<div class="background-row" role="status" data-testid="chat-background">
                  <span class="background-dot" aria-hidden="true"></span>${t('activity.backgroundWait')}
                </div>`
              : nothing
        }
      </div>
      ${this.floatingMode && this.mode ? this.renderModeRow(this.mode, true) : nothing}
      ${
        this.showJump
          ? html`<button
              class="ut-surface--badge jump"
              @click=${this.jumpToLatest}
              aria-label=${this.unread ? t('chat.newMessages', { n: this.unread }) : t('chat.jumpToLatest')}
            >
              ${icon('chevronDown', 20)}
              ${this.unread ? html`<span class="badge">${this.unread > 99 ? '99+' : this.unread}</span>` : nothing}
            </button>`
          : nothing
      }
      ${this.renderMsgMenu()}
      </div>
      ${docked ? this.renderDock() : nothing}
      ${
        (this.mode || this.statusLines.length) && !this.compactChrome && !this.readOnly && !phone
          ? this.renderModeRow(this.mode, false)
          : nothing
      }
    `;
  }

  /**
   * A phone's one row under the session header (32 pt): the mode chip and the status line as
   * chips scrolling sideways, and search pinned at the end (there is no title bar). Without a
   * mode or a status line there is no row; search is in the composer's + sheet then.
   */
  protected renderPhoneRow() {
    if (this.compactChrome || this.searchOpen) return nothing;
    const mode = this.readOnly ? null : this.mode;
    const segments = compactStatusSegments(this.statusLines);
    // Only with something to show: an empty row cost 32 pt (search is also in the composer's +).
    if (!mode && !segments.length) return nothing;
    return html`<div class="mode-row phone-row" data-testid="chat-phone-row">
      <div class="chips">${this.renderModeChips(mode, segments)}</div>
      ${
        this.messages.length
          ? html`<button
              class="ut-surface--badge row-search search-toggle"
              aria-label=${t('chat.search')}
              title=${t('chat.search')}
              @click=${this.openSearch}
            >
              ${icon('search', 18)}
            </button>
            ${
              this.fieldFocusedElsewhere
                ? nothing
                : html`<input
                    class="search-proxy"
                    tabindex="-1"
                    aria-hidden="true"
                    autocomplete="off"
                    @focus=${this.onSearchProxyFocus}
                  />`
            }`
          : nothing
      }
    </div>`;
  }

  /** Lines under Claude Code's prompt box (Settings → status line in chat). */
  protected syncStatusLines(screen = this.getScreenTail?.() ?? '') {
    // With the terminal's wrap flags a status line cut over two rows (a phone's width) reads
    // whole (claude-status-line.ts).
    const layout = this.statusLineOn ? this.getScreenLayout?.() : undefined;
    const lines =
      this.statusLineOn && this.agent === 'claude'
        ? parseClaudeStatusLine(
            screen,
            layout && { cols: layout.cols, wrappedRows: layout.wrappedRows }
          )
        : [];
    if (lines.join('\n') !== this.statusLines.join('\n')) this.statusLines = lines;
  }

  protected handleStatusLinePref = (e: Event) => {
    this.statusLineOn = (e as CustomEvent<boolean>).detail === true;
    this.syncStatusLines();
  };

  /** The mode chip floats over the conversation: a phone on its side with a short pane. */
  protected get floatingMode(): boolean {
    return Boolean(this.mode) && this.compactChrome && this.landscape && !this.readOnly;
  }

  protected renderModeRow(mode: string | null, floating: boolean) {
    const segments = floating ? [] : compactStatusSegments(this.statusLines);
    return html`<div class="mode-row ${floating ? 'floating' : ''}">
      ${this.renderModeChips(mode, segments)}
    </div>`;
  }

  protected renderModeChips(
    mode: string | null,
    segments: ReturnType<typeof compactStatusSegments>
  ) {
    return html`${
      mode
        ? html`<button
            class="ut-surface--badge mode"
            data-testid="mode-chip"
            aria-haspopup="dialog"
            @click=${this.openModePicker}
            aria-label=${t('chat.changeMode')}
          >
            ${modeLabel(mode)}${icon('chevronDown', 12)}
          </button>`
        : nothing
    }
      ${
        segments.length
          ? html`<div class="status-line" data-testid="chat-status-line" dir="ltr" title=${this.statusLines.join('\n')}>
              ${segments.map(
                (seg) => html`<span class="status-chip" data-testid="chat-status-chip">
                  ${seg.text ? html`<span class="status-label">${seg.text}</span>` : nothing}
                  ${
                    seg.percent !== undefined
                      ? html`<span class="status-bar" aria-hidden="true"><span
                            class="status-fill ${seg.percent >= 85 ? 'high' : seg.percent >= 60 ? 'mid' : ''}"
                            style="width: ${Math.max(4, seg.percent)}%"
                          ></span></span><span class="status-pct">${seg.percent}%</span>`
                      : nothing
                  }
                  ${seg.reset ? html`<span class="status-reset">↻${seg.reset}</span>` : nothing}
                </span>`
              )}
            </div>`
          : nothing
      }`;
  }
}
