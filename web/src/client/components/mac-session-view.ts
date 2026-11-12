/**
 * The conversation of an agent running outside Untether ("On this Mac"), alone in a terminal
 * window or in a pane of a tmux session: followed live from its transcript, read-only. Nothing
 * typed here reaches it; a tmux pane can be opened instead, to type into it.
 *
 * Rendered into <body> as a full-screen sheet, like the Claude history, so it stays fixed to
 * the screen and not to a sliding sidebar. Its styles live here.
 */
import { html, LitElement, nothing, render } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  MAC_TMUX_OPEN_EVENT,
  type MacSessionViewDetail,
  type MacTmuxOpenDetail,
} from '../../shared/mac-sessions.js';
import { LocaleController, t, tAround } from '../i18n/index.js';
import { Z_INDEX } from '../utils/constants.js';
import { MAC_AGENT_NAMES, macAppName } from '../utils/mac-sessions.js';
import { openMacShare } from '../utils/mac-share.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import './claude-chat-view.js';
import { tapHandler } from './ios-install-steps.js';

/** live: the conversation shows; ended: the agent is gone (404); off: Mac sessions off (503). */
type SheetState = 'live' | 'unavailable' | 'ended' | 'off';

function basename(path: string | undefined): string {
  return (
    path
      ?.replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? ''
  );
}

@customElement('mac-session-view')
export class MacSessionView extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) detail!: MacSessionViewDetail;
  @state() private sheetState: SheetState = 'live';
  protected readonly i18n = new LocaleController(this);

  /** The click that finishes the tap that opened the sheet must not hit a button in it. */
  private readonly openedAt = Date.now();

  close = () => {
    this.dispatchEvent(new CustomEvent('close'));
  };

  private readonly closeTap = tapHandler(() => this.close(), this.openedAt);

  /** Open the pane's tmux session in Untether, ready to type. */
  private readonly openTap = tapHandler(() => {
    const id = this.detail.tmuxId;
    if (!id) return;
    this.close();
    window.dispatchEvent(
      new CustomEvent<MacTmuxOpenDetail>(MAC_TMUX_OPEN_EVENT, { detail: { id, mode: 'control' } })
    );
  }, this.openedAt);

  /** "Share with phone": the share sheet over this one, which closes once it is shared. */
  private readonly shareTap = tapHandler(() => {
    const { chatId, agent, app, title, share } = this.detail;
    if (app !== 'Terminal' && app !== 'iTerm') return;
    openMacShare({
      id: chatId,
      agent,
      app,
      ...(title ? { title } : {}),
      ...(share?.jobId ? { jobId: share.jobId } : {}),
    });
  }, this.openedAt);

  /** The footer's share button, or why it isn't there yet; nothing while the feature is off. */
  private renderShare() {
    const { share, app, agent, kind, inTmux } = this.detail;
    if (!share || kind !== 'agent' || inTmux || (app !== 'Terminal' && app !== 'iTerm')) {
      return nothing;
    }
    if (share.can || share.jobId) {
      return html`<button
        class="ut-mac-view-primary"
        data-testid="mac-view-share"
        @pointerdown=${this.shareTap}
        @pointerup=${this.shareTap}
        @click=${this.shareTap}
      >
        ${share.jobId ? t('macShare.sharing') : t('macShare.action')}
      </button>`;
    }
    if (share.reason !== 'busy' && share.reason !== 'waiting') return nothing;
    return html`<p class="ut-mac-view-running" data-testid="mac-view-share-why">
      ${t('macShare.whenIdle', { agent: MAC_AGENT_NAMES[agent] ?? agent })}
    </p>`;
  }

  private handleAvailability = (e: CustomEvent<boolean>) => {
    if (this.sheetState === 'ended' || this.sheetState === 'off') return;
    this.sheetState = e.detail ? 'live' : 'unavailable';
  };

  /** A 404 is final: the agent exited, or its pane or tmux server is gone. */
  private handleError = (e: CustomEvent<number>) => {
    if (e.detail === 404) this.sheetState = 'ended';
    else if (e.detail === 503) this.sheetState = 'off';
  };

  private get pane(): boolean {
    return (
      this.detail.kind === 'pane' &&
      this.detail.tmuxName !== undefined &&
      this.detail.windowIndex !== undefined
    );
  }

  private renderWhere() {
    const { cwd, tmuxName, windowIndex } = this.detail;
    if (this.pane) {
      // Only the session's name is the user's: the phrase around it follows the page.
      const [before, name, after] = tAround(
        'macSessions.view.inTmuxWindow',
        { name: tmuxName ?? '', index: windowIndex ?? 0 },
        'name'
      );
      return html`${before}<bdi>${name}</bdi>${after}`;
    }
    const folder = cwd ? formatPathForDisplay(cwd) : '';
    return html`<bdi>${this.agentApp() ?? t('macSessions.where.otherTerminal')}</bdi>${
      folder ? html` · <span dir="ltr">${folder}</span>` : nothing
    }`;
  }

  /** Where an agent runs, as its row says it: "tmux" under a server that can't be listed. */
  private agentApp(): string | null {
    const { app, inTmux } = this.detail;
    if (inTmux) return 'tmux';
    return app ? macAppName(app) : null;
  }

  private renderBody() {
    if (this.sheetState === 'ended' || this.sheetState === 'off') {
      return html`<div class="ut-mac-view-gone" role="status" data-testid="mac-view-ended">
        <p>${this.sheetState === 'ended' ? t('macSessions.view.ended') : t('macSessions.error.disabled')}</p>
        <button
          class="ut-mac-view-primary"
          data-testid="mac-view-ended-close"
          @pointerdown=${this.closeTap}
          @pointerup=${this.closeTap}
          @click=${this.closeTap}
        >
          ${t('common.close')}
        </button>
      </div>`;
    }
    const { chatId } = this.detail;
    return html`
      ${
        this.sheetState === 'unavailable'
          ? html`<div class="ut-mac-view-note" role="status" data-testid="mac-view-unavailable">
              ${t('macSessions.view.unavailable')}
            </div>`
          : nothing
      }
      <claude-chat-view
        class="ut-mac-view-chat"
        .readOnly=${true}
        .sessionId=${`mac:${chatId}`}
        .chatUrl=${`/api/mac-sessions/${encodeURIComponent(chatId)}/chat`}
        @claude-chat-availability=${this.handleAvailability}
        @claude-chat-error=${this.handleError}
      ></claude-chat-view>
    `;
  }

  private renderFooter() {
    if (this.sheetState === 'ended' || this.sheetState === 'off') return nothing;
    const { tmuxId, tmuxName, windowIndex } = this.detail;
    if (this.pane) {
      const [before, name, after] = tAround(
        'macSessions.view.runningInTmux',
        { name: tmuxName ?? '', index: windowIndex ?? 0 },
        'name'
      );
      return html`<div class="ut-mac-view-foot">
        <p class="ut-mac-view-running">${before}<bdi>${name}</bdi>${after}</p>
        ${
          tmuxId
            ? html`<button
                class="ut-mac-view-primary"
                data-testid="mac-view-open"
                @pointerdown=${this.openTap}
                @pointerup=${this.openTap}
                @click=${this.openTap}
              >
                ${t('macSessions.action.open')}
              </button>`
            : nothing
        }
      </div>`;
    }
    // Only the app it runs in can type into it: nothing here can, so say why. In tmux, it is
    // that its server can't be reached (no tmux session to open), not where it was started.
    const where = this.agentApp();
    return html`<div class="ut-mac-view-foot">
      ${this.renderShare()}
      <p class="ut-mac-view-running">
        ${
          where
            ? t('macSessions.view.runningIn', { app: where })
            : t('macSessions.view.runningElsewhere')
        }
      </p>
      <details class="ut-mac-view-why" data-testid="mac-view-why">
        <summary>${t('macSessions.view.whyTitle')}</summary>
        <p>${this.detail.inTmux ? t('macSessions.cannotOpen.unreachable') : t('macSessions.view.whyBody')}</p>
      </details>
    </div>`;
  }

  render() {
    if (!this.detail) return nothing;
    const { title, cwd, agent } = this.detail;
    const heading = title || basename(cwd) || MAC_AGENT_NAMES[agent] || agent;
    return html`
      <style>
        .ut-mac-view {
          position: fixed;
          inset: 0;
          display: flex;
          flex-direction: column;
          background: var(--color-bg);
          color: var(--color-text);
          padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left);
        }
        .ut-mac-view-bar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding-block: 6px;
          padding-inline: 16px 4px;
          background: var(--color-bg-secondary);
          border-bottom: 1px solid var(--color-border);
        }
        .ut-mac-view-heading {
          flex: 1;
          min-width: 0;
        }
        .ut-mac-view-title {
          font-weight: var(--ut-fw-semibold);
          font-size: 16px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ut-mac-view-where {
          font-size: 12px;
          color: var(--color-text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ut-mac-view-badge {
          flex-shrink: 0;
          font-size: 11px;
          font-weight: var(--ut-fw-semibold);
          padding: 2px 8px;
          border-radius: var(--ut-r-pill);
          color: var(--color-text-muted);
          border: 1px solid var(--color-border);
        }
        .ut-mac-view-close {
          flex-shrink: 0;
          width: 44px;
          height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: var(--ut-r-8);
          color: var(--color-text-muted);
          touch-action: manipulation;
        }
        .ut-mac-view-body {
          position: relative;
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .ut-mac-view-chat {
          flex: 1;
          min-height: 0;
        }
        .ut-mac-view-note,
        .ut-mac-view-gone {
          padding: 32px 16px;
          text-align: center;
          color: var(--color-text-dim);
        }
        .ut-mac-view-gone p {
          margin: 0 0 16px;
        }
        .ut-mac-view-foot {
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding-block: 10px calc(10px + env(safe-area-inset-bottom));
          padding-inline: 16px;
          background: var(--color-bg-secondary);
          border-top: 1px solid var(--color-border);
          font-size: 13px;
        }
        .ut-mac-view-running {
          margin: 0;
          color: var(--color-text-muted);
        }
        .ut-mac-view-why summary {
          min-height: 44px;
          display: flex;
          align-items: center;
          color: var(--color-primary);
          cursor: pointer;
        }
        .ut-mac-view-why p {
          margin: 0 0 4px;
          color: var(--color-text-dim);
        }
        .ut-mac-view-primary {
          align-self: stretch;
          min-height: 44px;
          padding: 0 18px;
          border-radius: var(--ut-r-lg);
          background: var(--color-primary);
          color: var(--color-bg);
          font-weight: var(--ut-fw-semibold);
          font-size: 15px;
          touch-action: manipulation;
        }
        .ut-mac-view-gone .ut-mac-view-primary {
          min-width: 160px;
        }
      </style>
      <div
        class="ut-mac-view"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ut-mac-view-title"
        data-testid="mac-session-view"
        style="z-index: ${Z_INDEX.MODAL};"
      >
        <div class="ut-mac-view-bar">
          <div class="ut-mac-view-heading">
            <div id="ut-mac-view-title" class="ut-mac-view-title"><bdi>${heading}</bdi></div>
            <div class="ut-mac-view-where" data-testid="mac-view-where">${this.renderWhere()}</div>
          </div>
          <span class="ut-mac-view-badge" data-testid="mac-view-read-only"
            >${t('macSessions.view.readOnly')}</span
          >
          <button
            class="ut-mac-view-close"
            aria-label=${t('common.close')}
            title=${t('common.close')}
            data-testid="mac-view-close"
            @pointerdown=${this.closeTap}
            @pointerup=${this.closeTap}
            @click=${this.closeTap}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div class="ut-mac-view-body">${this.renderBody()}</div>
        ${this.renderFooter()}
      </div>
    `;
  }
}

let openSheet: { host: HTMLElement; release: () => void } | null = null;

export function closeMacSessionView(): void {
  if (!openSheet) return;
  const { host, release } = openSheet;
  openSheet = null;
  render(nothing, host);
  host.remove();
  release();
}

/** Open the read-only conversation of a Mac agent or tmux pane (MAC_SESSION_VIEW_EVENT). */
export function openMacSessionView(detail: MacSessionViewDetail): void {
  closeMacSessionView();
  const opener = document.activeElement;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const sheet: { host: HTMLElement; release: () => void } = { host, release: () => {} };
  openSheet = sheet;
  render(
    html`<mac-session-view .detail=${detail} @close=${closeMacSessionView}></mac-session-view>`,
    host
  );
  // The view renders on its next update; hold focus once its dialog exists.
  void host.querySelector<MacSessionView>('mac-session-view')?.updateComplete.then(() => {
    if (openSheet !== sheet) return;
    sheet.release = holdSheetFocus(
      host.querySelector<HTMLElement>('.ut-mac-view'),
      closeMacSessionView,
      opener
    );
  });
}

declare global {
  interface HTMLElementTagNameMap {
    'mac-session-view': MacSessionView;
  }
}
