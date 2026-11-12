/**
 * One item of "On this Mac" as a list row (shared/mac-sessions.ts): a tmux session on the user's
 * own tmux servers, or an agent running outside Untether. It looks like a session row (.psr)
 * and says where the item runs.
 *
 * A tap on a tmux session opens it here as a new tmux client in the user's open mode, or goes to
 * the Untether session already attached to it; a tap on an agent opens its conversation,
 * read-only. ⋯ or a long press offers the other actions. Nothing on these rows is destructive,
 * so there are no swipe actions ("Share with phone" closes the agent on the Mac, but only after
 * its own confirm sheet). Events never carry a Mac id where an Untether id is expected.
 *
 * @fires navigate-to-session - The Untether session attached to the tmux session (detail: { sessionId })
 * @fires session-created - The tmux session was opened in a new Untether session (detail: { sessionId })
 * @fires session-killed - Disconnect Untether ended that session (detail: { sessionId })
 * @fires error - An action failed (detail: message)
 * @fires ut-open-mac-session-view - On window: show a conversation, read-only (MacSessionViewDetail)
 * @fires ut-mac-sessions-changed - On window: after opening or disconnecting
 */
import { html, LitElement, nothing, render } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type {
  MacAgentSession,
  MacOpenMode,
  MacSessionItem,
  MacTmuxPaneAgent,
  MacTmuxSession,
} from '../../shared/mac-sessions.js';
import { TMUX_MIN_OPEN_VERSION } from '../../shared/mac-sessions.js';
import { LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { formatActivity, isBackgroundWait } from '../utils/claude-activity.js';
import { claudeWaitingLabel } from '../utils/claude-waiting-label.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import {
  announceMacSessionsChanged,
  MAC_AGENT_NAMES,
  MacSessionsApiError,
  macAgentWindowText,
  macAlsoOpenInText,
  macItemBadge,
  macItemState,
  macItemTime,
  macItemTitle,
  macItemWhere,
  macMoreAgentsText,
  macOpenErrorText,
  macPrimaryAgent,
  macRowLabel,
  macSessionViewDetail,
  openMacSession,
  showMacConversation,
} from '../utils/mac-sessions.js';
import { macShareDetail, openMacShare } from '../utils/mac-share.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { terminateSession } from '../utils/session-actions.js';
import { focusSheet, holdSheetFocus } from '../utils/sheet-a11y.js';
import { agentAvatar } from './agent-avatar.js';
import { formatRowTime, type RowState, rowGlyphKind } from './phone-session-row.js';
import { preferPhoneChatMode } from './session-view/ui-state-manager.js';

const LONG_PRESS_MS = 550;
/** Travel before a touch counts as a scroll, and no longer as a tap or a long press. */
const TAP_SLOP_PX = 12;
/** Taps finishing the gesture that opened the sheet must not hit its buttons. */
const SHEET_GUARD_MS = 500;

type SheetMode = 'actions' | 'cannot-open' | 'confirm-disconnect';

let sheetIds = 0;

@customElement('mac-session-row')
export class MacSessionRow extends LitElement {
  createRenderRoot() {
    return this;
  }

  protected readonly i18n = new LocaleController(this);

  @property({ attribute: false }) item!: MacSessionItem;
  @property({ attribute: false }) authClient?: AuthClient;
  /** What a tap on a tmux session opens: the user's setting (MacSessionsResponse.openMode). */
  @property({ type: String }) openMode: MacOpenMode = 'control';

  /** Opening or disconnecting: further taps wait for it. */
  @state() private pending: 'opening' | 'disconnecting' | null = null;

  private press: { x: number; y: number; id: number } | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressed = false;
  private touchActedAt = 0;
  private sheetHost: HTMLElement | null = null;
  private sheetMode: SheetMode = 'actions';
  private sheetOpenedAt = 0;
  private sheetTitleId = '';
  private releaseSheetFocus: (() => void) | null = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cancelPress();
    // repeat() moves rows (disconnect + reconnect): only a row really gone closes its sheet.
    setTimeout(() => {
      if (!this.isConnected) this.closeSheet();
    }, 0);
  }

  private authHeader(): Record<string, string> {
    return this.authClient?.getAuthHeader() ?? {};
  }

  private emit(type: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  // ---- gestures ---------------------------------------------------------------------------

  private cancelPress() {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  private onDown = (e: PointerEvent) => {
    this.cancelPress();
    this.longPressed = false;
    this.press = null;
    if (e.pointerType === 'mouse') return;
    this.press = { x: e.clientX, y: e.clientY, id: e.pointerId };
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.press = null;
      this.longPressed = true;
      navigator.vibrate?.(15);
      this.openSheet('actions');
    }, LONG_PRESS_MS);
  };

  private onMove = (e: PointerEvent) => {
    const press = this.press;
    if (!press || press.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP_PX) {
      this.cancelPress();
      this.press = null;
    }
  };

  private onUp = (e: PointerEvent) => {
    const press = this.press;
    this.cancelPress();
    this.press = null;
    if (this.longPressed) {
      // The finger lifting after a long press: its click must not reach the new sheet.
      if (e.type === 'pointerup') swallowNextClick();
      return;
    }
    // A touch tap acts on pointerup (iOS can take the first tap as a hover); a scroll that
    // started on the row ends here too and is no tap.
    if (!press || e.type !== 'pointerup' || endsADrag(e)) return;
    this.touchActedAt = Date.now();
    swallowNextClick();
    this.activate();
  };

  private onClick = () => {
    if (this.longPressed) {
      this.longPressed = false;
      return;
    }
    if (Date.now() - this.touchActedAt < 700) return;
    this.activate();
  };

  /** Touch on pointerup (then the click is swallowed), mouse and keyboard on click. */
  private tapAction(fn: () => void, guardSheet = false) {
    return {
      handleEvent: (e: Event) => {
        e.stopPropagation();
        if (e.type === 'pointerdown') return;
        if (guardSheet && Date.now() - this.sheetOpenedAt < SHEET_GUARD_MS) return;
        if (e.type === 'pointerup') {
          if ((e as PointerEvent).pointerType === 'mouse') return;
          if (endsADrag(e as PointerEvent)) return;
          this.touchActedAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.touchActedAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  // ---- actions ----------------------------------------------------------------------------

  private activate() {
    if (this.pending) return;
    const item = this.item;
    if (item.kind === 'agent' && item.share?.jobId) {
      // A share of it is running: its progress, not its conversation.
      this.share();
    } else if (item.kind === 'agent') {
      this.read();
    } else if (item.utSessionId) {
      this.goToSession(item.utSessionId);
    } else if (item.canOpen) {
      void this.open(this.openMode);
    } else {
      this.openSheet('cannot-open');
    }
  }

  private goToSession(sessionId: string) {
    this.emit('navigate-to-session', { sessionId });
  }

  private read(pane?: MacTmuxPaneAgent) {
    const detail = macSessionViewDetail(this.item, pane);
    if (detail) showMacConversation(detail);
  }

  /** "Share with phone": its sheet plans and confirms, or shows the running share. */
  private share() {
    if (this.item.kind !== 'agent') return;
    const detail = macShareDetail(this.item);
    if (detail) openMacShare(detail);
  }

  /** Opens the tmux session in a new Untether session, or goes to the one attached to it. */
  private async open(mode: MacOpenMode) {
    const item = this.item;
    if (item.kind !== 'tmux' || this.pending) return;
    this.pending = 'opening';
    // An agent in it: open in the chat view, like a conversation started from the list.
    if (item.agents.length) preferPhoneChatMode();
    try {
      const result = await openMacSession(item.id, { mode }, this.authHeader());
      if (result.reused) this.goToSession(result.sessionId);
      else this.emit('session-created', { sessionId: result.sessionId });
    } catch (error) {
      this.emit('error', macOpenErrorText(error));
      if (error instanceof MacSessionsApiError && error.code === 'gone') {
        announceMacSessionsChanged();
      }
    } finally {
      this.pending = null;
    }
  }

  /**
   * Ends the Untether session attached to the tmux session; the tmux session keeps running.
   * Only one whose own program is the tmux client (utClient): another one runs the client inside
   * a shell, or a terminal window's ut, and ending it would end those.
   */
  private async disconnect() {
    const item = this.item;
    if (item.kind !== 'tmux' || !item.utSessionId || !item.utClient) return;
    if (!this.authClient || this.pending) return;
    const sessionId = item.utSessionId;
    this.pending = 'disconnecting';
    const result = await terminateSession(sessionId, this.authClient, 'running');
    this.pending = null;
    if (!result.success) {
      this.emit('error', t('sessions.row.disconnectFailed', { error: result.error ?? '' }));
      return;
    }
    this.emit('session-killed', { sessionId });
    announceMacSessionsChanged();
  }

  // ---- sheet ------------------------------------------------------------------------------

  /** Rendered into <body>: the phone sidebar slides with a transform (see phone-session-row). */
  openSheet(mode: SheetMode) {
    if (this.sheetHost) return;
    this.sheetMode = mode;
    this.sheetOpenedAt = Date.now();
    this.sheetTitleId = `msr-sheet-title-${++sheetIds}`;
    this.sheetHost = document.createElement('div');
    document.body.appendChild(this.sheetHost);
    this.renderSheet();
    // A long press leaves focus wherever it was: hand it back to the row itself.
    const opener = this.contains(document.activeElement)
      ? document.activeElement
      : this.querySelector('.psr-main');
    this.releaseSheetFocus = holdSheetFocus(
      this.sheetHost.querySelector<HTMLElement>('.psr-sheet'),
      this.closeSheet,
      opener
    );
    requestAnimationFrame(() => this.sheetHost?.querySelector('.psr-sheet')?.classList.add('open'));
  }

  private closeSheet = () => {
    if (!this.sheetHost) return;
    render(nothing, this.sheetHost);
    this.sheetHost.remove();
    this.sheetHost = null;
    this.releaseSheetFocus?.();
    this.releaseSheetFocus = null;
  };

  /** The click finishing the tap that opened the sheet can land on the new backdrop. */
  private onBackdrop = () => {
    if (Date.now() - this.sheetOpenedAt > 400) this.closeSheet();
  };

  /** A step inside the sheet: it shows its next question, and a double tap can't answer it. */
  private toStep(mode: SheetMode) {
    this.sheetMode = mode;
    this.sheetOpenedAt = Date.now();
    this.renderSheet();
    focusSheet(this.sheetHost?.querySelector<HTMLElement>('.psr-sheet') ?? null);
  }

  private sheetButton(
    label: string,
    testId: string,
    fn: () => void,
    options: { destructive?: boolean; step?: boolean } = {}
  ) {
    const handler = this.tapAction(() => {
      if (!options.step) this.closeSheet();
      fn();
    }, true);
    return html`<button
      class=${options.destructive ? 'destructive' : ''}
      data-testid=${testId}
      @pointerup=${handler}
      @click=${handler}
    >
      ${label}
    </button>`;
  }

  /** Read buttons: one per agent of a tmux session, by agent and window. */
  private readButtons(item: MacSessionItem, single: boolean) {
    if (item.kind === 'agent' || (single && item.agents.length === 1)) {
      const pane = item.kind === 'tmux' ? item.agents[0] : undefined;
      return [
        this.sheetButton(t('macSessions.action.read'), 'msr-sheet-read', () => this.read(pane)),
      ];
    }
    return item.agents.map((agent, index) =>
      this.sheetButton(
        t('macSessions.action.readAgent', {
          agent: MAC_AGENT_NAMES[agent.agent],
          index: agent.windowIndex,
        }),
        `msr-sheet-read-${index}`,
        () => this.read(agent)
      )
    );
  }

  /**
   * "Share with phone", above Read, on an agent row while the feature is on: disabled with why
   * while the agent works or waits, "Sharing…" (its progress) while a share runs.
   */
  private shareButtons(item: MacAgentSession) {
    const share = item.share;
    if (!share || !macShareDetail(item)) return [];
    if (share.can || share.jobId) {
      return [
        this.sheetButton(
          share.jobId ? t('macShare.sharing') : t('macShare.action'),
          'msr-sheet-share',
          () => this.share()
        ),
      ];
    }
    if (share.reason !== 'busy' && share.reason !== 'waiting') return [];
    return [
      html`<button
        class="ut-surface--control unavailable"
        disabled
        aria-disabled="true"
        data-testid="msr-sheet-share"
      >
        ${t('macShare.action')}
        <span class="psr-sheet-note" data-testid="msr-sheet-share-why"
          >${t('macShare.whenIdle', { agent: MAC_AGENT_NAMES[item.agent] })}</span
        >
      </button>`,
    ];
  }

  private tmuxActions(item: MacTmuxSession) {
    const reads = this.readButtons(item, false);
    const utSessionId = item.utSessionId;
    if (utSessionId) {
      return [
        this.sheetButton(t('macSessions.action.goTo'), 'msr-sheet-goto', () =>
          this.goToSession(utSessionId)
        ),
        ...reads,
        ...(item.utClient
          ? [
              this.sheetButton(
                t('macSessions.action.disconnect'),
                'msr-sheet-disconnect',
                () => this.toStep('confirm-disconnect'),
                { destructive: true, step: true }
              ),
            ]
          : []),
      ];
    }
    return [
      this.sheetButton(
        t('macSessions.action.open'),
        'msr-sheet-open',
        () => void this.open('control')
      ),
      this.sheetButton(
        t('macSessions.action.watch'),
        'msr-sheet-watch',
        () => void this.open('watch')
      ),
      ...reads,
    ];
  }

  private cannotOpenReason(item: MacTmuxSession): string {
    return item.cannotOpenReason === 'tmux-too-old'
      ? t('macSessions.error.tmuxTooOld', { version: TMUX_MIN_OPEN_VERSION })
      : t('macSessions.cannotOpen.unreachable');
  }

  private renderSheet() {
    const host = this.sheetHost;
    if (!host) return;
    const item = this.item;
    const title = macItemTitle(item);
    const id = this.sheetTitleId;
    // A tmux session that can't be opened: its ⋯ shows the same reason as a tap.
    const mode =
      this.sheetMode === 'actions' && item.kind === 'tmux' && !item.utSessionId && !item.canOpen
        ? 'cannot-open'
        : this.sheetMode;
    let content: unknown;
    if (mode === 'confirm-disconnect') {
      content = html`
        <div class="psr-sheet-title question" id=${id}>
          <bdi>${t('sessions.row.disconnectConfirm', { name: title })}</bdi>
        </div>
        ${this.sheetButton(t('sessions.row.disconnect'), 'msr-disconnect-confirm', () => void this.disconnect(), { destructive: true })}
      `;
    } else if (mode === 'cannot-open' && item.kind === 'tmux') {
      content = html`
        <div class="psr-sheet-title question" id=${id}>
          ${t('macSessions.cannotOpen.title')}
          <span class="psr-sheet-note" data-testid="msr-sheet-reason">${this.cannotOpenReason(item)}</span>
        </div>
        ${item.agents.length ? this.readButtons(item, true) : nothing}
      `;
    } else {
      content = html`
        <div class="psr-sheet-title" id=${id}><bdi>${title}</bdi></div>
        ${
          item.kind === 'tmux'
            ? this.tmuxActions(item)
            : [...this.shareButtons(item), ...this.readButtons(item, true)]
        }
      `;
    }
    // One template for every step, so a step keeps the sheet (and its "open" class) in place.
    render(
      html`
        <div class="psr-sheet-backdrop" @click=${this.onBackdrop}></div>
        <div
          class="psr-sheet"
          role=${mode === 'confirm-disconnect' ? 'alertdialog' : 'dialog'}
          aria-modal="true"
          aria-labelledby=${id}
          data-testid="msr-sheet"
          data-mode=${mode}
        >
          <div class="psr-sheet-group ut-surface--floating ut-surface--material">${content}</div>
          <button class="psr-sheet-cancel ut-surface--floating ut-surface--material" @click=${this.onBackdrop}>${t('common.cancel')}</button>
        </div>
      `,
      host
    );
  }

  // ---- render -----------------------------------------------------------------------------

  /** The shared row avatar: Claude's / Codex's / Gemini's mark, else a terminal glyph. */
  private renderAvatar(state: RowState) {
    const agent = macPrimaryAgent(this.item)?.agent;
    return agentAvatar({ variant: 'row', kind: rowGlyphKind(agent ?? 'tmux'), state });
  }

  /** Line 2: where it runs, then its badges. */
  private renderWhere() {
    const item = this.item;
    if (item.kind === 'tmux') {
      const also = macAlsoOpenInText(item);
      return html`<div class="msr-where">
        <span class="msr-where-text"
          ><bdi>${macItemWhere(item)}</bdi> · ${t('tmux.windows', { n: item.windows })}</span
        >
        ${also ? html`<span class="msr-badge" data-testid="msr-also-open"><bdi>${also}</bdi></span>` : nothing}
      </div>`;
    }
    return html`<div class="msr-where">
      <span class="msr-where-text"
        ><bdi>${macItemWhere(item)}</bdi>${
          item.cwd
            ? html` · <span class="msr-path" dir="ltr">${formatPathForDisplay(item.cwd)}</span>`
            : nothing
        }</span
      >
      <span class="msr-badge" data-testid="msr-read-only">${macItemBadge(item)}</span>
    </div>`;
  }

  /** Line 3: what the agent is doing, else the pane's program and folder; "+n more". */
  private renderStatus(state: string) {
    const item = this.item;
    const agent = macPrimaryAgent(item);
    const where = macAgentWindowText(item);
    const more = macMoreAgentsText(item);
    let status: unknown = nothing;
    if (!agent) {
      if (item.kind === 'tmux') {
        const { command, cwd } = item.current;
        const text = [command, cwd && formatPathForDisplay(cwd)].filter(Boolean).join(' · ');
        status = text ? html`<span class="psr-path" dir="ltr">${text}</span>` : nothing;
      }
    } else if (state === 'waiting') {
      const why = claudeWaitingLabel(agent.status?.waitingFor);
      status = html`<span class="psr-needs">${t('sessions.row.needsYou')}${why ? html` · <bdi>${why}</bdi>` : nothing}</span>`;
    } else if (state === 'working') {
      const activity = agent.status?.activity;
      status = activity
        ? html`<span class="psr-working"><bdi>${formatActivity(activity)}</bdi></span>${
            activity.since
              ? html` · <claude-activity-elapsed class="psr-elapsed" since=${activity.since}></claude-activity-elapsed>`
              : nothing
          }`
        : html`<span class="psr-working">${t('sessions.row.working')}<span class="psr-dots"></span></span>`;
    } else if (isBackgroundWait(agent.status)) {
      const preview = agent.status?.preview;
      status = html`<span class="psr-background" data-testid="msr-background">${t('activity.backgroundWait')}</span>${
        preview
          ? html` · ${preview.role === 'user' ? html`<span class="psr-you">${t('sessions.row.you')}</span>` : nothing}<bdi>${preview.text}</bdi>`
          : nothing
      }`;
    } else if (agent.status?.preview) {
      const preview = agent.status.preview;
      status = html`${preview.role === 'user' ? html`<span class="psr-you">${t('sessions.row.you')}</span>` : nothing}<bdi>${preview.text}</bdi>`;
    }
    if (status === nothing && !where && !more) return nothing;
    return html`<div class="psr-preview msr-status" data-testid="msr-status">
      ${
        // A product name and a number around translated words: it follows the page (a <bdi>
        // would take the direction of "Claude" and read backwards in Arabic).
        // Only with something after it: an idle agent with no preview yet left "… window 0 ·".
        where
          ? html`<span data-testid="msr-window">${where}</span>${status === nothing ? nothing : ' · '}`
          : nothing
      }${status}${more ? html` <span class="msr-more">${more}</span>` : nothing}
    </div>`;
  }

  render() {
    const item = this.item;
    if (!item) return nothing;
    const state = macItemState(item);
    const title = macItemTitle(item);
    const time = macItemTime(item);
    const openHere = item.kind === 'tmux' && item.utSessionId ? macItemBadge(item) : '';
    const sharing = item.kind === 'agent' && item.share?.reason === 'in-progress';
    const pendingText =
      this.pending === 'opening'
        ? t('macSessions.row.opening')
        : this.pending === 'disconnecting'
          ? t('sessions.row.disconnecting')
          : sharing
            ? t('macShare.sharing')
            : nothing;
    const menu = this.tapAction(() => this.openSheet('actions'));
    return html`
      <div
        class="psr msr ${this.pending ? 'msr-pending' : ''}"
        data-testid="mac-session-row"
        data-kind=${item.kind}
        data-state=${state}
        style="position: relative; touch-action: pan-y"
        @pointerdown=${this.onDown}
        @pointermove=${this.onMove}
        @pointerup=${this.onUp}
        @pointercancel=${this.onUp}
        @pointerleave=${() => this.cancelPress()}
        @contextmenu=${(e: Event) => e.preventDefault()}
        @click=${this.onClick}
      >
        ${this.renderAvatar(state)}
        <div class="psr-body">
          <div
            class="psr-main"
            role="button"
            tabindex="0"
            aria-label=${macRowLabel(item, formatRowTime(time))}
            aria-disabled=${this.pending ? 'true' : 'false'}
            @keydown=${(e: KeyboardEvent) => {
              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
              e.preventDefault();
              this.activate();
            }}
          >
            <div class="psr-top">
              <span class="psr-title"><bdi>${title}</bdi></span>
              ${openHere ? html`<span class="msr-badge msr-badge-ut" data-testid="msr-open-here">${openHere}</span>` : nothing}
              <span class="psr-time ${state === 'waiting' ? 'psr-time-alert' : ''}"
                ><ut-row-time at=${time ?? ''}></ut-row-time
              ></span>
            </div>
            ${this.renderWhere()} ${this.renderStatus(state)}
          </div>
          <div class="psr-live" role="status" data-testid="msr-pending">${pendingText}</div>
        </div>
        <button
          class="ut-surface--control psr-menu"
          type="button"
          aria-label=${t('macSessions.row.moreActions', { name: title })}
          aria-haspopup="dialog"
          data-testid="msr-menu"
          @pointerdown=${menu}
          @pointerup=${menu}
          @click=${menu}
        >
          ⋯
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mac-session-row': MacSessionRow;
  }
}
