/**
 * "While you were away": a compact card at the top of an agent session (Claude, Codex,
 * Gemini) that worked while the user wasn't looking — files it edited, commands it ran,
 * errors, its last message and what it is doing now. Built by the server from the
 * transcript (no model call). Shows only after an absence of a couple of minutes with real
 * activity; dismissing it hides it until there is new activity.
 */
import { css, html, LitElement, nothing, type PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import { authClient } from '../services/auth-client.js';
import { a11yBaseStyles } from '../utils/a11y-base-styles.js';
import {
  AWAY_MIN_MS,
  dismissedActivity,
  lastSeen,
  markDismissed,
  markSeen,
  shouldShowAway,
} from '../utils/away-seen.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { materialControlStyles, materialSurfaceStyles } from '../utils/material-surface-styles.js';
import { reducedMotionStyles } from '../utils/reduced-motion.js';
import { sessionTool } from './phone-session-row.js';
import { openChangesSheet } from './session-view/changes-sheet.js';

export interface AwaySummaryData {
  available: boolean;
  agent?: string;
  since?: string;
  lastActivityAt?: string;
  toolCalls: number;
  messages: number;
  files: Array<{ path: string; edits: number }>;
  commands: Array<{ command: string; isError?: boolean; exitCode?: number; pending?: boolean }>;
  errors: Array<{ tool: string; target?: string; text: string }>;
  lastMessage?: string;
  status: 'working' | 'waiting' | 'done' | 'unknown';
  partial?: boolean;
}

/** While shown, the card refreshes "Now: …" this often. */
const REFRESH_MS = 15_000;
/** While the session is on screen, "last seen" moves forward this often. */
const HEARTBEAT_MS = 30_000;
const TAP_SLOP_PX = 10;
const LIST_MAX = 8;
const AGENTS = new Set(['claude', 'codex', 'gemini']);

export function isAgentSession(session: Session | null): boolean {
  if (session?.status !== 'running') return false;
  return Boolean(session.claudeStatus) || AGENTS.has(sessionTool(session));
}

function agoText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return t('away.agoMinutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('away.agoHours', { n: hours });
  return t('away.agoDays', { n: Math.round(hours / 24) });
}

const counted = (count: number, one: Parameters<typeof t>[0], many: Parameters<typeof t>[0]) =>
  count === 1 ? t(one) : t(many, { count });

/** "edited 4 files · ran 6 commands · 1 error · 3 messages" (exported for tests). */
export function awayCounts(summary: AwaySummaryData): string {
  const parts: string[] = [];
  if (summary.files.length) {
    parts.push(counted(summary.files.length, 'away.filesOne', 'away.filesMany'));
  }
  if (summary.commands.length) {
    parts.push(counted(summary.commands.length, 'away.commandsOne', 'away.commandsMany'));
  }
  const otherTools =
    summary.toolCalls -
    summary.commands.length -
    summary.files.reduce((sum, file) => sum + file.edits, 0);
  if (!summary.files.length && !summary.commands.length && otherTools > 0) {
    parts.push(counted(summary.toolCalls, 'away.toolsOne', 'away.toolsMany'));
  }
  if (summary.errors.length) {
    parts.push(counted(summary.errors.length, 'away.errorsOne', 'away.errorsMany'));
  }
  if (summary.messages) {
    parts.push(counted(summary.messages, 'away.messagesOne', 'away.messagesMany'));
  }
  return parts.join(' · ');
}

function splitPath(path: string): [string, string] {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? ['', path] : [path.slice(0, slash + 1), path.slice(slash + 1)];
}

@customElement('away-summary-card')
export class AwaySummaryCard extends LitElement {
  static styles = [
    materialSurfaceStyles,
    reducedMotionStyles,
    a11yBaseStyles,
    css`
    :host {
      display: block;
      pointer-events: none;
    }
    .card {
      pointer-events: auto;
      background: var(--color-bg-elevated);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-left: 3px solid var(--color-primary);
      border-radius: var(--ut-r-12);
      box-shadow: var(--ut-glow-6-24) color-mix(in srgb, var(--color-bg) 60%, transparent);
      font-size: 13px;
      line-height: 1.35;
      max-height: 60vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .head {
      display: flex;
      align-items: flex-start;
    }
    button {
      font: inherit;
      color: inherit;
      background: var(--ut-piece-control-fill, none);
      border: 0;
      margin: 0;
      text-align: start;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .summary {
      flex: 1;
      min-width: 0;
      padding: 10px 4px 10px 12px;
    }
    .title {
      font-weight: var(--ut-fw-semibold);
      color: var(--color-text-bright);
    }
    .counts {
      color: var(--color-text);
      margin-top: 2px;
    }
    .now {
      color: var(--color-text-muted);
      margin-top: 2px;
    }
    .now b {
      font-weight: var(--ut-fw-semibold);
      color: var(--color-primary-text);
    }
    .now b.waiting {
      color: var(--color-status-warning-text, var(--color-status-warning));
    }
    .chev {
      display: inline-block;
      margin-inline-start: 4px;
      color: var(--color-text-dim);
      transition: transform 0.15s;
    }
    .chev.open {
      transform: rotate(90deg);
    }
    .close {
      flex: none;
      width: 44px;
      height: 44px;
      font-size: 20px;
      color: var(--color-text-muted);
      display: grid;
      place-items: center;
    }
    .details {
      overflow-y: auto;
      overscroll-behavior: contain;
      border-top: 1px solid var(--color-border-light);
      padding: 6px 12px 10px;
    }
    h4 {
      margin: 8px 0 4px;
      font-size: 11px;
      font-weight: var(--ut-fw-semibold);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--color-text-dim);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      padding: 3px 0;
      display: flex;
      gap: 6px;
      align-items: baseline;
      min-width: 0;
    }
    .file {
      width: 100%;
      display: flex;
      gap: 6px;
      align-items: baseline;
      padding: 6px 0;
      min-height: 32px;
    }
    .path {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: ltr;
      text-align: start;
    }
    .dir {
      color: var(--color-text-dim);
    }
    .base {
      color: var(--color-primary-text);
    }
    .n {
      flex: none;
      color: var(--color-text-muted);
      font-variant-numeric: tabular-nums;
    }
    code {
      flex: 1;
      min-width: 0;
      font-family: var(--ut-font-mono-system);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: ltr;
    }
    .mark {
      flex: none;
      width: 1.2em;
      text-align: center;
    }
    .bad {
      color: var(--color-status-error-text);
    }
    .ok {
      color: var(--color-status-success-text);
    }
    .err {
      color: var(--color-status-error-text);
      word-break: break-word;
    }
    .more,
    .partial {
      color: var(--color-text-dim);
      font-size: 12px;
    }
    .msg {
      margin: 0;
      color: var(--color-text);
      white-space: pre-wrap;
      word-break: break-word;
    }
  `,
    materialControlStyles,
  ];

  protected readonly i18n = new LocaleController(this);

  @property({ type: Object }) session: Session | null = null;

  @state() private summary: AwaySummaryData | null = null;
  @state() private expanded = false;
  /** Start of the absence the card covers (epoch ms). */
  @state() private since = 0;

  private sessionId: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private refresher: ReturnType<typeof setInterval> | null = null;
  private fetchSeq = 0;
  private down: { x: number; y: number } | null = null;
  private touchActedAt = 0;

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.heartbeat = setInterval(() => {
      if (this.sessionId && document.visibilityState === 'visible') markSeen(this.sessionId);
    }, HEARTBEAT_MS);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.leave();
  }

  protected willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has('session')) return;
    const id = this.session && isAgentSession(this.session) ? this.session.id : null;
    if (id === this.sessionId) return;
    this.leave();
    this.sessionId = id;
    if (id) void this.check();
  }

  /** The user stops looking at the current session: remember when, drop the card. */
  private leave(): void {
    if (this.sessionId) markSeen(this.sessionId);
    this.fetchSeq++;
    this.summary = null;
    this.expanded = false;
    this.stopRefresh();
  }

  private onVisibility = () => {
    if (!this.sessionId) return;
    if (document.visibilityState === 'hidden') {
      markSeen(this.sessionId);
    } else if (!this.summary) {
      // Back from the lock screen or another app: maybe the agent worked meanwhile.
      void this.check();
    }
  };

  /** Show the card when the agent did something since this session was last on screen. */
  async check(): Promise<void> {
    const id = this.sessionId;
    if (!id) return;
    const since = lastSeen(id);
    const now = Date.now();
    markSeen(id, now);
    if (since === undefined || now - since < AWAY_MIN_MS) return;
    const summary = await this.fetchSummary(id, since);
    if (!summary || id !== this.sessionId) return;
    if (!shouldShowAway(summary, { since, now, dismissed: dismissedActivity(id) })) return;
    this.since = since;
    this.summary = summary;
    this.startRefresh();
  }

  private async fetchSummary(id: string, since: number): Promise<AwaySummaryData | null> {
    const seq = ++this.fetchSeq;
    try {
      const params = new URLSearchParams({ since: new Date(since).toISOString() });
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(id)}/away-summary?${params.toString()}`,
        { headers: authClient.getAuthHeader() }
      );
      if (!res.ok || seq !== this.fetchSeq) return null;
      return (await res.json()) as AwaySummaryData;
    } catch {
      return null;
    }
  }

  private startRefresh(): void {
    this.stopRefresh();
    this.refresher = setInterval(async () => {
      const id = this.sessionId;
      if (!id || !this.summary || document.visibilityState !== 'visible') return;
      const fresh = await this.fetchSummary(id, this.since);
      if (fresh?.available && this.summary && id === this.sessionId) this.summary = fresh;
    }, REFRESH_MS);
  }

  private stopRefresh(): void {
    if (this.refresher) clearInterval(this.refresher);
    this.refresher = null;
  }

  private dismiss(): void {
    if (this.sessionId) {
      markDismissed(this.sessionId, this.summary?.lastActivityAt);
      markSeen(this.sessionId);
    }
    this.fetchSeq++;
    this.summary = null;
    this.expanded = false;
    this.stopRefresh();
  }

  private openFile(path: string): void {
    const dir = this.session?.workingDir || this.session?.gitRepoPath;
    if (dir) openChangesSheet(dir, { file: path, sessionId: this.session?.id });
  }

  /**
   * Touch acts on pointerup (iOS may eat the first tap on fresh buttons as a hover) and the
   * click that follows is swallowed; mouse and keyboard use the click.
   */
  private tap(fn: () => void) {
    return {
      handleEvent: (e: Event) => {
        if (e.type === 'pointerdown') {
          const p = e as PointerEvent;
          this.down = { x: p.clientX, y: p.clientY };
          return;
        }
        if (e.type === 'pointerup') {
          const p = e as PointerEvent;
          if (p.pointerType === 'mouse') return;
          const start = this.down;
          this.down = null;
          if (start && Math.hypot(p.clientX - start.x, p.clientY - start.y) > TAP_SLOP_PX) return;
          this.touchActedAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.touchActedAt < 700) {
          return;
        }
        fn();
      },
    };
  }

  private renderList<T>(items: T[], row: (item: T) => unknown) {
    const shown = items.slice(-LIST_MAX);
    return html`<ul>
      ${shown.map((item) => html`<li>${row(item)}</li>`)}
      ${
        items.length > shown.length
          ? html`<li class="more">${t('away.more', { count: items.length - shown.length })}</li>`
          : nothing
      }
    </ul>`;
  }

  private renderDetails(summary: AwaySummaryData) {
    const files = summary.files.slice(0, LIST_MAX);
    return html`<div class="details" data-testid="away-details">
      ${
        summary.files.length
          ? html`<h4>${t('away.files')}</h4>
            <ul>
              ${files.map((file) => {
                const [dir, base] = splitPath(file.path);
                const open = this.tap(() => this.openFile(file.path));
                return html`<li>
                  <button
                    class="ut-surface--control file"
                    data-testid="away-file"
                    @pointerdown=${open}
                    @pointerup=${open}
                    @click=${open}
                  >
                    <span class="path"><span class="dir">${dir}</span><span class="base">${base}</span></span>
                    <span class="n">×${file.edits}</span>
                  </button>
                </li>`;
              })}
              ${
                summary.files.length > files.length
                  ? html`<li class="more">
                      ${t('away.more', { count: summary.files.length - files.length })}
                    </li>`
                  : nothing
              }
            </ul>`
          : nothing
      }
      ${
        summary.commands.length
          ? html`<h4>${t('away.commands')}</h4>
            ${this.renderList(
              summary.commands,
              (command) => html`<span
                  class="mark ${command.isError ? 'bad' : command.pending ? '' : 'ok'}"
                  >${command.isError ? '✗' : command.pending ? '…' : '✓'}</span
                ><code>${command.command}</code>${
                  command.isError && command.exitCode !== undefined
                    ? html`<span class="n bad">${t('away.exitCode', { code: command.exitCode })}</span>`
                    : command.pending
                      ? html`<span class="n">${t('away.running')}</span>`
                      : nothing
                }`
            )}`
          : nothing
      }
      ${
        summary.errors.length
          ? html`<h4>${t('away.errors')}</h4>
            ${this.renderList(
              summary.errors,
              (error) => html`<span class="mark bad">!</span><span class="err"
                  >${error.tool}${error.target ? ` · ${error.target}` : ''}: ${error.text}</span
                >`
            )}`
          : nothing
      }
      ${
        summary.lastMessage
          ? html`<h4>${t('away.lastMessage')}</h4>
            <p class="msg">${summary.lastMessage}</p>`
          : nothing
      }
      ${summary.partial ? html`<p class="partial">${t('away.partial')}</p>` : nothing}
    </div>`;
  }

  render() {
    const summary = this.summary;
    if (!summary) return nothing;
    const status =
      summary.status === 'unknown' ? undefined : t(`away.status.${summary.status}` as const);
    const toggle = this.tap(() => {
      this.expanded = !this.expanded;
    });
    const close = this.tap(() => this.dismiss());
    return html`<section
      class="ut-surface--panel card"
      data-testid="away-card"
      role="region"
      aria-label=${t('away.titleShort')}
    >
      <div class="head">
        <button
          class="ut-surface--control ut-surface--compact summary"
          data-testid="away-toggle"
          aria-expanded=${this.expanded ? 'true' : 'false'}
          @pointerdown=${toggle}
          @pointerup=${toggle}
          @click=${toggle}
        >
          <div class="title">
            ${t('away.title', { ago: agoText(Date.now() - this.since) })}<span
              class="chev ${this.expanded ? 'open' : ''}"
              aria-hidden="true"
              >›</span
            >
          </div>
          <div class="counts" data-testid="away-counts">${awayCounts(summary)}</div>
          ${
            status
              ? html`<div class="now">
                  ${t('away.now')} <b class=${summary.status}>${status}</b>
                </div>`
              : nothing
          }
        </button>
        <button
          class="ut-surface--control ut-surface--compact close"
          data-testid="away-dismiss"
          aria-label=${t('away.dismiss')}
          title=${t('away.dismiss')}
          @pointerdown=${close}
          @pointerup=${close}
          @click=${close}
        >
          ×
        </button>
      </div>
      ${this.expanded ? this.renderDetails(summary) : nothing}
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'away-summary-card': AwaySummaryCard;
  }
}
