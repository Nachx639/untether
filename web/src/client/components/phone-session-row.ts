/**
 * Phone Session Row
 *
 * One session as a chat-list row (phone-spec 3.1, 2026-10-12): a neutral 40 px avatar with the
 * program's glyph and one state dot, the title and time, a caption ("folder · branch", mono),
 * and one status line: what the agent is doing, that it needs you (a button opening the reply
 * sheet), its last message, or a shell's last line of output. Exceptions only as flags (not
 * shielded, pinned, muted). Used by session-list on phones instead of the large
 * terminal-preview cards; the Agents tab draws the same anatomy (agent-mission.ts).
 *
 * Swipe left reveals Más (the action sheet) and Cerrar (still confirmed); swipe right Fijar /
 * Desfijar, and a full swipe right on a waiting row opens the reply sheet.
 * Long-press (or the ⋯ button) opens actions (utils/phone-action-sheet.ts): kill a running
 * session (after a confirmation step) or clear an exited one. A session attached to a tmux
 * session outside Untether says Disconnect instead: ending it leaves the tmux session running.
 * A session opened with ut in a terminal window shows that window's app ("On the Mac ·
 * Terminal").
 *
 * @fires session-select - When the row is tapped (detail: Session)
 * @fires session-killed - When the session was killed or cleared (detail: { sessionId, session })
 * @fires session-kill-error - When killing failed (detail: { sessionId, error })
 * @fires session-pin-toggle - Pin/Unpin from the action sheet (detail: { sessionId, pinned })
 */

import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  isDeclineOption,
  promptKind,
  shortPromptLabel,
  translatePromptOption,
} from '../../shared/claude-prompt-text.js';
import { compactDetail } from '../../shared/claude-screen.js';
import { sessionProviderMarker } from '../../shared/model-providers.js';
import { isGeneratedSessionName, sessionTitle } from '../../shared/session-title.js';
import type { Session } from '../../shared/types.js';
import { getLocale, LocaleController, t } from '../i18n/index.js';
import type { AuthClient } from '../services/auth-client.js';
import { sessionActionService } from '../services/session-action-service.js';
import { toast } from '../utils/action-toast.js';
import { explainLine, midCutTitle } from '../utils/card-line.js';
import {
  type ClaudeActivity,
  formatActivity,
  isBackgroundWait,
  sessionActivity,
} from '../utils/claude-activity.js';
import { resumableAgent, resumeSession } from '../utils/claude-resume.js';
import { claudeWaitingLabel } from '../utils/claude-waiting-label.js';
import { swallowNextClick } from '../utils/ghost-click.js';
import { lastActivityAt } from '../utils/last-activity.js';
import {
  announceMacSessionsChanged,
  isAttachedTmuxSession,
  macWindowKillNote,
  macWindowLabel,
  macWindowMarkerLabel,
} from '../utils/mac-sessions.js';
import { formatPathForDisplay } from '../utils/path-utils.js';
import {
  type ActionSheetItem,
  actionItems,
  PhoneActionSheet,
} from '../utils/phone-action-sheet.js';
import { endsADrag } from '../utils/pointer-drag.js';
import type { GroupMenu } from '../utils/project-groups.js';
import { setSessionMuted, setSessionUserTitle } from '../utils/session-actions.js';
import { applyGroupPin, groupPinItems } from '../utils/session-group-pin.js';
import { relativeTime } from '../utils/session-status.js';
import {
  canKeepAwake,
  canSuspend,
  isFinishedSession,
  setKeepAwake,
  suspendedAt,
  suspendWithFeedback,
} from '../utils/session-suspend.js';
import { resetTitleLabel, visibleSessionTitle } from '../utils/session-title.js';
import { waitingChoices, waitingFor } from '../utils/session-waiting.js';
import { icon } from './icons.js';
import './provider-badge.js';
import { agentAvatar } from './agent-avatar.js';
import './rename-field.js';
import {
  canMoveToUntether,
  canShield,
  moveToUntether,
  shieldConfirmText,
  shieldSession,
} from '../utils/shield.js';

const LONG_PRESS_MS = 550;
/** Width of one swipe action button. */
const SWIPE_ACTION_PX = 84;
/** Horizontal travel before a touch counts as a swipe (and not a tap or a scroll). */
const SWIPE_SLOP_PX = 12;
/** A swipe right past this share of the row on a waiting row opens the reply sheet. */
const FULL_SWIPE_FRACTION = 0.5;

/** Only one row shows its swipe actions at a time, like Mail and Messages. */
let swipeOpenRow: PhoneSessionRow | null = null;
function markSwipeOpen(row: PhoneSessionRow) {
  swipeOpenRow = row;
}

export type RowGlyphKind = 'claude' | 'codex' | 'gemini' | 'terminal';

/** Which glyph a row's avatar shows: the agent's mark, else a terminal prompt (no letters). */
export function rowGlyphKind(tool: string, isClaude = false): RowGlyphKind {
  if (isClaude || tool === 'claude') return 'claude';
  if (tool === 'codex' || tool === 'gemini') return tool;
  return 'terminal';
}

/** "Bash · vitest run src/server" (tool names are names, not translated), else the wording. */
export function activityLine(activity: ClaudeActivity): string {
  const tool = activity.tool?.startsWith('mcp__')
    ? activity.tool.split('__').pop() || activity.tool
    : activity.tool;
  if (activity.kind === 'tool' && tool && activity.target) return `${tool} · ${activity.target}`;
  return formatActivity(activity);
}

/** The folder a session runs in, by its own name ("untether", "~"). */
export function folderLabel(workingDir: string | undefined): string {
  const display = formatPathForDisplay(workingDir ?? '').replace(/\/+$/, '');
  if (!display) return '';
  if (display === '~') return '~';
  return display.slice(display.lastIndexOf('/') + 1) || '/';
}

/** "now", "5 min", "14:02" (today), "Mon", or "3 Oct" — like a chat list. */
export function formatRowTime(iso: string | undefined, now = new Date()): string {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (minutes < 1) return t('sessions.row.now');
  if (minutes < 60) return t('sessions.row.minutes', { n: minutes });
  if (then.toDateString() === now.toDateString()) {
    return then.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  }
  if (minutes < 6 * 24 * 60) return then.toLocaleDateString(getLocale(), { weekday: 'short' });
  return then.toLocaleDateString(getLocale(), { day: 'numeric', month: 'short' });
}

const timedRows = new Set<RowTime>();
let rowTimer: ReturnType<typeof setInterval> | undefined;
/** Relative times move by the minute; 30 s keeps them at most half a minute behind. */
const ROW_TIME_TICK_MS = 30_000;

function tickRowTimes() {
  if (typeof document !== 'undefined' && document.hidden) return;
  for (const element of timedRows) element.refresh();
}

/**
 * `<ut-row-time at="ISO">`: a row's "now / 5 min / 14:02", rewriting its own text. One shared
 * timer for every row, paused while the page is hidden, so a list whose sessions did not change
 * never re-renders just to move its clocks (2026-10-02: rows kept saying "now" for hours).
 */
export class RowTime extends HTMLElement {
  static get observedAttributes() {
    return ['at'];
  }

  connectedCallback() {
    this.refresh();
    timedRows.add(this);
    rowTimer ??= setInterval(tickRowTimes, ROW_TIME_TICK_MS);
  }

  disconnectedCallback() {
    timedRows.delete(this);
    if (rowTimer && !timedRows.size) {
      clearInterval(rowTimer);
      rowTimer = undefined;
    }
  }

  attributeChangedCallback() {
    if (this.isConnected) this.refresh();
  }

  refresh() {
    const text = formatRowTime(this.getAttribute('at') ?? undefined);
    if (this.textContent !== text) this.textContent = text;
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('ut-row-time')) {
  customElements.define('ut-row-time', RowTime);
}

export const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'nu', 'pwsh', '']);
const WRAPPER_FLAGS = /^-/;
/** Programs that run another one: `exec claude`, `env X=1 codex`, `caffeinate -i claude`. */
const WRAPPERS = new Set(['exec', 'env', 'nohup', 'command', 'sudo', 'caffeinate', 'time']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const AGENT_WORD = /(?:^|[\s/;&|(])(claude|codex|gemini)(?=$|[\s;&|)])/;

/** The program a list of words runs, past wrappers, their flags and VAR=value assignments. */
function programOf(words: string[]): string {
  const base = (word: string) => word.split('/').pop()?.toLowerCase() ?? '';
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? '';
    if (ASSIGNMENT.test(word)) {
      i++;
      continue;
    }
    if (WRAPPERS.has(base(word))) {
      i++;
      while (i < words.length && (WRAPPER_FLAGS.test(words[i]) || ASSIGNMENT.test(words[i]))) i++;
      continue;
    }
    return base(word);
  }
  return '';
}

/**
 * The program a session runs: "claude" for ["zsh", "-lic", "claude --resume x"],
 * ["/opt/homebrew/bin/gemini"], ["caffeinate", "-i", "claude"] or
 * ["zsh", "-lc", "cd ~/app && exec codex"]; "zsh" for a plain shell.
 */
export function sessionTool(
  session: Pick<Session, 'command' | 'codexActive' | 'geminiActive'>
): string {
  // `codex` / `gemini` typed inside a shell: the server spots its process in the session.
  if (session.codexActive) return 'codex';
  if (session.geminiActive) return 'gemini';
  const argv = Array.isArray(session.command) ? session.command : [];
  const first = programOf(argv);
  const agentIn = (text: string) => AGENT_WORD.exec(text.toLowerCase())?.[1];
  if (SHELLS.has(first)) {
    // A shell running a command string (zsh -lic "claude ...") is that command.
    const start = argv.findIndex((word) => programOf([word]) === first);
    const script = argv.slice(start + 1).find((arg) => !WRAPPER_FLAGS.test(arg));
    if (script) {
      const program = programOf(script.trim().split(/\s+/));
      if (program === 'claude' || program === 'codex' || program === 'gemini') return program;
      return agentIn(script) ?? program;
    }
    return first;
  }
  if (first === 'claude' || first === 'codex' || first === 'gemini') return first;
  return agentIn(argv.join(' ')) ?? first;
}

/**
 * A terminal's last line that says nothing: only caret-notation escapes ("^[", "^[[A", "^[b"),
 * a pager's ":" or "(END)" prompt, or blanks.
 */
export function isNoiseLine(line: string): boolean {
  return /^(?:\^\[[[\]\w;?]*|\s|:|\(END\))*$/.test(line);
}

export type RowState = 'working' | 'waiting' | 'idle' | 'shell' | 'exited';

export function rowState(session: Session): RowState {
  if (session.status === 'exited') return 'exited';
  const claude = session.claudeStatus?.status;
  // Busy only for background agents: the reply is over, so the row rests like an idle one.
  if (claude === 'busy') return isBackgroundWait(session.claudeStatus) ? 'idle' : 'working';
  if (claude === 'waiting') return 'waiting';
  if (claude) return 'idle';
  // Codex's own state, from its rollout (Session.agentStatus, 2026-11-10).
  const agent = session.agentStatus?.status;
  if (agent) return agent === 'busy' ? 'working' : agent;
  return 'shell';
}

@customElement('phone-session-row')
export class PhoneSessionRow extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Object }) session!: Session;
  @property({ type: Object }) authClient!: AuthClient;
  @property({ type: Boolean }) selected = false;
  /** Claude answered or started waiting since you last opened this session. */
  @property({ type: Boolean }) unread = false;
  /** Pinned to the top of the list on this device (session-list owns the set). */
  @property({ type: Boolean }) pinned = false;
  /** Its project's icon (an orchestrator's row): shown on the avatar, the agent's mark small. */
  @property({ attribute: false }) projectIcon: string | null = null;
  /** Its project's orchestrator, shown outside its project group: the sparkles among the flags. */
  @property({ type: Boolean }) orchestrator = false;
  /** The home's groups and where each session is (its sheet's "Anclar" / "Mover a…"). */
  @property({ attribute: false }) groupMenu: GroupMenu | null = null;
  /**
   * Changes whenever anything shown changes. The app keeps the same Session object across
   * polls and updates it in place, which alone would not re-render this row.
   */
  @property({ type: String }) stamp = '';
  @state() private killing = false;
  @state() private answering: number | null = null;
  /**
   * Why the last quick answer did nothing: the prompt changed, another answer was on its way,
   * the session was opened to watch only (its tmux client is read-only), or the keys went in and
   * the menu stayed (the answer did not land).
   */
  @state() private answerFailed: false | 'changed' | 'busy' | 'watching' | 'undelivered' = false;
  @state() private resuming = false;
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly i18n = new LocaleController(this);

  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressed = false;

  /**
   * How far the row is slid to show its swipe actions: negative = left (Más, Cerrar at the
   * trailing edge), positive = right (Fijar at the leading edge), 0 = closed. In RTL the
   * same finger movement, mirrored by the layout.
   */
  @state() private swipeX = 0;
  @state() private swiping = false;
  private swipeStart: { x: number; y: number; base: number; id: number } | null = null;
  /** The gesture went sideways or vertical; decided once per touch. */
  private swipeAxis: 'x' | 'y' | null = null;
  /** The click that ends a swipe (or closes the actions) must not also open the session. */
  private swallowClick = false;
  private swipeActionAt = 0;
  /** The sheet's Rename row is a field (rename-field.ts). */
  private renaming = false;

  /** Trailing actions: Más + Cerrar (Quitar when exited). */
  private trailingWidth(): number {
    return SWIPE_ACTION_PX * 2;
  }

  /** Leading action: Fijar / Desfijar. */
  private leadingWidth(): number {
    return SWIPE_ACTION_PX;
  }

  /** A full swipe right on a waiting row opens the reply sheet (past half the row). */
  private fullSwipePx(): number {
    return Math.max(this.leadingWidth() * 1.6, (this.offsetWidth || 360) * FULL_SWIPE_FRACTION);
  }

  closeSwipe() {
    this.swipeX = 0;
    if (swipeOpenRow === this) swipeOpenRow = null;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cancelPress();
    if (swipeOpenRow === this) swipeOpenRow = null;
    if (this.answerTimer) clearTimeout(this.answerTimer);
    // repeat() moves rows when their order changes (disconnect + reconnect in the same task);
    // only a row that is really gone takes its open sheet with it.
    setTimeout(() => {
      if (!this.isConnected) this.closeSheet();
    }, 0);
  }

  private cancelPress() {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  private handlePointerDown = (e: PointerEvent) => {
    this.longPressed = false;
    this.cancelPress();
    // Touching another row puts away the actions an open row is showing.
    if (swipeOpenRow && swipeOpenRow !== this) swipeOpenRow.closeSwipe();
    this.swipeStart = { x: e.clientX, y: e.clientY, base: this.swipeX, id: e.pointerId };
    this.swipeAxis = null;
    // Touch browsers often send no click after a drag; don't let a stale flag eat this tap.
    this.swallowClick = false;
    this.pressTimer = setTimeout(() => {
      this.longPressed = true;
      navigator.vibrate?.(15);
      this.openSheet();
    }, LONG_PRESS_MS);
  };

  private handlePointerMove = (e: PointerEvent) => {
    const start = this.swipeStart;
    if (!start || start.id !== e.pointerId) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!this.swipeAxis) {
      // Only a clearly sideways move is a swipe, so scrolling the list stays a scroll.
      if (Math.abs(dy) > SWIPE_SLOP_PX && Math.abs(dy) >= Math.abs(dx)) this.swipeAxis = 'y';
      else if (Math.abs(dx) > SWIPE_SLOP_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
        this.swipeAxis = 'x';
        this.cancelPress();
        this.swiping = true;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      }
      if (Math.abs(dy) > SWIPE_SLOP_PX) this.cancelPress();
    }
    if (this.swipeAxis !== 'x') return;
    // Follows the finger, with a little rubber band past the buttons (none on a waiting row
    // swiped right: it goes on to the full swipe that answers).
    const raw = start.base + dx;
    const trailing = this.trailingWidth();
    const leading = this.rowState() === 'waiting' ? Number.POSITIVE_INFINITY : this.leadingWidth();
    if (raw < -trailing) this.swipeX = -trailing + (raw + trailing) / 3;
    else if (raw > leading) this.swipeX = leading + (raw - leading) / 3;
    else this.swipeX = raw;
  };

  private handlePointerEnd = () => {
    this.cancelPress();
    const swiped = this.swipeAxis === 'x';
    this.swipeStart = null;
    this.swipeAxis = null;
    if (!swiped) return;
    this.swiping = false;
    this.swallowClick = true;
    if (this.swipeX > 0 && this.rowState() === 'waiting' && this.swipeX >= this.fullSwipePx()) {
      this.closeSwipe();
      this.openAnswerSheet();
      return;
    }
    if (this.swipeX < -this.trailingWidth() / 2) {
      this.swipeX = -this.trailingWidth();
      markSwipeOpen(this);
    } else if (this.swipeX > this.leadingWidth() / 2) {
      this.swipeX = this.leadingWidth();
      markSwipeOpen(this);
    } else {
      this.closeSwipe();
    }
  };

  private rowState(): RowState {
    return rowState(this.session);
  }

  /** The reply sheet ("Te necesita", app.ts): answer without opening the session. */
  private openAnswerSheet() {
    window.dispatchEvent(
      new CustomEvent('ut-open-answer-sheet', { detail: { sessionId: this.session.id } })
    );
  }

  private handleClick = () => {
    this.cancelPress();
    if (this.swallowClick) {
      this.swallowClick = false;
      return;
    }
    // A tap on a row showing its actions just puts them away.
    if (this.swipeX) {
      this.closeSwipe();
      return;
    }
    // The click that ends a long press must not also open the session.
    if (this.longPressed) {
      this.longPressed = false;
      return;
    }
    this.dispatchEvent(
      new CustomEvent('session-select', { detail: this.session, bubbles: true, composed: true })
    );
  };

  private openSession() {
    this.longPressed = false;
    this.dispatchEvent(
      new CustomEvent('session-select', { detail: this.session, bubbles: true, composed: true })
    );
  }

  private handleMenuClick = (e: Event) => {
    e.stopPropagation();
    this.openSheet();
  };

  /** Action sheet (open, rename, pin, mute, shield, kill/clear): utils/phone-action-sheet.ts. */
  private sheet: PhoneActionSheet | null = null;

  /** The open sheet, for the swipe's Rename and tests. */
  get sheetOpen(): boolean {
    return this.sheet?.isOpen ?? false;
  }

  private openSheet(confirmKill = false) {
    if (this.sheet?.isOpen) return;
    // A long press leaves focus wherever it was: hand it back to the row's own button.
    const opener = this.contains(document.activeElement)
      ? document.activeElement
      : this.querySelector('.psr-main');
    this.sheet = new PhoneActionSheet({
      label: this.displayTitle(),
      opener,
      onClose: () => {
        this.renaming = false;
      },
    });
    this.sheet.open(confirmKill ? this.killStep : this.actionsContent);
    if (confirmKill) this.sheet.setOptions({ role: 'alertdialog' });
  }

  private closeSheet = () => {
    this.sheet?.close();
  };

  /** Draw the sheet's actions again (the rename field came or went). */
  private renderSheet() {
    this.sheet?.update(this.actionsContent);
  }

  /**
   * "Kill “name”?": killing a running session ends its process (and an agent's work), so it
   * never happens on a single, possibly stray, tap. The confirm button takes the Kill
   * button's place, so the sheet restarts its guard: a double tap mustn't kill.
   */
  private killStep = (sheet: PhoneActionSheet) => {
    const attached = isAttachedTmuxSession(this.session);
    // Opened with ut in a terminal window: killing it ends it in that window on the Mac too.
    const windowNote = macWindowKillNote(this.session);
    return html`<div class="psr-sheet-group ut-surface--floating ut-surface--material">
      <div class="psr-sheet-title question">
        <bdi>${t(
          attached
            ? 'sessions.row.disconnectConfirm'
            : this.session.shielded
              ? 'shield.killConfirm'
              : 'sessions.row.killConfirm',
          { name: this.displayTitle() }
        )}</bdi>
        ${
          windowNote
            ? html`<div data-testid="psr-kill-mac-window" style="margin-top: 4px">${windowNote}</div>`
            : nothing
        }
      </div>
      ${actionItems(sheet, [
        {
          label: t(attached ? 'sessions.row.disconnect' : 'sessions.row.kill'),
          destructive: true,
          testId: 'psr-kill-confirm',
          run: () => void this.kill(),
        },
      ])}
    </div>`;
  };

  private shieldStep = (
    sheet: PhoneActionSheet
  ) => html`<div class="psr-sheet-group ut-surface--floating ut-surface--material">
    <div class="psr-sheet-title question">
      <bdi>${shieldConfirmText(this.session, this.displayTitle())}</bdi>
    </div>
    ${actionItems(sheet, [
      {
        label: t('shield.shield'),
        icon: 'shield',
        testId: 'psr-shield-confirm',
        run: () => void this.shield(),
      },
    ])}
  </div>`;

  private moveStep = (
    sheet: PhoneActionSheet
  ) => html`<div class="psr-sheet-group ut-surface--floating ut-surface--material">
    <div class="psr-sheet-title question">
      <bdi>${t('moveToUntether.confirm', { name: this.displayTitle() })}</bdi>
    </div>
    ${actionItems(sheet, [
      {
        label: t('moveToUntether.action'),
        icon: 'shield',
        testId: 'psr-move-to-untether-confirm',
        run: () => void this.moveToUntether(),
      },
    ])}
  </div>`;

  private actionsContent = (sheet: PhoneActionSheet) => {
    const exited = isFinishedSession(this.session);
    const attached = isAttachedTmuxSession(this.session);
    const port = this.session.previewPorts?.[0]?.port;
    const first: ActionSheetItem[] = [
      {
        label: t('sessions.row.open'),
        icon: 'chevronRight',
        testId: 'psr-open',
        run: () => this.openSession(),
      },
    ];
    if (!exited && port) {
      first.push({
        label: html`${t('preview.title')} · <span dir="ltr">:${port}</span>`,
        icon: 'eye',
        testId: 'psr-preview',
        run: () => this.openPreview(),
      });
    }
    const organize: ActionSheetItem[] = [];
    if (!exited && !this.renaming) {
      organize.push({
        label: t('sessions.row.rename'),
        icon: 'pencil',
        testId: 'psr-rename',
        keepOpen: true,
        run: () => {
          this.renaming = true;
          this.renderSheet();
        },
      });
      if (this.session.userTitle) {
        organize.push({
          label: resetTitleLabel(this.session),
          icon: 'restart',
          testId: 'psr-reset-title',
          run: () => void this.saveUserTitle(null),
        });
      }
    }
    organize.push({
      label: t(this.pinned ? 'organize.unpin' : 'organize.pin'),
      icon: this.pinned ? 'pinOff' : 'pin',
      testId: 'psr-pin',
      run: () => this.togglePin(),
    });
    // Its group on the home (2026-11-04): anchored by hand, wins over the automatic one.
    organize.push(
      ...groupPinItems(sheet, {
        session: this.session,
        menu: this.groupMenu,
        apply: (groupPin) => {
          this.closeSheet();
          void applyGroupPin(this, this.session, groupPin, this.authClient);
        },
      })
    );
    if (!exited) {
      organize.push({
        label: t(this.session.muted ? 'organize.unmute' : 'organize.mute'),
        icon: this.session.muted ? 'bell' : 'bellOff',
        testId: 'psr-mute',
        run: () => void this.toggleMute(),
      });
    }
    if (canShield(this.session)) {
      organize.push({
        label: t('shield.shield'),
        icon: 'shield',
        testId: 'psr-shield',
        keepOpen: true,
        run: () => sheet.step(this.shieldStep),
      });
    }
    // A `ut` session in a Mac window moves to Untether (2026-10-25).
    if (canMoveToUntether(this.session)) {
      organize.push({
        label: t('moveToUntether.action'),
        icon: 'shield',
        testId: 'psr-move-to-untether',
        keepOpen: true,
        run: () => sheet.step(this.moveStep),
      });
    }
    // Suspend by hand (2026-10-31): the server checks it is safe, else says why.
    if (canSuspend(this.session)) {
      organize.push({
        label: t('suspend.now'),
        icon: 'pause',
        testId: 'psr-suspend',
        run: () => void suspendWithFeedback(this.session, this.authClient?.getAuthHeader()),
      });
    }
    if (canKeepAwake(this.session)) {
      const keepAwake = this.session.keepAwake === true;
      organize.push({
        label: t(keepAwake ? 'suspend.allowSuspend' : 'suspend.keepAwake'),
        icon: keepAwake ? 'pause' : 'zap',
        testId: 'psr-keep-awake',
        run: () => void this.toggleKeepAwake(),
      });
    }
    if (exited && resumableAgent(this.session) && !attached) {
      organize.push({
        label: t('sessions.row.resume'),
        icon: 'restart',
        run: () => void this.resumeClaude(),
      });
    }
    const end: ActionSheetItem = {
      label: t(
        exited ? 'sessions.row.clear' : attached ? 'sessions.row.disconnect' : 'sessions.row.kill'
      ),
      icon: exited ? 'trash' : 'x',
      destructive: true,
      testId: 'psr-kill',
      keepOpen: !exited,
      run: exited
        ? () => void this.kill()
        : () => {
            sheet.setOptions({ role: 'alertdialog' });
            sheet.step(this.killStep);
          },
    };
    return html`
      <div class="psr-sheet-group ut-surface--floating ut-surface--material">
        <div class="psr-sheet-title">
          <bdi>${this.displayTitle()}</bdi>
          ${this.renderWhere()}
          ${
            this.session.shielded && !exited
              ? html`<div class="psr-sheet-subtitle" data-testid="psr-shield-info">
                  ${icon('shield', 13)} ${t('shield.info')}
                </div>`
              : nothing
          }
        </div>
        ${actionItems(sheet, first)}
      </div>
      <div class="psr-sheet-group ut-surface--floating ut-surface--material">
        ${
          this.renaming && !exited
            ? html`<ut-rename-field
                data-testid="psr-rename-field"
                .value=${visibleSessionTitle(this.session)}
                .save=${(name: string) => this.renameTo(name)}
                @rename-done=${this.closeSheet}
                @rename-cancel=${() => {
                  this.renaming = false;
                  this.renderSheet();
                  this.sheet?.element
                    ?.querySelector<HTMLElement>('[data-testid="psr-rename"]')
                    ?.focus();
                }}
              ></ut-rename-field>`
            : nothing
        }
        ${actionItems(sheet, organize)}
      </div>
      <div class="psr-sheet-group ut-surface--floating ut-surface--material">${actionItems(sheet, [end])}</div>
    `;
  };

  private togglePin() {
    this.dispatchEvent(
      new CustomEvent('session-pin-toggle', {
        detail: { sessionId: this.session.id, pinned: !this.pinned },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Muting lives on the server: it has to stop the pushes sent while the app is closed. */
  private async toggleMute() {
    const session = this.session;
    const muted = !session.muted;
    const result = await setSessionMuted(session.id, muted, this.authClient);
    if (!result.success) {
      toast({ kind: 'error', text: t('organize.muteFailed') });
      return;
    }
    // Shown right away; the next poll brings the same value from the server.
    session.muted = muted;
    this.requestUpdate();
  }

  /** "Don't suspend" lives on the server: the suspender reads it (session-suspender.ts). */
  private async toggleKeepAwake() {
    const session = this.session;
    const keepAwake = session.keepAwake !== true;
    if (!(await setKeepAwake(session.id, keepAwake, this.authClient?.getAuthHeader()))) {
      toast({ kind: 'error', text: t('suspend.keepAwakeFailed') });
      return;
    }
    session.keepAwake = keepAwake || undefined;
    this.requestUpdate();
  }

  private displayTitle(): string {
    return sessionTitle(this.session) || this.session.name || this.session.command?.join(' ') || '';
  }

  /**
   * Continue an exited session's conversation (`claude --resume <id>`, `codex resume <id>`) in
   * a new session.
   */
  private async resumeClaude() {
    if (!resumableAgent(this.session) || this.resuming) return;
    this.resuming = true;
    try {
      const result = await resumeSession(this.session, this.authClient?.getAuthHeader());
      this.dispatchEvent(
        new CustomEvent('session-created', { detail: result, bubbles: true, composed: true })
      );
    } catch (error) {
      this.dispatchEvent(
        new CustomEvent('error', { detail: `${t('newChat.failed')}: ${error}`, bubbles: true })
      );
    } finally {
      this.resuming = false;
    }
  }

  /**
   * A finished Claude or Codex conversation that can be continued gets a one-tap Resume right
   * on its row, instead of only behind the long press.
   */
  private renderResume() {
    if (!resumableAgent(this.session)) return nothing;
    // Suspended: the row's own tap wakes it, in place.
    if (this.session.suspended) return nothing;
    // Its conversation still runs in that tmux session: resuming it would write it twice.
    if (isAttachedTmuxSession(this.session)) return nothing;
    return html`<button
      class="ut-surface--control psr-resume"
      data-testid="psr-resume"
      ?disabled=${this.resuming}
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @click=${(e: Event) => {
        e.stopPropagation();
        void this.resumeClaude();
      }}
    >
      ${icon('restart', 14)}${t('phoneList.resume')}
    </button>`;
  }

  /** "Blindar": open the shielded version of this session (see utils/shield.ts). */
  private async shield() {
    try {
      const result = await shieldSession(this.session.id, this.authClient?.getAuthHeader());
      this.dispatchEvent(
        new CustomEvent('session-created', { detail: result, bubbles: true, composed: true })
      );
    } catch (error) {
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: t('shield.failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  /** "Llevar a Untether": its conversation leaves the Mac window for a shielded session. */
  private async moveToUntether() {
    try {
      const result = await moveToUntether(
        this.session.id,
        this.displayTitle(),
        this.authClient?.getAuthHeader()
      );
      if (!result) return;
      this.dispatchEvent(
        new CustomEvent('session-created', { detail: result, bubbles: true, composed: true })
      );
    } catch (error) {
      this.dispatchEvent(
        new CustomEvent('error', {
          detail: t('moveToUntether.failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
          bubbles: true,
          composed: true,
        })
      );
    }
  }

  /**
   * Rename = the title shown (not the generated session name, kept as the subtitle), inline in
   * the sheet. Resolves to the error the field shows, if the save failed.
   */
  private async renameTo(name: string): Promise<string | undefined> {
    const result = await this.saveUserTitle(name);
    return result.success ? undefined : t('toast.renameFailed', { error: String(result.error) });
  }

  /** Save the user's title, or null to go back to the agent's conversation title. */
  private async saveUserTitle(userTitle: string | null) {
    const result = await setSessionUserTitle(this.session.id, userTitle, this.authClient);
    if (result.success) {
      this.dispatchEvent(
        new CustomEvent('session-renamed', {
          detail: { sessionId: this.session.id, userTitle },
          bubbles: true,
          composed: true,
        })
      );
    }
    return result;
  }

  private async kill() {
    if (this.killing) return;
    this.killing = true;
    const disconnecting = this.disconnects();
    const result = await sessionActionService.deleteSession(this.session, {
      authClient: this.authClient,
      callbacks: {
        onError: (error) => {
          // A disconnect that failed says so in its own words below, not as a failed kill.
          if (disconnecting) return;
          this.dispatchEvent(
            new CustomEvent('session-kill-error', {
              detail: { sessionId: this.session.id, error },
              bubbles: true,
              composed: true,
            })
          );
        },
        onSuccess: () =>
          this.dispatchEvent(
            new CustomEvent('session-killed', {
              detail: { sessionId: this.session.id, session: this.session },
              bubbles: true,
              composed: true,
            })
          ),
      },
    });
    if (!result.success) {
      this.killing = false;
      if (disconnecting) {
        this.dispatchEvent(
          new CustomEvent('error', {
            detail: t('sessions.row.disconnectFailed', { error: result.error ?? '' }),
            bubbles: true,
            composed: true,
          })
        );
      }
    } else if (disconnecting) {
      // Its row under "On this Mac" no longer says "In Untether".
      announceMacSessionsChanged();
    }
  }

  /** Ending this session detaches its tmux client: the tmux session keeps running. */
  private disconnects(): boolean {
    return this.session.status !== 'exited' && isAttachedTmuxSession(this.session);
  }

  /**
   * Answer Claude's on-screen prompt by its option number, without opening the session. The
   * server re-checks that this question is still the one on screen before typing the digit.
   */
  private async answer(
    option: number,
    choices: { question: string; options: string[]; detail?: string[]; key?: string },
    e: Event
  ) {
    e.stopPropagation();
    if (this.answering !== null) return;
    this.answering = option;
    this.answerFailed = false;
    try {
      const response = await fetch(`/api/sessions/${this.session.id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authClient?.getAuthHeader() },
        // The options and what the menu is about tell it apart from the next prompt.
        body: JSON.stringify({
          option,
          question: choices.question,
          options: choices.options,
          key: choices.key,
        }),
      });
      if (!response.ok) {
        const error =
          response.status === 409
            ? ((await response.json().catch(() => ({}))) as { error?: string }).error
            : undefined;
        this.answerFailed =
          response.status === 504
            ? 'undelivered'
            : error === 'busy'
              ? 'busy'
              : error === 'read-only'
                ? 'watching'
                : 'changed';
      }
    } catch {
      this.answerFailed = 'changed';
    }
    // On success the next poll replaces the prompt; keep the button marked until then.
    this.answerTimer = setTimeout(
      () => {
        this.answering = null;
        this.answerTimer = null;
      },
      this.answerFailed ? 0 : 3000
    );
  }

  private openPreview() {
    window.dispatchEvent(
      new CustomEvent('ut-open-preview', {
        detail: { sessionId: this.session.id, port: this.session.previewPorts?.[0]?.port },
      })
    );
  }

  /** A dev server runs in this session: a chip straight to its preview. */
  private previewTouchedAt = 0;
  private renderPreviewChip() {
    const port = this.session.previewPorts?.[0]?.port;
    if (this.session.status === 'exited' || !port) return nothing;
    return html`<div class="psr-preview-chip-row">
      <span
        class="ut-preview-chip"
        role="button"
        tabindex="0"
        data-testid="psr-preview-chip"
        @pointerdown=${(e: Event) => e.stopPropagation()}
        @pointerup=${(e: PointerEvent) => {
          e.stopPropagation();
          if (e.pointerType === 'mouse') return;
          // A scroll of the list that started on the chip ends here too: not a tap.
          if (endsADrag(e)) return;
          this.previewTouchedAt = Date.now();
          swallowNextClick();
          this.openPreview();
        }}
        @click=${(e: Event) => {
          e.stopPropagation();
          if (Date.now() - this.previewTouchedAt < 700) return;
          this.openPreview();
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          this.openPreview();
        }}
        >${t('preview.title')} <span dir="ltr">:${port}</span></span
      >
    </div>`;
  }

  /**
   * Quick answers right in the row (phone-spec 3.6): one wrapped row of 44 px pills with short
   * translated labels ("Sí" / "Siempre" / "No"; the option's own text is the accessible name
   * and what is sent). Only the first is filled; "No…" options are neutral. Labels that would
   * read the same (two "Sí") fall back to the translated option text. What they approve
   * ("Bash command · pnpm test") is the line just above them.
   */
  private renderChoices() {
    const choices = waitingChoices(this.session);
    if (!choices?.options.length) return nothing;
    const detail = this.choicesDetail();
    const translate = t as Parameters<typeof shortPromptLabel>[1];
    const short = choices.options.map((option) => shortPromptLabel(option, translate));
    const unique = short.every((label, index) => label && short.indexOf(label) === index);
    const labels = choices.options.map((option, index) =>
      unique ? (short[index] as string) : translatePromptOption(option, translate)
    );
    return html`
      <div class="psr-choices" @pointerdown=${(e: Event) => e.stopPropagation()}>
        ${
          this.answerFailed
            ? html`<div class="psr-choices-error">
                ${t(
                  this.answerFailed === 'busy'
                    ? 'screenMenu.sending'
                    : this.answerFailed === 'watching'
                      ? 'macSessions.error.watching'
                      : this.answerFailed === 'undelivered'
                        ? 'answerSheet.notDelivered'
                        : 'sessions.row.promptChanged'
                )}
              </div>`
            : nothing
        }
        ${detail ? html`<div class="psr-caption psr-choices-detail" dir="ltr">${detail}</div>` : nothing}
        <div class="psr-choice-row" role="group" aria-label=${choices.question}>
          ${choices.options.map(
            (option, index) => html`
              <button
                class="ut-surface--badge psr-choice ${index === 0 && !isDeclineOption(option) ? 'primary' : ''} ${this.answering === index + 1 ? 'sending' : ''}"
                aria-label=${option}
                title=${option}
                ?disabled=${this.answering !== null}
                @click=${(e: Event) => this.answer(index + 1, choices, e)}
              >
                <bdi>${labels[index]}</bdi>
              </button>
            `
          )}
        </div>
      </div>
    `;
  }

  /**
   * The waiting row's status line: "Te necesita · Permiso ›" as a 44 px button opening the
   * reply sheet (app.ts) instead of the session. It acts on pointerup like the sheets; the
   * click that follows is swallowed so the row underneath doesn't open the session too. A
   * mouse uses the click. Outside the row's role=button: no nested interactive elements.
   */
  private renderNeeds() {
    const asks = waitingFor(this.session);
    let touchedAt = 0;
    const open = () => this.openAnswerSheet();
    return html`<button
      type="button"
      class="ut-text-action psr-needs psr-needs-btn"
      data-testid="psr-needs-chip"
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @pointerup=${(e: PointerEvent) => {
        e.stopPropagation();
        if (e.pointerType === 'mouse') return;
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
    >
      <span class="psr-needs-text"
        >${t('sessions.row.needsYou')}${asks ? html` · ${claudeWaitingLabel(asks)}` : nothing}</span
      >${icon('chevronRight', 16)}
    </button>`;
  }

  /** What a quick answer approves ("Bash command · pnpm test"), not the stock question. */
  private choicesDetail(): string {
    const choices = waitingChoices(this.session);
    if (!choices) return '';
    if (choices.detail?.length) return compactDetail(choices.detail);
    // Its own question when it says something ("Trust this folder?"); never "Do you want to
    // proceed?".
    const kind = promptKind(choices);
    return kind === 'permission' || kind === 'plan' ? '' : choices.question;
  }

  /** One status line (not waiting): working, background, last message, or a shell's output. */
  private renderStatus(state: RowState) {
    // Suspended to free memory (2026-10-31): a discreet "paused" (or why it could not wake).
    const suspension = this.session.suspended;
    if (suspension) {
      return suspension.resumeError
        ? html`<span class="psr-paused psr-paused-error" data-testid="psr-wake-failed" title=${suspension.resumeError}>${t('suspend.wakeFailedShort')}</span>`
        : html`<span class="psr-paused" data-testid="psr-paused">${icon('pause', 12)} ${
            suspendedAt(this.session) === undefined
              ? t('suspend.paused')
              : t('suspend.pausedSince', {
                  ago: relativeTime(Date.now() - (suspendedAt(this.session) as number)),
                })
          }</span>`;
    }
    const claude = this.session.claudeStatus;
    const preview = claude?.preview;
    if (state === 'working') {
      // What Claude is doing right now ("Bash · vitest run …"), minutes after the first one.
      const activity = sessionActivity(this.session);
      return activity
        ? html`<span class="psr-working" data-testid="row-activity"><bdi>${activityLine(activity)}</bdi></span>${
            activity.since
              ? html`<span class="psr-sep"> · </span><claude-activity-elapsed class="psr-elapsed" minutes since=${activity.since}></claude-activity-elapsed>`
              : nothing
          }`
        : html`<span class="psr-working">${t('sessions.row.working')}<span class="psr-dots"></span></span>`;
    }
    const text = preview
      ? html`${preview.role === 'user' ? html`<span class="psr-you">${t('sessions.row.you')}</span>` : nothing}${preview.text}`
      : nothing;
    if (state === 'idle' && isBackgroundWait(claude)) {
      // The reply is in; background agents still run. Calm, no dots: nothing to wait for here.
      return html`<span class="psr-background" data-testid="row-background">${t('activity.backgroundWait')}</span>${preview ? html`<span class="psr-sep"> · </span>${text}` : nothing}`;
    }
    if (preview) return text;
    const lastLine = this.lastLine();
    if (lastLine) {
      return html`<span class="psr-last-line" data-testid="row-last-line"><bdi>${lastLine}</bdi></span>`;
    }
    return state === 'exited'
      ? html`<span class="psr-exited">${t('a11y.row.exited')}</span>`
      : nothing;
  }

  /**
   * What VoiceOver reads for the row, like a chat list: "claude, Fix the login, needs you,
   * 2 min, new reply, <preview>". The row's visible parts are many small spans; read as one.
   */
  private accessibleName(
    tool: string,
    title: string,
    subtitle: string | undefined,
    state: RowState,
    time: string
  ): string {
    const claude = this.session.claudeStatus;
    const status =
      state === 'waiting'
        ? [t('sessions.row.needsYou'), claudeWaitingLabel(claude?.waitingFor)]
            .filter(Boolean)
            .join(' · ')
        : state === 'working'
          ? (() => {
              const activity = sessionActivity(this.session);
              return activity ? formatActivity(activity) : t('sessions.row.working');
            })()
          : this.session.suspended
            ? this.session.suspended.resumeError
              ? t('suspend.wakeFailedShort')
              : t('suspend.pausedHint')
            : state === 'exited'
              ? t('a11y.row.exited')
              : isBackgroundWait(claude)
                ? t('activity.backgroundWait')
                : '';
    const preview =
      state === 'waiting'
        ? ''
        : claude?.preview
          ? `${claude.preview.role === 'user' ? t('sessions.row.you') : ''}${claude.preview.text}`
          : formatPathForDisplay(this.session.workingDir);
    const lastLine = state === 'waiting' ? '' : this.lastLine();
    const macWindow = this.session.macWindow;
    return [
      tool,
      title,
      this.orchestrator ? t('board.orchestrator') : '',
      macWindow ? macWindowLabel(macWindow) : '',
      subtitle,
      status,
      time,
      this.unread ? t('sessions.row.unread') : '',
      this.pinned ? t('organize.pinned') : '',
      this.session.muted ? t('organize.muted') : '',
      this.session.shielded ? t('shield.badge') : '',
      this.recentlyRestored() ? t('shield.restored') : '',
      this.recentClaudeUpdate() ?? '',
      preview,
      lastLine,
    ]
      .map((part) => part?.trim())
      .filter((part, index, parts) => part && parts.indexOf(part) === index)
      .join(', ');
  }

  /** A shielded session recreated after a reboot in the last day (still running). */
  private recentlyRestored(): boolean {
    const { restoredAt, status } = this.session;
    if (!restoredAt || status !== 'running') return false;
    const age = Date.now() - Date.parse(restoredAt);
    return age >= 0 && age < 24 * 60 * 60 * 1000;
  }

  /**
   * "Updated to 2.1.316": Untether restarted its idle Claude on the installed version in the
   * last day (2026-10-31, the restartUpdatedClaude setting).
   */
  private recentClaudeUpdate(): string | undefined {
    const update = this.session.claudeUpdatedTo;
    if (!update || this.session.status !== 'running') return undefined;
    const age = Date.now() - Date.parse(update.at);
    return age >= 0 && age < 24 * 60 * 60 * 1000
      ? t('claudeUpdate.updatedTo', { version: update.to })
      : undefined;
  }

  /**
   * Last output line of a shell/Codex/Gemini session; Claude rows have their own preview. Not
   * a line of escapes or a pager prompt ("^[", "^[^[b", ":"): noise at a glance (QA 2026-10-12).
   */
  private lastLine(): string | undefined {
    const { lastLine, claudeStatus } = this.session;
    return lastLine &&
      !isNoiseLine(lastLine) &&
      !claudeStatus?.preview &&
      this.session.status === 'running'
      ? lastLine
      : undefined;
  }

  /** Only the exceptions, as icons in a fixed slot after the time: not shielded, pinned, muted. */
  private renderFlags() {
    const session = this.session;
    const flags: TemplateResult[] = [];
    if (this.recentlyRestored()) {
      flags.push(html`<span
        class="psr-flag"
        data-testid="psr-restored-badge"
        role="img"
        aria-label=${t('shield.restored')}
        title=${t('shield.restored')}
        >${icon('restart', 12)}</span
      >`);
    }
    const claudeUpdate = this.recentClaudeUpdate();
    if (claudeUpdate) {
      flags.push(html`<span
        class="psr-flag"
        data-testid="psr-claude-updated-badge"
        role="img"
        aria-label=${claudeUpdate}
        title=${claudeUpdate}
        >${icon('check', 12)}</span
      >`);
    }
    if (
      !session.shielded &&
      canShield(session) &&
      rowState(session) !== 'shell' &&
      !session.agentStatus
    ) {
      flags.push(html`<span
        class="psr-flag"
        data-testid="psr-unshielded-badge"
        role="img"
        aria-label=${t('phone.notShielded')}
        title=${t('phone.notShielded')}
        >${icon('shieldOff', 12)}</span
      >`);
    }
    if (this.orchestrator) {
      flags.push(html`<span
        class="psr-flag psr-flag-orch"
        data-testid="psr-orchestrator-badge"
        role="img"
        aria-label=${t('board.orchestrator')}
        title=${t('board.orchestrator')}
        >${icon('sparkles', 12)}</span
      >`);
    }
    const provider = sessionProviderMarker(session);
    if (provider) {
      flags.push(html`<ut-provider-badge
        class="psr-flag"
        data-testid="psr-provider-badge"
        .besideLogo=${true}
        .providerId=${provider.id}
        .model=${provider.model}
      ></ut-provider-badge>`);
    }
    if (this.pinned) {
      flags.push(html`<span class="psr-flag" data-testid="psr-pinned-badge" role="img" aria-label=${t('organize.pinned')}
        >${icon('pin', 12)}</span
      >`);
    }
    if (session.muted) {
      flags.push(html`<span class="psr-flag" data-testid="psr-muted-badge" role="img" aria-label=${t('organize.muted')}
        >${icon('bellOff', 12)}</span
      >`);
    }
    return flags.length ? html`<span class="psr-flags">${flags}</span>` : nothing;
  }

  /**
   * Under the title, only for a session in a terminal window on the Mac: that window ("On
   * the Mac · Terminal"), which says where it runs and that ending it closes the window. The
   * folder, branch and a given name live in its sheet («Más», renderWhere): the row is its
   * title, state, one line and time (2026-11-08, «las tarjetas de inicio son muy verbosas»).
   */
  private renderCaption(subtitle: string) {
    const session = this.session;
    if (!session.macWindow) return nothing;
    return html`<div class="psr-caption psr-mac-window" data-testid="psr-mac-window">
      <span class="psr-mac-mark" role="img" aria-label=${macWindowMarkerLabel()} title=${macWindowMarkerLabel()}
        >${icon('monitor', 12)}</span
      ><span class="psr-mac-label"
        ><bdi>${macWindowLabel(session.macWindow)}</bdi>${subtitle ? html` · <bdi>${subtitle}</bdi>` : nothing}</span
      >
    </div>`;
  }

  /**
   * The sheet's lines under the title: a name someone gave it, "untether · feat/x" (the
   * folder by its own name and the branch), and the agent's whole line when it was cut.
   */
  private renderWhere() {
    const session = this.session;
    const folder = folderLabel(session.workingDir);
    const branch = typeof session.gitBranch === 'string' ? session.gitBranch : '';
    const subtitle = this.subtitle();
    const explain = session.status === 'running' ? (session.explain?.text ?? '') : '';
    if (!subtitle && !folder && !branch && !explain) return nothing;
    return html`<div class="psr-sheet-where" data-testid="psr-sheet-where">
      ${subtitle ? html`<div class="psr-subtitle"><bdi>${subtitle}</bdi></div>` : nothing}
      ${
        folder || branch
          ? html`<div class="psr-where ut-data" dir="ltr">${[folder, branch].filter(Boolean).join(' · ')}</div>`
          : nothing
      }
      ${explain ? html`<div class="psr-sheet-explain" dir="auto">${explain}</div>` : nothing}
    </div>`;
  }

  /** A name someone gave the session, when the title is Claude's (the generated one says nothing). */
  private subtitle(): string {
    const session = this.session;
    const claudeTitle = sessionTitle(session);
    return claudeTitle && !isGeneratedSessionName(session.name, session.command)
      ? session.name
      : '';
  }

  render() {
    const session = this.session;
    const state = rowState(session);
    const tool = sessionTool(session);
    const isClaude = Boolean(session.claudeStatus) || tool === 'claude';
    const claudeTitle = sessionTitle(session);
    const title = claudeTitle || session.name || session.command?.join(' ') || '';
    const subtitle = this.subtitle();
    // The model's line about what its agent does (card-line.ts), else the status of always.
    const explain = explainLine(session);
    // The same moment as the session's agent card (utils/last-activity.ts).
    const activityAt = lastActivityAt(session);
    const timeIso = activityAt === undefined ? undefined : new Date(activityAt).toISOString();
    const time = formatRowTime(timeIso);
    // A suspended session is paused, not finished: Kill (not Clear), like a live one.
    const exited = isFinishedSession(session);
    const disconnects = this.disconnects();
    const waiting = state === 'waiting';
    const hasChoices = waiting && Boolean(waitingChoices(session)?.options.length);
    // Touch runs the action on pointerup: on iOS the first tap on a freshly revealed button
    // was often taken as a hover and produced no click at all (2026-10-02, simulator 3/3).
    // The click that may still follow is ignored; mouse and keyboard use the click.
    const swipeAction = (fn: () => void) => ({
      handleEvent: (e: Event) => {
        e.stopPropagation();
        if (e.type === 'pointerup') {
          if ((e as PointerEvent).pointerType === 'mouse') return;
          if (endsADrag(e as PointerEvent)) return;
          this.swipeActionAt = Date.now();
          swallowNextClick();
        } else if (Date.now() - this.swipeActionAt < 700) {
          return;
        }
        this.closeSwipe();
        fn();
      },
    });
    const leadingShown = this.swipeX > 0;
    const trailingShown = this.swipeX < 0;
    const fullSwipe = waiting && this.swipeX >= this.fullSwipePx();
    let replyTouchedAt = 0;
    return html`
      <div class="psr-frame" style="position: relative; overflow-x: clip; overflow-y: visible">
      <div
        class="psr-swipe-actions psr-swipe-leading ${waiting ? 'psr-swipe-answer' : ''}"
        aria-hidden=${leadingShown ? 'false' : 'true'}
        style="position: absolute; inset: 0 auto 0 0; display: flex; width: ${
          waiting ? Math.max(this.leadingWidth(), this.swipeX) : this.leadingWidth()
        }px; ${leadingShown || (this.swiping && this.swipeX > 0) ? '' : 'visibility: hidden'}"
      >
        <button
          tabindex="-1"
          data-testid="psr-swipe-pin"
          class="ut-surface--badge psr-swipe-btn ${fullSwipe ? 'psr-swipe-btn-answer' : ''}"
          @pointerup=${swipeAction(() => (fullSwipe ? this.openAnswerSheet() : this.togglePin()))}
          @click=${swipeAction(() => this.togglePin())}
        >
          ${icon(fullSwipe ? 'chevronRight' : this.pinned ? 'pinOff' : 'pin', 18)}
          <span>${fullSwipe ? t('phone.reply') : t(this.pinned ? 'phone.unpin' : 'phone.pin')}</span>
        </button>
      </div>
      <div
        class="psr-swipe-actions psr-swipe-trailing"
        aria-hidden=${trailingShown ? 'false' : 'true'}
        style="position: absolute; inset: 0 0 0 auto; display: flex; width: ${this.trailingWidth()}px; ${
          trailingShown || (this.swiping && this.swipeX < 0) ? '' : 'visibility: hidden'
        }"
      >
        <button
          tabindex="-1"
          data-testid="psr-swipe-more"
          class="ut-surface--badge psr-swipe-btn"
          @pointerup=${swipeAction(() => this.openSheet())}
          @click=${swipeAction(() => this.openSheet())}
        >
          ${icon('more', 18)}<span>${t('phone.more')}</span>
        </button>
        <button
          tabindex="-1"
          data-testid="psr-swipe-kill"
          class="ut-surface--badge psr-swipe-btn psr-swipe-btn-danger ${disconnects ? 'psr-swipe-btn-long' : ''}"
          @pointerup=${swipeAction(() => (exited ? void this.kill() : this.openSheet(true)))}
          @click=${swipeAction(() => (exited ? void this.kill() : this.openSheet(true)))}
        >
          ${icon(exited ? 'trash' : 'x', 18)}<span
            >${t(exited ? 'phoneList.swipeClear' : disconnects ? 'sessions.row.disconnect' : 'phoneList.swipeKill')}</span
          >
        </button>
      </div>
      <div
        class="psr ut-surface--material ut-surface--${state} ${this.killing ? 'psr-killing' : ''} ${this.selected ? 'psr-selected' : ''} ${this.unread ? 'psr-unread' : ''} ${hasChoices ? 'psr-has-choices' : ''}"
        data-testid="phone-session-row"
        data-state=${state}
        style="position: relative; touch-action: pan-y; ${
          this.swipeX || this.swiping
            ? `transform: translateX(${this.swipeX}px);${this.swiping ? ' transition: none;' : ''}${
                // The selected tint is translucent; keep it but don't let the actions show through.
                this.selected
                  ? ' background: linear-gradient(var(--color-selected), var(--color-selected)), var(--color-bg);'
                  : ''
              }`
            : ''
        }"
        @pointerdown=${this.handlePointerDown}
        @pointermove=${this.handlePointerMove}
        @pointerup=${this.handlePointerEnd}
        @pointercancel=${this.handlePointerEnd}
        @pointerleave=${() => this.cancelPress()}
        @contextmenu=${(e: Event) => e.preventDefault()}
        @click=${this.handleClick}
      >
        ${agentAvatar({
          variant: 'row',
          kind: rowGlyphKind(tool, isClaude),
          state,
          projectIcon: this.projectIcon,
          provider: sessionProviderMarker(session),
        })}
        <div class="psr-body">
          <div
            class="psr-main"
            role="button"
            tabindex="0"
            aria-label=${this.accessibleName(tool, title, subtitle, state, time)}
            aria-current=${this.selected ? 'true' : 'false'}
            @keydown=${(e: KeyboardEvent) => {
              if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
              e.preventDefault();
              this.handleClick();
            }}
          >
            <div class="psr-top">
              <span class="psr-title ut-mid" dir="auto">${midCutTitle(title)}</span>
              ${this.unread ? html`<span class="psr-unread-dot"></span>` : nothing}
              <span class="psr-time ${waiting ? 'psr-time-alert' : ''}"
                ><ut-row-time at=${timeIso ?? ''}></ut-row-time
              ></span>
              ${this.renderFlags()}
            </div>
            ${this.renderCaption(subtitle)}
            ${
              waiting
                ? nothing
                : html`<div class="psr-preview psr-status"><bdi>${
                    explain && !session.suspended
                      ? html`<span class="psr-explain" data-testid="row-explain">${explain}</span>`
                      : this.renderStatus(state)
                  }</bdi></div>`
            }
          </div>
          ${waiting ? this.renderNeeds() : nothing}
          ${this.renderChoices()}
          ${this.renderResume()}
          ${this.renderPreviewChip()}
          <div class="psr-live" role="status">${this.killing && disconnects ? t('sessions.row.disconnecting') : nothing}</div>
        </div>
        ${
          waiting && !hasChoices
            ? html`<button
                class="ut-surface--control ut-surface--primary psr-reply"
                data-testid="psr-reply"
                @pointerdown=${(e: Event) => e.stopPropagation()}
                @pointerup=${(e: PointerEvent) => {
                  e.stopPropagation();
                  if (e.pointerType === 'mouse' || endsADrag(e)) return;
                  replyTouchedAt = Date.now();
                  swallowNextClick();
                  this.openAnswerSheet();
                }}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  if (Date.now() - replyTouchedAt < 700) return;
                  this.openAnswerSheet();
                }}
              >
                ${t('phone.reply')}
              </button>`
            : html`<button
                class="ut-surface--control ut-surface--compact psr-menu"
                aria-label=${t('a11y.row.actions', { name: title })}
                aria-haspopup="dialog"
                @pointerdown=${(e: Event) => e.stopPropagation()}
                @click=${this.handleMenuClick}
              >
                ${icon('more', 20)}
              </button>`
        }
      </div>
      </div>
    `;
  }
}
