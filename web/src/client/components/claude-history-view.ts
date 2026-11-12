/**
 * Claude conversation history (phones): every Claude Code conversation on this machine,
 * newest first, with search. Tapping one opens the session already running it, or resumes it
 * (`claude --resume`) in a new session in its own folder. One running right now outside
 * Untether (a Terminal tab, a tmux pane) is never resumed, which would make a second writer
 * of it: the row says where it runs, and offers to read it here or to open its tmux session.
 *
 * Rendered into <body> as a full-screen view: position:fixed inside the phone sidebar (which
 * slides with a transform) would be fixed to the sidebar instead of the screen.
 */

import { html, LitElement, nothing, render } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MAC_TMUX_OPEN_EVENT, type MacTmuxOpenDetail } from '../../shared/mac-sessions.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import {
  type ClaudeLiveOutside,
  ClaudeLiveOutsideError,
  findLiveClaudeSession,
  liveOutsideText,
  preferChatMode,
  resumeClaudeConversation,
  userSkipsPermissions,
} from '../utils/claude-resume.js';
import { Z_INDEX } from '../utils/constants.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { showMacConversation } from '../utils/mac-sessions.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import { formatRowTime } from './phone-session-row.js';

export interface ClaudeConversation {
  id: string;
  cwd: string;
  title: string;
  lastMessageAt: string;
  messageCount: number;
  preview: string;
  /** It runs right now outside Untether: never resumed here. */
  live?: ClaudeLiveOutside;
}

export interface ClaudeHistoryOptions {
  authHeader: () => Record<string, string>;
  /** Current sessions: a conversation already running opens its session instead. */
  getSessions: () => Session[];
  onOpenSession: (sessionId: string) => void;
  /** A new session was started; the app opens it once it shows up. */
  onSessionCreated: (sessionId: string) => void;
}

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;
/** The click that finishes the tap that opened the view must not hit a row under the finger. */
const OPEN_GUARD_MS = 500;
const TAP_SLOP_PX = 10;

@customElement('claude-history-view')
export class ClaudeHistoryView extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) options!: ClaudeHistoryOptions;
  @state() private query = '';
  @state() private conversations: ClaudeConversation[] = [];
  @state() private hasMore = false;
  @state() private loading = false;
  @state() private failed = false;
  @state() private resumingId: string | null = null;
  @state() private resumeError = '';
  /** The conversation running outside Untether whose notice shows (after a tap on it). */
  @state() private liveNoticeId: string | null = null;
  protected readonly i18n = new LocaleController(this);

  private openedAt = Date.now();
  private requestSeq = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private touchActedAt = 0;
  private down: { x: number; y: number } | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.openedAt = Date.now();
    void this.load(false);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.requestSeq++;
  }

  /** Fetch the first page (or the next one with `more`); stale answers are dropped. */
  private async load(more: boolean) {
    const seq = ++this.requestSeq;
    this.loading = true;
    this.failed = false;
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(more ? this.conversations.length : 0),
    });
    if (this.query.trim()) params.set('query', this.query.trim());
    try {
      const response = await fetch(`/api/claude/conversations?${params}`, {
        headers: this.options?.authHeader() ?? {},
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = (await response.json()) as {
        conversations: ClaudeConversation[];
        hasMore: boolean;
      };
      if (seq !== this.requestSeq) return;
      this.conversations = more
        ? [...this.conversations, ...page.conversations]
        : page.conversations;
      this.hasMore = page.hasMore;
    } catch {
      if (seq === this.requestSeq) this.failed = true;
    } finally {
      if (seq === this.requestSeq) this.loading = false;
    }
  }

  private handleInput = (e: Event) => {
    this.query = (e.target as HTMLInputElement).value;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.load(false), SEARCH_DEBOUNCE_MS);
  };

  close = () => {
    this.dispatchEvent(new CustomEvent('close'));
  };

  /**
   * Touch acts on pointerup: on iOS the first tap on freshly shown buttons is often taken as a
   * hover and produces no click. The click that may still follow is ignored; mouse and keyboard
   * use the click. A finger that moved was scrolling, and nothing acts right after opening.
   */
  private act(fn: () => void) {
    return {
      handleEvent: (e: Event) => {
        if (e.type === 'pointerdown') {
          const p = e as PointerEvent;
          this.down = { x: p.clientX, y: p.clientY };
          return;
        }
        if (Date.now() - this.openedAt < OPEN_GUARD_MS) return;
        if (e.type === 'pointerup') {
          const p = e as PointerEvent;
          if (p.pointerType === 'mouse') return;
          const moved =
            !this.down ||
            Math.hypot(p.clientX - this.down.x, p.clientY - this.down.y) > TAP_SLOP_PX;
          this.down = null;
          if (moved) return;
          this.touchActedAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.touchActedAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  private async select(conversation: ClaudeConversation) {
    if (this.resumingId) return;
    const sessions = this.options.getSessions();
    const live = findLiveClaudeSession(sessions, conversation.id);
    if (live) {
      preferChatMode();
      this.close();
      this.options.onOpenSession(live.id);
      return;
    }
    this.resumeError = '';
    if (conversation.live) {
      this.liveNoticeId = conversation.id;
      return;
    }
    preferChatMode();
    this.resumingId = conversation.id;
    try {
      const { sessionId } = await resumeClaudeConversation({
        claudeSessionId: conversation.id,
        workingDir: conversation.cwd,
        name: `claude (${formatPathForDisplay(conversation.cwd)})`,
        skipPermissions: userSkipsPermissions(sessions),
        authHeader: this.options.authHeader(),
      });
      this.close();
      this.options.onSessionCreated(sessionId);
    } catch (error) {
      if (error instanceof ClaudeLiveOutsideError) {
        // It started running elsewhere since the list was loaded.
        this.conversations = this.conversations.map((c) =>
          c.id === conversation.id ? { ...c, live: error.live } : c
        );
        this.liveNoticeId = conversation.id;
      } else {
        this.resumeError = t('history.resumeFailed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.resumingId = null;
    }
  }

  /** Its conversation, read-only, in the sheet "On this Mac" uses. */
  private readHere(conversation: ClaudeConversation, live: ClaudeLiveOutside) {
    if (!live.chatId) return;
    this.close();
    const pane = live.where === 'tmux' && live.tmuxId;
    showMacConversation({
      chatId: live.chatId,
      kind: pane ? 'pane' : 'agent',
      agent: 'claude',
      title: conversation.title,
      cwd: conversation.cwd,
      ...(pane
        ? { tmuxId: live.tmuxId, tmuxName: live.tmuxName, windowIndex: live.windowIndex }
        : // In tmux without a tmux session to open: its server can't be listed.
          live.where === 'tmux'
          ? { inTmux: { server: '' } }
          : { app: live.app }),
    });
  }

  /** Its tmux session, opened in Untether ready to type. */
  private openTmux(live: ClaudeLiveOutside) {
    if (!live.tmuxId) return;
    this.close();
    window.dispatchEvent(
      new CustomEvent<MacTmuxOpenDetail>(MAC_TMUX_OPEN_EVENT, {
        detail: { id: live.tmuxId, mode: 'control' },
      })
    );
  }

  private renderLiveNotice(conversation: ClaudeConversation, live: ClaudeLiveOutside) {
    const read = this.act(() => this.readHere(conversation, live));
    const open = this.act(() => this.openTmux(live));
    return html`<div class="ut-history-live" role="status" data-testid="history-live">
      <p>${liveOutsideText(live)}</p>
      ${
        live.chatId || (live.where === 'tmux' && live.tmuxId)
          ? html`<div class="ut-history-live-actions">
              ${
                live.chatId
                  ? html`<button
                      data-testid="history-read-here"
                      @pointerdown=${read}
                      @pointerup=${read}
                      @click=${read}
                    >
                      ${t('history.readHere')}
                    </button>`
                  : nothing
              }
              ${
                live.where === 'tmux' && live.tmuxId
                  ? html`<button
                      data-testid="history-open-tmux"
                      @pointerdown=${open}
                      @pointerup=${open}
                      @click=${open}
                    >
                      ${t('macSessions.action.open')}
                    </button>`
                  : nothing
              }
            </div>`
          : nothing
      }
    </div>`;
  }

  private renderRow(conversation: ClaudeConversation, liveIds: Set<string>) {
    const live = liveIds.has(conversation.id) || !!conversation.live;
    const resuming = this.resumingId === conversation.id;
    const open = this.act(() => void this.select(conversation));
    return html`
      <li>
        <button
          class="ut-history-row"
          data-testid="history-row"
          ?disabled=${resuming}
          @pointerdown=${open}
          @pointerup=${open}
          @click=${open}
        >
          <span class="ut-history-top">
            <span class="ut-history-title"><bdi>${conversation.title}</bdi></span>
            <span class="ut-history-time">${formatRowTime(conversation.lastMessageAt)}</span>
          </span>
          <span class="ut-history-folder" dir="ltr">${formatPathForDisplay(conversation.cwd)}</span>
          ${
            resuming || live
              ? html`<span class="ut-history-badge">
                  ${resuming ? t('history.resuming') : t('history.running')}
                </span>`
              : nothing
          }
          ${
            conversation.preview
              ? html`<span class="ut-history-preview"><bdi>${conversation.preview}</bdi></span>`
              : nothing
          }
        </button>
        ${
          conversation.live && this.liveNoticeId === conversation.id
            ? this.renderLiveNotice(conversation, conversation.live)
            : nothing
        }
      </li>
    `;
  }

  private renderBody() {
    if (this.failed && this.conversations.length === 0) {
      const retry = this.act(() => void this.load(false));
      return html`<div class="ut-history-empty">
        ${t('history.failed')}
        <button class="ut-history-more" @pointerdown=${retry} @pointerup=${retry} @click=${retry}>
          ${t('history.retry')}
        </button>
      </div>`;
    }
    if (this.conversations.length === 0) {
      return html`<div class="ut-history-empty">
        ${
          this.loading
            ? t('history.loading')
            : this.query.trim()
              ? t('history.noMatches', { query: this.query.trim() })
              : t('history.empty')
        }
      </div>`;
    }
    const liveIds = new Set(
      this.options
        .getSessions()
        .filter((s) => s.status !== 'exited' && s.claudeSessionId)
        .map((s) => s.claudeSessionId as string)
    );
    const more = this.act(() => void this.load(true));
    return html`
      <ul class="ut-history-list" data-testid="history-list">
        ${this.conversations.map((c) => this.renderRow(c, liveIds))}
      </ul>
      ${
        this.hasMore || (this.failed && this.conversations.length > 0)
          ? html`<button
              class="ut-history-more"
              data-testid="history-load-more"
              ?disabled=${this.loading}
              @pointerdown=${more}
              @pointerup=${more}
              @click=${more}
            >
              ${this.loading ? t('history.loading') : t('history.loadMore')}
            </button>`
          : nothing
      }
    `;
  }

  render() {
    const close = this.act(this.close);
    return html`
      <style>
        .ut-history {
          position: fixed;
          inset: 0;
          display: flex;
          flex-direction: column;
          background: var(--color-bg);
          color: var(--color-text);
          padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
        }
        .ut-history-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          background: var(--color-bg-secondary);
        }
        .ut-history-heading {
          flex: 1;
          min-width: 0;
          font-weight: var(--ut-fw-semibold);
          font-size: 17px;
        }
        .ut-history-bar button {
          min-height: 40px;
          padding: 0 14px;
          border-radius: var(--ut-r-8);
          font-size: 15px;
          color: var(--color-primary);
          touch-action: manipulation;
        }
        .ut-history-search {
          padding: 0 12px 10px;
          background: var(--color-bg-secondary);
          border-bottom: 1px solid var(--color-border);
        }
        .ut-history-search input {
          width: 100%;
          min-height: 38px;
          padding: 0 12px;
          border-radius: var(--ut-r-lg);
          border: 1px solid var(--color-border);
          background: var(--color-bg-tertiary);
          color: var(--color-text);
          /* 16px keeps iOS from zooming into the field. */
          font-size: 16px;
        }
        .ut-history-scroll {
          flex: 1;
          overflow: auto;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
          padding-bottom: calc(16px + env(safe-area-inset-bottom));
        }
        .ut-history-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .ut-history-row {
          display: flex;
          flex-direction: column;
          gap: 2px;
          width: 100%;
          padding: 10px 16px;
          text-align: start;
          border-bottom: 1px solid var(--color-border);
          color: var(--color-text);
          touch-action: pan-y;
        }
        .ut-history-row:disabled {
          opacity: 0.6;
        }
        .ut-history-top {
          display: flex;
          align-items: baseline;
          gap: 8px;
        }
        .ut-history-title {
          flex: 1;
          min-width: 0;
          font-weight: var(--ut-fw-semibold);
          font-size: 15px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ut-history-time {
          flex-shrink: 0;
          font-size: 12px;
          color: var(--color-text-muted);
        }
        .ut-history-folder {
          font-family: var(--ut-font-mono-system);
          font-size: 12px;
          color: var(--color-text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          text-align: start;
        }
        .ut-history-badge {
          align-self: flex-start;
          font-size: 11px;
          font-weight: var(--ut-fw-semibold);
          padding: 1px 8px;
          border-radius: var(--ut-r-pill);
          color: var(--color-primary-text);
          border: 1px solid color-mix(in srgb, var(--color-primary) 45%, transparent);
        }
        .ut-history-preview {
          font-size: 13px;
          color: var(--color-text-dim);
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .ut-history-more {
          display: block;
          margin: 12px auto;
          min-height: 40px;
          padding: 0 18px;
          border-radius: var(--ut-r-pill);
          border: 1px solid var(--color-border);
          background: var(--color-bg-tertiary);
          color: var(--color-text);
          font-size: 14px;
          touch-action: manipulation;
        }
        .ut-history-empty {
          padding: 32px 16px;
          text-align: center;
          color: var(--color-text-dim);
        }
        .ut-history-error {
          padding: 8px 16px;
          font-size: 13px;
          color: var(--color-status-error);
        }
        .ut-history-live {
          padding: 10px 16px 12px;
          border-bottom: 1px solid var(--color-border);
          background: var(--color-bg-secondary);
          font-size: 13px;
          color: var(--color-text-dim);
        }
        .ut-history-live p {
          margin: 0;
        }
        .ut-history-live-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 8px;
        }
        .ut-history-live-actions button {
          min-height: 44px;
          padding: 0 16px;
          border-radius: var(--ut-r-pill);
          border: 1px solid var(--color-border);
          background: var(--color-bg-tertiary);
          color: var(--color-primary);
          font-size: 14px;
          touch-action: manipulation;
        }
      </style>
      <div
        class="ut-history"
        role="dialog"
        aria-modal="true"
        aria-label=${t('history.title')}
        data-testid="claude-history"
        style="z-index: ${Z_INDEX.MODAL};"
      >
        <div class="ut-history-bar">
          <div class="ut-history-heading">${t('history.title')}</div>
          <button
            data-testid="history-close"
            @pointerdown=${close}
            @pointerup=${close}
            @click=${close}
          >
            ${t('history.close')}
          </button>
        </div>
        <div class="ut-history-search">
          <input
            type="search"
            enterkeyhint="search"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            data-testid="history-search"
            aria-label=${t('history.search')}
            placeholder=${t('history.search')}
            .value=${this.query}
            @input=${this.handleInput}
          />
        </div>
        ${this.resumeError ? html`<div class="ut-history-error" role="alert">${this.resumeError}</div>` : nothing}
        <div class="ut-history-scroll">${this.renderBody()}</div>
      </div>
    `;
  }
}

let openView: { host: HTMLElement; release: () => void } | null = null;

export function closeClaudeHistory(): void {
  if (!openView) return;
  const { host, release } = openView;
  openView = null;
  render(nothing, host);
  host.remove();
  release();
}

export function openClaudeHistory(options: ClaudeHistoryOptions): void {
  closeClaudeHistory();
  const opener = document.activeElement;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view: { host: HTMLElement; release: () => void } = { host, release: () => {} };
  openView = view;
  render(
    html`<claude-history-view .options=${options} @close=${closeClaudeHistory}></claude-history-view>`,
    host
  );
  // The view renders on its next update; hold focus once its dialog exists.
  void host.querySelector<ClaudeHistoryView>('claude-history-view')?.updateComplete.then(() => {
    if (openView !== view) return;
    view.release = holdSheetFocus(
      host.querySelector<HTMLElement>('.ut-history'),
      closeClaudeHistory,
      opener
    );
  });
}
