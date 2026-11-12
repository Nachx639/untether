import { LitElement, type PropertyValues } from 'lit';
import { property, query, state } from 'lit/decorators.js';
import {
  narrowerThanPty,
  parseScreenChoices,
  type ScreenChoices,
  type ScreenLayout,
  sameShownMenu,
} from '../../../shared/claude-screen.js';
import { LocaleController, t } from '../../i18n/index.js';
import { authClient } from '../../services/auth-client.js';
import { announce } from '../../utils/announce.js';
import type { ClaudeActivity } from '../../utils/claude-activity.js';
import {
  ModeDebouncer,
  modeSwitchBlocked,
  parseClaudeMode,
  readClaudeMode,
} from '../../utils/claude-mode.js';
import {
  CHAT_STATUS_LINE_CHANGED_EVENT,
  readChatStatusLinePref,
} from '../../utils/claude-status-line.js';
import { claudeWaitingLabel } from '../../utils/claude-waiting-label.js';
import { swallowNextClick } from '../../utils/ghost-click.js';
import { createLogger } from '../../utils/logger.js';
import { isPhoneScreen } from '../../utils/mobile-utils.js';
import type { PhoneActionSheet } from '../../utils/phone-action-sheet.js';
import { endsADrag } from '../../utils/pointer-drag.js';
import type { VoicePlayer } from '../../utils/read-aloud-player.js';
import { closeClaudeModePicker, openClaudeModePicker } from '../claude-mode-picker.js';
import { cacheChat, chatCache, rememberedMode, rememberMode } from './chat-cache.js';
import {
  AGENT_TEXT,
  type ChatAgent,
  type ChatMessage,
  type ChatResponse,
  type ClaudeChatState,
  type SentChatMessage,
  type SentChatMessageRef,
} from './chat-types.js';
import {
  baseMessageId,
  matchSent,
  type PendingSent,
  SENT_CONFIRM_MS,
  type SendState,
  sentWords,
} from './sent-messages.js';
import { checkMacVoice } from './speech.js';

const logger = createLogger('claude-chat-view');

const POLL_INTERVAL_MS = 1500;
/** While Claude is idle and nothing changed for this many polls (~30 s), poll less often. */
const IDLE_POLLS_BEFORE_SLOWING = 20;
const IDLE_POLL_INTERVAL_MS = 3000;
/** Not a Claude session (a shell in chat mode): only check now and then whether one started. */
const UNAVAILABLE_POLL_INTERVAL_MS = 5000;
/** Right after a send: a poll at once, then these long after it, then the usual pace. */
const SENT_POLL_OFFSETS_MS = [300, 800];
/** A failed image is fetched again after this, doubling with each failure up to the max. */
const IMAGE_RETRY_MS = 3000;
const IMAGE_RETRY_MAX_MS = 60_000;

/** How long a menu just answered stays hidden while the screen still shows it. */
const ANSWERED_MENU_HIDE_MS = 4000;

/** State, polling and sent messages of the chat view; the UI layer on top draws it. */
export abstract class ClaudeChatViewBase extends LitElement {
  // Drawn and handled by the UI layer (chat-view-ui.ts); lifecycle and polling here call them.
  protected abstract trackFieldFocus: () => void;
  protected abstract closeSearch: () => void;
  protected abstract cancelLongPress: () => void;
  protected abstract closeMsgMenuOutside: (e: Event) => void;
  protected abstract handleStatusLinePref: (e: Event) => void;
  protected abstract highlightMatches(): void;
  protected abstract stopSpeaking(): void;
  protected abstract syncStatusLines(screen?: string): void;

  @property({ type: String }) sessionId = '';
  /** Where the conversation is read; empty means GET /api/sessions/:sessionId/claude-chat. */
  @property({ type: String }) chatUrl = '';
  /** True while the terminal's buffer is mid-replay, not the live screen: no mode read then. */
  @property({ attribute: false }) screenSettling?: () => boolean;
  /**
   * Nothing is sent from here: questions show without their options, and there is no Stop,
   * mode chip, voice mode or "Open terminal".
   */
  @property({ type: Boolean, reflect: true }) readOnly = false;
  /**
   * A short pane (split preview on a small phone): the conversation gets the room; the title
   * bar (the session header already names it) and the permission-mode row are left out.
   */
  @property({ type: Boolean }) compactChrome = false;
  /**
   * A phone on its side (utils/short-landscape.ts), 2026-10-04: the conversation is a centred
   * column at most 720 pt wide instead of bubbles along the left edge of a 956 pt screen, and
   * with `compactChrome` the permission mode stays as a small chip over the conversation
   * (it takes no row there) instead of going away.
   */
  @property({ type: Boolean, reflect: true }) landscape = false;
  /** The title the user gave the session: shown instead of the conversation's. */
  @property({ type: String }) userTitle = '';
  @property({ type: Boolean, reflect: true }) unavailable = false;
  /** Last lines of the terminal screen, where Claude Code shows its mode. */
  @property({ attribute: false }) getScreenTail?: () => string;
  /**
   * The screen's last lines for reading a menu, as the composer and the server read them:
   * enough to reach its dialog's top (getScreenTail's 30 may not; its key then lacked the
   * command, fourth review of 2026-10-03). With their layout.
   */
  @property({ attribute: false }) getMenuScreen?: () => string;
  @property({ attribute: false }) getScreenLayout?: () => ScreenLayout | undefined;
  /**
   * The PTY's width, as the stream last said: when it changes the menu is read again at once.
   * A poll may be seconds away, and meanwhile the card kept labels the phone's copy had lost
   * (QA 2026-10-04: another client widened the PTY to 53 under the phone's 45 columns).
   */
  @property({ type: Number }) ptyCols?: number;
  /**
   * The screen is a phone (isPhoneScreen): the phone addendum's layout (phone-spec §3.5). Set
   * from the screen on connect and on resize; reflected for the styles.
   */
  @property({ type: Boolean, reflect: true }) phone = false;
  /** The soft keyboard is up (html[data-keyboard-visible], owned by the session view). */
  @property({ type: Boolean, reflect: true }) kbd = false;
  /**
   * Desktop chat mode (set by the session view when it is not on a phone): a centred
   * reading column, desktop type, and the prompt and busy strip docked over the composer as on
   * a phone; the title bar (with search) and the mode row stay. Desktop showed a chat parsed
   * from the terminal's output instead, a bubble of spinner frames for Claude Code (2026-10-12).
   */
  @property({ type: Boolean, reflect: true }) desktop = false;
  /** How the phone layout is detected; tests replace it. */
  static detectPhone: () => boolean = () => isPhoneScreen();

  @state() protected messages: ChatMessage[] = [];
  /** Messages sent from the phone that the transcript does not have yet, in send order. */
  @state() protected pendingSent: PendingSent[] = [];
  protected sentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  protected sentSeq = 0;
  /** Transcript messages (base ids) that took a sent bubble's place: each stands for one. */
  protected claimedIds = new Set<string>();
  @state() protected busy = false;
  /**
   * Claude Code says "busy" while background agents run, even after its reply: then it
   * waits for the user, and the view says so instead of showing the typing dots.
   */
  @state() protected backgroundWait = false;
  /** What Claude is doing while busy ("Editing app.ts"), shown next to the typing dots. */
  @state() protected activity: ClaudeActivity | null = null;
  @state() protected waitingFor: string | null = null;
  @state() protected loaded = false;
  /** The last poll could not reach the server: what is shown may be out of date. */
  @state() protected offline = false;
  protected readonly i18n = new LocaleController(this);
  @state() protected expandedTools = new Set<string>();
  @state() protected conversationTitle = '';
  @state() protected imageUrls = new Map<string, string>();
  protected loadingImages = new Set<string>();
  /** Images whose fetch failed: when each may be tried again, and how many tries so far. */
  protected failedImages = new Map<string, { retryAt: number; failures: number }>();
  @state() protected mode: string | null = null;
  /** Claude Code's status line under its prompt box, when Settings shows it in chat. */
  @state() protected statusLines: string[] = [];
  protected statusLineOn = readChatStatusLinePref();
  /** The agent in this session: Codex/Gemini chats get their own wording, no Claude mode chip. */
  @state() protected agent: ChatAgent = 'claude';
  @state() protected screenChoices: ScreenChoices | null = null;
  /**
   * Claude waits on a menu this screen cannot read: its terminal is narrower than the PTY,
   * sized by a terminal that owns it (a Mac window, another tmux client), and the menu's rows
   * lost their tails here.
   */
  @state() protected menuTooNarrow = false;
  /** An option of the question card on its way through the server. */
  @state() protected answering = false;
  /** Why the last tap on the card did nothing (the menu changed, the request failed). */
  @state() protected answerNote = '';
  /**
   * The menu just answered: its card stays hidden while the screen still shows it (Claude
   * redraws after the Enter), for a few seconds at most.
   */
  protected answeredMenu: { menu: ScreenChoices; at: number } | null = null;
  /**
   * Whether a question with its options shows here, as last told to the phone composer;
   * unset until told once, so a view mounted again says where it stands.
   */
  protected askingShown: boolean | undefined;
  protected signature = '';
  /** The server's fingerprint of the messages shown (null: none yet, or the chat is unavailable). */
  protected messagesVersion: string | null = null;
  /** Shown while the user reads further up; counts replies that arrived meanwhile. */
  @state() protected showJump = false;
  @state() protected unread = 0;
  /** The answer being read aloud, if any (only one at a time). */
  @state() protected speakingId: string | null = null;
  /** The Mac reads answers aloud (see speakWithMac); otherwise the phone's own voice. */
  @state() protected macVoice = false;
  protected voicePlayer: VoicePlayer | null = null;
  /** The bubble's long-press sheet on a phone (it lives in <body>, see phone-action-sheet). */
  protected msgSheet: PhoneActionSheet | null = null;
  protected speakAbort: AbortController | null = null;

  /** Runs of tool rows unfolded on a phone ("N pasos"), by their first row's id. */
  @state() protected expandedSteps = new Set<string>();
  /** The docked prompt's detail shows whole (it is cut at three lines). */
  @state() protected promptDetailOpen = false;
  /** The long-press menu of a bubble without its own icons (phone). */
  @state() protected msgMenu: {
    message: ChatMessage;
    text: string;
    top: number;
    left: number;
  } | null = null;
  protected longPressTimer: ReturnType<typeof setTimeout> | null = null;
  protected longPressStart: { x: number; y: number } | null = null;
  protected keyboardObserver: MutationObserver | null = null;
  /** The busy/asking state last told to the composer (claude-chat-state). */
  protected toldState = '';

  @state() protected searchOpen = false;
  @state() protected searchQuery = '';
  @state() protected searchIndex = 0;
  @state() protected searchCount = 0;
  /**
   * Another text field has the focus (the composer, with its keyboard up). 2026-10-04: the
   * search proxy is a real field so a tap on the search icon raises the keyboard, but while the
   * composer was focused iOS counted it as the next field and offered its ↑ ↓ arrows, which
   * could move the keyboard to this invisible input (owner's iPhone, focus-diagnostics). It is
   * left out then: a tap lands on the search button below it, and moving the focus from the
   * composer to the search field by script keeps the keyboard that is already up.
   */
  @state() protected fieldFocusedElsewhere = false;
  protected searchMarks: HTMLElement[] = [];
  protected scrollToMatchPending = false;

  @query('.scroller') protected scroller?: HTMLElement;

  protected pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the polls right after a send fall due (Date.now()), soonest first. */
  protected sentPolls: number[] = [];
  /** The last send, until its QA timing line is logged (see logSentTiming). */
  protected sentTiming: {
    id: string;
    startedAt: number;
    /** Claude was working already: its "thinking" showed before the send. */
    busy: boolean;
    bubbleMs?: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  protected stickToBottom = true;
  protected resizeObserver: ResizeObserver | null = null;

  /** Polls in a row that brought nothing new while Claude was idle. */
  protected unchangedPolls = 0;

  connectedCallback() {
    super.connectedCallback();
    this.syncPhone();
    window.addEventListener('resize', this.syncPhone);
    window.addEventListener('orientationchange', this.syncPhone);
    this.keyboardObserver = new MutationObserver(this.syncKeyboard);
    this.keyboardObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-keyboard-visible'],
    });
    this.syncKeyboard();
    document.addEventListener('pointerdown', this.closeMsgMenuOutside, true);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    // Typing or tapping (sending a message, answering) brings a slowed poll back at once.
    document.addEventListener('keydown', this.handleUserActivity, true);
    document.addEventListener('pointerdown', this.handleUserActivity, true);
    document.addEventListener('focusin', this.trackFieldFocus, true);
    document.addEventListener('focusout', this.trackFieldFocus, true);
    this.trackFieldFocus();
    window.addEventListener(CHAT_STATUS_LINE_CHANGED_EVENT, this.handleStatusLinePref);
    void checkMacVoice().then((available) => {
      this.macVoice = available;
    });
    if (!this.loaded) this.restoreCachedChat();
    this.poll();
    // Moved in the page (disconnected, then connected again): firstUpdated does not run again.
    if (this.hasUpdated) this.observeSize();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('resize', this.syncPhone);
    window.removeEventListener('orientationchange', this.syncPhone);
    this.keyboardObserver?.disconnect();
    this.keyboardObserver = null;
    document.removeEventListener('pointerdown', this.closeMsgMenuOutside, true);
    this.msgSheet?.close();
    this.cancelLongPress();
    closeClaudeModePicker();
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    document.removeEventListener('keydown', this.handleUserActivity, true);
    document.removeEventListener('pointerdown', this.handleUserActivity, true);
    document.removeEventListener('focusin', this.trackFieldFocus, true);
    document.removeEventListener('focusout', this.trackFieldFocus, true);
    window.removeEventListener(CHAT_STATUS_LINE_CHANGED_EVENT, this.handleStatusLinePref);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.stopSpeaking();
    this.forgetSent();
    for (const url of this.imageUrls.values()) URL.revokeObjectURL(url);
    // 2026-11-10: the revoked URLs stayed in the map, so a reconnected view painted broken
    // <img>s and never asked for the images again.
    this.imageUrls = new Map();
  }

  protected syncPhone = () => {
    const phone = (this.constructor as typeof ClaudeChatViewBase).detectPhone();
    if (phone !== this.phone) this.phone = phone;
  };

  protected syncKeyboard = () => {
    this.kbd = document.documentElement.getAttribute('data-keyboard-visible') === 'true';
  };

  /**
   * The prompt and the busy strip sit in the dock over the composer (a phone, or desktop chat
   * mode); tool rows read as verbs and runs of them fold into "N pasos".
   */
  protected get docked(): boolean {
    return this.phone || this.desktop;
  }

  /**
   * Fetch an uploaded image (or, keyed "fs:<path>", an image file Claude read) with the auth
   * header: an <img src> could not send it.
   */
  protected async loadImage(name: string) {
    if (this.loadingImages.has(name)) return;
    const failed = this.failedImages.get(name);
    if (failed && Date.now() < failed.retryAt) return;
    this.loadingImages.add(name);
    let loaded = false;
    let dropped = false;
    try {
      const source = name.startsWith('fs:')
        ? `/api/fs/raw?path=${encodeURIComponent(name.slice(3))}`
        : `/api/files/${encodeURIComponent(name)}`;
      const response = await fetch(source, { headers: authClient.getAuthHeader() });
      if (!response.ok) return;
      const blob = await response.blob();
      // Disconnected while fetching: nobody would revoke this URL (2026-11-10).
      if (!this.isConnected) {
        dropped = true;
        return;
      }
      const url = URL.createObjectURL(blob);
      this.imageUrls = new Map(this.imageUrls).set(name, url);
      loaded = true;
    } catch (error) {
      logger.debug('failed to load uploaded image', error);
    } finally {
      // A failed fetch stayed "loading" for good: the image never came, even once the
      // server was back (2026-10-20 review). Try again later, waiting longer each time.
      this.loadingImages.delete(name);
      if (loaded || dropped) {
        this.failedImages.delete(name);
      } else {
        const failures = (failed?.failures ?? 0) + 1;
        const delay = Math.min(IMAGE_RETRY_MAX_MS, IMAGE_RETRY_MS * 2 ** (failures - 1));
        this.failedImages.set(name, { retryAt: Date.now() + delay, failures });
        // The retry runs on a render: make sure one comes, even on a quiet conversation.
        setTimeout(() => {
          if (this.isConnected) this.requestUpdate();
        }, delay);
      }
    }
  }

  firstUpdated() {
    this.observeSize();
  }

  protected observeSize() {
    this.resizeObserver?.disconnect();
    // The keyboard shrinks the view; keep the latest message in sight. Synchronously: a
    // resize observer runs after layout and before paint, while scrollToBottom() waits a
    // frame, so each keyboard or composer-row change painted the conversation shifted
    // for one frame and then snapped back (2026-10-03).
    this.resizeObserver = new ResizeObserver(() => {
      if (this.stickToBottom && this.scroller) this.scroller.scrollTop = this.scroller.scrollHeight;
    });
    this.resizeObserver.observe(this);
    // The scroller too: the dock over the composer (a permission card, the busy strip) grows
    // inside this view and shrinks only the scroller, which the host's size does not show.
    // User report (2026-10-14): the transcript jumped ~160 px for a couple of frames when a
    // permission card docked, until the next frame's scrollToBottom caught up.
    if (this.scroller) this.resizeObserver.observe(this.scroller);
  }

  updated(changed: PropertyValues) {
    // The PTY's width changed: the menu on the card may no longer be what the screen holds.
    if (changed.has('ptyCols') && this.waitingFor) this.readScreenMenu(true);
    const switched = (key: 'sessionId' | 'chatUrl') =>
      changed.has(key) && changed.get(key) !== undefined;
    if (switched('sessionId') || switched('chatUrl')) {
      // A different conversation: forget everything shown for the previous one.
      this.messages = [];
      this.signature = '';
      this.messagesVersion = null;
      this.loaded = false;
      this.offline = false;
      this.busy = false;
      this.backgroundWait = false;
      this.waitingFor = null;
      this.screenChoices = null;
      // The question card's state was the last session's (review of 2026-10-03).
      this.answering = false;
      this.answerNote = '';
      this.answeredMenu = null;
      // The mode last read for this session, not the last one's (and not blank while the
      // switched-to terminal replays its history: the chip would blink out).
      this.mode = rememberedMode(this.sessionId);
      this.agent = 'claude';
      closeClaudeModePicker();
      this.conversationTitle = '';
      this.closeSearch();
      this.expandedTools = new Set();
      this.expandedSteps = new Set();
      this.msgMenu = null;
      this.msgSheet?.close();
      this.stickToBottom = true;
      this.showJump = false;
      this.unread = 0;
      this.stopSpeaking();
      this.spokenStatus = null;
      // Sent messages belong to the session they were sent to.
      this.forgetSent();
      this.modeReads = new ModeDebouncer();
      this.restoreCachedChat();
      this.poll();
    }
    if (
      changed.has('busy') ||
      changed.has('backgroundWait') ||
      changed.has('waitingFor') ||
      changed.has('loaded')
    ) {
      this.announceStatus();
    }
    const timing = this.sentTiming;
    if (timing) {
      // Rendered: the sent bubble first, then (a poll later) Claude's typing dots.
      const ms = Math.round(performance.now() - timing.startedAt);
      if (timing.bubbleMs === undefined && changed.has('pendingSent')) timing.bubbleMs = ms;
      if (timing.bubbleMs !== undefined && this.busy) {
        this.logSentTiming(timing.busy ? 'already showing' : `${ms} ms`);
      }
    }
    const grew = [
      'messages',
      'pendingSent',
      'busy',
      'backgroundWait',
      'waitingFor',
      'screenChoices',
      'imageUrls',
      'mode',
    ].some((key) => changed.has(key));
    if (grew && this.stickToBottom) this.scrollToBottom();
    if (
      ['messages', 'pendingSent', 'searchQuery', 'searchOpen', 'expandedTools'].some((key) =>
        changed.has(key)
      )
    ) {
      this.highlightMatches();
    }
    // The phone composer shows a menu's options as buttons too; while this view asks, it
    // leaves them here (2026-10-03: the same buttons twice, one set over the other).
    const asking =
      !this.unavailable && Boolean(this.pendingQuestion || (this.waitingFor && this.screenChoices));
    if (asking !== this.askingShown) {
      this.askingShown = asking;
      this.dispatchEvent(
        new CustomEvent<boolean>('claude-chat-asking', {
          detail: asking,
          bubbles: true,
          composed: true,
        })
      );
    }
    // The phone composer shows its quick replies only while Claude is idle (phone-spec §3.7):
    // the busy strip or the prompt takes the dock otherwise.
    const promptDocked =
      this.docked && !this.unavailable && Boolean(this.pendingQuestion || this.waitingFor);
    const state = `${this.sessionId}|${this.busy && !this.unavailable}|${asking}|${promptDocked}`;
    if (state !== this.toldState) {
      this.toldState = state;
      this.dispatchEvent(
        new CustomEvent<ClaudeChatState>('claude-chat-state', {
          detail: {
            sessionId: this.sessionId,
            busy: this.busy && !this.unavailable,
            asking,
            promptDocked,
          },
          bubbles: true,
          composed: true,
        })
      );
    }
    if (changed.has('screenChoices') || changed.has('waitingFor')) this.promptDetailOpen = false;
  }

  /** Claude's state as last told to a screen reader; null until the first poll lands. */
  protected spokenStatus: string | null = null;

  /**
   * Say "working", "waiting for you" or "finished" when it changes, politely, not on every
   * poll and not for the state a session already had when it opened.
   */
  protected announceStatus() {
    if (!this.loaded) return;
    const status = this.waitingFor
      ? `waiting:${this.waitingFor}`
      : this.busy
        ? 'busy'
        : this.backgroundWait
          ? 'background'
          : 'idle';
    const before = this.spokenStatus;
    this.spokenStatus = status;
    if (before === null || before === status) return;
    const text = AGENT_TEXT[this.agent];
    if (this.waitingFor) announce(t('chat.waiting', { reason: this.waitingFor }));
    else if (this.busy) announce(t(text.working));
    else if (this.backgroundWait) announce(t('a11y.chat.replied'));
    else if (before === 'busy' || before === 'background') announce(t(text.finished));
  }

  protected pollGeneration = 0;

  /** Hidden: stop polling (the phone kept waking every 1.5 s). Shown: fetch at once. */
  protected readonly handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.sentPolls = [];
    } else {
      this.unchangedPolls = 0;
      this.poll();
    }
  };

  protected readonly handleUserActivity = () => {
    if (this.unchangedPolls < IDLE_POLLS_BEFORE_SLOWING) return;
    this.unchangedPolls = 0;
    this.poll();
  };

  protected async poll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (!this.isConnected || !this.sessionId) return;
    // A restarted poll (session switch) supersedes any request still in flight, so an old
    // session's answer never lands in the new view (its question buttons would type there).
    const generation = ++this.pollGeneration;
    const sessionId = this.sessionId;

    // Hidden: no request and no timer; the visibilitychange handler polls on return.
    if (document.visibilityState === 'hidden') return;

    // The messages already shown: the server leaves them out of its answer if still current
    // (a long conversation was ~50 KB compressed every 1.5 s while the agent worked).
    const have = this.messagesVersion;
    const url = this.chatUrl || `/api/sessions/${sessionId}/claude-chat`;
    const query = have ? `${url.includes('?') ? '&' : '?'}have=${encodeURIComponent(have)}` : '';
    try {
      const response = await fetch(`${url}${query}`, {
        headers: authClient.getAuthHeader(),
      });
      // 404: no Claude conversation here (or it is gone), so step aside for the terminal.
      // Any other error (a 502/503/500/401 while the server restarts) says nothing about the
      // conversation: it blanked the chat, flipped to the terminal and later counted every
      // message as unread (2026-10-20 review). Keep what is shown, marked out of date.
      const chat: ChatResponse | null = response.ok
        ? ((await response.json()) as ChatResponse)
        : response.status === 404
          ? { available: false, messages: [] }
          : null;
      if (generation === this.pollGeneration && sessionId === this.sessionId) {
        // Whoever shows this view tells the error answers apart (404: the agent is gone).
        if (!response.ok) {
          this.dispatchEvent(
            new CustomEvent<number>('claude-chat-error', {
              detail: response.status,
              bubbles: true,
              composed: true,
            })
          );
        }
        if (!chat) {
          this.offline = true;
        } else {
          this.offline = false;
          if (!Array.isArray(chat.messages)) {
            chat.messages = this.messages;
            chat.messagesVersion = this.messagesVersion ?? undefined;
          }
          const changed = this.apply(chat);
          // No status means no Claude here: that's not activity, so don't keep polling fast.
          // Background agents can keep Claude "busy" for an hour after its reply: poll like idle.
          const active = chat.available && chat.status !== 'idle' && !this.backgroundWait;
          this.unchangedPolls = changed || active ? 0 : this.unchangedPolls + 1;
        }
      }
    } catch (error) {
      logger.debug('failed to load claude chat', error);
      if (generation === this.pollGeneration) this.offline = true;
    }

    if (
      this.isConnected &&
      generation === this.pollGeneration &&
      // Re-read after the await: the page may have been hidden meanwhile.
      (document.visibilityState as DocumentVisibilityState) !== 'hidden'
    ) {
      const delay = this.unavailable
        ? UNAVAILABLE_POLL_INTERVAL_MS
        : this.unchangedPolls >= IDLE_POLLS_BEFORE_SLOWING
          ? IDLE_POLL_INTERVAL_MS
          : POLL_INTERVAL_MS;
      this.pollTimer = setTimeout(() => this.poll(), this.nextSentPoll() ?? delay);
    }
  }

  /** The wait for the next of the polls right after a send, while one is left. */
  protected nextSentPoll(): number | undefined {
    const now = Date.now();
    // Those that fell due while a request was out: one poll at once stands for them all.
    while (this.sentPolls.length > 1 && this.sentPolls[1] <= now) this.sentPolls.shift();
    const at = this.sentPolls.shift();
    return at === undefined ? undefined : Math.max(0, at - now);
  }

  /** Reads the menu Claude waits on off the terminal's screen (none when it waits on none). */
  protected readScreenMenu(waiting: boolean, screen = this.getScreenTail?.() ?? '') {
    const layout = waiting ? this.getScreenLayout?.() : undefined;
    const screenChoices = waiting
      ? parseScreenChoices(this.getMenuScreen?.() ?? screen, layout)
      : null;
    this.menuTooNarrow = !screenChoices && narrowerThanPty(layout);
    // A fresh object every poll re-rendered (and re-scrolled) the view each 1.5 s while
    // Claude waited on a question; keep the old one when the choices are the same.
    if (JSON.stringify(screenChoices) !== JSON.stringify(this.screenChoices)) {
      this.screenChoices = screenChoices;
      this.answerNote = '';
      if (!sameShownMenu(this.answeredMenu?.menu, screenChoices)) this.answeredMenu = null;
    }
  }

  /** Smooths the mode read from the screen across polls (see apply()). */
  protected modeReads = new ModeDebouncer();

  protected get cacheKey(): string {
    return this.chatUrl || this.sessionId;
  }

  /** Shows the conversation's last transcript from this page load, if any, at once. */
  protected restoreCachedChat(): void {
    const cached = this.cacheKey ? chatCache.get(this.cacheKey) : undefined;
    if (!cached) return;
    this.messages = cached.messages;
    this.messagesVersion = cached.messagesVersion;
    this.signature = cached.signature;
    this.conversationTitle = cached.title;
    this.agent = cached.agent;
    // Its chip too, not a poll later.
    if (cached.agent === 'claude' && !this.mode) this.mode = rememberedMode(this.sessionId);
    this.loaded = true;
  }

  /** Shows a poll's answer; returns whether anything on screen changed. */
  protected apply(chat: ChatResponse): boolean {
    const before = `${this.agent}|${this.unavailable}|${this.busy}|${this.backgroundWait}|${this.waitingFor}|${this.conversationTitle}|${this.signature}|${this.mode}|${JSON.stringify(this.screenChoices)}|${this.menuTooNarrow}|${JSON.stringify(this.activity)}`;
    this.unavailable = !chat.available;
    this.dispatchEvent(
      new CustomEvent('claude-chat-availability', { detail: chat.available, bubbles: true })
    );
    this.agent = chat.agent === 'codex' || chat.agent === 'gemini' ? chat.agent : 'claude';
    this.backgroundWait = chat.status === 'busy' && chat.waitingForBackground === true;
    this.busy = chat.status === 'busy' && !this.backgroundWait;
    // A fresh object every poll re-rendered the whole transcript each 1.5 s while Claude
    // worked (2026-11-10); keep the old one when the activity is the same.
    const activity = this.busy ? (chat.activity ?? null) : null;
    if (JSON.stringify(activity) !== JSON.stringify(this.activity)) this.activity = activity;
    this.conversationTitle = chat.title ?? '';
    // Mid-replay the buffer holds old screens: the mode chip keeps what the last live read
    // showed. (Menus here need the server's "waiting" as well, so they are still read.)
    const settling = this.screenSettling?.() ?? false;
    const screen = this.getScreenTail?.() ?? '';
    // Claude Code's permission mode; Codex and Gemini have no such status line. Until the
    // terminal's screen has loaded (a moment after opening) the mode last read for this
    // session stands in: the chip turning up late pushed the conversation up (2026-10-03).
    if (this.agent !== 'claude') {
      this.mode = null;
    } else if (settling) {
      // Keep the chip as it is, or show this session's last mode: a view made for the switch
      // starts with none, and the chip stayed blank through the replay (QA, 2026-10-14).
      if (!this.mode) this.mode = rememberedMode(this.sessionId);
    } else if (screen.trim()) {
      // Two reads in a row decide a change: one torn redraw of Claude's footer (a background
      // task's row over the mode line while the terminal and the PTY disagree on size) flipped
      // the chip to a workflow's name and back every second (user report, 2026-10-14).
      if (this.modeReads.value === null && this.mode) this.modeReads.set(this.mode);
      this.mode = this.modeReads.read(readClaudeMode(screen));
      rememberMode(this.sessionId, this.mode);
    } else {
      this.mode = rememberedMode(this.sessionId);
    }
    this.syncStatusLines(screen);
    this.readScreenMenu(chat.status === 'waiting', screen);
    this.waitingFor =
      chat.status === 'waiting'
        ? (claudeWaitingLabel(chat.waitingFor) ?? t('chat.yourInput'))
        : null;
    // Tool results attach to existing messages, so compare more than the last id.
    const signature = `${chat.messages.length}:${chat.messages[chat.messages.length - 1]?.id}:${
      chat.messages.filter((m) => m.result !== undefined).length
    }`;
    // With the server's fingerprint any change counts (an edited message too). The server
    // always sends it except for an unavailable chat ({available:false}), where the
    // signature decides.
    const messagesChanged =
      chat.messagesVersion !== undefined
        ? chat.messagesVersion !== this.messagesVersion
        : signature !== this.signature;
    if (messagesChanged) {
      this.signature = signature;
      this.messagesVersion = chat.messagesVersion ?? null;
      // Nothing shown before (a first load, or after the list was emptied): there is no
      // "new since you looked" to count.
      if (!this.stickToBottom && this.messages.length > 0) {
        // Count what came after the last message already shown, by id: the server sends at
        // most the latest 400, so past that the list length stops growing.
        const lastSeen = this.messages[this.messages.length - 1]?.id;
        const from = lastSeen ? chat.messages.findIndex((m) => m.id === lastSeen) + 1 : 0;
        this.unread += chat.messages
          .slice(from > 0 ? from : this.messages.length)
          .filter((m) => m.role === 'assistant').length;
      }
      this.messages = chat.messages;
      // In the same render, so a sent bubble gives way to the transcript's without a flicker.
      this.settleSent();
    }
    const wasLoaded = this.loaded;
    this.loaded = true;
    if (chat.available) {
      cacheChat(this.cacheKey, {
        messages: this.messages,
        messagesVersion: this.messagesVersion,
        signature: this.signature,
        title: this.conversationTitle,
        agent: this.agent,
      });
    }
    const after = `${this.agent}|${this.unavailable}|${this.busy}|${this.backgroundWait}|${this.waitingFor}|${this.conversationTitle}|${this.signature}|${this.mode}|${JSON.stringify(this.screenChoices)}|${this.menuTooNarrow}|${JSON.stringify(this.activity)}`;
    return !wasLoaded || after !== before;
  }

  /** A single-choice AskUserQuestion Claude is currently waiting on, if any. */
  protected get pendingQuestion() {
    if (!this.waitingFor) return null;
    const last = this.messages[this.messages.length - 1];
    return last?.role === 'tool' && last.tool === 'AskUserQuestion'
      ? (last.question ?? null)
      : null;
  }

  /**
   * The menu on screen is the one just answered, a few seconds ago at most: same options and
   * key. By its options alone, the next command's prompt stayed hidden for 4 s, with no buttons
   * anywhere (fourth review of 2026-10-03).
   */
  protected justAnswered(): boolean {
    return (
      this.answeredMenu !== null &&
      sameShownMenu(this.answeredMenu.menu, this.screenChoices) &&
      Date.now() - this.answeredMenu.at < ANSWERED_MENU_HIDE_MS
    );
  }

  protected async answer(optionIndex: number) {
    if (this.answering || this.readOnly) return;
    const choices = this.pendingQuestion ? null : this.screenChoices;
    if (!choices) {
      // A question read from the conversation (no menu on screen to check): its number.
      this.waitingFor = null;
      this.dispatchEvent(
        new CustomEvent('claude-chat-input', {
          detail: String(optionIndex + 1),
          bubbles: true,
          composed: true,
        })
      );
      return;
    }
    const sessionId = this.sessionId;
    // A menu on screen is answered by the server, which checks it is still the same menu: the
    // cursor moved there and Enter, or a yes/no letter and Enter. The card keeps showing it
    // (buttons off) until then, so the composer does not show it again under it, and a failed
    // answer says so instead of the buttons just coming back (review of 2026-10-03).
    this.answering = true;
    this.answerNote = '';
    let response: Response | null = null;
    try {
      response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authClient.getAuthHeader() },
        body: JSON.stringify({
          option: optionIndex + 1,
          question: choices.question,
          options: choices.options,
          key: choices.key,
        }),
      });
    } catch {
      response = null;
    } finally {
      if (this.sessionId === sessionId) this.answering = false;
    }
    // Another session opened meanwhile: this answer is not about what it shows.
    if (this.sessionId !== sessionId) return;
    if (response?.ok) {
      this.answeredMenu = { menu: choices, at: Date.now() };
      // Shown again if the screen still has it then (the answer did not take).
      setTimeout(() => this.requestUpdate(), ANSWERED_MENU_HIDE_MS + 50);
      this.pollSoon();
      return;
    }
    const error =
      response?.status === 409
        ? ((await response.json().catch(() => ({}))) as { error?: string }).error
        : undefined;
    this.answerNote = t(
      error === 'busy'
        ? 'screenMenu.sending'
        : response?.status === 409
          ? 'screenMenu.changed'
          : 'screenMenu.failed'
    );
  }

  protected toggleTool(id: string) {
    const next = new Set(this.expandedTools);
    const opening = !next.delete(id);
    if (opening) next.add(id);
    this.expandedTools = next;
    if (!opening) return;
    // Reading what was opened: following new messages (or the image loading) pushed it out of
    // sight. Bring it into view; the view only stays pinned if that is still the bottom.
    this.markUserScroll();
    this.stickToBottom = false;
    void this.updateComplete.then(() => {
      this.revealToolDetail(id);
      this.handleScroll();
    });
  }

  protected revealToolDetail(id: string) {
    for (const detail of this.shadowRoot?.querySelectorAll<HTMLElement>('.tool-detail') ?? []) {
      if (detail.dataset.toolId === id) detail.scrollIntoView?.({ block: 'nearest' });
    }
  }

  /** Pick Claude Code's permission mode from a sheet; it presses Shift+Tab until it shows. */
  protected openModePicker = () => {
    if (this.readOnly) return;
    const sessionId = this.sessionId;
    openClaudeModePicker({
      sessionId,
      readMode: () => (this.getScreenTail ? parseClaudeMode(this.getScreenTail()) : null),
      sendShiftTab: () =>
        this.dispatchEvent(
          new CustomEvent('claude-chat-input', { detail: '\x1b[Z', bubbles: true, composed: true })
        ),
      // Shift+Tab inside a permission dialog would move its selection, not the mode (on the
      // edit dialog it means "allow all edits"). Read the live screen, not the last poll's
      // state, which can be 1.5-3 s old.
      isBlocked: () =>
        sessionId !== this.sessionId ||
        !this.isConnected ||
        Boolean(this.waitingFor || this.screenChoices) ||
        modeSwitchBlocked(this.getScreenTail?.() ?? ''),
      onModeChange: (mode) => {
        if (sessionId === this.sessionId && mode) {
          this.mode = mode;
          this.modeReads.set(mode);
        }
      },
    });
  };

  /** Interrupt Claude Code (Esc), like the stop button of a chat app. */
  protected stop = () => {
    if (this.readOnly) return;
    this.dispatchEvent(
      new CustomEvent('claude-chat-input', { detail: '\x1b', bubbles: true, composed: true })
    );
  };

  protected scrollToBottom() {
    requestAnimationFrame(() => {
      if (this.scroller) this.scroller.scrollTop = this.scroller.scrollHeight;
    });
  }

  protected lastUserScrollIntent = 0;

  protected markUserScroll = () => {
    this.lastUserScrollIntent = Date.now();
  };

  protected handleScroll = () => {
    const el = this.scroller;
    if (!el) return;
    // Only a scroll the user made can unpin the view: layout changes (the composer growing,
    // the keyboard opening) also move scrollTop and must not stop following new messages.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom || Date.now() - this.lastUserScrollIntent < 1000) this.stickToBottom = atBottom;
    this.showJump = !this.stickToBottom;
    if (this.stickToBottom) this.unread = 0;
  };

  /**
   * The composer was focused: show the end of the conversation, like a messaging app.
   * Instant (the keyboard is animating); the resize observer keeps it there as it lands.
   */
  followLatest() {
    this.stickToBottom = true;
    this.showJump = false;
    this.unread = 0;
    this.scrollToBottom();
  }

  /**
   * A message the phone composer just sent: the user's bubble at once, "sending…", until the
   * transcript has it. It showed only once Claude Code had written it and the next poll (every
   * 1.5 s) brought it (2026-10-03). Sent again (Retry), its bubble goes back to sending.
   */
  addSentMessage(sent: SentChatMessage) {
    if (sent.sessionId !== this.sessionId || this.unavailable) return;
    const shownBefore = this.messages
      .filter((message) => message.role === 'user')
      .map((message) => baseMessageId(message.id));
    // Sent again, it is the latest send: at the end, compared with what is shown now.
    this.pendingSent = [
      ...this.pendingSent.filter((pending) => pending.id !== sent.id),
      {
        id: sent.id,
        text: sent.text,
        ...sentWords(sent.text),
        at: sent.at,
        state: 'sending',
        seq: ++this.sentSeq,
        shownBefore: new Set(shownBefore),
      },
    ];
    this.watchSent(sent.id);
    // Like a messaging app: what was just sent is in sight, even from further up.
    this.followLatest();
    this.logSentTiming('not seen before the next send');
    this.sentTiming = {
      id: sent.id,
      startedAt: sent.startedAt,
      busy: this.busy,
      timer: setTimeout(() => this.logSentTiming('not seen in 30 s'), SENT_CONFIRM_MS),
    };
    this.pollSoon();
  }

  /**
   * Claude's "thinking" shows with the first poll after it starts: polls a few hundred ms
   * apart catch it, where the usual pace left it for 1.5 s later. After a message, and after
   * an answer to its question card.
   */
  protected pollSoon() {
    const now = Date.now();
    this.sentPolls = SENT_POLL_OFFSETS_MS.map((offset) => now + offset);
    this.unchangedPolls = 0;
    this.poll();
  }

  /** The composer could not send it (refused, or not delivered): "Couldn't send · Retry". */
  markSendFailed(ref: SentChatMessageRef) {
    if (ref.sessionId !== this.sessionId || !this.setSendState(ref.id, 'failed')) return;
    announce(t('chat.sendFailed'));
    if (this.sentTiming?.id === ref.id) this.logSentTiming('not seen, not sent');
  }

  /**
   * One line per send for QA: how long its bubble and Claude's "thinking" took to show, from
   * the composer's send. At log level: the client logger drops debug lines unless debug mode is
   * on, which nothing in the app turns on, so they would never reach the server's log.
   */
  protected logSentTiming(thinking: string) {
    const timing = this.sentTiming;
    if (!timing) return;
    clearTimeout(timing.timer);
    this.sentTiming = null;
    logger.log(`chat timing: bubble ${timing.bubbleMs ?? '?'} ms, thinking ${thinking}`);
  }

  /**
   * No sign of it in the transcript and no error after SENT_CONFIRM_MS: it may have gone (Claude
   * Code queues a message sent while it works) or not, so neither "sending" nor a Retry that
   * could send it twice.
   */
  protected watchSent(id: string) {
    clearTimeout(this.sentTimers.get(id));
    this.sentTimers.set(
      id,
      setTimeout(() => {
        this.sentTimers.delete(id);
        if (this.pendingSent.find((pending) => pending.id === id)?.state === 'sending') {
          this.setSendState(id, 'unconfirmed');
        }
      }, SENT_CONFIRM_MS)
    );
  }

  /** Moves a sent bubble to another state; false if it is gone or already in it. */
  protected setSendState(id: string, state: SendState): boolean {
    const pending = this.pendingSent.find((sent) => sent.id === id);
    if (!pending || pending.state === state) return false;
    if (state !== 'sending') {
      clearTimeout(this.sentTimers.get(id));
      this.sentTimers.delete(id);
    }
    this.pendingSent = this.pendingSent.map((sent) => (sent.id === id ? { ...sent, state } : sent));
    return true;
  }

  /**
   * Sent bubbles the transcript now has give way to its messages (a failed one too: it went).
   * One sent before a message that came stays just before that message: it is not coming
   * (Claude Code takes queued messages in order) or not logged, and must not trail below
   * everything said since. Without a clock: the Mac's and the phone's may differ.
   */
  protected settleSent() {
    if (this.pendingSent.length === 0) return;
    const matches = matchSent(this.pendingSent, this.messages, this.claimedIds);
    const came = this.pendingSent.flatMap((pending) => {
      const id = matches.get(pending.id);
      return id === undefined ? [] : [{ seq: pending.seq, id: baseMessageId(id) }];
    });
    for (const { id } of came) this.claimedIds.add(id);
    const shown = new Set(this.messages.map((message) => baseMessageId(message.id)));
    let changed = matches.size > 0;
    const next: PendingSent[] = [];
    for (const pending of this.pendingSent) {
      // Its message came; or the one it stood before is gone (past the latest 400, or /clear).
      if (matches.has(pending.id) || (pending.before && !shown.has(pending.before))) {
        clearTimeout(this.sentTimers.get(pending.id));
        this.sentTimers.delete(pending.id);
        changed = true;
        continue;
      }
      const later = pending.before ? undefined : came.find(({ seq }) => seq > pending.seq);
      if (later) changed = true;
      next.push(later ? { ...pending, before: later.id } : pending);
    }
    if (changed) this.pendingSent = next;
  }

  protected forgetSent() {
    for (const timer of this.sentTimers.values()) clearTimeout(timer);
    this.sentTimers.clear();
    this.claimedIds.clear();
    this.pendingSent = [];
    this.sentPolls = [];
    if (this.sentTiming) clearTimeout(this.sentTiming.timer);
    this.sentTiming = null;
  }

  /** "Retry": the composer sends it again the way it went (TerminalChatView.resendMessage). */
  protected retrySent(id: string) {
    this.dispatchEvent(
      new CustomEvent<SentChatMessageRef>('chat-message-retry', {
        detail: { sessionId: this.sessionId, id },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Retry acts on a tap's pointerup (iOS can eat a first tap's click), and on a keyboard click. */
  protected retryTap(id: string) {
    return (e: Event) => {
      if (e.type === 'pointerup') {
        // A scroll of the conversation that started on the button ends here too: not a tap.
        if ((e as PointerEvent).button > 0 || endsADrag(e as PointerEvent)) return;
        // The click that follows the tap would send it twice.
        swallowNextClick();
      }
      this.retrySent(id);
    };
  }
}
