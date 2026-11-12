/**
 * Live activity of a working Claude ("Editing app.ts · 1m 20s"). The server sends structured
 * data (tool, target, since); the wording lives here so it follows the app language.
 */
import type { Session } from '../../shared/types.js';
import { type MessageKey, t } from '../i18n/index.js';

export type ClaudeActivity = NonNullable<NonNullable<Session['claudeStatus']>['activity']>;

/** [with target, without target] per tool. */
const TOOL_KEYS: Record<string, [MessageKey, MessageKey]> = {
  Bash: ['activity.running', 'activity.runningCommand'],
  Edit: ['activity.editing', 'activity.editingFile'],
  MultiEdit: ['activity.editing', 'activity.editingFile'],
  Write: ['activity.editing', 'activity.editingFile'],
  NotebookEdit: ['activity.editing', 'activity.editingFile'],
  Read: ['activity.reading', 'activity.readingFile'],
  Grep: ['activity.searching', 'activity.searchingFiles'],
  Glob: ['activity.searching', 'activity.searchingFiles'],
  WebFetch: ['activity.browsing', 'activity.browsingWeb'],
  WebSearch: ['activity.browsing', 'activity.browsingWeb'],
  Task: ['activity.agent', 'activity.agentNoTarget'],
  Agent: ['activity.agent', 'activity.agentNoTarget'],
};

/** One short line: "Running: pnpm test", "Reading app.ts", "Thinking…". */
export function formatActivity(activity: ClaudeActivity): string {
  if (activity.kind === 'thinking') return t('activity.thinking');
  if (activity.kind === 'writing') return t('activity.writing');
  const tool = activity.tool ?? '';
  if (tool === 'TodoWrite') return t('activity.todos');
  const keys = TOOL_KEYS[tool];
  if (!keys) {
    // MCP tools are named mcp__server__tool: the last part reads best.
    const name = tool.startsWith('mcp__') ? tool.split('__').pop() || tool : tool;
    return t('activity.using', { tool: name });
  }
  return activity.target ? t(keys[0], { target: activity.target }) : t(keys[1]);
}

/** "45s", "1m 20s", "2h 5m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return t('activity.elapsedHours', { h, m });
  if (m) return t('activity.elapsedMinutes', { m, s });
  return t('activity.elapsedSeconds', { s });
}

/**
 * The same time at a glance's resolution (phone rows and agent cards, 2026-10-12): seconds
 * only in the first minute, then "3 min", then "2h 5m". Nothing on a list ticks every second
 * once it is a minute old (phone-spec 1.1).
 */
export function formatElapsedMinutes(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return t('activity.elapsedSeconds', { s: total });
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h) return t('activity.elapsedHours', { h, m });
  return t('sessions.row.minutes', { n: m });
}

/** A Claude status as the server sends it (an Untether session's or a Mac agent's). */
interface StatusLike {
  status: string;
  waitingForBackground?: boolean;
}

/**
 * Claude's reply is over and only background agents or tasks keep it "busy": it waits for
 * the user, not working on a turn (2026-10-04: "Working…" for an hour after the reply).
 */
export function isBackgroundWait(claude: StatusLike | undefined): boolean {
  return claude?.status === 'busy' && claude.waitingForBackground === true;
}

/** Claude is working on a turn: busy, and not just waiting for background work. */
export function isClaudeWorking(claude: StatusLike | undefined): boolean {
  return claude?.status === 'busy' && !claude.waitingForBackground;
}

/** The activity to show for a session, only while Claude is working in it. */
export function sessionActivity(
  session: Pick<Session, 'claudeStatus' | 'status'>
): ClaudeActivity | undefined {
  const claude = session.claudeStatus;
  return session.status === 'running' && isClaudeWorking(claude) ? claude?.activity : undefined;
}

const ticking = new Set<ActivityElapsed>();
let timer: ReturnType<typeof setInterval> | undefined;

function tick() {
  if (typeof document !== 'undefined' && document.hidden) return;
  for (const element of ticking) element.refresh();
}

function startTimer() {
  if (!timer && ticking.size) timer = setInterval(tick, 1000);
}

function stopTimerIfIdle() {
  if (timer && !ticking.size) {
    clearInterval(timer);
    timer = undefined;
  }
}

/**
 * `<claude-activity-elapsed since="…" label="…">`: the running time of the current step (or
 * any time since, inside `label`'s "{time}"), updated once a second by writing its own text.
 * One shared timer for every instance, paused while the page is hidden, so a long session
 * list never re-renders just to move a clock. With the `minutes` attribute it reads at minute
 * resolution after the first minute (formatElapsedMinutes): the text then changes once a
 * minute.
 */
export class ActivityElapsed extends HTMLElement {
  static get observedAttributes() {
    return ['since', 'label', 'minutes'];
  }

  connectedCallback() {
    this.setAttribute('aria-hidden', 'true');
    this.refresh();
    ticking.add(this);
    startTimer();
  }

  disconnectedCallback() {
    ticking.delete(this);
    stopTimerIfIdle();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.refresh();
  }

  refresh() {
    const since = Number(this.getAttribute('since'));
    // `label` wraps the time in words, e.g. "Idle for {time}" (split/join: no "$" patterns).
    const label = this.getAttribute('label') || '{time}';
    const format = this.hasAttribute('minutes') ? formatElapsedMinutes : formatElapsed;
    const text = since > 0 ? label.split('{time}').join(format(Date.now() - since)) : '';
    if (this.textContent !== text) this.textContent = text;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('claude-activity-elapsed')) {
  customElements.define('claude-activity-elapsed', ActivityElapsed);
}
