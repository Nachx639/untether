/**
 * Mission control (phone, /agents): every running Claude / Codex / Gemini session as a card —
 * what it is doing, for how long, and whether it needs you — plus a broadcast bar to send one
 * instruction to several agents. Cards and sorting come from utils/agent-mission.ts; the data
 * is the session list the app already polls.
 *
 * @fires session-select - A card was tapped outside select mode (detail: Session)
 */
import { html, LitElement, nothing, render } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { sessionProviderMarker } from '../../shared/model-providers.js';
import { sessionTitle } from '../../shared/session-title.js';
import type { Session } from '../../shared/types.js';
import { LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import {
  type AgentCard,
  type BroadcastIo,
  type BroadcastResult,
  broadcast,
  httpBroadcastIo,
  missionCards,
} from '../utils/agent-mission.js';
import {
  formatActivity,
  formatElapsedMinutes,
  isBackgroundWait,
  sessionActivity,
} from '../utils/claude-activity.js';
import { claudeWaitingLabel } from '../utils/claude-waiting-label.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { endsADrag } from '../utils/pointer-drag.js';
import { holdSheetFocus } from '../utils/sheet-a11y.js';
import { agentAvatar } from './agent-avatar.js';
import { icon } from './icons.js';
import { activityLine, folderLabel, type RowState } from './phone-session-row.js';

const LONG_PRESS_MS = 550;
const TAP_SLOP_PX = 10;
/** Clicks this soon after a sheet opens are the tap that opened it, not a choice. */
const SHEET_GUARD_MS = 500;

/**
 * Touch acts on pointerup (iOS can take the first tap on a fresh button as a hover) and the
 * click that follows is swallowed; mouse and keyboard act on click.
 */
/**
 * With every session an agent, "Sessions" and "Agents" list the same ones: a line at the top
 * of Agents says what the tab adds, until dismissed (per device; a cleared storage shows it
 * again, which is harmless).
 */
export const AGENTS_INTRO_DISMISSED_KEY = 'ut-agents-intro-dismissed';

function isAgentsIntroDismissed(): boolean {
  try {
    return localStorage.getItem(AGENTS_INTRO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberAgentsIntroDismissed(): void {
  try {
    localStorage.setItem(AGENTS_INTRO_DISMISSED_KEY, '1');
  } catch {
    // Storage blocked: the line comes back next visit.
  }
}

function tap(fn: (e: Event) => void, guardSince?: () => number) {
  let touchActedAt = 0;
  return {
    handleEvent(e: Event) {
      if (guardSince && Date.now() - guardSince() < SHEET_GUARD_MS) return;
      if (e.type === 'pointerup') {
        const p = e as PointerEvent;
        if (p.pointerType === 'mouse') return;
        // A scroll that started on the button ends here too. Not told by this handler's own
        // pointerdown: a render mid-scroll makes new handlers, and the tabs make one per event.
        if (endsADrag(p)) return;
        touchActedAt = Date.now();
        swallowNextClick();
      } else if (Date.now() - touchActedAt < 700) {
        return;
      }
      fn(e);
    },
  };
}

const KIND_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

/** The row's state dot, as on the Sessions tab (phone-session-row.ts rowState). */
function rowStateOf(card: AgentCard): RowState {
  return card.state;
}

export function cardTitle(session: Session): string {
  return sessionTitle(session) || session.name || session.command?.join(' ') || session.id;
}

/** What the agent is doing now, one line. */
function doingText(card: AgentCard): string {
  const { session, state } = card;
  if (state === 'waiting') {
    const waitingFor = session.claudeStatus?.waitingFor;
    return waitingFor
      ? `${t('sessions.row.needsYou')} · ${claudeWaitingLabel(waitingFor)}`
      : t('sessions.row.needsYou');
  }
  if (state === 'working') {
    const activity = sessionActivity(session);
    return activity ? formatActivity(activity) : t('sessions.row.working');
  }
  if (session.status === 'running' && isBackgroundWait(session.claudeStatus)) {
    return t('activity.backgroundWait');
  }
  return card.since
    ? t('mission.state.idleFor', { time: formatElapsedMinutes(Date.now() - card.since) })
    : t('mission.state.idle');
}

/**
 * An idle card says how long ago it last did something, in words ("Idle for 14h 2m"), not a
 * bare time in the corner: next to the Sessions list's "14 min" that read as a contradiction
 * (2026-10-04, iPhone QA). Both are the same moment now (utils/last-activity.ts).
 */
function idleFor(card: AgentCard): boolean {
  return (
    card.state === 'idle' &&
    Boolean(card.since) &&
    !(card.session.status === 'running' && isBackgroundWait(card.session.claudeStatus))
  );
}

/** Last message (Claude) or last line on screen (Codex / Gemini). */
function previewText(session: Session): string {
  const preview = session.claudeStatus?.preview;
  if (preview) return `${preview.role === 'user' ? t('sessions.row.you') : ''}${preview.text}`;
  return session.lastLine ?? '';
}

/**
 * Mission control's own pieces. The rows are the Sessions tab's (.psr*, list.css); chrome is
 * sans, mono only for the folder and the times (phone-spec 1.7, 2026-10-12).
 */
const STYLES = html`<style>
  agent-mission,
  [data-testid='broadcast-sheet'] {
    font-family: var(--font-ui);
  }
  .vtm-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 44px;
    margin-bottom: 4px;
    font-size: 13px;
    color: var(--color-text-muted);
  }
  .vtm-counts {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vtm-toolbar button {
    flex: none;
    min-height: 44px;
    padding: 0 8px;
    margin-inline-end: -8px;
    color: var(--color-text);
    font-size: 15px;
    font-weight: var(--ut-fw-medium);
  }
  .vtm-list {
    padding-bottom: 12px;
  }
  /* Select mode's rows: the Sessions tab's anatomy with a check. Waiting has no tint of its
     own: the amber dot and status line say it, as on Sessions (QA 2026-10-12). */
  .vtm-slot {
    display: contents;
  }
  .vtm-row.selected {
    background: var(--color-selected);
    box-shadow: var(--ut-piece-raised), inset 3px 0 0 var(--color-primary);
  }
  .vtm-check {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    align-self: center;
    border-radius: var(--ut-r-circle);
    border: 2px solid var(--color-border-light);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-on-fill);
  }
  .vtm-row.selected .vtm-check {
    border-color: var(--color-primary);
    background: var(--color-primary);
  }
  .vtm-intro {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    margin-bottom: 4px;
    color: var(--color-text-muted);
    font-size: 13px;
  }
  /* Read in full, never cut before its point (QA 2026-10-12: "Solo los agentes de IA (Claude,
     Codex, Ge…"): it wraps next to "Entendido", three or four lines at 320-393 pt. */
  .vtm-intro p {
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 4px 0;
    line-height: 18px;
  }
  .vtm-intro button {
    flex: none;
    min-height: 44px;
    padding: 0 8px;
    margin-inline-end: -8px;
    color: var(--color-text);
    font-size: 15px;
    font-weight: var(--ut-fw-medium);
  }
  .vtm-empty {
    padding: 32px 12px;
    text-align: center;
    color: var(--color-text-muted);
    font-size: 15px;
  }
  .vtm-bar {
    position: sticky;
    bottom: 0;
    margin: 0 -4px;
    padding: 10px 4px calc(10px + env(safe-area-inset-bottom, 0px));
    background: var(--color-bg);
    border-top: 1px solid var(--color-border-light);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .vtm-chips {
    display: flex;
    gap: 8px;
    overflow-x: auto;
  }
  .vtm-chips button {
    flex-shrink: 0;
    min-height: 36px;
    padding: 0 14px;
    border-radius: var(--ut-r-pill);
    font-size: 15px;
    color: var(--color-text);
    background: var(--color-bg-tertiary);
  }
  .vtm-send-row {
    display: flex;
    gap: 8px;
  }
  .vtm-send-row input {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    font-size: 16px;
    padding: 9px 12px;
    border-radius: var(--ut-r-lg);
    border: 1px solid var(--color-border-light);
    background: var(--color-surface);
    color: var(--color-text);
  }
  .vtm-send-row button {
    flex-shrink: 0;
    min-height: 44px;
    padding: 0 16px;
    border-radius: var(--ut-r-lg);
    font-weight: var(--ut-fw-semibold);
    background: var(--color-primary);
    color: var(--color-on-fill);
  }
  .vtm-send-row button:disabled {
    background: var(--color-bg-tertiary);
    color: var(--color-text-dim);
  }
  .vtm-sheet-list {
    max-height: 45vh;
    overflow-y: auto;
  }
  .vtm-sheet-row {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 10px 16px;
    font-size: 15px;
    color: var(--color-text);
    border-top: 1px solid var(--color-border-light);
  }
  .vtm-sheet-row .vtm-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--ut-fw-medium);
  }
  .vtm-sheet-row .vtm-note {
    flex-shrink: 0;
    font-size: 13px;
    color: var(--color-text-muted);
  }
  .vtm-sheet-row .vtm-note.sent {
    color: var(--color-status-success-text, var(--color-status-success));
  }
  .vtm-sheet-row .vtm-note.blocked,
  .vtm-sheet-row .vtm-note.exited {
    color: var(--color-attention-text);
  }
  .vtm-sheet-row .vtm-note.failed {
    color: var(--color-status-error-text, var(--color-status-error));
  }
  .psr-sheet-group button.vtm-confirm {
    font-weight: var(--ut-fw-semibold);
  }
</style>`;

@customElement('agent-mission')
export class AgentMission extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Array }) sessions: Session[] = [];
  @property({ type: Object }) authClient?: AuthClient;
  /** Tests replace the HTTP calls. */
  @property({ attribute: false }) io?: BroadcastIo;
  /**
   * The Sessions tab's row for a session (session-list.ts renderPhoneRow): with it, Agents
   * shows the very same rows — ⋯, long-press sheet, swipes, inline answers, Responder — and
   * keeps its own cards only for select mode. Without it (tests, no list), its own cards.
   */
  @property({ attribute: false }) renderRow?: (session: Session) => unknown;
  /** See missionStamp(): sessions change in place between polls. */
  @property({ type: String }) stamp = '';
  /** The line saying what this tab is for: shown until dismissed, once per device. */
  @state() private introDismissed = isAgentsIntroDismissed();
  @state() private selecting = false;
  @state() private selected = new Set<string>();
  @state() private draft = '';
  protected readonly i18n = new LocaleController(this);

  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private pressStart: { x: number; y: number } | null = null;
  private longPressed = false;
  private touchActedAt = 0;
  private sheetHost: HTMLElement | null = null;
  private releaseSheetFocus: (() => void) | null = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    this.closeSheet();
    this.cancelPress();
  }

  private toggle(sessionId: string) {
    const next = new Set(this.selected);
    if (!next.delete(sessionId)) next.add(sessionId);
    this.selected = next;
  }

  private setSelecting(on: boolean) {
    this.selecting = on;
    if (!on) this.selected = new Set();
  }

  private openSession(session: Session) {
    this.dispatchEvent(
      new CustomEvent('session-select', { detail: session, bubbles: true, composed: true })
    );
  }

  private activate(card: AgentCard) {
    if (this.selecting) this.toggle(card.session.id);
    else this.openSession(card.session);
  }

  private cancelPress() {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  private cardEvents(card: AgentCard) {
    return {
      handleEvent: (e: Event) => {
        const p = e as PointerEvent;
        switch (e.type) {
          case 'pointerdown':
            this.longPressed = false;
            this.pressStart = { x: p.clientX, y: p.clientY };
            this.cancelPress();
            if (p.pointerType !== 'mouse') {
              this.pressTimer = setTimeout(() => {
                this.pressTimer = null;
                this.longPressed = true;
                this.selecting = true;
                if (!this.selected.has(card.session.id)) this.toggle(card.session.id);
                navigator.vibrate?.(10);
              }, LONG_PRESS_MS);
            }
            return;
          case 'pointermove':
            if (
              this.pressStart &&
              Math.hypot(p.clientX - this.pressStart.x, p.clientY - this.pressStart.y) > TAP_SLOP_PX
            ) {
              this.cancelPress();
              this.pressStart = null;
            }
            return;
          case 'pointercancel':
            this.cancelPress();
            this.pressStart = null;
            return;
          case 'pointerup': {
            this.cancelPress();
            if (p.pointerType === 'mouse') return;
            const wasTap = this.pressStart !== null;
            this.pressStart = null;
            if (this.longPressed) {
              this.longPressed = false;
              this.touchActedAt = Date.now();
              swallowNextClick();
              return;
            }
            if (!wasTap) return;
            this.touchActedAt = Date.now();
            swallowNextClick();
            this.activate(card);
            return;
          }
          case 'click':
            if (Date.now() - this.touchActedAt < 700) return;
            this.activate(card);
            return;
          case 'keydown': {
            const key = (e as KeyboardEvent).key;
            if (key === 'Enter' || key === ' ') {
              e.preventDefault();
              this.activate(card);
            }
            return;
          }
          case 'contextmenu':
            e.preventDefault();
            return;
        }
      },
    };
  }

  /**
   * One agent as a Sessions row (phone-session-row.ts anatomy, 2026-10-12): avatar and dot,
   * title and time, "folder · branch", one status line; "Te necesita · …" opens the reply
   * sheet. Used in select mode (with a check), and wherever no renderRow is given.
   */
  private renderCard(card: AgentCard) {
    const { session, kind, state } = card;
    const selected = this.selected.has(session.id);
    const events = this.cardEvents(card);
    const title = cardTitle(session);
    const doing = doingText(card);
    const preview = previewText(session);
    const label = [KIND_NAMES[kind], title, doing, preview].filter(Boolean).join(', ');
    const folder = folderLabel(session.workingDir);
    const branch = typeof session.gitBranch === 'string' ? session.gitBranch : '';
    const activity = state === 'working' ? sessionActivity(session) : undefined;
    return html`
      <div
        class="psr vtm-row vtm-card ut-surface--material ${state} ${selected ? 'selected' : ''}"
        data-testid="agent-card"
        data-session-id=${session.id}
        data-state=${state}
        data-kind=${kind}
        role=${this.selecting ? 'checkbox' : 'button'}
        aria-checked=${this.selecting ? (selected ? 'true' : 'false') : nothing}
        aria-label=${label}
        tabindex="0"
        @pointerdown=${events}
        @pointermove=${events}
        @pointerup=${events}
        @pointercancel=${events}
        @click=${events}
        @keydown=${events}
        @contextmenu=${events}
      >
        ${this.selecting ? html`<span class="vtm-check" aria-hidden="true">${selected ? icon('check', 14) : nothing}</span>` : nothing}
        ${agentAvatar({ variant: 'row', kind, state: rowStateOf(card), provider: sessionProviderMarker(session) })}
        <div class="psr-body">
          <div class="psr-main">
            <div class="psr-top">
              <span class="psr-title vtm-name"><bdi>${title}</bdi></span>
              ${
                !card.since
                  ? nothing
                  : idleFor(card)
                    ? html`<span class="psr-time"
                        ><ut-row-time at=${new Date(card.since).toISOString()}></ut-row-time
                      ></span>`
                    : html`<span class="psr-time ${state === 'waiting' ? 'psr-time-alert' : ''}"
                        ><claude-activity-elapsed class="vtm-elapsed" minutes since=${card.since}></claude-activity-elapsed
                      ></span>`
              }
            </div>
            ${
              folder || branch
                ? html`<div class="psr-caption">
                    <span class="psr-where ut-data vtm-folder" dir="ltr">${[folder, branch].filter(Boolean).join(' · ')}</span>
                  </div>`
                : nothing
            }
            ${
              state === 'waiting' && !this.selecting
                ? nothing
                : html`<div class="psr-preview psr-status vtm-doing" data-testid="agent-doing"><bdi>${
                    state === 'working'
                      ? html`<span class="psr-working">${activity ? activityLine(activity) : doing}</span>`
                      : state === 'waiting'
                        ? html`<span class="psr-needs-text">${doing}</span>`
                        : idleFor(card)
                          ? preview || doing
                          : doing
                  }</bdi></div>`
            }
          </div>
          ${state === 'waiting' && !this.selecting ? this.renderNeeds(session, doing) : nothing}
        </div>
      </div>
    `;
  }

  /**
   * "Needs you · Permission request ›" opens the answer sheet (app.ts), as in the Sessions
   * list; the rest of the row opens the session. It acts on pointerup like the row, and the
   * click that follows is swallowed so the row doesn't open the session too; a mouse uses the
   * click.
   */
  private renderNeeds(session: Session, doing: string) {
    let touchedAt = 0;
    const open = () =>
      window.dispatchEvent(
        new CustomEvent('ut-open-answer-sheet', { detail: { sessionId: session.id } })
      );
    return html`<div
      class="psr-needs psr-needs-btn vtm-needs"
      data-testid="agent-doing"
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @pointerup=${(e: PointerEvent) => {
        e.stopPropagation();
        if (e.pointerType === 'mouse') return;
        // A scroll of the list that started on it ends here too: not a tap.
        if (endsADrag(e)) return;
        touchedAt = Date.now();
        swallowNextClick();
        open();
      }}
      @click=${(e: Event) => {
        e.stopPropagation();
        if (Date.now() - touchedAt < 700) return;
        open();
      }}
    ><span class="psr-needs-text"><bdi>${doing}</bdi></span>${icon('chevronRight', 16)}</div>`;
  }

  private targets(cards: AgentCard[]): AgentCard[] {
    return cards.filter((card) => this.selected.has(card.session.id));
  }

  private renderBar(cards: AgentCard[]) {
    const count = this.targets(cards).length;
    if (!this.selecting) return nothing;
    const quick = [t('mission.quick.continue'), t('mission.quick.tests')];
    const ask = (text: string) => tap(() => this.confirmBroadcast(text));
    const send = ask(this.draft);
    return html`
      <div class="vtm-bar ut-surface--panel ut-surface--material" data-testid="broadcast-bar">
        <div class="vtm-chips">
          ${quick.map((text) => {
            const handler = ask(text);
            return html`<button
              data-testid="broadcast-chip"
              ?disabled=${!count}
              @pointerup=${handler}
              @click=${handler}
            >${text}</button>`;
          })}
        </div>
        <div class="vtm-send-row">
          <input
            type="text"
            enterkeyhint="send"
            data-testid="broadcast-input"
            placeholder=${t('mission.placeholder')}
            aria-label=${t('mission.placeholder')}
            .value=${this.draft}
            @input=${(e: Event) => {
              this.draft = (e.target as HTMLInputElement).value;
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                this.confirmBroadcast(this.draft);
              }
            }}
          />
          <button
            data-testid="broadcast-send"
            ?disabled=${!count || !this.draft.trim()}
            @pointerup=${send}
            @click=${send}
          >
            ${t('mission.send', { n: count })}
          </button>
        </div>
      </div>
    `;
  }

  render() {
    const cards = missionCards(this.sessions);
    const counts = { waiting: 0, working: 0, idle: 0 };
    for (const card of cards) counts[card.state]++;
    const toggleSelect = tap(() => this.setSelecting(!this.selecting));
    const selectAll = tap(() => {
      this.selected = new Set(cards.map((card) => card.session.id));
    });
    const dismissIntro = tap(() => {
      rememberAgentsIntroDismissed();
      this.introDismissed = true;
    });
    return html`
      ${STYLES}
      <div data-testid="agent-mission">
        ${
          this.introDismissed
            ? nothing
            : html`<div class="vtm-intro ut-surface--panel ut-surface--material" data-testid="agents-intro">
                <p>${t('mission.intro')}</p>
                <button data-testid="agents-intro-dismiss" @pointerup=${dismissIntro}
                  @click=${dismissIntro}>${t('mission.introDismiss')}</button>
              </div>`
        }
        ${
          cards.length
            ? html`
              <div class="vtm-toolbar">
                <span class="vtm-counts" data-testid="mission-counts">${
                  this.selecting
                    ? t('mission.selected', { n: this.targets(cards).length })
                    : [
                        t('mission.waitingCount', { n: counts.waiting }),
                        t('mission.workingCount', { n: counts.working }),
                      ].join(' · ')
                }</span>
                <span>
                  ${
                    this.selecting
                      ? html`<button data-testid="mission-select-all" @pointerup=${selectAll}
                          @click=${selectAll}>${t('mission.selectAll')}</button>`
                      : nothing
                  }
                  <button data-testid="mission-select" @pointerup=${toggleSelect}
                    @click=${toggleSelect}>
                    ${this.selecting ? t('mission.done') : t('mission.select')}
                  </button>
                </span>
              </div>
              <div class="psr-list vtm-list" data-testid="agent-cards">
                ${repeat(
                  cards,
                  (card) => card.session.id,
                  (card) =>
                    this.renderRow && !this.selecting
                      ? html`<div
                          class="vtm-slot"
                          data-testid="agent-card"
                          data-session-id=${card.session.id}
                          data-state=${card.state}
                          data-kind=${card.kind}
                        >${this.renderRow(card.session)}</div>`
                      : this.renderCard(card)
                )}
              </div>
              ${this.renderBar(cards)}
            `
            : html`<div class="vtm-empty ut-surface--panel ut-surface--material" data-testid="mission-empty">${t('mission.empty')}</div>`
        }
      </div>
    `;
  }

  // --- Confirmation / results sheet (rendered in <body>, like the other phone sheets) ------

  private closeSheet = () => {
    if (!this.sheetHost) return;
    render(nothing, this.sheetHost);
    this.sheetHost.remove();
    this.sheetHost = null;
    this.releaseSheetFocus?.();
    this.releaseSheetFocus = null;
  };

  private confirmBroadcast(rawText: string) {
    const text = rawText.trim();
    const targets = this.targets(missionCards(this.sessions));
    if (!text || !targets.length || this.sheetHost) return;
    const host = document.createElement('div');
    host.dataset.testid = 'broadcast-sheet';
    document.body.appendChild(host);
    this.sheetHost = host;
    const openedAt = Date.now();
    let results: BroadcastResult[] | null = null;
    let sending = false;
    const since = () => openedAt;

    const run = async () => {
      if (sending || results) return;
      sending = true;
      draw();
      const io =
        this.io ?? httpBroadcastIo(() => (this.authClient ? this.authClient.getAuthHeader() : {}));
      try {
        results = await broadcast(targets, text, io);
      } finally {
        sending = false;
      }
      if (results.some((result) => result.outcome === 'sent')) this.draft = '';
      draw();
    };

    const note = (card: AgentCard) => {
      const result = results?.find((r) => r.sessionId === card.session.id);
      if (result) {
        const words = {
          sent: t('mission.result.sent'),
          blocked: t('mission.result.blocked'),
          exited: t('mission.result.exited'),
          failed: t('mission.result.failed', { error: result.error ?? '' }),
          watchOnly: t('mission.result.watchOnly'),
        };
        return html`<span class="vtm-note ${result.outcome}" data-testid="broadcast-result"
          data-outcome=${result.outcome}>${words[result.outcome]}</span>`;
      }
      return card.session.claudeStatus?.choices || card.session.agentStatus?.choices
        ? html`<span class="vtm-note blocked">${t('mission.result.blocked')}</span>`
        : nothing;
    };

    const draw = () => {
      if (this.sheetHost !== host) return;
      const sent = results?.filter((r) => r.outcome === 'sent').length ?? 0;
      const confirm = tap(() => void run(), since);
      const close = tap(() => this.closeSheet(), since);
      render(
        html`
          <div class="psr-sheet-backdrop" @click=${() => {
            if (!sending && Date.now() - openedAt > SHEET_GUARD_MS) this.closeSheet();
          }}></div>
          <div class="psr-sheet" role="dialog" aria-modal="true" aria-label=${t('mission.confirmTitle', { text, n: targets.length })}>
            <div class="psr-sheet-group ut-surface--floating ut-surface--material">
              <div class="psr-sheet-title question" data-testid="broadcast-title">${
                results
                  ? t('mission.resultsTitle', { sent, n: targets.length })
                  : t('mission.confirmTitle', { text, n: targets.length })
              }</div>
              <div class="vtm-sheet-list">
                ${targets.map(
                  (card) => html`<div class="vtm-sheet-row" data-testid="broadcast-target"
                    data-session-id=${card.session.id}>
                    <span class="vtm-name"><bdi>${cardTitle(card.session)}</bdi></span>
                    ${note(card)}
                  </div>`
                )}
              </div>
              ${
                results
                  ? nothing
                  : html`<button class="ut-surface--badge vtm-confirm" data-testid="broadcast-confirm" ?disabled=${sending}
                      @pointerup=${confirm} @click=${confirm}>
                      ${sending ? t('mission.sending') : t('mission.confirm')}
                    </button>`
              }
            </div>
            <button class="psr-sheet-cancel ut-surface--floating ut-surface--material" data-testid="broadcast-close" ?disabled=${sending}
              @pointerup=${close} @click=${close}>
              ${results ? t('common.close') : t('common.cancel')}
            </button>
          </div>
          ${STYLES}
        `,
        host
      );
    };

    draw();
    this.releaseSheetFocus = holdSheetFocus(host.querySelector<HTMLElement>('.psr-sheet'), () => {
      if (!sending) this.closeSheet();
    });
    requestAnimationFrame(() => host.querySelector('.psr-sheet')?.classList.add('open'));
  }
}
