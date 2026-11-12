/**
 * Share with phone (shared/mac-share.ts): an idle Claude Code in a plain Terminal or iTerm2
 * tab is closed there with one SIGTERM and reopened in the same tab through ut, with
 * `--resume <its id>`, so the same conversation runs on the Mac and on the phone.
 *
 * plan(id) checks everything it can without changing anything, probes that exact tab with
 * AppleScript, and gives a single-use token bound to that plan (120 s). start(token) runs the
 * job, one per agent and per tty:
 *
 *   checking → probing → closing → closed → [waiting-unlock] → typing → starting → [trust]
 *   checking → closing → closed → opening → starting → [trust]                (new-window)
 *
 * - checking: the plan's checks again, fresh; Claude idle for 3 s by its own clock and the
 *   transcript unchanged for 2 s.
 * - probing: screen unlocked, then the same tab found again, still running the agent.
 * - closing: a last read of the session file, then one SIGTERM to the verified pid. Never
 *   SIGKILL, never a process group, never a second signal: if it hasn't exited in 10 s the job
 *   ends `still-running` and nothing else is done. From here the conversation counts as live
 *   (pendingConversations), so History and resume never open it a second time meanwhile.
 * - closed: the shell has the tab's foreground back and the transcript is at least as long as
 *   before, ending in a whole line. Probe P1 (Claude Code 2.1.289, our own pty): SIGTERM exits
 *   in 0.93 s, removes the session file at 0.33 s, appends one whole line to the transcript,
 *   leaves the alternate screen and turns the cursor, bracketed paste, mouse, focus and
 *   keyboard-protocol modes back (`?1049l ?25h ?2004l ?1000-1006l ?1004l <u >4m`), restores
 *   cooked mode, and prints "Resume this session with: claude --resume <id>" (so a tab whose
 *   share fails still shows how to continue). SIGINT behaves the same with exit code 0.
 * - waiting-unlock: the Mac locked after the close and no new window can be opened (a shell
 *   with no known path). Every Apple Event hangs while locked, so nothing is sent; the job
 *   waits up to 15 min for the unlock, then gives the command.
 * - typing: lock check, the shell still in the foreground, the same tab probed, then the line
 *   typed. A typing that times out may still be delivered when the Mac answers: the job keeps
 *   watching (`relaunch-unknown`) and tells the user to check the tab first.
 * - starting: a `fwd_` session of this server, started after the typing, running this
 *   conversation. A Claude on that tty that isn't under ut reopened on the Mac only.
 * - trust: the exact trust dialog of the same folder is confirmed (cursor moved and verified,
 *   then Enter); any other dialog is left to the user on the phone.
 *
 * new-window (owner's decision, 2026-10-04): with the Mac locked, the plan doesn't refuse. It
 * reports `mode: 'new-window'`, runs no AppleScript (so the draft check, which reads the tab,
 * can't run: the sheet warns instead), and the job closes the agent the same way and then
 * reopens it in a new Terminal window through LaunchServices (new-window.ts). The old tab is
 * left at its shell prompt. A same-tab job whose Mac locks before the typing turns new-window
 * too (probing, or typing before anything was sent), instead of waiting for the unlock. A
 * typing that was sent and not confirmed never does: it may still be delivered.
 *
 * Every AppleScript step checks the screen lock first, and every osascript is killed at 5 s.
 * The log names the job, app, tty, step and outcome: never the command, flags, folder or
 * screen.
 */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isForwardedSession } from '../../../shared/forwarded-session.js';
import type {
  MacAgentKind,
  MacAgentSession,
  MacLiveConversation,
} from '../../../shared/mac-sessions.js';
import { isMacSessionId } from '../../../shared/mac-sessions.js';
import {
  isMacShareToken,
  MAC_SHARE_APPS,
  MAC_SHARE_PLAN_TTL_MS,
  MAC_SHARE_UNLOCK_WAIT_MIN,
  type MacShareApp,
  type MacShareAvailability,
  type MacShareErrorCode,
  type MacShareFailReason,
  type MacShareJob,
  type MacShareMode,
  type MacSharePlan,
  type MacShareStatus,
  type MacShareStep,
} from '../../../shared/mac-share.js';
import type { SessionInfo } from '../../../shared/types.js';
import { createLogger } from '../../utils/logger.js';
import type { ProcessTable } from '../claude-chat.js';
import type { ScreenMenu } from '../screen-menu.js';
import { NEW_WINDOW_APP, newWindowCommand, shellPathFor } from './new-window.js';
import type { OsascriptOutcome, OsascriptRunner } from './osascript.js';
import { ancestors, hostAppOf, isForwarderArgs } from './process-tree.js';
import { buildRelaunchCommand, type RelaunchFs, realRelaunchFs } from './relaunch-command.js';
import type { MacSessionsScanner } from './scanner.js';
import type { ScreenLockState } from './screen-lock.js';
import {
  agentGone,
  type ClaudeSessionRecord,
  claudeTranscriptPath,
  hasBackgroundWork,
  hasPromptDraft,
  idleProblem,
  readClaudeSessionRecord,
  type ShellJob,
  shellHasForeground,
  shellJobOf,
  type TranscriptState,
  transcriptState,
} from './share-checks.js';
import type { MacShareSettings } from './share-settings.js';
import {
  outcomeProblem,
  type ProbeResult,
  parseProbe,
  parseType,
  probeArgs,
  probeProblem,
  sameTab,
  type TabRef,
  typeArgs,
} from './terminal-scripts.js';

const logger = createLogger('mac-share');

/** HTTP status of each error the share API answers with. */
export const MAC_SHARE_HTTP_STATUS: Record<MacShareErrorCode, number> = {
  'bad-id': 400,
  'bad-token': 400,
  'no-auth': 403,
  gone: 404,
  disabled: 503,
  busy: 409,
  waiting: 409,
  'background-work': 409,
  draft: 409,
  'no-conversation': 409,
  'cwd-missing': 409,
  'in-progress': 409,
  locked: 409,
  'tab-not-found': 409,
  'tab-ambiguous': 409,
  unresponsive: 409,
  'automation-ask': 409,
  'automation-denied': 409,
  'automation-pending': 409,
  'plan-expired': 409,
  'plan-changed': 409,
  'not-shareable': 422,
  'agent-not-supported': 422,
  'unsupported-app': 422,
  'unsupported-shell': 422,
  'not-shell-job': 422,
  'unsafe-value': 422,
};

export class MacShareError extends Error {
  readonly status: number;
  constructor(
    readonly code: MacShareErrorCode,
    /** unsupported-shell: the tab's shell, as a safe name ("tcsh"). */
    readonly shell?: string
  ) {
    super(code);
    this.name = 'MacShareError';
    this.status = MAC_SHARE_HTTP_STATUS[code];
  }
}

// Timings (ms unless named otherwise).
export const IDLE_SETTLE_MS = 3_000;
export const IDLE_WAIT_MS = 10_000;
export const TRANSCRIPT_STABLE_MS = 2_000;
export const EXIT_WAIT_MS = 10_000;
export const SHELL_BACK_WAIT_MS = 3_000;
export const UNLOCK_POLL_MS = 2_000;
export const START_POLL_MS = 500;
export const TRUST_WAIT_MS = 60_000;
export const WATCH_MS = 10 * 60_000;
export const JOB_KEEP_MS = 15 * 60_000;
/** A Claude seen on that tty without our session this long is concluded to be elsewhere. */
const ELSEWHERE_GRACE_MS = 3_000;
const POLL_MS = 250;
const EXIT_POLL_MS = 100;

/** The exact first-run dialog answered for a folder the conversation already ran in. */
const TRUST_DIALOGS: Partial<Record<MacAgentKind, { options: string[]; yes: number }>> = {
  claude: { options: ['No, exit', 'Yes, I trust this folder'], yes: 1 },
};

/** The fwd_ sessions this server lists, as the job looks for the reopened agent. */
export type ShareUtSession = Pick<
  SessionInfo,
  'id' | 'command' | 'workingDir' | 'status' | 'startedAt' | 'claudeSessionId'
>;

export interface MacShareDeps {
  settings(): MacShareSettings;
  scanner: Pick<MacSessionsScanner, 'resolve' | 'invalidate' | 'liveClaudeConversations'>;
  /** A `ps` read now, never the shared 2 s cache. */
  freshTable(): Promise<ProcessTable>;
  screenLock(): Promise<ScreenLockState>;
  runner: Pick<OsascriptRunner, 'run'>;
  /** The one signal this feature ever sends. */
  sigterm(pid: number): void;
  /**
   * new-window: writes the `.command` file and hands it to the app (no AppleScript). Required,
   * so a test can never reach the real `open`.
   */
  openWindow(app: MacShareApp, command: string): Promise<boolean>;
  /** This server's sessions (ptyManager.listSessions()). */
  utSessions(): ShareUtSession[];
  /** Reading and answering the menu on a session's screen, and pressing Enter there. */
  screen: Pick<ScreenMenu, 'read' | 'moveCursor'> & { pressEnter(sessionId: string): void };
  /** This server's control dir, and the one `ut` uses when nothing says otherwise. */
  controlDir: string;
  defaultControlDir: string;
  readSession?: (claudeDir: string, pid: number, lstart: string) => ClaudeSessionRecord | null;
  transcriptPath?: (claudeDir: string, cwd: string, id: string) => string | null;
  transcript?: (file: string, id: string) => TranscriptState | null;
  relaunchFs?: RelaunchFs;
  realpath?: (folder: string) => string;
  platform?: NodeJS.Platform;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  randomToken?: () => string;
}

interface PlanRecord {
  token: string;
  expiresAt: number;
  macId: string;
  pid: number;
  lstart: string;
  agent: MacAgentKind;
  app: MacShareApp;
  tty: string;
  shellPid: number;
  shellPgid: number;
  claudeDir: string;
  conversationId: string;
  cwd: string;
  transcript: string;
  /** The probed tab; null for a new-window plan, which never probes. */
  tab: TabRef | null;
  mode: MacShareMode;
  /** The relaunch line: typed into the tab, run in a new window, or shown after a failure. */
  command: string;
  /** What a new window runs, when one can be opened (a known shell path). */
  windowCommand: string | null;
  public: MacSharePlan;
}

interface JobRecord {
  job: MacShareJob;
  plan: PlanRecord;
  key: { agent: string; tty: string };
  endedAt?: number;
  /** The transcript's size when it was last seen idle, before the close. */
  size?: number;
  /** When the line was typed (or its typing given up on). */
  typedAt?: number;
}

const FINAL: ReadonlySet<MacShareJob['state']> = new Set([
  'shared',
  'aborted',
  'still-running',
  'failed-after-close',
]);

class JobEnd extends Error {
  constructor(
    readonly state: MacShareJob['state'],
    readonly detail: { error?: MacShareErrorCode; reason?: MacShareFailReason } = {}
  ) {
    super(state);
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const token = () => randomBytes(16).toString('base64url');

function realpathOr(folder: string): string {
  try {
    return fs.realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
}

export class MacShare {
  private readonly plans = new Map<string, PlanRecord>();
  private readonly jobs = new Map<string, JobRecord>();
  /** Tokens already started, so a repeated start answers the same job. */
  private readonly started = new Map<string, { jobId: string; macId: string; at: number }>();
  /** Apps scripted successfully in this server run: no explainer needed for them. */
  private readonly scripted = new Set<MacShareApp>();
  private disposed = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: MacShareDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
  }

  /** GET /api/mac-sessions `share`. */
  status(): MacShareStatus {
    const settings = this.deps.settings();
    return settings.enabled
      ? { enabled: true }
      : { enabled: false, ...(settings.reason ? { reason: settings.reason } : {}) };
  }

  /** The row's `share` (cheap: no AppleScript, no ps). Undefined while the feature is off. */
  availability(row: MacAgentSession): MacShareAvailability | undefined {
    const settings = this.deps.settings();
    if (!settings.enabled) return undefined;
    const running = this.jobFor(row.id);
    if (running) return { can: false, reason: 'in-progress', jobId: running.job.id };
    if (row.agent !== 'claude') return { can: false, reason: 'agent-off' };
    if (row.inTmux) return { can: false, reason: 'in-tmux' };
    if (!MAC_SHARE_APPS.includes(row.app as MacShareApp)) {
      return { can: false, reason: 'unsupported-app' };
    }
    if (row.status?.status === 'busy') return { can: false, reason: 'busy' };
    if (row.status?.status === 'waiting') return { can: false, reason: 'waiting' };
    return { can: true };
  }

  /** Conversations closed by a share and not reopened yet: History and resume treat them live. */
  pendingConversations(): Map<string, MacLiveConversation> {
    const pending = new Map<string, MacLiveConversation>();
    for (const record of this.jobs.values()) {
      if (record.job.closed && !FINAL.has(record.job.state)) {
        pending.set(record.plan.conversationId, { where: 'terminal', app: record.plan.app });
      }
    }
    return pending;
  }

  /** Stops every job before its next step (the server is going down). */
  dispose(): void {
    this.disposed = true;
  }

  // ── plan ──────────────────────────────────────────────────────────────────────────────

  async plan(macId: string, options: { allowPrompt?: boolean } = {}): Promise<MacSharePlan> {
    this.prune();
    const settings = this.deps.settings();
    if (settings.reason === 'no-auth') throw new MacShareError('no-auth');
    if (!settings.enabled) throw new MacShareError('disabled');
    if (!isMacSessionId(macId) || !macId.startsWith('a-')) throw new MacShareError('bad-id');
    const target = await this.deps.scanner.resolve(macId);
    if (!target) throw new MacShareError('gone');
    if (target.kind !== 'agent') throw new MacShareError('not-shareable');
    // Only Claude: nothing is prepared for another agent.
    if (target.agent !== 'claude') throw new MacShareError('agent-not-supported');
    if (this.jobFor(macId)) throw new MacShareError('in-progress');

    const table = await this.deps.freshTable();
    const app = hostAppOf(table, target.pid, this.deps.platform ?? process.platform);
    if (app !== 'Terminal' && app !== 'iTerm') throw new MacShareError('unsupported-app');
    const job = this.shellJob(table, target.pid, target.lstart);
    if ([...this.jobs.values()].some((r) => !r.endedAt && r.key.tty === job.tty)) {
      throw new MacShareError('in-progress');
    }
    const claudeDir = target.claudeDir ?? '';
    const record = this.idleRecord(claudeDir, job);
    const conversationId = record.sessionId as string;
    if (hasBackgroundWork(table, job.pid)) throw new MacShareError('background-work');
    const cwd = record.cwd ?? target.cwd ?? '';
    const transcript = (this.deps.transcriptPath ?? claudeTranscriptPath)(
      claudeDir,
      cwd,
      conversationId
    );
    if (!transcript) throw new MacShareError('no-conversation');
    const state = (this.deps.transcript ?? transcriptState)(transcript, conversationId);
    if (!state) throw new MacShareError('no-conversation');
    if (!state.flushed) throw new MacShareError('busy');

    const built = buildRelaunchCommand(
      {
        agent: target.agent,
        args: job.args,
        conversationId,
        cwd,
        shell: job.shellArg0,
        launcher: settings.launcher,
        ...(settings.utPath ? { utPath: settings.utPath } : {}),
        controlDir: this.deps.controlDir,
        defaultControlDir: this.deps.defaultControlDir,
      },
      this.deps.relaunchFs ?? realRelaunchFs
    );
    if (!built.ok) throw new MacShareError(built.error, built.shellName);
    const relaunchFs = this.deps.relaunchFs ?? realRelaunchFs;
    const shellPath = shellPathFor(built.shell, job.shellArg0, (file) =>
      relaunchFs.isExecutableFile(file)
    );
    const windowCommand = shellPath ? newWindowCommand(cwd, shellPath, built.command) : null;

    // Locked: no AppleScript at all (it would hang). It reopens in a new window, so the tab is
    // never probed and its draft can't be checked (the sheet says so).
    const locked = (await this.deps.screenLock()).locked;
    if (locked && !windowCommand) throw new MacShareError('locked');
    let tab: TabRef | null = null;
    if (!locked) {
      // Nothing runs AppleScript until the phone showed what macOS will ask.
      if (!options.allowPrompt && !this.scripted.has(app)) {
        throw new MacShareError('automation-ask');
      }
      const probe = await this.probe(app, job.tty, target.agent, true);
      if (app === 'Terminal' && probe.busy === false) throw new MacShareError('tab-not-found');
      if (hasPromptDraft(probe.contents)) throw new MacShareError('draft');
      tab = probe.tab;
    }
    const mode: MacShareMode = locked ? 'new-window' : 'same-tab';

    const expiresAt = this.now() + MAC_SHARE_PLAN_TTL_MS;
    const planToken = (this.deps.randomToken ?? token)();
    const plan: MacSharePlan = {
      token: planToken,
      expiresAt: new Date(expiresAt).toISOString(),
      agent: target.agent,
      app,
      tty: job.tty,
      cwd,
      conversationId,
      mode,
      ...(mode === 'new-window' ? { windowApp: NEW_WINDOW_APP[app] } : {}),
      command: mode === 'new-window' && windowCommand ? windowCommand : built.command,
      kept: built.kept,
      dropped: built.dropped,
      ...(built.droppedPrompt ? { droppedPrompt: true } : {}),
      warnings: built.warnings,
    };
    // A new plan for the same agent replaces its old token.
    for (const [key, old] of this.plans) if (old.macId === macId) this.plans.delete(key);
    this.plans.set(planToken, {
      token: planToken,
      expiresAt,
      macId,
      pid: job.pid,
      lstart: job.lstart,
      agent: target.agent,
      app,
      tty: job.tty,
      shellPid: job.shellPid,
      shellPgid: job.shellPgid,
      claudeDir,
      conversationId,
      cwd,
      transcript,
      tab,
      mode,
      command: built.command,
      windowCommand,
      public: plan,
    });
    this.log(`plan ${app} ${job.tty}: ready (${mode})`);
    return plan;
  }

  // ── start and poll ────────────────────────────────────────────────────────────────────

  /**
   * Starts the job of a plan (of the row `macId`, when given); the same token, agent or tty
   * again gives the running job.
   */
  async start(planToken: unknown, macId?: string): Promise<{ jobId: string }> {
    this.prune();
    const settings = this.deps.settings();
    if (settings.reason === 'no-auth') throw new MacShareError('no-auth');
    if (!settings.enabled) throw new MacShareError('disabled');
    if (!isMacShareToken(planToken)) throw new MacShareError('bad-token');
    const again = this.started.get(planToken);
    if (again && (macId === undefined || again.macId === macId)) return { jobId: again.jobId };
    const plan = this.plans.get(planToken);
    if (plan && macId !== undefined && plan.macId !== macId) throw new MacShareError('bad-token');
    if (!plan || plan.expiresAt <= this.now()) {
      this.plans.delete(planToken);
      throw new MacShareError('plan-expired');
    }
    this.plans.delete(planToken);
    const running = [...this.jobs.values()].find(
      (r) => !r.endedAt && (r.key.agent === `${plan.pid}|${plan.lstart}` || r.key.tty === plan.tty)
    );
    if (running) return { jobId: running.job.id };
    const table = await this.deps.freshTable();
    if (agentGone(table, plan.pid, plan.lstart)) throw new MacShareError('plan-changed');

    const id = (this.deps.randomToken ?? token)();
    const record: JobRecord = {
      plan,
      key: { agent: `${plan.pid}|${plan.lstart}`, tty: plan.tty },
      job: {
        id,
        state: 'running',
        step: 'checking',
        closed: false,
        agent: plan.agent,
        app: plan.app,
        mode: plan.mode,
        ...(plan.mode === 'new-window' ? { windowApp: NEW_WINDOW_APP[plan.app] } : {}),
        updatedAt: new Date(this.now()).toISOString(),
      },
    };
    this.jobs.set(id, record);
    this.started.set(planToken, { jobId: id, macId: plan.macId, at: this.now() });
    void this.run(record);
    return { jobId: id };
  }

  job(jobId: string): MacShareJob | undefined {
    this.prune();
    const record = this.jobs.get(jobId);
    return record ? { ...record.job } : undefined;
  }

  // ── the job ───────────────────────────────────────────────────────────────────────────

  private async run(record: JobRecord): Promise<void> {
    const { plan } = record;
    try {
      const shell = await this.checking(record);
      await this.probing(record);
      await this.closing(record, shell);
      await this.afterClose(record, shell);
      if (record.job.mode === 'same-tab') {
        const typed = await this.typing(record, shell);
        if (typed === 'unknown') {
          this.set(record, { state: 'relaunch-unknown', reason: 'unconfirmed' });
          await this.watch(record, 'unconfirmed');
          return;
        }
        if (typed === 'locked') this.toNewWindow(record);
      }
      if (record.job.mode === 'new-window') await this.opening(record);
      const found = await this.starting(record);
      if (!found) {
        this.set(record, {
          state: 'relaunch-unknown',
          reason: 'timeout',
          seconds: this.deps.settings().startTimeoutSec,
        });
        await this.watch(record, 'timeout');
        return;
      }
      await this.trust(record, found);
    } catch (error) {
      if (error instanceof JobEnd) {
        this.end(record, error.state, error.detail);
      } else {
        logger.warn(`share ${plan.app} ${plan.tty}: ${(error as Error)?.name ?? 'error'}`);
        this.end(
          record,
          record.job.closed ? 'failed-after-close' : 'aborted',
          record.job.closed ? { reason: 'unresponsive' } : { error: 'unresponsive' }
        );
      }
    }
  }

  /** Plan checks again, fresh; idle held for 3 s, and the transcript still for 2 s. */
  private async checking(record: JobRecord): Promise<ShellJob> {
    const { plan } = record;
    this.step(record, 'checking');
    const deadline = this.now() + IDLE_WAIT_MS;
    let lastSize = -1;
    let sizeSince = 0;
    for (;;) {
      this.alive();
      const table = await this.deps.freshTable();
      const job = this.abortOn(() => this.shellJob(table, plan.pid, plan.lstart));
      if (job.tty !== plan.tty || job.shellPid !== plan.shellPid) throw this.abort('plan-changed');
      const session = this.abortOn(() => this.idleRecord(plan.claudeDir, job));
      if (session.sessionId !== plan.conversationId) throw this.abort('plan-changed');
      if (hasBackgroundWork(table, job.pid)) throw this.abort('background-work');
      const state = (this.deps.transcript ?? transcriptState)(plan.transcript, plan.conversationId);
      if (!state) throw this.abort('no-conversation');
      const now = this.now();
      if (state.size !== lastSize) {
        lastSize = state.size;
        sizeSince = now;
      }
      const idleFor = now - (session.statusUpdatedAt ?? 0);
      if (state.flushed && idleFor >= IDLE_SETTLE_MS && now - sizeSince >= TRANSCRIPT_STABLE_MS) {
        record.size = state.size;
        return job;
      }
      if (now >= deadline) throw this.abort('busy');
      await this.sleep(POLL_MS);
    }
  }

  /**
   * The same tab, found again with the screen unlocked, still running the agent. A new-window
   * job skips it; a same-tab one whose Mac is locked now turns new-window (when it can).
   */
  private async probing(record: JobRecord): Promise<void> {
    const { plan } = record;
    if (record.job.mode === 'new-window') return;
    this.step(record, 'probing');
    this.alive();
    if (plan.windowCommand && (await this.deps.screenLock()).locked) {
      this.toNewWindow(record);
      return;
    }
    await this.abortOnAsync(() => this.requireUnlocked());
    let probe: Extract<ProbeResult, { kind: 'found' }>;
    try {
      probe = await this.probe(plan.app, plan.tty, plan.agent, true);
    } catch (error) {
      // It locked while probing (the probe only reads): reopen in a new window instead.
      if (error instanceof MacShareError && error.code === 'locked' && plan.windowCommand) {
        this.toNewWindow(record);
        return;
      }
      if (error instanceof MacShareError) throw this.abort(error.code);
      throw error;
    }
    if (!plan.tab || !sameTab(probe.tab, plan.tab)) throw this.abort('plan-changed');
    if (plan.app === 'Terminal' && probe.busy === false) throw this.abort('tab-not-found');
    if (hasPromptDraft(probe.contents)) throw this.abort('draft');
  }

  /** One SIGTERM, right after a last idle read; then wait for the exit. Never SIGKILL. */
  private async closing(record: JobRecord, shell: ShellJob): Promise<void> {
    const { plan } = record;
    this.step(record, 'closing');
    this.alive();
    const table = await this.deps.freshTable();
    if (agentGone(table, plan.pid, plan.lstart)) throw this.abort('gone');
    // The last read, right before the signal (about a millisecond).
    const last = this.abortOn(() => this.idleRecord(plan.claudeDir, shell));
    if (last.sessionId !== plan.conversationId) throw this.abort('plan-changed');
    record.job.closed = true;
    record.job.resumeCommand = plan.command;
    this.deps.sigterm(plan.pid);
    this.log(`share ${plan.app} ${plan.tty}: SIGTERM sent`);
    const deadline = this.now() + EXIT_WAIT_MS;
    for (;;) {
      await this.sleep(EXIT_POLL_MS);
      const now = await this.deps.freshTable();
      if (agentGone(now, plan.pid, plan.lstart)) return;
      if (this.now() >= deadline) {
        // It is still running, with its conversation: nothing more is done to it.
        record.job.closed = false;
        delete record.job.resumeCommand;
        throw new JobEnd('still-running');
      }
    }
  }

  /** The shell has its tab back and the transcript is whole; then wait out a locked screen. */
  private async afterClose(record: JobRecord, shell: ShellJob): Promise<void> {
    const { plan } = record;
    this.step(record, 'closed');
    // 2026-10-04: a new window doesn't need the old tab's shell; waiting for it failed a share
    // whose agent was started by a script (QA), which ends instead of giving a prompt back.
    const deadline = this.now() + SHELL_BACK_WAIT_MS;
    for (;;) {
      if (record.job.mode === 'new-window') break;
      const table = await this.deps.freshTable();
      if (shellHasForeground(table, shell)) break;
      if (this.now() >= deadline) throw this.fail('shell-busy');
      await this.sleep(EXIT_POLL_MS);
    }
    const size = record.size ?? 0;
    const state = (this.deps.transcript ?? transcriptState)(plan.transcript, plan.conversationId);
    if (!state?.flushed || state.size < size) throw this.fail('transcript');
    if ((this.deps.readSession ?? readClaudeSessionRecord)(plan.claudeDir, plan.pid, plan.lstart)) {
      this.log(`share ${plan.app} ${plan.tty}: its session file is still there`);
    }
  }

  /** Waits for the screen to be unlocked, up to 15 min after the close. */
  private async waitUnlocked(record: JobRecord): Promise<void> {
    let lock = await this.deps.screenLock();
    if (!lock.locked) return;
    this.step(record, 'waiting-unlock');
    const deadline = this.now() + MAC_SHARE_UNLOCK_WAIT_MIN * 60_000;
    while (lock.locked) {
      if (this.now() >= deadline) throw this.fail('locked');
      await this.sleep(UNLOCK_POLL_MS);
      this.alive();
      lock = await this.deps.screenLock();
    }
  }

  /**
   * Types the line into the same tab: 'typed', 'unknown' when the app never answered, or
   * 'locked' when the Mac locked before anything was sent and a new window can be opened.
   */
  private async typing(
    record: JobRecord,
    shell: ShellJob
  ): Promise<'typed' | 'unknown' | 'locked'> {
    const { plan } = record;
    if (await this.lockedForWindow(record)) return 'locked';
    this.step(record, 'typing');
    this.alive();
    // Opened again somewhere meanwhile (History, a resume): typing would make a second writer.
    const live = await this.deps.scanner.liveClaudeConversations().catch(() => null);
    if (live?.has(plan.conversationId)) throw this.fail('already-open');
    const table = await this.deps.freshTable();
    if (!shellHasForeground(table, shell)) throw this.fail('shell-busy');

    // The probe checks the lock again; a lock now means a new window (or waiting), not failing.
    if (await this.lockedForWindow(record)) return 'locked';
    this.step(record, 'typing');
    let probe: Extract<ProbeResult, { kind: 'found' }>;
    try {
      probe = await this.probe(plan.app, plan.tty, plan.agent, false);
    } catch (error) {
      const code = error instanceof MacShareError ? error.code : undefined;
      if (code === 'locked' && plan.windowCommand) return 'locked';
      throw this.fail(afterCloseReason(code));
    }
    if (!plan.tab || !sameTab(probe.tab, plan.tab)) throw this.fail('tab-gone');
    if (plan.app === 'Terminal' && (probe.busy || probe.agentPresent))
      throw this.fail('shell-busy');

    if (await this.lockedForWindow(record)) return 'locked';
    this.step(record, 'typing');
    const call = typeArgs(plan.tab, plan.tty, plan.agent, plan.command);
    if (!call) throw this.fail('refused');
    record.typedAt = this.now();
    const outcome = await this.deps.runner.run(plan.app, call.script, call.args);
    // Killed at 5 s, or AppleScript's own timeout (-1712): the event was sent and may still be
    // delivered when the app answers (P4 settles whether a killed one is).
    if (
      outcome.kind === 'timeout' ||
      outcome.kind === 'disposed' ||
      (outcome.kind === 'error' && outcome.error === 'event-timeout')
    ) {
      this.log(`share ${plan.app} ${plan.tty}: typing not confirmed`);
      return 'unknown';
    }
    if (outcome.kind !== 'ok') throw this.fail(typingReason(outcome));
    const result = parseType(outcome.stdout);
    switch (result) {
      case 'typed':
        this.scripted.add(plan.app);
        this.log(`share ${plan.app} ${plan.tty}: typed`);
        return 'typed';
      case 'moved':
      case 'gone':
      case 'not-running':
        throw this.fail('tab-gone');
      case 'busy':
      case 'agent-running':
        throw this.fail('shell-busy');
      default:
        throw this.fail('refused');
    }
  }

  /**
   * Locked, before anything was typed: true when a new window can be opened instead. Without
   * one (no shell path), it waits for the unlock as before and answers false.
   */
  private async lockedForWindow(record: JobRecord): Promise<boolean> {
    if (!(await this.deps.screenLock()).locked) return false;
    if (record.plan.windowCommand) return true;
    await this.waitUnlocked(record);
    return false;
  }

  private toNewWindow(record: JobRecord): void {
    const { plan } = record;
    this.set(record, { mode: 'new-window', windowApp: NEW_WINDOW_APP[plan.app] });
    this.log(`share ${plan.app} ${plan.tty}: locked, reopening in a new window`);
  }

  /**
   * new-window: hands the `.command` file to the app through LaunchServices. No AppleScript:
   * the old tab is neither read nor typed into, and stays at its shell prompt.
   */
  private async opening(record: JobRecord): Promise<void> {
    const { plan } = record;
    this.step(record, 'opening');
    this.alive();
    // Opened again somewhere meanwhile (History, a resume): a new window would be a second writer.
    const live = await this.deps.scanner.liveClaudeConversations().catch(() => null);
    if (live?.has(plan.conversationId)) throw this.fail('already-open');
    if (!plan.windowCommand) throw this.fail('window-failed');
    const app = NEW_WINDOW_APP[plan.app];
    record.typedAt = this.now();
    const opened = await this.deps.openWindow(app, plan.windowCommand).catch(() => false);
    if (!opened) throw this.fail('window-failed');
    this.log(`share ${plan.app} ${plan.tty}: new ${app} window opened`);
  }

  /** Waits for the reopened agent: our fwd_ session, or a Claude elsewhere on that tty. */
  private async starting(record: JobRecord): Promise<ShareUtSession | null> {
    this.step(record, 'starting');
    const limit = this.deps.settings().startTimeoutSec * 1000;
    return this.lookFor(record, this.now() + limit);
  }

  /**
   * Polls until `deadline` for the reopened agent. Ours → the session. Seen on the tty but not
   * under ut, or under another Untether → the job fails with that reason (it runs on the Mac
   * with its conversation; nothing is lost).
   */
  private async lookFor(record: JobRecord, deadline: number): Promise<ShareUtSession | null> {
    const { plan } = record;
    const since = (record.typedAt ?? this.now()) - 2_000;
    let elsewhereSince: number | undefined;
    for (;;) {
      this.alive();
      const ours = this.deps
        .utSessions()
        .find(
          (session) =>
            isForwardedSession(session) &&
            session.status === 'running' &&
            Date.parse(session.startedAt) >= since &&
            (session.claudeSessionId === plan.conversationId ||
              session.command.some((word) => word.includes(plan.conversationId)))
        );
      if (ours) return ours;
      const elsewhere = await this.onTty(record);
      if (elsewhere) {
        elsewhereSince ??= this.now();
        if (this.now() - elsewhereSince >= ELSEWHERE_GRACE_MS) {
          throw this.fail(elsewhere === 'ut' ? 'other-instance' : 'not-shared');
        }
      } else {
        elsewhereSince = undefined;
      }
      if (this.now() >= deadline) return null;
      await this.sleep(START_POLL_MS);
    }
  }

  /**
   * A Claude on the plan's tty (any tty, for a new window) running this conversation: under a
   * ut forwarder or not.
   */
  private async onTty(record: JobRecord): Promise<'ut' | 'bare' | null> {
    const { plan } = record;
    const anyTty = record.job.mode === 'new-window';
    const table = await this.deps.freshTable();
    const read = this.deps.readSession ?? readClaudeSessionRecord;
    for (const [pid, info] of table.procs) {
      if ((!anyTty && info.tty !== plan.tty) || !info.tty || pid === plan.pid) continue;
      const lstart = table.starts.get(pid);
      if (!lstart) continue;
      const session = read(plan.claudeDir, pid, lstart);
      if (session?.sessionId !== plan.conversationId) continue;
      const underUt = ancestors(table, pid).some((p) => isForwarderArgs(table.args.get(p) ?? ''));
      return underUt ? 'ut' : 'bare';
    }
    return null;
  }

  /** After a typing or a start that wasn't confirmed: keep looking for 10 minutes. */
  private async watch(record: JobRecord, reason: 'unconfirmed' | 'timeout'): Promise<void> {
    const found = await this.lookFor(record, this.now() + WATCH_MS);
    if (!found) throw new JobEnd('failed-after-close', { reason });
    await this.trust(record, found);
  }

  /** The reopened session: confirm the trust dialog of the same folder, then it's shared. */
  private async trust(record: JobRecord, session: ShareUtSession): Promise<void> {
    const { plan } = record;
    const settings = this.deps.settings();
    const dialog = TRUST_DIALOGS[plan.agent];
    const realpath = this.deps.realpath ?? realpathOr;
    const sameFolder = realpath(session.workingDir) === realpath(plan.cwd);
    const deadline = this.now() + TRUST_WAIT_MS;
    let answered = false;
    for (;;) {
      this.alive();
      const current = this.deps.utSessions().find((s) => s.id === session.id);
      if (current?.status !== 'running') throw this.fail('exited');
      const menu = await this.deps.screen.read(session.id).catch(() => null);
      if (menu) {
        const isTrust = !!dialog && JSON.stringify(menu.options) === JSON.stringify(dialog.options);
        if (!isTrust) return this.shared(record, session.id, 'answer');
        if (!settings.autoTrust || !sameFolder) return this.shared(record, session.id, 'trust');
        if (!answered) {
          this.step(record, 'trust');
          answered = true;
          if (!(await this.deps.screen.moveCursor(session.id, menu, dialog.yes))) {
            return this.shared(record, session.id, 'trust');
          }
          this.deps.screen.pressEnter(session.id);
          this.log(`share ${plan.app} ${plan.tty}: trust dialog of the same folder confirmed`);
        }
      } else if (await this.agentReady(record)) {
        return this.shared(record, session.id);
      }
      if (this.now() >= deadline) {
        return this.shared(record, session.id, menu ? (answered ? 'trust' : 'answer') : undefined);
      }
      await this.sleep(START_POLL_MS);
    }
  }

  /** The reopened Claude wrote its session file: it is past its startup dialogs. */
  private async agentReady(record: JobRecord): Promise<boolean> {
    const { plan } = record;
    const anyTty = record.job.mode === 'new-window';
    const table = await this.deps.freshTable();
    const read = this.deps.readSession ?? readClaudeSessionRecord;
    for (const [pid, info] of table.procs) {
      if ((!anyTty && info.tty !== plan.tty) || !info.tty || pid === plan.pid) continue;
      const lstart = table.starts.get(pid);
      const session = lstart ? read(plan.claudeDir, pid, lstart) : null;
      if (session?.sessionId === plan.conversationId && session.status) return true;
    }
    return false;
  }

  private shared(record: JobRecord, sessionId: string, needs?: 'trust' | 'answer'): void {
    record.job.sessionId = sessionId;
    if (needs) record.job.needs = needs;
    this.end(record, 'shared');
    this.deps.scanner.invalidate();
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────

  private shellJob(table: ProcessTable, pid: number, lstart: string): ShellJob {
    const job = shellJobOf(table, pid, lstart);
    if ('problem' in job) throw new MacShareError(job.problem);
    return job;
  }

  /** The fresh session file of the agent, which must be idle with a conversation. */
  private idleRecord(claudeDir: string, job: ShellJob): ClaudeSessionRecord {
    const record = (this.deps.readSession ?? readClaudeSessionRecord)(
      claudeDir,
      job.pid,
      job.lstart
    );
    const problem = idleProblem(record);
    if (problem) throw new MacShareError(problem);
    return record as ClaudeSessionRecord;
  }

  /** Throws `locked` unless the screen is known unlocked or unknown (the 5 s kill covers it). */
  private async requireUnlocked(): Promise<void> {
    const lock = await this.deps.screenLock();
    if (lock.locked) throw new MacShareError('locked');
  }

  /** Probes the tab of `tty`; a refusal, a hang or no single tab throw the plan's error. */
  private async probe(
    app: MacShareApp,
    tty: string,
    agent: MacAgentKind,
    withContents: boolean
  ): Promise<Extract<ProbeResult, { kind: 'found' }>> {
    const call = probeArgs(app, tty, agent, withContents);
    if (!call) throw new MacShareError('not-shell-job');
    const outcome = await this.deps.runner.run(app, call.script, call.args);
    if (outcome.kind !== 'ok') {
      const code = outcomeProblem(outcome) ?? 'unresponsive';
      if (code === 'unresponsive' && outcome.kind === 'timeout') {
        // It hung: the screen locked meanwhile, or (on the first call of this run, with the
        // screen unlocked) macOS is probably asking.
        const lock = await this.deps.screenLock();
        if (lock.locked) throw new MacShareError('locked');
        if (!this.scripted.has(app)) throw new MacShareError('automation-pending');
      }
      throw new MacShareError(code);
    }
    const result = parseProbe(app, outcome.stdout);
    const problem = probeProblem(result);
    if (problem || result.kind !== 'found') throw new MacShareError(problem ?? 'unresponsive');
    this.scripted.add(app);
    return result;
  }

  private abort(code: MacShareErrorCode): JobEnd {
    return new JobEnd('aborted', { error: code });
  }

  private fail(reason: MacShareFailReason): JobEnd {
    return new JobEnd('failed-after-close', { reason });
  }

  private abortOn<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof MacShareError) throw this.abort(error.code);
      throw error;
    }
  }

  private async abortOnAsync<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof MacShareError) throw this.abort(error.code);
      throw error;
    }
  }

  /** Stops a job whose server is going down, before its next step. */
  private alive(): void {
    if (this.disposed) throw new Error('disposed');
  }

  private step(record: JobRecord, step: MacShareStep): void {
    record.job.step = step;
    record.job.updatedAt = new Date(this.now()).toISOString();
    this.log(`share ${record.plan.app} ${record.plan.tty}: ${step}`);
  }

  private set(record: JobRecord, fields: Partial<MacShareJob>): void {
    Object.assign(record.job, fields, { updatedAt: new Date(this.now()).toISOString() });
  }

  private end(
    record: JobRecord,
    state: MacShareJob['state'],
    detail: { error?: MacShareErrorCode; reason?: MacShareFailReason } = {}
  ): void {
    const fields: Partial<MacShareJob> = { state };
    if (detail.error) fields.error = detail.error;
    if (detail.reason) fields.reason = detail.reason;
    if (detail.reason === 'timeout') fields.seconds = this.deps.settings().startTimeoutSec;
    if (state === 'shared') {
      delete record.job.reason;
      delete record.job.seconds;
    }
    this.set(record, fields);
    record.endedAt = this.now();
    this.log(
      `share ${record.plan.app} ${record.plan.tty}: ${state}${detail.error ? ` ${detail.error}` : ''}${detail.reason ? ` ${detail.reason}` : ''}`
    );
  }

  /** The job of an agent row, while it runs (a finished one no longer blocks a new plan). */
  private jobFor(macId: string): JobRecord | undefined {
    for (const record of this.jobs.values()) {
      if (record.plan.macId === macId && !record.endedAt) return record;
    }
    return undefined;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, plan] of this.plans) if (plan.expiresAt <= now) this.plans.delete(key);
    for (const [key, started] of this.started) {
      if (now - started.at > MAC_SHARE_PLAN_TTL_MS) this.started.delete(key);
    }
    for (const [key, record] of this.jobs) {
      if (record.endedAt !== undefined && now - record.endedAt > JOB_KEEP_MS) this.jobs.delete(key);
    }
  }

  private log(message: string): void {
    logger.log(message);
  }
}

/** A failed pre-typing probe, as the reason the share stopped after the close. */
function afterCloseReason(code: MacShareErrorCode | undefined): MacShareFailReason {
  switch (code) {
    case 'automation-denied':
      return 'denied';
    case 'tab-not-found':
    case 'tab-ambiguous':
      return 'tab-gone';
    case 'locked':
      return 'locked';
    default:
      return 'unresponsive';
  }
}

/** A typing call that answered with an error (nothing was typed). */
function typingReason(outcome: OsascriptOutcome): MacShareFailReason {
  if (outcome.kind === 'error') {
    if (outcome.error === 'denied') return 'denied';
    if (outcome.error === 'gone' || outcome.error === 'not-running') return 'tab-gone';
    return 'refused';
  }
  // in-flight: another call to that app was still pending, so this one never ran.
  return 'unresponsive';
}
