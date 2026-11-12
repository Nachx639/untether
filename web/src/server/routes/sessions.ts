import { type Response, Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import {
  looseText,
  type parseScreenChoices,
  sameMenuKey,
  takesReply,
} from '../../shared/claude-screen.js';
import { isForwardedSession } from '../../shared/forwarded-session.js';
import { normalizeUserTitle } from '../../shared/session-title.js';
import { cellsToText } from '../../shared/terminal-text-formatter.js';
import type {
  ProviderSessionMarker,
  ServerStatus,
  Session,
  SessionAgentStatus,
  SessionCreateOptions,
  SessionGroupPin,
  SessionInput,
  TitleMode,
} from '../../shared/types.js';
import { HttpMethod } from '../../shared/types.js';
import { forwarderPidOf } from '../pty/forwarder-kill.js';
import { PtyError, type PtyManager } from '../pty/index.js';
import { isProcessRunning } from '../pty/process-utils.js';
import type { ExitedKeepReason } from '../pty/pty-manager.js';
import { type AgentExplainerOptions, createAgentExplainer } from '../services/agent-explain.js';
import {
  type ClaudeStatus,
  claudeConversationExists,
  claudeWorkingDir,
  promptStatus,
  readClaudeStatuses,
} from '../services/claude-chat.js';
import {
  INITIAL_INPUT_MAX_LENGTH,
  type InitialInputAgent,
  type InitialInputOptions,
  trustFolderOption,
  typeWhenClaudeReady,
  typeWhenCodexReady,
} from '../services/claude-initial-input.js';
import { claudeResumeTarget } from '../services/claude-session-id.js';
import {
  type ClaudeRestartActions,
  claudeInputDraft,
  type RestartResult,
  restartCommandOffered,
  updateNoticeOnScreen,
} from '../services/claude-update-restart.js';
import { isCodexCommand, readCodexChat } from '../services/codex-chat.js';
import { codexResumeTarget, codexSessionRef } from '../services/codex-process.js';
import {
  carriedCodexArgs,
  codexResumeCommand,
  codexThreadExists,
  codexThreadIsSure,
  codexThreadTitle,
  liveCodexThreadPid,
  recordCodexThreads,
  startsCodex,
} from '../services/codex-thread.js';
import type { SessionAccess } from '../services/copilot/session-access.js';
import { readGeminiChat } from '../services/gemini-chat.js';
import { geminiSessionRef } from '../services/gemini-process.js';
import type { LiveConversation } from '../services/mac-sessions/agents.js';
import { MacWindowApps } from '../services/mac-sessions/window-apps.js';
import { menuKeyHash } from '../services/menu-key-hash.js';
import type { InteractiveProviderLaunch } from '../services/model-provider-launch.js';
import {
  type CloseWindowResult,
  claudeAtWork,
  type LeaveWindowDeps,
  leaveTerminalWindow,
  ttyOfPid,
  type WindowNoticeWriter,
  windowNoticeText,
} from '../services/move-to-untether.js';
import type { PreviewRegistry } from '../services/preview-registry.js';
import type { RemoteRegistry } from '../services/remote-registry.js';
import { type AnswerScreenMenu, createScreenMenu } from '../services/screen-menu.js';
import { sessionDirForBranch } from '../services/session-branch-dir.js';
import { chatAnswer, readSessionChat } from '../services/session-chat.js';
import { createLastLineReader } from '../services/session-last-line.js';
import type { SessionReplacements } from '../services/session-replacements.js';
import type { SuspendByUserResult, WakeResult } from '../services/session-suspender.js';
import { shieldReopenPlan } from '../services/shielded-tmux.js';
import { tailscaleServeService } from '../services/tailscale-serve-service.js';
import type { DeliverInitialInput, DeliverInitialInputOptions } from '../services/task-launcher.js';
import { LARGE_REPLAY_MAX_BYTES, type TerminalManager } from '../services/terminal-manager.js';
import { colors } from '../utils/colors.js';
import { detectGitInfo } from '../utils/git-info.js';
import { getDetailedGitStatusCached } from '../utils/git-status.js';
import { createLogger } from '../utils/logger.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';
import { generateSessionName } from '../utils/session-naming.js';
import { createControlMessage, type TerminalSpawnResponse } from '../websocket/control-protocol.js';
import { controlUnixHandler } from '../websocket/control-unix-handler.js';

const logger = createLogger('sessions');

interface SessionRoutesConfig {
  /**
   * The cards' one line about what each agent session does (agent-explain.ts): the model call
   * and the setting. Unset: no lines.
   */
  agentExplain?: Pick<AgentExplainerOptions, 'ask' | 'enabled'>;
  ptyManager: PtyManager;
  terminalManager: TerminalManager;
  remoteRegistry: RemoteRegistry | null;
  isHQMode: boolean;
  previewRegistry?: PreviewRegistry;
  /** New sessions without an explicit `shielded` are shielded (the user's setting, default on). */
  shieldNewSessionsByDefault?: () => boolean;
  /**
   * Why Untether must not type into a session now because of the user's own input there
   * (user-input-guard.ts); none: never held.
   */
  userHold?: (sessionId: string) => Promise<string | null>;
  /** Hands out the "type the first message once the agent is ready" helper (tasks use it). */
  exposeInitialInput?: (deliver: DeliverInitialInput) => void;
  /** Hands out the trust-dialog answer of task sessions (a new orchestrator's uses it too). */
  exposeTrustDialogAnswer?: (answer: (sessionId: string) => Promise<boolean>) => void;
  /** Hands out the answer to a menu on a session's screen (`ut task answer` uses it). */
  exposeMenuAnswer?: (answer: AnswerScreenMenu) => void;
  /** The app of the terminal window each `ut` session runs in (`macWindow`); tests pass theirs. */
  macWindows?: MacWindowApps;
  /**
   * Every store keyed by session id follows a session reopened as another (Blindar, Llevar a
   * Untether, Resume Claude) through this one registry.
   */
  sessionReplacements?: SessionReplacements;
  /** Codex in a running session (codex-session-status.ts). Unset: no Codex state anywhere. */
  codex?: {
    /** Whether a Codex runs there (its command, or typed in its shell). */
    runs: (sessionId: string) => boolean;
    /**
     * Its state from its rollout, waiting with the menu when one is on its screen; undefined
     * when no Codex runs there or nothing is known yet.
     */
    status: (sessionId: string) => Promise<SessionAgentStatus | undefined>;
    /** Its menu was answered: the next look reads its screen again. */
    answered: (sessionId: string) => void;
  };
  /** Claude Code's live status in a session (Llevar a Untether asks before interrupting it). */
  claudeStatusOf?: (sessionId: string) => Promise<ClaudeStatus | undefined>;
  /** The terminal device of a forwarder's window ("/dev/ttys003"). */
  windowTtyOf?: (pid: number) => Promise<string | null>;
  /** Closes the terminal window of `tty` when it holds nothing else (AppleScript, server.ts). */
  closeTerminalWindow?: (app: string, tty: string) => Promise<CloseWindowResult>;
  /** What is done with a window whose session moved to Untether (tests pass theirs). */
  leaveWindow?: (
    window: { tty: string; app: string | null; notice: string },
    forwarder: Pick<LeaveWindowDeps, 'forwarderEnded' | 'forwarderWroteNotice'>
  ) => Promise<{ notice: WindowNoticeWriter; closed: CloseWindowResult }>;
  /** Claude conversations running right now outside Untether: never resumed here. */
  liveClaudeConversations?: () => Promise<Map<string, LiveConversation>>;
  /**
   * The pid of a Codex started as `codex resume <thread>` anywhere on this computer, or null
   * (codex-thread.ts liveCodexThreadPid; tests pass theirs): its thread is never resumed again.
   */
  liveCodexThread?: (threadId: string) => Promise<number | null>;
  /**
   * An interactive session against an external model provider (model-providers.ts): resolves
   * its command line (with `--model`/`--settings`), environment and marker. Null when the
   * provider is gone or its key cannot be read. Unset: no providers.
   */
  providerInteractive?: (
    marker: ProviderSessionMarker,
    command: string[]
  ) => Promise<InteractiveProviderLaunch | null>;
  /** Hands out these routes' reads and actions on local sessions (the voice copilot uses them). */
  exposeSessionAccess?: (access: SessionAccess) => void;
  /**
   * "Clean up exited" keeps this session (a task's or an orchestrator's, which
   * sessionReplaced/Resume still need). Wired by server.ts to the task scheduler.
   */
  keepOnExitedCleanup?: (sessionId: string) => boolean;
  /** Some client shows this session on a visible page now (ws-v3-hub isSessionBeingViewed). */
  isSessionViewed?: (sessionId: string, exceptClientId?: string | null) => boolean;
  /** Hands out the restart of a Claude session on its updated version (claude-update-restart). */
  exposeClaudeRestart?: (actions: ClaudeRestartActions) => void;
  /**
   * Wakes a suspended session (session-suspender.ts) before anything is typed into it or its
   * conversation is resumed; a session that is not suspended answers ok at once.
   */
  wakeSuspended?: (
    sessionId: string,
    why: string,
    /** The user asked for it (a tap, a resume, typing): tried even right after a failure. */
    options?: { byUser?: boolean }
  ) => Promise<WakeResult>;
  /** Suspends a session the user asked to, or answers why not (session-suspender.ts). */
  suspendByUser?: (sessionId: string) => Promise<SuspendByUserResult>;
}

// Helper function to resolve path with default fallback
function resolvePath(inputPath: string, defaultPath: string): string {
  if (!inputPath || inputPath.trim() === '') {
    return defaultPath;
  }

  // Use our utility function to handle tilde expansion and absolute path resolution
  const expanded = resolveAbsolutePath(inputPath);

  // If the input was relative (not starting with / or ~), resolve it relative to defaultPath
  if (!inputPath.startsWith('/') && !inputPath.startsWith('~')) {
    return path.join(defaultPath, inputPath);
  }

  return expanded;
}

/**
 * How long a reply waits for Claude to leave its menu (Esc) and show its prompt before the
 * text is typed. The phone keeps the message until then, so past this it says so instead.
 */
const REPLY_TYPE_WAIT_MS = 15_000;
/** Pause before each terminal warm-up of a long waiting session (see warmTerminal). */
const WARM_GAP_MS = 250;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The session's PTY is a tmux client attached to a tmux session that keeps running without it
 * (opened from "On this Mac" or the tmux list): closing it detaches, and its program is not its
 * own to shield or resume.
 */
function isAttachedToTmux(session: Pick<Session, 'multiplexer' | 'name' | 'command'>): boolean {
  return (
    !!session.multiplexer ||
    !!session.name?.startsWith('tmux:') ||
    !!session.command?.includes('tmux attach')
  );
}

/** How long a session may sit in 'starting' and still count as on its way (see isLiveSession). */
export const STARTING_LIVE_MS = 2 * 60_000;

/**
 * Running, or still starting (a session sits in 'starting' through git detection, tmux and
 * spawn). A 'starting' one older than STARTING_LIVE_MS was left by a crash mid-create and is
 * not live (2026-10-20).
 */
export function isLiveSession(
  session: Pick<Session, 'status' | 'startedAt'>,
  now = Date.now()
): boolean {
  if (session.status === 'running') return true;
  if (session.status !== 'starting') return false;
  const started = Date.parse(session.startedAt);
  return Number.isFinite(started) && now - started < STARTING_LIVE_MS;
}

/** A route's answer as data, so the voice copilot can take the same code path in-process. */
interface RouteAnswer {
  status: number;
  body: Record<string, unknown>;
}

const answerWith = (status: number, body: Record<string, unknown>): RouteAnswer => ({
  status,
  body,
});

function sendAnswer(res: Response, answer: RouteAnswer) {
  (answer.status === 200 ? res : res.status(answer.status)).json(answer.body);
}

export function createSessionRoutes(config: SessionRoutesConfig): Router {
  const router = Router();
  const { ptyManager, terminalManager, remoteRegistry, isHQMode } = config;
  const macWindows = config.macWindows ?? new MacWindowApps();
  const claudeStatusNow = config.claudeStatusOf ?? ((sessionId) => liveClaudeStatus(sessionId));
  const windowTtyOf = config.windowTtyOf ?? ttyOfPid;
  const leaveWindow =
    config.leaveWindow ??
    ((window, forwarder) =>
      leaveTerminalWindow(window, { ...forwarder, closeWindow: config.closeTerminalWindow }));

  // GET /sessions is polled every second by every client; a screen read is only needed for
  // sessions where Claude waits for an answer, and a couple of seconds of staleness is fine.
  // Concurrent polls share one read, and a session whose output would be costly to replay is
  // skipped (no quick answers for it; the session view still works).
  /** Resumes on their way, by Claude conversation or Codex thread id: the session id they will answer with. */
  const resumesInFlight = new Map<string, { sessionId: string; done: Promise<boolean> }>();
  /** Shield reopens on their way, by the session being reopened. */
  const shieldsInFlight = new Map<
    string,
    Promise<{ sessionId: string; replaced: boolean } | null>
  >();
  /** Where a Codex thread is open right now by a `codex resume` of it, if anywhere. */
  async function liveCodexThread(threadId: string): Promise<LiveConversation | undefined> {
    const pid = await (config.liveCodexThread ?? liveCodexThreadPid)(threadId).catch(() => null);
    if (pid === null) return undefined;
    logger.warn(`Codex thread ${threadId} is open in process ${pid}: not resumed again`);
    return { where: 'terminal' };
  }

  /**
   * Claims a Claude conversation (or a Codex thread, 2026-11-10) for a resume, or answers with
   * the session that already has it: a resume on its way (awaited) or a live Untether session
   * (other than `excludeId`).
   * Shared by POST /sessions and Blindar (2026-10-20: shielding an exited session started a
   * second `claude --resume` while the same conversation was being resumed or already ran in
   * another session). `release(ok)` must be called once the new session exists (or failed).
   */
  async function claimConversation(
    resumed: string,
    excludeId?: string
  ): Promise<
    | { kind: 'existing'; sessionId: string }
    | { kind: 'failed' }
    | { kind: 'claimed'; sessionId: string; release: (ok: boolean) => void }
  > {
    const pending = resumesInFlight.get(resumed);
    if (pending) {
      const ok = await pending.done;
      return ok ? { kind: 'existing', sessionId: pending.sessionId } : { kind: 'failed' };
    }
    const sessions = ptyManager.listSessions();
    const liveHere = sessions.find(
      (session) =>
        session.id !== excludeId &&
        isLiveSession(session) &&
        (session.claudeSessionId === resumed || session.codexThreadId === resumed)
    );
    if (liveHere) return { kind: 'existing', sessionId: liveHere.id };
    // 2026-10-31: a suspended session still owns its conversation: it wakes (same id) instead
    // of a second `claude --resume` starting next to it.
    const suspended = sessions.find(
      (session) => session.id !== excludeId && session.suspended?.claudeSessionId === resumed
    );
    if (suspended && config.wakeSuspended) {
      const woke = await config.wakeSuspended(suspended.id, 'its conversation was resumed', {
        byUser: true,
      });
      return woke.ok ? { kind: 'existing', sessionId: suspended.id } : { kind: 'failed' };
    }
    let settle: (ok: boolean) => void = () => {};
    const claim = {
      sessionId: generateSessionId(),
      done: new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
    };
    resumesInFlight.set(resumed, claim);
    return {
      kind: 'claimed',
      sessionId: claim.sessionId,
      release: (ok) => {
        if (resumesInFlight.get(resumed) === claim) resumesInFlight.delete(resumed);
        settle(ok);
      },
    };
  }
  /**
   * Keeps a resume's claim (claimConversation) until the session `sessionId` exists (a Terminal
   * window's forwarder registers it on its own) or TERMINAL_RESUME_CLAIM_MS passed.
   */
  function holdResumeUntilSessionAppears(
    sessionId: string,
    release: (ok: boolean) => void,
    timeoutMs = TERMINAL_RESUME_CLAIM_MS
  ): void {
    const started = Date.now();
    const look = () => {
      let found = false;
      try {
        found = !!ptyManager.getSession(sessionId);
      } catch {
        found = false;
      }
      if (found) return release(true);
      if (Date.now() - started >= timeoutMs) return release(false);
      setTimeout(look, 500).unref?.();
    };
    look();
  }
  const choicesCache = new Map<string, { at: number; value: ScreenChoices }>();
  const choicesInFlight = new Map<string, Promise<ScreenChoices>>();
  type ScreenChoices = ReturnType<typeof parseScreenChoices>;

  // Read like the phone reads its copy (services/screen-menu.ts): the key of a menu read here
  // (the list's quick answers, the answer sheet, the check of an answer) and on the phone
  // covers the same lines, its dialog's top included where it scrolled out of sight.
  const screenMenu = createScreenMenu({
    recentText: (sessionId, lines) => terminalManager.getRecentText(sessionId, lines),
    sendInput: (sessionId, input) => ptyManager.sendInput(sessionId, input),
  });
  const readScreenChoices = (sessionId: string): Promise<ScreenChoices> =>
    screenMenu.read(sessionId);

  // A long session's screen reads cheaply only once its terminal exists, and nothing built it
  // before someone opened the session: after every restart a long Claude waiting for an answer
  // (19 MB, 2026-10-03) had no quick answers in the list. Built here, off the request, one at
  // a time with a pause between: each replay blocks the server (~0.3 s per 20 MB), and several
  // waiting sessions warmed in the same tick added up (review of 2026-10-03).
  const warming = new Set<string>();
  const warmQueue: string[] = [];
  let warmingNow = false;
  function warmTerminal(sessionId: string) {
    if (warming.has(sessionId)) return;
    if (!terminalManager.canSnapshotCheaply(sessionId, LARGE_REPLAY_MAX_BYTES)) return;
    warming.add(sessionId);
    warmQueue.push(sessionId);
    void drainWarmQueue();
  }
  async function drainWarmQueue() {
    if (warmingNow) return;
    warmingNow = true;
    try {
      for (let sessionId = warmQueue.shift(); sessionId; sessionId = warmQueue.shift()) {
        // Requests waiting meanwhile go first.
        await sleep(WARM_GAP_MS);
        await terminalManager
          .getBufferSnapshot(sessionId)
          .catch((error) => logger.debug(`could not build the terminal of ${sessionId}: ${error}`));
        warming.delete(sessionId);
      }
    } finally {
      warmingNow = false;
    }
  }

  async function screenChoices(sessionId: string, maxAgeMs = 2000): Promise<ScreenChoices> {
    const cached = choicesCache.get(sessionId);
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.value;
    if (!terminalManager.canSnapshotCheaply(sessionId)) {
      warmTerminal(sessionId);
      return null;
    }
    let pending = choicesInFlight.get(sessionId);
    if (!pending) {
      pending = readScreenChoices(sessionId)
        .catch((error) => {
          logger.debug(`[GET /sessions] Could not read screen of ${sessionId}: ${error}`);
          return null;
        })
        .then((value) => {
          choicesCache.set(sessionId, { at: Date.now(), value });
          if (choicesCache.size > 100) {
            choicesCache.delete(choicesCache.keys().next().value as string);
          }
          return value;
        })
        .finally(() => choicesInFlight.delete(sessionId));
      choicesInFlight.set(sessionId, pending);
    }
    return pending;
  }

  // Last output line of shells and other non-Claude sessions, for the phone list. Same cost
  // rules as above: only cheap screens, unchanged screens are never re-read, and a changing one
  // at most every 2 s.
  const lastLines = createLastLineReader({
    canSnapshotCheaply: (sessionId) => terminalManager.canSnapshotCheaply(sessionId),
    getChangeCount: (sessionId) => terminalManager.getChangeCount(sessionId),
    outputModifiedAt: (sessionId) => terminalManager.outputModifiedAt(sessionId),
    readScreenText: async (sessionId) =>
      cellsToText((await terminalManager.getBufferSnapshot(sessionId)).cells, false),
  });

  // The cards' one line (agent-explain.ts): from the cache on every poll, a model call only
  // when a session changed, within its limits.
  const explainer = config.agentExplain
    ? createAgentExplainer({
        ...config.agentExplain,
        readChat: async (sessionId) => {
          const session = ptyManager.getSession(sessionId);
          if (!session?.pid || session.status !== 'running') return null;
          const programPid = ptyManager.programRootPid(session) ?? session.pid;
          return readSessionChat({ ...session, pid: session.pid }, programPid);
        },
        onError: (error) => logger.debug(`[GET /sessions] card line failed: ${error}`),
      })
    : null;

  /**
   * Types `text` into the session once its agent is ready at its prompt, resolving to whether
   * it was typed: an "Ask Claude"/"Ask Codex" message waits for a new session's agent to start
   * (minutes, while the user answers its dialogs), a reply only for Claude to leave its menu.
   */
  function typeWhenReady(
    sessionId: string,
    text: string,
    agent: InitialInputAgent,
    options?: InitialInputOptions,
    trustFolder = false,
    notUsers = false
  ): Promise<boolean> {
    return wakeFirst(sessionId, 'text to type').then((notAwake) =>
      notAwake ? false : typeWhenAwake(sessionId, text, agent, options, trustFolder, notUsers)
    );
  }

  function typeWhenAwake(
    sessionId: string,
    text: string,
    agent: InitialInputAgent,
    options?: InitialInputOptions,
    trustFolder = false,
    notUsers = false
  ): Promise<boolean> {
    // One typing at a time per session; what is not the user's waits for the user's own input
    // (2026-11-10: another agent's reply went in stuck to a message of the user's). The
    // user's own text counts as keys of theirs for whatever else waits to be typed.
    const userHold = config.userHold;
    const guard = {
      lockKey: sessionId,
      ...(notUsers && userHold
        ? {
            userHold: () => userHold(sessionId),
            onHold: (why: string) => {
              logger.log(`input for session ${sessionId} waits: ${why}`);
              options?.onUserHold?.(why);
            },
          }
        : {}),
    };
    if (!notUsers) ptyManager.noteUserInput?.(sessionId);
    const running = () => ptyManager.getSession(sessionId)?.status === 'running';
    // A task's own worktree: nobody watches its new session, so its trust dialog is answered.
    const answerDialog = trustFolder ? () => answerTrustDialog(sessionId) : undefined;
    const send = (input: { text: string } | { key: 'enter' }) => {
      if (running()) ptyManager.sendInput(sessionId, input);
    };
    const onGiveUp = (reason: string) =>
      logger.warn(`initial input for session ${sessionId} not delivered: ${reason}`);
    return agent === 'codex'
      ? typeWhenCodexReady(
          text,
          {
            isRunning: running,
            screenText: async () =>
              cellsToText((await terminalManager.getBufferSnapshot(sessionId)).cells, false),
            send,
            onGiveUp,
            answerDialog,
            ...guard,
          },
          options
        )
      : typeWhenClaudeReady(
          text,
          {
            isRunning: running,
            claudeStatus: async () => {
              const current = ptyManager.getSession(sessionId);
              const pid = current ? ptyManager.programRootPid(current) : undefined;
              return pid ? promptStatus((await readClaudeStatuses([pid])).get(pid)) : undefined;
            },
            dialogOnScreen: async () => (await readScreenChoices(sessionId)) !== null,
            screenText: async () =>
              cellsToText((await terminalManager.getBufferSnapshot(sessionId)).cells, false),
            send,
            onGiveUp,
            answerDialog,
            ...guard,
          },
          options
        );
  }

  /** "Yes, I trust this folder" when that dialog is on screen; true when it was answered. */
  async function answerTrustDialog(sessionId: string): Promise<boolean> {
    const choices = await readScreenChoices(sessionId);
    const option = trustFolderOption(choices);
    if (!choices || !option) return false;
    logger.log(`trust dialog in session ${sessionId}: answering option ${option}`);
    const answer = await answerMenu(sessionId, {
      option,
      question: choices.question,
      options: choices.options,
      key: choices.key,
    });
    return answer.status === 200;
  }

  /**
   * Types an "Ask Claude"/"Ask Codex" message into a new session once the agent is ready;
   * resolves to whether it was typed (2026-10-20: tasks were told "sent" when the typing had
   * given up, and their fix requests were lost).
   */
  function deliverInitialInput(
    sessionId: string,
    text: unknown,
    agent: InitialInputAgent,
    options?: DeliverInitialInputOptions
  ): Promise<boolean> {
    if (typeof text !== 'string' || !text.trim()) return Promise.resolve(false);
    const typing = {
      ...(options?.whileBusy ? { whileBusy: true } : {}),
      ...(options?.onDialogWaiting ? { onDialogWaiting: options.onDialogWaiting } : {}),
      ...(options?.onUserHold ? { onUserHold: options.onUserHold } : {}),
    };
    return typeWhenReady(
      sessionId,
      text,
      agent,
      typing,
      options?.trustFolder === true,
      options?.notUsers === true
    ).catch((error) => {
      logger.error(`initial input for session ${sessionId} failed:`, error);
      return false;
    });
  }
  config.exposeInitialInput?.(deliverInitialInput);
  config.exposeTrustDialogAnswer?.(answerTrustDialog);
  // A task's prompt answered from outside its screen (2026-11-10): the same checked answer as
  // the phone's (the menu read again, the option only given while it is still that menu).
  config.exposeMenuAnswer?.(async (sessionId, menu, option) => {
    const answer = await answerMenu(sessionId, {
      option,
      question: menu.question,
      options: menu.options,
      key: menu.key,
    });
    if (answer.status === 200) return 'ok';
    return answer.status === 504 ? 'not-delivered' : 'changed';
  });

  // Server status endpoint
  router.get('/server/status', async (_req, res) => {
    logger.debug('[GET /server/status] Getting server status');

    let macAppConnected = false;
    try {
      macAppConnected = controlUnixHandler.isMacAppConnected();
    } catch (error) {
      // The Mac app connection is optional. Keep mode discovery available so a
      // transient control-socket failure cannot block normal web sessions.
      logger.warn('Failed to check Mac app connection; reporting disconnected:', error);
    }

    const status: ServerStatus = {
      macAppConnected,
      isHQMode,
      version: process.env.VERSION || 'unknown',
    };
    res.json(status);
  });

  // Tailscale Serve status endpoint
  router.get('/sessions/tailscale/status', async (_req, res) => {
    logger.debug('[GET /sessions/tailscale/status] Getting Tailscale Serve status');
    try {
      const status = await tailscaleServeService.getStatus();

      // Add helpful guidance for common issues
      if (!status.isRunning && status.isPermanentlyDisabled) {
        const enhancedStatus = {
          ...status,
          lastError: 'Tailscale Serve is disabled on your tailnet',
          recommendation:
            'Untether tried to enable Tailscale Serve but your tailnet requires admin approval. You can still use Untether normally - it will be accessible on your tailnet without the Serve proxy.',
          fallbackMode: "Running in standard mode - accessible via your machine's tailnet IP",
          permanentlyDisabled: true,
        };
        res.json(enhancedStatus);
      } else if (
        !status.isRunning &&
        status.lastError?.includes('Serve is not enabled on your tailnet')
      ) {
        const enhancedStatus = {
          ...status,
          lastError: 'Tailscale Serve feature requires tailnet permissions',
          recommendation:
            'Contact your Tailscale admin or visit your tailnet admin panel to enable the Serve feature',
          fallbackMode:
            'Untether is running in HTTP mode. You can still access it directly on your tailnet IP',
        };
        res.json(enhancedStatus);
      } else {
        res.json(status);
      }
    } catch (error) {
      logger.error('Failed to get Tailscale Serve status:', error);
      res.status(500).json({ error: 'Failed to get Tailscale Serve status' });
    }
  });

  // Tailscale connection test endpoint with diagnostics
  router.get('/sessions/tailscale/test', async (_req, res) => {
    logger.debug('[GET /sessions/tailscale/test] Testing Tailscale connection');
    try {
      const { spawn } = await import('child_process');
      const tailscaleExecutable = await tailscaleServeService.getExecutablePath().catch(() => null);

      // Test 1: Check if Tailscale is installed and running
      const tailscaleStatus = tailscaleExecutable
        ? await new Promise<{ isRunning: boolean; output: string }>((resolve) => {
            const statusProcess = spawn(tailscaleExecutable, ['status'], {
              stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stdout = '';
            let stderr = '';

            if (statusProcess.stdout) {
              statusProcess.stdout.on('data', (data) => {
                stdout += data.toString();
              });
            }

            if (statusProcess.stderr) {
              statusProcess.stderr.on('data', (data) => {
                stderr += data.toString();
              });
            }

            statusProcess.on('exit', (code) => {
              const output = stdout || stderr;
              resolve({
                isRunning: code === 0,
                output: output.trim(),
              });
            });

            statusProcess.on('error', () => {
              resolve({
                isRunning: false,
                output: 'Tailscale command not found',
              });
            });

            setTimeout(() => {
              statusProcess.kill('SIGTERM');
              resolve({
                isRunning: false,
                output: 'Tailscale status check timeout',
              });
            }, 5000);
          })
        : {
            isRunning: false,
            output: 'Tailscale command not found',
          };

      // Test 2: Check Tailscale Serve configuration
      const serveStatus = await tailscaleServeService.getStatus();

      // Test 3: Check actual server binding
      const serverInfo = {
        isListening: true, // We're responding to this request
        port: process.env.PORT || '4020',
        bindAddress: process.env.BIND_ADDRESS || '127.0.0.1',
      };

      res.json({
        timestamp: new Date().toISOString(),
        tailscale: {
          installed: tailscaleStatus.isRunning,
          status: tailscaleStatus.output,
        },
        tailscaleServe: {
          configured: serveStatus.isRunning,
          port: serveStatus.port,
          error: serveStatus.lastError,
          startTime: serveStatus.startTime,
        },
        server: serverInfo,
        recommendations: generateTailscaleRecommendations(tailscaleStatus, {
          configured: serveStatus.isRunning,
          error: serveStatus.lastError,
        }),
      });
    } catch (error) {
      logger.error('Failed to test Tailscale connection:', error);
      res.status(500).json({
        error: 'Failed to perform Tailscale connection test',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Codex/Gemini titles for the voice copilot's frequent looks: finding their files walks the
  // process tree, and a title changes once per conversation.
  const agentTitles = new Map<
    string,
    {
      at: number;
      codexActive?: boolean;
      codexTitle?: string;
      geminiActive?: boolean;
      geminiTitle?: string;
    }
  >();
  function fromTitleCache(session: Session, maxAgeMs: number | undefined): boolean {
    if (maxAgeMs === undefined) return false;
    const hit = agentTitles.get(session.id);
    if (!hit || Date.now() - hit.at > maxAgeMs) {
      agentTitles.delete(session.id);
      return false;
    }
    if (hit.codexActive) session.codexActive = true;
    if (hit.codexTitle) session.codexTitle = hit.codexTitle;
    if (hit.geminiActive) session.geminiActive = true;
    if (hit.geminiTitle) session.geminiTitle = hit.geminiTitle;
    return true;
  }
  function rememberAgentTitles(sessions: Session[]) {
    for (const session of sessions) {
      if (session.status !== 'running' || session.claudeStatus || agentTitles.has(session.id))
        continue;
      agentTitles.set(session.id, {
        at: Date.now(),
        codexActive: session.codexActive,
        codexTitle: session.codexTitle,
        geminiActive: session.geminiActive,
        geminiTitle: session.geminiTitle,
      });
    }
    if (agentTitles.size > 500) agentTitles.clear();
  }

  /**
   * Local sessions with what the phone list shows: Claude status (and the menu on screen while
   * waiting), Codex/Gemini titles, last line, resumability. GET /sessions and the voice
   * copilot's session state read the same thing. `git`: detect missing Git info (the list only);
   * `agentTitlesMaxAgeMs`: reuse Codex/Gemini titles read this recently (the copilot looks often);
   * `choicesMaxAgeMs`: how old a cached screen menu may be.
   */
  async function listLocalSessions(opts: {
    git: boolean;
    agentTitlesMaxAgeMs?: number;
    choicesMaxAgeMs?: number;
    /** The client's language: each agent session gets its card line (GET /sessions only). */
    explainLang?: string;
  }): Promise<Session[]> {
    // Get local sessions
    const localSessions = ptyManager.listSessions();
    // Sessions opened with ut in a terminal window: their app is looked up meanwhile.
    macWindows.refresh(localSessions);

    // Add source info to local sessions and detect Git info if missing
    const localSessionsWithSource = await Promise.all(
      localSessions.map(async (session) => {
        // If session doesn't have Git info, try to detect it
        if (opts.git && !session.gitRepoPath && session.workingDir) {
          try {
            const gitInfo = await detectGitInfo(session.workingDir);
            // logger.debug(
            //   `[GET /sessions] Detected Git info for session ${session.id}: repo=${gitInfo.gitRepoPath}, branch=${gitInfo.gitBranch}`
            // );
            return {
              ...session,
              ...gitInfo,
              source: 'local' as const,
            };
          } catch (error) {
            // If Git detection fails, just return session as-is
            logger.debug(
              `[GET /sessions] Could not detect Git info for session ${session.id}: ${error}`
            );
          }
        }

        return {
          ...session,
          source: 'local' as const,
        };
      })
    );

    // Claude Code status per session (working / waiting for the user / idle).
    try {
      // A shielded session's pid is its tmux client: look under the program inside tmux.
      const rootPid = (session: Session) => ptyManager.programRootPid(session);
      const runningPids = (localSessionsWithSource as Session[])
        .filter((session) => session.status === 'running' && rootPid(session))
        .map((session) => rootPid(session) as number);
      const claudeStatuses = await readClaudeStatuses(runningPids);
      for (const session of localSessionsWithSource as Session[]) {
        const pid = session.status === 'running' ? rootPid(session) : undefined;
        const claudeStatus = pid ? claudeStatuses.get(pid) : undefined;
        if (claudeStatus) {
          const { sessionId: claudeSessionId, ...status } = claudeStatus;
          session.claudeStatus = status;
          if (status.status === 'waiting') {
            // Quick answers from the list: the numbered prompt on screen, if any.
            const choices = await screenChoices(session.id, opts.choicesMaxAgeMs);
            if (choices) session.claudeStatus.choices = choices;
          }
          if (status.title && session.claudeTitle !== status.title) {
            try {
              ptyManager.setClaudeTitle(session.id, status.title);
              session.claudeTitle = status.title;
            } catch (error) {
              logger.debug(`[GET /sessions] Could not save Claude title: ${error}`);
            }
          }
          if (claudeSessionId && session.claudeSessionId !== claudeSessionId) {
            // A failed save must not drop the statuses of the remaining sessions.
            try {
              const taken = ptyManager.setClaudeSessionId(session.id, claudeSessionId);
              session.claudeSessionId = claudeSessionId;
              if (taken?.userTitle) session.userTitle = taken.userTitle;
              if (taken?.groupPin) session.groupPin = taken.groupPin;
              if (taken?.claudeTitle && !session.claudeTitle)
                session.claudeTitle = taken.claudeTitle;
            } catch (error) {
              logger.debug(`[GET /sessions] Could not save Claude session id: ${error}`);
            }
          }
        }
      }
    } catch (error) {
      logger.debug(`[GET /sessions] Could not read Claude statuses: ${error}`);
    }
    // 2026-10-18: a session opened in ~/Projects whose Claude then works in a project stayed
    // in "Otras". Where Claude works now (its transcript) decides the session's group.
    await Promise.all(
      (localSessionsWithSource as Session[]).map(async (session) => {
        if (!session.claudeStatus || !session.claudeSessionId || !session.workingDir) return;
        try {
          const dir = claudeWorkingDir(session.workingDir, session.claudeSessionId);
          if (!dir || dir === session.workingDir || !fs.existsSync(dir)) return;
          session.workDir = dir;
          const git = await detectGitInfo(dir);
          const repo = git.gitMainRepoPath || git.gitRepoPath;
          if (repo) session.workRepoPath = repo;
        } catch (error) {
          logger.debug(`[GET /sessions] Could not tell where ${session.id} works: ${error}`);
        }
      })
    );
    // Codex's state from its own rollout, and the menu it waits on. Only the sessions a Codex
    // runs in, all at once: each may read its screen, and one after the other they held the
    // whole list back (review of 2026-11-10).
    await Promise.all(
      (localSessionsWithSource as Session[]).map(async (session) => {
        if (session.status !== 'running' || session.claudeStatus) return;
        if (!config.codex?.runs(session.id)) return;
        try {
          const agentStatus = await config.codex.status(session.id);
          if (agentStatus) {
            session.agentStatus = agentStatus;
            session.codexActive = true;
          }
          // A long session's screen is only read once its terminal exists (see warmTerminal):
          // built while a menu may be up (at work, or no turn yet), never for a Codex at rest,
          // whose terminal closes again and would be replayed on every poll.
          if (agentStatus?.status !== 'idle' && !terminalManager.canSnapshotCheaply(session.id)) {
            warmTerminal(session.id);
          }
        } catch (error) {
          logger.debug(`[GET /sessions] Could not read Codex state of ${session.id}: ${error}`);
        }
      })
    );
    // Codex (started directly or typed in a shell): its conversation title (the first
    // prompt), like Claude's generated title.
    for (const session of localSessionsWithSource as Session[]) {
      if (session.status !== 'running' || session.claudeStatus) continue;
      if (fromTitleCache(session, opts.agentTitlesMaxAgeMs)) continue;
      try {
        const ref = await codexSessionRef({
          ...session,
          pid: ptyManager.programRootPid(session),
        });
        if (!ref) continue;
        session.codexActive = true;
        // Its thread's name (Codex's own, or `/rename`) first, as Codex itself lists it.
        const title =
          (session.codexThreadId ? codexThreadTitle(session.codexThreadId) : undefined) ??
          readCodexChat(ref).title;
        if (title) session.codexTitle = title;
      } catch (error) {
        logger.debug(`[GET /sessions] Could not read Codex title of ${session.id}: ${error}`);
      }
    }
    // Ended Codex sessions (2026-11-10): the thread's title stays on them, and "Resume" is
    // offered only when its thread can be resumed: none running it in another session (a
    // second tap would open it twice), its folder and its rollout still there.
    const runningThreads = new Set(
      (localSessionsWithSource as Session[])
        .filter((session) => session.status !== 'exited' && session.codexThreadId)
        .map((session) => session.codexThreadId)
    );
    for (const session of localSessionsWithSource as Session[]) {
      if (session.status !== 'exited' || !session.codexThreadId) continue;
      try {
        const title = codexThreadTitle(session.codexThreadId);
        if (title) session.codexTitle = title;
        session.codexResumable =
          !runningThreads.has(session.codexThreadId) &&
          !isAttachedToTmux(session) &&
          !!session.workingDir &&
          fs.existsSync(session.workingDir) &&
          codexThreadExists(session.codexThreadId);
      } catch (error) {
        session.codexResumable = false;
        logger.debug(`[GET /sessions] Could not read Codex thread of ${session.id}: ${error}`);
      }
    }
    // Gemini CLI (started directly or typed in a shell): its first prompt as the title.
    for (const session of localSessionsWithSource as Session[]) {
      if (session.status !== 'running' || session.claudeStatus || session.codexActive) continue;
      // Read with the Codex title above, or still remembered from an earlier look.
      if (opts.agentTitlesMaxAgeMs !== undefined && agentTitles.has(session.id)) continue;
      try {
        const ref = await geminiSessionRef({
          ...session,
          pid: ptyManager.programRootPid(session),
        });
        if (!ref) continue;
        session.geminiActive = true;
        const title = readGeminiChat(ref).title;
        if (title) session.geminiTitle = title;
      } catch (error) {
        logger.debug(`[GET /sessions] Could not read Gemini title of ${session.id}: ${error}`);
      }
    }
    // Dev servers each running session started (the "Preview" chip).
    if (config.previewRegistry) {
      for (const session of localSessionsWithSource as Session[]) {
        const ports =
          session.status === 'running' ? config.previewRegistry.forSession(session.id) : [];
        if (ports.length > 0) session.previewPorts = ports;
      }
    }
    // Shells, Codex, Gemini…: the last line of output instead of Claude's message preview.
    await Promise.all(
      (localSessionsWithSource as Session[]).map(async (session) => {
        if (session.status !== 'running' || session.claudeStatus) return;
        try {
          const lastLine = await lastLines.get(session.id);
          if (lastLine) session.lastLine = lastLine;
        } catch (error) {
          logger.debug(`[GET /sessions] Could not read last line of ${session.id}: ${error}`);
        }
      })
    );
    // Exited Claude sessions: offer "resume" only when there is a conversation to resume.
    // 2026-10-18 review: one already resumed in another session showed "Resume" again, and a
    // second tap made a second writer of the conversation.
    const runningConversations = new Set(
      (localSessionsWithSource as Session[])
        .filter((session) => session.status === 'running' && session.claudeSessionId)
        .map((session) => session.claudeSessionId)
    );
    for (const session of localSessionsWithSource as Session[]) {
      if (session.status === 'exited' && session.claudeSessionId && session.workingDir) {
        if (runningConversations.has(session.claudeSessionId)) {
          session.claudeResumable = false;
          continue;
        }
        // Attached to tmux, the conversation still runs there: resuming it would make a
        // second writer of it.
        if (isAttachedToTmux(session)) {
          session.claudeResumable = false;
          continue;
        }
        // 2026-10-18: a merged task's worktree is gone; a resume there would start Claude
        // in the server's own folder instead.
        if (!fs.existsSync(session.workingDir)) {
          session.claudeResumable = false;
          continue;
        }
        try {
          session.claudeResumable = claudeConversationExists(
            session.workingDir,
            session.claudeSessionId
          );
        } catch {
          session.claudeResumable = false;
        }
      }
    }

    for (const session of localSessionsWithSource as Session[]) {
      const macWindow = macWindows.macWindow(session);
      if (macWindow) session.macWindow = macWindow;
    }

    if (explainer && opts.explainLang !== undefined) {
      const sessions = localSessionsWithSource as Session[];
      for (const session of sessions) {
        const explanation = explainer.explain(session, opts.explainLang);
        if (explanation) session.explain = explanation;
      }
      explainer.prune(new Set(sessions.map((session) => session.id)));
    }

    if (opts.agentTitlesMaxAgeMs !== undefined)
      rememberAgentTitles(localSessionsWithSource as Session[]);
    return localSessionsWithSource as Session[];
  }

  // List all sessions (aggregate local + remote in HQ mode)
  router.get('/sessions', async (req, res) => {
    // Polled every 1-3 s by every client: no per-poll log lines (debug lines always reach the
    // log file).
    try {
      let allSessions: unknown[] = await listLocalSessions({
        git: true,
        explainLang: typeof req.query?.lang === 'string' ? req.query.lang : '',
      });

      // If in HQ mode, aggregate sessions from all remotes
      if (isHQMode && remoteRegistry) {
        const remotes = remoteRegistry.getRemotes();
        logger.debug(`checking ${remotes.length} remote servers for sessions`);

        // Fetch sessions from each remote in parallel
        const remotePromises = remotes.map(async (remote) => {
          try {
            const response = await fetch(`${remote.url}/api/sessions`, {
              headers: {
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(5000), // 5 second timeout
            });

            if (response.ok) {
              const remoteSessions = (await response.json()) as Session[];
              logger.debug(`got ${remoteSessions.length} sessions from remote ${remote.name}`);

              // Track session IDs for this remote
              const sessionIds = remoteSessions.map((s: Session) => s.id);
              remoteRegistry.updateRemoteSessions(remote.id, sessionIds);

              // Add remote info to each session
              return remoteSessions.map((session: Session) => ({
                ...session,
                source: 'remote',
                remoteId: remote.id,
                remoteName: remote.name,
                remoteUrl: remote.url,
              }));
            } else {
              logger.warn(
                `failed to get sessions from remote ${remote.name}: HTTP ${response.status}`
              );
              return [];
            }
          } catch (error) {
            logger.error(`failed to get sessions from remote ${remote.name}:`, error);
            return [];
          }
        });

        const remoteResults = await Promise.all(remotePromises);
        const remoteSessions = remoteResults.flat();
        logger.debug(`total remote sessions: ${remoteSessions.length}`);

        allSessions = [...allSessions, ...remoteSessions];
      }

      res.json(allSessions);
    } catch (error) {
      logger.error('error listing sessions:', error);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // Create new session (local or on remote)
  router.post('/sessions', async (req, res) => {
    const { command, name, remoteId, cols, rows, titleMode, gitBranch } = req.body;
    let { workingDir } = req.body;
    // Shielded sessions run in tmux on this server, never in a Terminal.app window. Without an
    // explicit choice, local web/phone sessions are shielded when the setting is on and tmux is
    // there: a restart or update of the server must not kill them (2026-10-03, a deploy killed
    // the user's own Claude session). Terminal.app sessions and remote (HQ) ones are untouched.
    const shielded =
      req.body.shielded === true ||
      (req.body.shielded === undefined &&
        req.body.spawn_terminal !== true &&
        !remoteId &&
        (config.shieldNewSessionsByDefault?.() ?? false) &&
        config.ptyManager.isShieldAvailable());
    const spawn_terminal = shielded ? false : req.body.spawn_terminal;
    // "Ask Claude": a first message the server types into the new session once Claude is ready.
    const { initialInput, initialInputAgent } = req.body;
    logger.debug(
      `creating new session: command=${JSON.stringify(command)}, remoteId=${remoteId || 'local'}, spawn_terminal=${spawn_terminal}, cols=${cols}, rows=${rows}`
    );

    if (!command || !Array.isArray(command) || command.length === 0) {
      logger.warn('session creation failed: invalid command array');
      return res.status(400).json({ error: 'Command array is required' });
    }

    if (gitBranch !== undefined && (typeof gitBranch !== 'string' || gitBranch.length > 250)) {
      return res.status(400).json({ error: 'gitBranch must be a branch name' });
    }

    if (
      initialInput !== undefined &&
      (typeof initialInput !== 'string' || initialInput.length > INITIAL_INPUT_MAX_LENGTH)
    ) {
      return res.status(400).json({ error: 'initialInput must be a string' });
    }
    if (
      initialInputAgent !== undefined &&
      initialInputAgent !== 'claude' &&
      initialInputAgent !== 'codex'
    ) {
      return res.status(400).json({ error: 'initialInputAgent must be "claude" or "codex"' });
    }
    // Which agent's prompt to wait for: as asked, else what the command runs.
    const inputAgent: InitialInputAgent =
      initialInputAgent ?? (isCodexCommand(command) ? 'codex' : 'claude');
    // A resume claims its conversation until the session exists (resumesInFlight).
    let reservedSessionId: string | undefined;
    let releaseResume: ((ok: boolean) => void) | undefined;
    let resumeStarted = false;

    try {
      // If remoteId is specified and we're in HQ mode, forward to remote
      if (remoteId && isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemote(remoteId);
        if (!remote) {
          logger.warn(`session creation failed: remote ${remoteId} not found`);
          return res.status(404).json({ error: 'Remote server not found' });
        }

        logger.log(colors.blue(`forwarding session creation to remote ${remote.name}`));

        // Forward the request to the remote server
        const startTime = Date.now();
        const response = await fetch(`${remote.url}/api/sessions`, {
          method: HttpMethod.POST,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${remote.token}`,
          },
          body: JSON.stringify({
            command,
            workingDir,
            name,
            spawn_terminal,
            cols,
            rows,
            titleMode,
            initialInput,
            initialInputAgent,
            ...(gitBranch ? { gitBranch } : {}),
            ...(shielded ? { shielded } : {}),
            // Don't forward remoteId to avoid recursion
          }),
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Unknown error' }));
          return res.status(response.status).json(error);
        }

        const result = (await response.json()) as { sessionId: string; createdAt?: string };
        logger.debug(`remote session creation took ${Date.now() - startTime}ms`);

        // Track the session in the remote's sessionIds
        if (result.sessionId) {
          remoteRegistry.addSessionToRemote(remote.id, result.sessionId);
        }

        // Forward the complete response (maintains compatibility with newer/older servers)
        res.json(result);
        return;
      }

      // HQ never spawns locally: a session must land on a registered remote. This
      // covers BOTH local-spawn paths below (terminal spawn + web session) but not
      // the forward-to-remote branch above (which already returned). On a Mac
      // remote isHQMode is false, so the forwarded request still spawns normally.
      if (isHQMode && !remoteId) {
        const count = remoteRegistry?.getRemotes().length ?? 0;
        logger.warn('session creation refused: HQ mode requires a target remote');
        return res.status(400).json({
          error:
            count === 0
              ? 'No machines are registered with this HQ, so no session can be created. Start Untether on a machine first.'
              : 'A target machine (remoteId) is required in HQ mode.',
        });
      }

      // `codex resume <id>` (2026-11-10): a thread is claimed like a Claude conversation, one
      // session per thread.
      const resumedThread = codexResumeTarget(command);
      const resumed = claudeResumeTarget(command) ?? resumedThread;
      if (resumed) {
        // 2026-10-20: a double tap on "Resume Claude" (or two devices at once) started the same
        // conversation twice: the check below only saw 'running' sessions, while the first one
        // sat in 'starting' through detectGitInfo/tmux/spawn. A resume already on its way is
        // the answer, and so is a session still starting with it.
        // Running in another Untether session already: that one is the answer, never a second.
        const claim = await claimConversation(resumed);
        if (claim.kind === 'existing')
          return res.json({ sessionId: claim.sessionId, existing: true });
        if (claim.kind === 'failed') {
          return res.status(409).json({
            error: 'resume-failed',
            details: 'Resuming this conversation failed a moment ago',
          });
        }
        reservedSessionId = claim.sessionId;
        releaseResume = claim.release;
      }
      // A conversation running outside Untether right now (a Terminal tab, a tmux pane) is
      // never resumed here, whoever asks: that would make a second writer of it.
      const liveElsewhere = resumedThread
        ? await liveCodexThread(resumedThread)
        : resumed
          ? (await config.liveClaudeConversations?.().catch(() => undefined))?.get(resumed)
          : undefined;
      if (liveElsewhere) {
        return res.status(409).json({
          error: 'live-elsewhere',
          details: 'This conversation is running outside Untether right now',
          live: liveElsewhere,
        });
      }

      // A chosen branch other than the folder's: its worktree (made when there is none),
      // never a switch of the user's checkout (services/session-branch-dir.ts). A resume
      // stays in its conversation's folder.
      if (gitBranch?.trim() && !resumed) {
        const branchDir = await sessionDirForBranch(
          resolvePath(workingDir, process.cwd()),
          gitBranch
        );
        if (!branchDir.ok) {
          return res.status(branchDir.code === 'worktree-failed' ? 500 : 400).json({
            error: branchDir.code,
            details: branchDir.message,
          });
        }
        if (branchDir.how !== 'current') {
          logger.log(
            `session on branch ${gitBranch}: ${branchDir.how === 'created' ? 'new' : 'existing'} worktree ${branchDir.workingDir}`
          );
        }
        workingDir = branchDir.workingDir;
      }

      // If spawn_terminal is true, use the control socket for terminal spawning
      if (spawn_terminal) {
        try {
          // Generate session ID (a resume's was reserved above)
          const sessionId = reservedSessionId ?? generateSessionId();
          const resolvedCwd = resolvePath(workingDir, process.cwd());
          const sessionName = name || generateSessionName(command, resolvedCwd);

          // Detect Git information for terminal spawn
          const gitInfo = await detectGitInfo(resolvedCwd);

          // Request Mac app to spawn terminal
          logger.log(
            colors.blue(`requesting terminal spawn with command: ${JSON.stringify(command)}`)
          );
          const spawnResult = await requestTerminalSpawn({
            sessionId,
            sessionName,
            command,
            workingDir: resolvedCwd,
            titleMode,
            gitRepoPath: gitInfo.gitRepoPath,
            gitBranch: gitInfo.gitBranch,
            gitAheadCount: gitInfo.gitAheadCount,
            gitBehindCount: gitInfo.gitBehindCount,
            gitHasChanges: gitInfo.gitHasChanges,
            gitIsWorktree: gitInfo.gitIsWorktree,
            gitMainRepoPath: gitInfo.gitMainRepoPath,
          });

          if (!spawnResult.success && spawnResult.mayStillOpen) {
            // 2026-10-20: a timeout fell back to a web session while the Terminal window was
            // still opening: the command ran twice. The error is reported instead, and a
            // resume keeps its claim until the window's session shows (or for a while).
            logger.warn(`terminal spawn for ${sessionId} not confirmed in time; no fallback`);
            if (releaseResume) {
              holdResumeUntilSessionAppears(sessionId, releaseResume);
              releaseResume = undefined;
            }
            res.status(504).json({
              error: 'terminal-spawn-timeout',
              details: 'The Mac app did not confirm the Terminal window in time; it may still open',
              sessionId,
            });
            return;
          }
          if (!spawnResult.success) {
            // Log the error but continue with fallback
            logger.warn('terminal spawn failed:', spawnResult.error || 'Unknown error');
            logger.debug('falling back to normal web session');
          } else {
            // Wait a bit for the session to be created
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Return the session ID - client will poll for the session to appear
            logger.log(colors.green(`terminal spawn requested for session ${sessionId}`));
            deliverInitialInput(sessionId, initialInput, inputAgent);
            resumeStarted = true;
            // The window's forwarder registers the session a moment later: until then a second
            // resume of the conversation must still find the claim (2026-10-20).
            if (releaseResume) {
              holdResumeUntilSessionAppears(sessionId, releaseResume);
              releaseResume = undefined;
            }
            res.json({
              sessionId,
              createdAt: new Date().toISOString(),
              workingDir: resolvedCwd,
            });
            return;
          }
        } catch (error) {
          // Log the error but continue with fallback
          logger.error('error spawning terminal:', error);
          logger.debug('falling back to normal web session');
        }
      }

      // Create local session
      let cwd = resolvePath(workingDir, process.cwd());

      // Check if the working directory exists, fall back to process.cwd() if not
      if (!fs.existsSync(cwd)) {
        // 2026-10-18: "Resume Claude" on a merged task's session (its worktree removed) started
        // the conversation in the server's folder. A resume belongs to its own folder only.
        if (resumed) {
          res.status(400).json({ error: `Folder no longer exists: ${cwd}` });
          return;
        }
        logger.warn(
          `Working directory '${cwd}' does not exist, using current directory as fallback`
        );
        cwd = process.cwd();
      }

      const sessionName = name || generateSessionName(command, cwd);

      // Detect Git information
      const gitInfo = await detectGitInfo(cwd);

      logger.log(
        colors.blue(
          `creating WEB session: ${command.join(' ')} in ${cwd} (spawn_terminal=${spawn_terminal})`
        )
      );

      if (shielded && !ptyManager.isShieldAvailable()) {
        return res
          .status(501)
          .json({ error: 'Shielded sessions need tmux, which is not installed on this Mac' });
      }

      // An interactive session against an external model provider (model-providers.ts): from the
      // New Session dialog (body `modelProvider`), or kept across "Resume Claude" from the ended
      // session's marker. Its Claude Code runs with the provider's base URL and key, the picker
      // and `--model`, never the user's own Anthropic login.
      let runCommand = command;
      // "Resume" on an ended Codex session sends the bare `codex resume <id>`: it goes on with
      // the executable and the options that session had (model, sandbox, -c…), as Blindar does.
      // A command with options of its own is started as it was asked.
      if (resumedThread && carriedCodexArgs(command.slice(1)).length === 0) {
        const ended = ptyManager
          .listSessions()
          .filter(
            (session) =>
              session.status === 'exited' &&
              session.codexThreadId === resumedThread &&
              startsCodex(session.command)
          )
          .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
        if (ended) runCommand = codexResumeCommand(ended.command, resumedThread);
      }
      let providerOpts: Pick<SessionCreateOptions, 'env' | 'unsetEnv' | 'modelProvider'> = {};
      if (config.providerInteractive) {
        const body = req.body.modelProvider as { id?: unknown; model?: unknown } | undefined;
        const bodyMarker: ProviderSessionMarker | undefined =
          body && typeof body.id === 'string' && body.id
            ? { id: body.id, model: typeof body.model === 'string' ? body.model : '' }
            : undefined;
        // "Resume Claude" on a provider session keeps its provider (the ended session's marker).
        const resumeMarker = resumed
          ? ptyManager.listSessions().find((s) => s.claudeSessionId === resumed && s.modelProvider)
              ?.modelProvider
          : undefined;
        const marker = bodyMarker ?? resumeMarker;
        if (marker) {
          const launch = await config.providerInteractive(marker, command);
          if (!launch) {
            return res.status(400).json({
              error: 'provider-unavailable',
              details: `model provider "${marker.id}" is not available (missing provider or key)`,
            });
          }
          runCommand = launch.command;
          providerOpts = {
            env: launch.env,
            unsetEnv: launch.unset,
            modelProvider: launch.marker,
          };
        }
      }

      const result = await ptyManager.createSession(runCommand, {
        ...(reservedSessionId ? { sessionId: reservedSessionId } : {}),
        name: sessionName,
        workingDir: cwd,
        cols,
        rows,
        titleMode,
        shielded,
        ...providerOpts,
        gitRepoPath: gitInfo.gitRepoPath,
        gitBranch: gitInfo.gitBranch,
        gitAheadCount: gitInfo.gitAheadCount,
        gitBehindCount: gitInfo.gitBehindCount,
        gitHasChanges: gitInfo.gitHasChanges,
        gitIsWorktree: gitInfo.gitIsWorktree,
        gitMainRepoPath: gitInfo.gitMainRepoPath,
      });

      const { sessionId, sessionInfo } = result;
      logger.log(colors.green(`WEB session ${sessionId} created (PID: ${sessionInfo.pid})`));

      // Stream watcher is set up when clients connect to the stream endpoint
      deliverInitialInput(sessionId, initialInput, inputAgent);

      // A task's (or its orchestrator's) conversation resumed by hand: the new session carries
      // on where the ended one was (2026-10-18 review: it showed loose, the task still failed).
      if (resumed) {
        const previous = ptyManager
          .listSessions()
          .filter(
            (session) =>
              session.id !== sessionId &&
              session.status === 'exited' &&
              (session.claudeSessionId === resumed || session.codexThreadId === resumed)
          )
          .sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''))[0];
        if (previous) {
          void config.sessionReplacements?.replaced(previous.id, sessionId, { resumed: true });
        }
      }

      resumeStarted = true;
      // The folder it really runs in (a branch's worktree, a fallback for a missing folder).
      res.json({ sessionId, createdAt: new Date().toISOString(), workingDir: cwd });
    } catch (error) {
      logger.error('error creating session:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to create session', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to create session' });
      }
    } finally {
      releaseResume?.(resumeStarted);
    }
  });

  // Get git status for a specific session
  router.get('/sessions/:sessionId/git-status', async (req, res) => {
    const sessionId = req.params.sessionId;

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}/git-status`, {
              headers: {
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to get git status from remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling
      const session = ptyManager.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Get detailed git status for the session's working directory
      const gitStatus = await getDetailedGitStatusCached(session.workingDir);

      res.json(gitStatus);
    } catch (error) {
      logger.error(`error getting git status for session ${sessionId}:`, error);
      res.status(500).json({ error: 'Failed to get git status' });
    }
  });

  // Get single session info
  router.get('/sessions/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}`, {
              headers: {
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to get session info from remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling
      const session = ptyManager.getSession(sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      macWindows.refresh([session]);
      const macWindow = macWindows.macWindow(session);
      if (macWindow) session.macWindow = macWindow;

      // If session doesn't have Git info, try to detect it
      if (!session.gitRepoPath && session.workingDir) {
        try {
          const gitInfo = await detectGitInfo(session.workingDir);
          // logger.debug(
          //   `[GET /sessions/:id] Detected Git info for session ${session.id}: repo=${gitInfo.gitRepoPath}, branch=${gitInfo.gitBranch}`
          // );
          res.json({ ...session, ...gitInfo });
          return;
        } catch (error) {
          // If Git detection fails, just return session as-is
          logger.debug(
            `[GET /sessions/:id] Could not detect Git info for session ${session.id}: ${error}`
          );
        }
      }

      res.json(session);
    } catch (error) {
      logger.error('error getting session info:', error);
      res.status(500).json({ error: 'Failed to get session info' });
    }
  });

  // Kill session (just kill the process)
  router.delete('/sessions/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    logger.debug(`killing session ${sessionId}`);

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward kill request to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}`, {
              method: HttpMethod.DELETE,
              headers: {
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(10000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            // Remote killed the session, now update our registry
            remoteRegistry.removeSessionFromRemote(sessionId);
            logger.log(colors.yellow(`remote session ${sessionId} killed on ${remote.name}`));

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to kill session on remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling - just kill it, no registry updates needed
      const session = ptyManager.getSession(sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // If session is already exited, clean it up instead of trying to kill it
      if (session.status === 'exited') {
        ptyManager.cleanupSession(sessionId);
        logger.log(colors.yellow(`local session ${sessionId} cleaned up`));
        res.json({ success: true, message: 'Session cleaned up' });
      } else {
        // A tmux attachment is detached, and its tmux session keeps running.
        const isTmuxAttachment = isAttachedToTmux(session);

        await ptyManager.killSession(sessionId, 'SIGTERM');

        if (isTmuxAttachment) {
          logger.log(colors.yellow(`local session ${sessionId} detached from tmux`));
          res.json({ success: true, message: 'Detached from tmux session' });
        } else {
          logger.log(colors.yellow(`local session ${sessionId} killed`));
          res.json({ success: true, message: 'Session killed' });
        }
      }
    } catch (error) {
      logger.error('error killing session:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to kill session', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to kill session' });
      }
    }
  });

  // Cleanup session files
  router.delete('/sessions/:sessionId/cleanup', async (req, res) => {
    const sessionId = req.params.sessionId;
    logger.debug(`cleaning up session ${sessionId} files`);

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward cleanup request to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}/cleanup`, {
              method: HttpMethod.DELETE,
              headers: {
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(10000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            // Remote cleaned up the session, now update our registry
            remoteRegistry.removeSessionFromRemote(sessionId);
            logger.log(colors.yellow(`remote session ${sessionId} cleaned up on ${remote.name}`));

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to cleanup session on remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling - just cleanup, no registry updates needed
      ptyManager.cleanupSession(sessionId);
      logger.log(colors.yellow(`local session ${sessionId} cleaned up`));

      res.json({ success: true, message: 'Session cleaned up' });
    } catch (error) {
      logger.error('error cleaning up session:', error);
      if (error instanceof PtyError && error.code === 'INVALID_SESSION_ID') {
        res.status(400).json({ error: 'Invalid session id' });
      } else if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to cleanup session', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to cleanup session' });
      }
    }
  });

  // Cleanup all exited sessions (local and remote)
  router.post('/cleanup-exited', async (req, res) => {
    logger.log(colors.blue('cleaning up all exited sessions'));
    try {
      // Clean up local sessions. Resumable Claude and Codex sessions, task sessions and shielded ones
      // that may come back are kept (keptByExitedCleanup), unless ?all=1 asks for everything.
      const all = req.query?.all === '1' || req.query?.all === 'true';
      // 2026-10-20: the kept ones vanished from the count without a word, and "Clean exited"
      // looked broken; the answer says how many were kept and why (`kept`, `keptReasons`).
      const keptReasons: Record<ExitedKeepReason, number> = {
        claude: 0,
        codex: 0,
        task: 0,
        shielded: 0,
      };
      let kept = 0;
      const localCleanedSessions = ptyManager.cleanupExitedSessions({
        all,
        keep: (session) => config.keepOnExitedCleanup?.(session.id) ?? false,
        onKept: (_session, reason) => {
          kept++;
          keptReasons[reason]++;
        },
      });
      logger.log(colors.green(`cleaned up ${localCleanedSessions.length} local exited sessions`));

      // Remove cleaned local sessions from remote registry if in HQ mode
      if (isHQMode && remoteRegistry) {
        for (const sessionId of localCleanedSessions) {
          remoteRegistry.removeSessionFromRemote(sessionId);
        }
      }

      let totalCleaned = localCleanedSessions.length;
      const remoteResults: Array<{ remoteName: string; cleaned: number; error?: string }> = [];

      // If in HQ mode, clean up sessions on all remotes
      if (isHQMode && remoteRegistry) {
        const allRemotes = remoteRegistry.getRemotes();

        // Clean up on each remote in parallel
        const remoteCleanupPromises = allRemotes.map(async (remote) => {
          try {
            const response = await fetch(`${remote.url}/api/cleanup-exited`, {
              method: HttpMethod.POST,
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(10000), // 10 second timeout
            });

            if (response.ok) {
              const result = (await response.json()) as {
                cleanedSessions: string[];
                kept?: number;
                keptReasons?: Partial<Record<ExitedKeepReason, number>>;
              };
              const cleanedSessionIds = result.cleanedSessions || [];
              const cleanedCount = cleanedSessionIds.length;
              totalCleaned += cleanedCount;
              if (typeof result.kept === 'number' && result.kept > 0) kept += result.kept;
              for (const reason of Object.keys(keptReasons) as ExitedKeepReason[]) {
                const count = result.keptReasons?.[reason];
                if (typeof count === 'number' && count > 0) keptReasons[reason] += count;
              }

              // Remove cleaned remote sessions from registry
              for (const sessionId of cleanedSessionIds) {
                remoteRegistry.removeSessionFromRemote(sessionId, remote.id);
              }

              remoteResults.push({ remoteName: remote.name, cleaned: cleanedCount });
            } else {
              throw new Error(`HTTP ${response.status}`);
            }
          } catch (error) {
            logger.error(`failed to cleanup sessions on remote ${remote.name}:`, error);
            remoteResults.push({
              remoteName: remote.name,
              cleaned: 0,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        });

        await Promise.all(remoteCleanupPromises);
      }

      res.json({
        success: true,
        message: `${totalCleaned} exited sessions cleaned up across all servers`,
        localCleaned: localCleanedSessions.length,
        // An HQ server reads this list to forget the ids it removed here (see above).
        cleanedSessions: localCleanedSessions,
        // Exited sessions left in place: a resumable Claude conversation, an open task's or an
        // orchestrator's, a shielded one that may come back (?all=1 removes them too).
        kept,
        keptReasons,
        remoteResults,
      });
    } catch (error) {
      logger.error('error cleaning up exited sessions:', error);
      if (error instanceof PtyError) {
        res
          .status(500)
          .json({ error: 'Failed to cleanup exited sessions', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to cleanup exited sessions' });
      }
    }
  });

  // Get session plain text
  router.get('/sessions/:sessionId/text', async (req, res) => {
    const sessionId = req.params.sessionId;
    const includeStyles = req.query.styles !== undefined;
    logger.debug(`getting plain text for session ${sessionId}, styles=${includeStyles}`);

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward text request to remote server
          try {
            const url = new URL(`${remote.url}/api/sessions/${sessionId}/text`);
            if (includeStyles) {
              url.searchParams.set('styles', '');
            }

            const response = await fetch(url.toString(), {
              headers: {
                Authorization: `Bearer ${remote.token}`,
              },
              signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            // Forward the text response
            const text = await response.text();
            res.setHeader('Content-Type', 'text/plain');
            return res.send(text);
          } catch (error) {
            logger.error(`failed to get text from remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling
      const session = ptyManager.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Get terminal buffer snapshot
      const snapshot = await terminalManager.getBufferSnapshot(sessionId);

      // Use shared formatter to convert cells to text
      const plainText = cellsToText(snapshot.cells, includeStyles);

      // Send as plain text
      res.setHeader('Content-Type', 'text/plain');
      res.send(plainText);
    } catch (error) {
      logger.error('error getting plain text:', error);
      res.status(500).json({ error: 'Failed to get terminal text' });
    }
  });

  // Claude Code conversation running in a local session (phone chat mode)
  router.get('/sessions/:sessionId/claude-chat', async (req, res) => {
    const session = ptyManager.getSession(req.params.sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!session.pid || session.status !== 'running') {
      return res.json({ available: false, messages: [] });
    }
    try {
      // A shielded session's pid is its tmux client: look under the program inside tmux.
      const programPid = ptyManager.programRootPid(session) ?? session.pid;
      const chat = await readSessionChat({ ...session, pid: session.pid }, programPid);
      // `?have=<fingerprint>`: the client already shows these messages; leave them out.
      res.json(chatAnswer(chat, req.query?.have));
    } catch (error) {
      logger.error('error reading claude chat:', error);
      res.status(500).json({ error: 'Failed to read Claude conversation' });
    }
  });

  // Send input to session
  router.post('/sessions/:sessionId/input', async (req, res) => {
    const sessionId = req.params.sessionId;
    const { text, key } = req.body;

    // Validate that only one of text or key is provided
    if ((text === undefined && key === undefined) || (text !== undefined && key !== undefined)) {
      logger.warn(
        `invalid input request for session ${sessionId}: both or neither text/key provided`
      );
      return res.status(400).json({ error: 'Either text or key must be provided, but not both' });
    }

    if (text !== undefined && typeof text !== 'string') {
      logger.warn(`invalid input request for session ${sessionId}: text is not a string`);
      return res.status(400).json({ error: 'Text must be a string' });
    }

    if (key !== undefined && typeof key !== 'string') {
      logger.warn(`invalid input request for session ${sessionId}: key is not a string`);
      return res.status(400).json({ error: 'Key must be a string' });
    }

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward input to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}/input`, {
              method: HttpMethod.POST,
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${remote.token}`,
              },
              body: JSON.stringify(req.body),
              signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to send input to remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      sendAnswer(res, await localInput(sessionId, text !== undefined ? { text } : { key }));
    } catch (error) {
      logger.error('error sending input:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to send input', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to send input' });
      }
    }
  });

  /** Text or a key into a local session (the input route and the voice copilot). */
  /** Wakes the session when it is suspended; the answer to give when that failed, else null. */
  async function wakeFirst(
    sessionId: string,
    why: string,
    byUser = false
  ): Promise<RouteAnswer | null> {
    if (!ptyManager.getSession(sessionId)?.suspended || !config.wakeSuspended) return null;
    const woke = await config.wakeSuspended(sessionId, why, { byUser });
    return woke.ok
      ? null
      : answerWith(503, { error: 'Session is suspended and could not wake', details: woke.error });
  }

  async function localInput(sessionId: string, inputData: SessionInput): Promise<RouteAnswer> {
    // Typed into a suspended session: it wakes first, then the input goes in (2026-10-31).
    const notAwake = await wakeFirst(sessionId, 'input through the API', true);
    if (notAwake) return notAwake;
    const session = ptyManager.getSession(sessionId);
    if (!session) {
      logger.error(`session ${sessionId} not found for input`);
      return answerWith(404, { error: 'Session not found' });
    }

    if (session.status !== 'running') {
      logger.error(`session ${sessionId} is not running (status: ${session.status})`);
      return answerWith(400, { error: 'Session is not running' });
    }

    logger.debug(`sending input to session ${sessionId}: ${JSON.stringify(inputData)}`);
    // A forwarder's stale ipc.sock is an error here, not a 200 for lost input (2026-10-20).
    await ptyManager.connectInput?.(sessionId);
    // The user's own keys: what Untether types for an agent waits for them (2026-11-10).
    ptyManager.noteUserInput?.(sessionId);
    ptyManager.sendInput(sessionId, inputData);
    return answerWith(200, { success: true });
  }

  // One answer or reply per session at a time: a double tap on the phone posted twice, and
  // the second Esc and text (or digit) landed on whatever came next (review of 2026-10-03).
  const answering = new Set<string>();

  /**
   * The menu the client showed is the one on screen: same question (one there is), or same
   * options, compared loosely; and the same key (its lines up to the dialog's top). Consecutive
   * permission prompts share question and options: a late tap approved the next command
   * (review of 2026-10-03). A client that sends no key for a menu that has one (an answer
   * sheet still on a push's choices, an app not reloaded since) is not trusted with it
   * (fourth review); a yes/no question has none.
   */
  function sameMenu(
    sessionId: string,
    choices: NonNullable<ScreenChoices>,
    body: { question?: unknown; options?: unknown; key?: unknown; keyHash?: unknown }
  ): boolean {
    const question = looseText(choices.question);
    const sameQuestion =
      question !== '' && typeof body.question === 'string' && looseText(body.question) === question;
    const sameOptions =
      choices.navigate === true &&
      Array.isArray(body.options) &&
      looseText(body.options.join('')) === looseText(choices.options.join(''));
    if (!sameQuestion && !sameOptions) return false;
    if (!choices.key) return true;
    if (typeof body.key !== 'string' || !body.key) {
      // An answer sheet still on a push's choices sends the push's fingerprint of the key.
      if (typeof body.keyHash === 'string' && body.keyHash === menuKeyHash(choices.key)) {
        return true;
      }
      logger.log(`menu key of ${sessionId}: the client sent none`);
      return false;
    }
    if (sameMenuKey(body.key, choices.key)) return true;
    // Which lines differ, when a read of the same menu is refused (start and end of each).
    const ends = (key: string) => `${key.length}: ${key.slice(0, 40)} … ${key.slice(-40)}`;
    logger.log(
      `menu key of ${sessionId} differs: phone ${ends(body.key)} / here ${ends(choices.key)}`
    );
    return false;
  }

  /**
   * An answer counts as given once its menu left the screen: keys sent to a prompt that did not
   * take them were a 200 and the phone said "sent" (2026-11-09). Never typed twice: the client
   * says it did not land and the user tries again.
   */
  async function answerLanded(
    sessionId: string,
    menu: NonNullable<ScreenChoices>
  ): Promise<RouteAnswer> {
    if (await screenMenu.waitGone(sessionId, menu)) return answerWith(200, { success: true });
    logger.warn(`answer to ${sessionId}: its menu is still on screen; not delivered`);
    return answerWith(504, { error: 'not-delivered' });
  }

  /**
   * Answer a menu on screen (phone list quick answers, the composer's menu buttons, the voice
   * copilot). The caller sends the question and options it showed; the screen is re-read and
   * the answer only given if that menu is still the one waiting, so a stale button can't
   * approve a newer prompt.
   */
  async function answerMenu(
    sessionId: string,
    input: Record<string, unknown> | undefined
  ): Promise<RouteAnswer> {
    const { option, question } = (input ?? {}) as { option: number; question: unknown };
    if (!Number.isInteger(option) || option < 1 || option > 9 || typeof question !== 'string') {
      return answerWith(400, { error: 'option (1-9) and question are required' });
    }
    const session = ptyManager.getSession(sessionId);
    if (session?.status !== 'running') {
      return answerWith(404, { error: 'Session not found or not running' });
    }
    // A tmux client attached read-only: tmux drops the keys, and the answer would never land.
    if (session.multiplexer?.mode === 'watch') return answerWith(409, { error: 'read-only' });
    if (answering.has(sessionId)) return answerWith(409, { error: 'busy' });
    answering.add(sessionId);
    try {
      // A push answer to a ut window whose forwarder died is an error, never a lost 200.
      await ptyManager.connectInput?.(sessionId);
      const choices = await readScreenChoices(sessionId);
      if (
        !choices ||
        !sameMenu(sessionId, choices, input ?? {}) ||
        option > choices.options.length
      ) {
        logger.log(`answer to ${sessionId}: the prompt changed (option ${option})`);
        return answerWith(409, { error: 'The prompt changed' });
      }
      logger.log(`answer to ${sessionId}: option ${option} of ${choices.options.length}`);
      choicesCache.delete(sessionId);
      if (choices.navigate) {
        if (!(await moveMenuCursor(sessionId, choices, option - 1))) {
          return answerWith(409, { error: 'The prompt changed' });
        }
        ptyManager.sendInput(sessionId, { key: 'enter' });
        return await answerLanded(sessionId, choices);
      }
      if (!choices.keys) return answerWith(409, { error: 'The prompt changed' });
      // A "(y/n)" question reads a line: the letter, then Enter (the letter alone left a
      // shell's "Continue? [Y/n]" waiting, review of 2026-10-03).
      ptyManager.sendInput(sessionId, { text: choices.keys[option - 1] });
      ptyManager.sendInput(sessionId, { key: 'enter' });
      return await answerLanded(sessionId, choices);
    } catch (error) {
      logger.error('error answering prompt:', error);
      return answerWith(500, { error: 'Failed to answer' });
    } finally {
      answering.delete(sessionId);
      // A Codex menu answered (or not): its screen is read again at the next look.
      config.codex?.answered(sessionId);
    }
  }

  router.post('/sessions/:sessionId/answer', async (req, res) => {
    sendAnswer(res, await answerMenu(req.params.sessionId, req.body));
  });

  /** The cursor to option `target`, verified on screen before any Enter (screen-menu.ts). */
  const moveMenuCursor = (
    sessionId: string,
    menu: NonNullable<ScreenChoices>,
    target: number
  ): Promise<boolean> => screenMenu.moveCursor(sessionId, menu, target);

  /** Claude Code's status for a running session, read live (not the list's cached one). */
  async function liveClaudeStatus(sessionId: string) {
    const session = ptyManager.getSession(sessionId);
    const pid = session ? ptyManager.programRootPid(session) : undefined;
    return pid ? (await readClaudeStatuses([pid])).get(pid) : undefined;
  }

  // The answer sheet (opened from a "Claude needs you" push or the list's chip) asks what is
  // waiting right now before it shows its buttons: the push may be minutes old.
  async function readPrompt(sessionId: string): Promise<RouteAnswer> {
    if (ptyManager.getSession(sessionId)?.status !== 'running') {
      return answerWith(404, { error: 'Session not found or not running' });
    }
    try {
      const claude = await liveClaudeStatus(sessionId);
      // Codex never says it waits (its rollout has no such event): a menu on its screen is it
      // waiting (approval, trust this folder, update), 2026-11-10.
      const codex = !claude && config.codex?.runs(sessionId) === true;
      const asks = claude?.status === 'waiting' || codex;
      const choices = asks ? await readScreenChoices(sessionId) : null;
      const waiting = codex ? choices !== null : claude?.status === 'waiting';
      return answerWith(200, {
        waiting,
        agent: codex ? 'codex' : claude ? 'claude' : undefined,
        waitingFor: waiting ? claude?.waitingFor : undefined,
        choices: choices
          ? {
              question: choices.question,
              options: choices.options,
              detail: choices.detail,
              key: choices.key,
            }
          : null,
      });
    } catch (error) {
      logger.error('error reading prompt:', error);
      return answerWith(500, { error: 'Failed to read prompt' });
    }
  }

  router.get('/sessions/:sessionId/prompt', async (req, res) => {
    sendAnswer(res, await readPrompt(req.params.sessionId));
  });

  // A written answer to Claude waiting on a menu (the answer sheet, the phone composer). Like
  // /answer, the client sends the menu it showed (null when it saw none) and nothing is typed if
  // the screen moved on. Esc dismisses the menu first (Claude's own "No, and tell Claude what to
  // do differently"), then the text is typed once Claude is back at its prompt; the response
  // waits for that, so the phone keeps the message until it is really typed.
  async function replyToMenu(
    sessionId: string,
    input: Record<string, unknown> | undefined
  ): Promise<RouteAnswer> {
    const { text, question, options } = (input ?? {}) as {
      text: unknown;
      question: unknown;
      options: unknown;
    };
    if (typeof text !== 'string' || !text.trim()) {
      return answerWith(400, { error: 'text is required' });
    }
    if (question !== null && typeof question !== 'string') {
      return answerWith(400, { error: 'question must be a string or null' });
    }
    const session = ptyManager.getSession(sessionId);
    if (session?.status !== 'running') {
      return answerWith(404, { error: 'Session not found or not running' });
    }
    if (session.multiplexer?.mode === 'watch') return answerWith(409, { error: 'read-only' });
    if (answering.has(sessionId)) return answerWith(409, { error: 'busy' });
    answering.add(sessionId);
    try {
      const claude = await liveClaudeStatus(sessionId);
      const choices = await readScreenChoices(sessionId);
      if (claude?.status !== 'waiting') {
        // A menu Claude does not report (its trust dialog at startup) takes Enter as confirming
        // its highlighted option: the phone must not type the message there either.
        if (choices?.navigate) {
          logger.log(`reply to ${sessionId}: a menu is up while Claude reports nothing`);
          return answerWith(409, { error: 'The prompt changed' });
        }
        // The phone composer sends here whenever Claude may be waiting; it is not, so the
        // phone types the message itself, which this case says apart from a changed prompt.
        logger.log(
          `reply to ${sessionId}: Claude is ${claude?.status ?? 'not reporting'}, typed as usual`
        );
        return answerWith(409, { error: 'not-waiting' });
      }
      if (text.length > INITIAL_INPUT_MAX_LENGTH) {
        return answerWith(413, { error: 'text is too long' });
      }
      // A menu the phone saw must still be the one on screen. With none on either side Claude
      // waits on something nobody can read, and Esc is its "tell Claude what to do instead".
      // The phone saw a menu the server no longer finds: Claude moved on, maybe to work its
      // status file does not show yet, which Esc would interrupt (review of 2026-10-03).
      const phoneSawMenu =
        typeof question === 'string' || (Array.isArray(options) && options.length > 0);
      const stale = choices
        ? !sameMenu(sessionId, choices, input ?? {}) || (choices.navigate && !takesReply(choices))
        : phoneSawMenu;
      if (stale) {
        logger.log(
          `reply to ${sessionId}: the prompt changed (${JSON.stringify(question)} vs ${JSON.stringify(choices?.question ?? null)})`
        );
        return answerWith(409, { error: 'The prompt changed' });
      }
      choicesCache.delete(sessionId);
      if (choices?.keys) {
        logger.log(`reply to ${sessionId}: typed (a yes/no question)`);
        ptyManager.sendInput(sessionId, {
          text: text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text,
        });
        ptyManager.sendInput(sessionId, { key: 'enter' });
        return await answerLanded(sessionId, choices);
      }
      // Typed straight into the menu, Enter confirmed its highlighted option: a plan correction
      // executed the plan (2026-10-03).
      logger.log(`reply to ${sessionId}: Esc, then the text once Claude is back at its prompt`);
      ptyManager.sendInput(sessionId, { key: 'escape' });
      const typed = await typeWhenReady(sessionId, text, 'claude', {
        timeoutMs: REPLY_TYPE_WAIT_MS,
        maxWaitMs: REPLY_TYPE_WAIT_MS,
      });
      if (!typed) {
        logger.warn(`reply to ${sessionId}: Claude did not get back to its prompt; not typed`);
        return answerWith(504, { error: 'not-delivered' });
      }
      return answerWith(200, { success: true });
    } catch (error) {
      logger.error('error replying to prompt:', error);
      return answerWith(500, { error: 'Failed to reply' });
    } finally {
      answering.delete(sessionId);
      // A Codex menu answered (or not): its screen is read again at the next look.
      config.codex?.answered(sessionId);
    }
  }

  router.post('/sessions/:sessionId/reply', async (req, res) => {
    sendAnswer(res, await replyToMenu(req.params.sessionId, req.body));
  });

  // Resize session
  router.post('/sessions/:sessionId/resize', async (req, res) => {
    const sessionId = req.params.sessionId;
    const { cols, rows } = req.body;
    // The page's id and whether it claims the size (pty/size-owner.ts); none from native apps.
    const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId : null;
    const claim = req.body?.claim === true;

    if (typeof cols !== 'number' || typeof rows !== 'number') {
      logger.warn(`invalid resize request for session ${sessionId}: cols/rows not numbers`);
      return res.status(400).json({ error: 'Cols and rows must be numbers' });
    }

    if (cols < 1 || rows < 1 || cols > 1000 || rows > 1000) {
      logger.warn(
        `invalid resize request for session ${sessionId}: cols=${cols}, rows=${rows} out of range`
      );
      return res.status(400).json({ error: 'Cols and rows must be between 1 and 1000' });
    }

    // Log resize requests at debug level
    logger.debug(`Resizing session ${sessionId} to ${cols}x${rows}`);

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward resize to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}/resize`, {
              method: HttpMethod.POST,
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${remote.token}`,
              },
              body: JSON.stringify({ cols, rows, clientId, claim }),
              signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to resize session on remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      // Local session handling
      const session = ptyManager.getSession(sessionId);
      if (!session) {
        logger.warn(`session ${sessionId} not found for resize`);
        return res.status(404).json({ error: 'Session not found' });
      }

      if (session.status !== 'running') {
        logger.warn(`session ${sessionId} is not running (status: ${session.status})`);
        return res.status(400).json({ error: 'Session is not running' });
      }

      // Resize the session, if this page owns its size or claims it
      const outcome = ptyManager.resizeSession(sessionId, cols, rows, { clientId, claim });
      if (outcome.applied) {
        logger.log(colors.green(`session ${sessionId} resized to ${cols}x${rows}`));
        return res.json({ success: true, applied: true, cols, rows });
      }
      res.json({ success: true, applied: false, reason: outcome.reason, cols, rows });
    } catch (error) {
      logger.error('error resizing session via PTY service:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to resize session', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to resize session' });
      }
    }
  });

  // Rename a session: `name` (the generated session name, as before) and/or `userTitle`, the
  // title the user gave it, shown instead of the agent's conversation title ('' or null goes
  // back to the automatic title). Clients that only send `name` keep working unchanged.
  /**
   * Wake a suspended session (2026-10-31, session-suspender.ts): the same session runs its
   * conversation again (`claude --resume`). The phone's tap on a paused row and its retry.
   */
  router.post('/sessions/:sessionId/wake', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = ptyManager.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!session.suspended) return res.json({ sessionId, woke: false });
    if (!config.wakeSuspended) return res.status(501).json({ error: 'Waking is not available' });
    const woke = await config.wakeSuspended(sessionId, 'opened by the user', { byUser: true });
    if (!woke.ok) return res.status(503).json({ error: woke.error });
    res.json({ sessionId: woke.sessionId, woke: true });
  });

  /**
   * Suspend a session now, at the user's request (2026-10-31: its menu, a swipe on the phone):
   * the same rules and safe stop as the idle look, without the idle time. Only a shielded
   * Claude session. 409 with `blockers` ({ kind, reason }) when anything keeps it awake (a turn,
   * a question or menu, text in its input box, background work, something scheduled, an
   * orchestrator's open tasks or queue): nothing is suspended then, and nothing is lost.
   */
  router.post('/sessions/:sessionId/suspend', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = ptyManager.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.suspended) return res.json({ sessionId, suspended: true, already: true });
    if (!config.suspendByUser) {
      return res.status(501).json({ error: 'Suspending is not available' });
    }
    const result = await config.suspendByUser(sessionId);
    if (!result.ok) {
      return res
        .status(409)
        .json({ error: 'The session cannot be suspended now', blockers: result.blockers });
    }
    res.json({ sessionId, suspended: true });
  });

  /** The session's "keep awake": never suspended (its menu). Body: { keepAwake: boolean }. */
  router.post('/sessions/:sessionId/keep-awake', (req, res) => {
    const sessionId = req.params.sessionId;
    const keepAwake = req.body?.keepAwake;
    if (typeof keepAwake !== 'boolean') {
      return res.status(400).json({ error: 'keepAwake must be a boolean' });
    }
    if (!ptyManager.setKeepAwake(sessionId, keepAwake)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ success: true, keepAwake });
  });

  /**
   * Anchor a session to a group of the home (2026-11-04, its menu: "Anclar a este grupo",
   * "Mover a…", "Quitar ancla"). Body: { groupPin: { repoPath: string | null } | null }: a
   * project's folder, null repoPath for "Otras", null to go back to the automatic grouping.
   * Only session.json changes (persisted like userTitle, follows the Claude conversation);
   * the running program is never touched.
   */
  router.post('/sessions/:sessionId/group-pin', async (req, res) => {
    const sessionId = req.params.sessionId;
    const raw = req.body?.groupPin as unknown;
    let groupPin: SessionGroupPin | null;
    if (raw === null) {
      groupPin = null;
    } else if (raw && typeof raw === 'object' && 'repoPath' in raw) {
      const repoPath = (raw as { repoPath: unknown }).repoPath;
      if (repoPath === null) {
        groupPin = { repoPath: null };
      } else if (typeof repoPath === 'string' && path.isAbsolute(repoPath)) {
        if (!fs.existsSync(repoPath)) {
          return res.status(400).json({ error: 'That folder does not exist' });
        }
        // A worktree or a folder inside a repository anchors to its main checkout.
        const git = await detectGitInfo(repoPath);
        const repo = git.gitMainRepoPath || git.gitRepoPath;
        groupPin = repo ? { repoPath: repo, git: true } : { repoPath: path.normalize(repoPath) };
      } else {
        return res.status(400).json({ error: 'repoPath must be an absolute path or null' });
      }
    } else {
      return res.status(400).json({ error: 'groupPin must be { repoPath } or null' });
    }
    if (!ptyManager.setGroupPin(sessionId, groupPin)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    logger.log(
      `session ${sessionId} ${groupPin ? `anchored to ${groupPin.repoPath ?? 'Otras'}` : 'grouped automatically again'}`
    );
    res.json({ success: true, groupPin });
  });

  router.patch('/sessions/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    logger.log(colors.yellow(`[PATCH] Received rename request for session ${sessionId}`));
    logger.debug(`[PATCH] Request body:`, req.body);

    const body = (req.body ?? {}) as { name?: unknown; userTitle?: unknown };
    const hasName = body.name !== undefined;
    const hasUserTitle = 'userTitle' in body;
    const { name } = body;
    const userTitle = hasUserTitle ? normalizeUserTitle(body.userTitle) : undefined;

    if ((hasName || !hasUserTitle) && (typeof name !== 'string' || name.trim() === '')) {
      logger.warn(`[PATCH] Invalid name provided: ${JSON.stringify(name)}`);
      return res.status(400).json({ error: 'Name must be a non-empty string' });
    }
    if (hasUserTitle && userTitle === undefined) {
      return res.status(400).json({ error: 'userTitle must be a string or null' });
    }

    try {
      // If in HQ mode, check if this is a remote session
      if (isHQMode && remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          // Forward update to remote server
          try {
            const response = await fetch(`${remote.url}/api/sessions/${sessionId}`, {
              method: HttpMethod.PATCH,
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${remote.token}`,
              },
              body: JSON.stringify({
                ...(hasName ? { name } : {}),
                ...(hasUserTitle ? { userTitle } : {}),
              }),
              signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
              return res.status(response.status).json(await response.json());
            }

            return res.json(await response.json());
          } catch (error) {
            logger.error(`failed to update session name on remote ${remote.name}:`, error);
            return res.status(503).json({ error: 'Failed to reach remote server' });
          }
        }
      }

      const session = ptyManager.getSession(sessionId);
      if (!session) {
        logger.warn(`[PATCH] Session ${sessionId} not found for name update`);
        return res.status(404).json({ error: 'Session not found' });
      }

      const result: { success: true; name?: string; userTitle?: string | null } = {
        success: true,
      };
      if (hasName && typeof name === 'string') {
        result.name = ptyManager.updateSessionName(sessionId, name);
        logger.log(colors.green(`[PATCH] Session ${sessionId} name updated to: ${result.name}`));
      }
      if (userTitle !== undefined) {
        ptyManager.setUserTitle(sessionId, userTitle);
        result.userTitle = userTitle;
        logger.log(
          colors.green(
            `[PATCH] Session ${sessionId} title ${userTitle ? 'set' : 'back to automatic'}`
          )
        );
      }

      res.json(result);
    } catch (error) {
      logger.error('error updating session name:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to update session name', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to update session name' });
      }
    }
  });

  // Mute or unmute notifications (push, in-app toasts, badge) for one session
  /**
   * "Blindar": a running process can't be moved into tmux, so shielding opens a new shielded
   * session in the same folder. A Claude session continues its conversation there
   * (`claude --resume`) and the old one is closed; anything else is started again and the old
   * session is left as it is.
   *
   * "Llevar a Untether" (2026-10-25) is the same route for a Claude session opened with `ut` in
   * a terminal window (services/move-to-untether.ts): its program is closed in the window, the
   * window keeps a line saying where it went (or is closed), and the conversation goes on
   * shielded here. Body: `force` moves it although Claude works or waits for an answer (else
   * 409 claude-busy), `windowNotice` is that line in the user's language.
   */
  router.post('/sessions/:sessionId/shield', async (req, res) => {
    await reopenSession(
      req.params.sessionId,
      (req.body ?? {}) as { force?: unknown; windowNotice?: unknown },
      'shield',
      (answer) => sendAnswer(res, answer)
    );
  });

  /**
   * Blindar's reopen. `mode` 'update' (2026-10-31, claude-update-restart.ts) reopens a running
   * Claude session the same way to restart it on a new version: it keeps whether it was
   * shielded, and only a Claude conversation of a program Untether runs is reopened.
   * `onAnswer` hears the answer as soon as there is one; the stores follow after it.
   */
  async function reopenSession(
    sessionId: string,
    body: { force?: unknown; windowNotice?: unknown },
    mode: 'shield' | 'update',
    onAnswer: (answer: RouteAnswer) => void = () => {}
  ): Promise<RouteAnswer> {
    let answer: RouteAnswer | undefined;
    const respond = (status: number, answerBody: Record<string, unknown>): RouteAnswer => {
      if (!answer) {
        answer = answerWith(status, answerBody);
        onAnswer(answer);
      }
      return answer;
    };
    // 2026-10-20: two taps on Blindar (or two devices) reopened the same session twice: two
    // shielded copies of one conversation. A reopen already on its way is the answer.
    const pending = shieldsInFlight.get(sessionId);
    if (pending) {
      const reopened = await pending;
      if (reopened)
        return respond(200, { sessionId: reopened.sessionId, replaced: reopened.replaced });
      return respond(409, { error: 'Shielding this session failed a moment ago' });
    }
    let session = ptyManager.getSession(sessionId);
    if (!session) return respond(404, { error: 'Session not found' });
    // A Codex that got its first prompt a moment ago: its thread is looked for now, not at the
    // recorder's next round, so it is reopened on its conversation.
    if (
      mode === 'shield' &&
      session.status === 'running' &&
      !session.codexThreadId &&
      startsCodex(session.command)
    ) {
      await recordCodexThreads({
        listSessions: () => ptyManager.listSessions(),
        rootPid: (running) => ptyManager.programRootPid(running),
        save: (id, threadId) => ptyManager.setCodexThreadId(id, threadId),
      }).catch((error) => logger.debug(`Codex thread look before shielding failed: ${error}`));
      session = ptyManager.getSession(sessionId) ?? session;
    }
    if (mode === 'update' && session.status !== 'running') {
      return respond(409, { error: 'Session is not running' });
    }
    if (mode === 'shield' && session.shielded && session.status !== 'exited') {
      return respond(409, { error: 'Session is already shielded' });
    }
    let plan = shieldReopenPlan(session);
    // A running Codex is only ended for its thread when the thread is sure (its command's, or
    // the only Codex of its folder): on a guess it stays, and a new one opens next to it as
    // before (2026-11-10 review).
    if (plan.resumes === 'codex' && session.status === 'running') {
      const sure = await codexThreadIsSure(session, ptyManager.listSessions(), (other) =>
        codexSessionRef({ ...other, pid: ptyManager.programRootPid(other) })
      ).catch(() => false);
      if (!sure) {
        logger.warn(
          `session ${sessionId}: another Codex runs in its folder, its thread is a guess: shielded as a new Codex`
        );
        plan = { command: session.command, replacesOld: false };
      }
    }
    // Its program runs in a terminal window (ut) and survives restarts there. Only a Claude
    // conversation can leave it: it goes on where it was, anything else would start over (a
    // running Codex stays in its window too: "Llevar a Untether" asks Claude's state first).
    const fromWindow = isForwardedSession(session);
    if (mode === 'update' && (plan.resumes !== 'claude' || fromWindow)) {
      return respond(409, { error: 'Only a Claude session Untether runs is reopened' });
    }
    if (
      fromWindow &&
      (!plan.replacesOld || (plan.resumes === 'codex' && session.status !== 'exited'))
    ) {
      return respond(409, {
        error: 'Session runs in a terminal window',
        details: 'It was opened with ut in a terminal window and keeps running there',
      });
    }
    // Its program runs in tmux already; reopened shielded it would be a tmux client nested in
    // the shield's tmux.
    if (isAttachedToTmux(session)) {
      return respond(409, {
        error: 'Session is attached to a tmux session',
        details: 'It shows a tmux session, which keeps running in tmux',
      });
    }
    const shielded = mode === 'shield' || session.shielded === true;
    if (shielded && !ptyManager.isShieldAvailable()) {
      return respond(501, {
        error: 'Shielded sessions need tmux, which is not installed on this Mac',
      });
    }
    const leavesWindow = fromWindow && session.status !== 'exited';
    // Closing Claude mid-turn loses that turn, and a question it waits on: the user decides.
    if (leavesWindow && body.force !== true) {
      const atWork = claudeAtWork(await claudeStatusNow(sessionId).catch(() => undefined));
      if (atWork) {
        return respond(409, {
          error: 'claude-busy',
          details: 'Claude is working or waiting for an answer in that window',
          status: atWork,
        });
      }
    }
    // A Claude conversation resumed by the shield: the same claim as a resume (2026-10-20, a
    // second `claude --resume` of a conversation already running or on its way elsewhere).
    // A Codex thread too (2026-11-10): one session per thread.
    const conversation =
      plan.resumes === 'claude'
        ? session.claudeSessionId
        : plan.resumes === 'codex'
          ? session.codexThreadId
          : undefined;
    let reservedSessionId: string | undefined;
    let releaseResume: ((ok: boolean) => void) | undefined;
    if (conversation) {
      const claim = await claimConversation(conversation, sessionId);
      if (claim.kind === 'existing') {
        return respond(200, { sessionId: claim.sessionId, replaced: false, existing: true });
      }
      if (claim.kind === 'failed') {
        return respond(409, { error: 'Resuming this conversation failed a moment ago' });
      }
      reservedSessionId = claim.sessionId;
      releaseResume = claim.release;
      // An exited session's conversation running outside Untether (a Terminal tab) is never
      // resumed here: that would make a second writer of it. (A running session's own Claude
      // is the one that will be closed.)
      if (session.status === 'exited') {
        const liveElsewhere =
          plan.resumes === 'codex'
            ? await liveCodexThread(conversation)
            : (await config.liveClaudeConversations?.().catch(() => undefined))?.get(conversation);
        if (liveElsewhere) {
          releaseResume(false);
          return respond(409, {
            error: 'live-elsewhere',
            details: 'This conversation is running outside Untether right now',
            live: liveElsewhere,
          });
        }
      }
    }
    let settle: (result: { sessionId: string; replaced: boolean } | null) => void = () => {};
    shieldsInFlight.set(
      sessionId,
      new Promise((resolve) => {
        settle = resolve;
      })
    );
    // The window it ran in, read before its forwarder ends.
    const forwarderPid = leavesWindow ? forwarderPidOf(sessionId, session) : null;
    const windowTty = forwarderPid ? await windowTtyOf(forwarderPid) : null;
    if (leavesWindow) {
      macWindows.refresh([session]);
      await macWindows.settled();
    }
    const windowApp = leavesWindow ? (macWindows.macWindow(session)?.app ?? null) : null;
    const notice = windowNoticeText(
      body.windowNotice,
      session.userTitle || session.claudeTitle || session.name
    );
    const replacements = config.sessionReplacements;
    if (plan.replacesOld) replacements?.replacing(sessionId);
    let newSessionId: string | null = null;
    /** The old session still runs: a failed reopen leaves everything on it. */
    let oldStillRuns = false;
    try {
      if (plan.replacesOld && session.status !== 'exited') {
        // Never two Claudes on one conversation: a window's program that outlived its Kill
        // (killSession confirms an external one ended, and marks it exited) stays where it is,
        // and nothing moves.
        const stillInWindow = () =>
          fromWindow && ptyManager.getSession(sessionId)?.status !== 'exited';
        try {
          // The forwarder writes the window's notice once the program has ended, before `ut`
          // returns and a shell wrapper may close the window on it (2026-10-25).
          await ptyManager.killSession(
            sessionId,
            'SIGTERM',
            leavesWindow ? { windowNotice: notice } : undefined
          );
        } catch (error) {
          oldStillRuns = stillInWindow();
          throw error;
        }
        if (stillInWindow()) {
          oldStillRuns = true;
          throw new Error('Its program is still running');
        }
      }
      const cwd = fs.existsSync(session.workingDir) ? session.workingDir : process.cwd();
      const gitInfo = await detectGitInfo(cwd);
      const result = await ptyManager.createSession(plan.command, {
        ...(reservedSessionId ? { sessionId: reservedSessionId } : {}),
        name: session.name,
        // The shielded session is the same one to the user: it keeps its titles.
        userTitle: session.userTitle,
        claudeTitle: session.claudeTitle,
        groupPin: session.groupPin,
        workingDir: cwd,
        cols: session.initialCols ?? 120,
        rows: session.initialRows ?? 30,
        shielded,
        ...gitInfo,
      });
      newSessionId = result.sessionId;
      // Muted stays muted (2026-10-20: the reopened session notified again).
      if (session.muted) ptyManager.setSessionMuted(result.sessionId, true);
      logger.log(
        colors.green(
          `session ${sessionId} ${fromWindow ? 'moved from its terminal window' : 'reopened'}${mode === 'update' ? ' on the updated Claude' : ' shielded'} as ${result.sessionId}`
        )
      );
      respond(200, { sessionId: result.sessionId, replaced: plan.replacesOld });
    } catch (error) {
      logger.error('error reopening session shielded:', error);
      respond(oldStillRuns ? 409 : 500, {
        error: 'Failed to open shielded session',
        details: error instanceof Error ? error.message : String(error),
      });
    } finally {
      shieldsInFlight.delete(sessionId);
      releaseResume?.(newSessionId !== null);
      settle(newSessionId ? { sessionId: newSessionId, replaced: plan.replacesOld } : null);
    }
    if (plan.replacesOld) {
      if (oldStillRuns) replacements?.notReplaced(sessionId);
      else await replacements?.replaced(sessionId, newSessionId);
    }
    if (windowTty && !oldStillRuns) {
      void leaveWindow(
        { tty: windowTty, app: windowApp, notice },
        {
          forwarderEnded: () => !forwarderPid || !isProcessRunning(forwarderPid),
          forwarderWroteNotice: () =>
            ptyManager.getSession(sessionId)?.windowNoticeWritten === true,
        }
      ).then(
        ({ notice: writer, closed }) =>
          logger.log(
            `window of session ${sessionId}: notice ${writer === 'none' ? 'not written' : `written by ${writer === 'forwarder' ? 'its forwarder' : 'the server'}`}, ${closed === 'gone' ? 'window closed by its shell' : closed}`
          ),
        (error) => logger.warn(`window of session ${sessionId} not handled: ${error}`)
      );
    }
    return answer ?? respond(500, { error: 'Failed to open shielded session' });
  }

  router.post('/sessions/:sessionId/mute', (req, res) => {
    const { sessionId } = req.params;
    const muted = req.body?.muted;
    if (typeof muted !== 'boolean') {
      return res.status(400).json({ error: 'muted must be a boolean' });
    }
    try {
      if (!ptyManager.setSessionMuted(sessionId, muted)) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json({ success: true, muted });
    } catch (error) {
      logger.error('error updating session mute:', error);
      res.status(500).json({ error: 'Failed to update session mute' });
    }
  });

  // Reset terminal size (for external terminals)
  router.post('/sessions/:sessionId/reset-size', async (req, res) => {
    const { sessionId } = req.params;

    try {
      // In HQ mode, forward to remote if session belongs to one
      if (remoteRegistry) {
        const remote = remoteRegistry.getRemoteBySessionId(sessionId);
        if (remote) {
          logger.debug(`forwarding reset-size to remote ${remote.id}`);
          const response = await fetch(`${remote.url}/api/sessions/${sessionId}/reset-size`, {
            method: HttpMethod.POST,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${remote.token}`,
            },
            body: JSON.stringify(req.body ?? {}),
          });

          if (!response.ok) {
            const error = await response.json();
            return res.status(response.status).json(error);
          }

          const result = await response.json();
          return res.json(result);
        }
      }

      logger.log(colors.cyan(`resetting terminal size for session ${sessionId}`));

      // Check if session exists
      const session = ptyManager.getSession(sessionId);
      if (!session) {
        logger.error(`session ${sessionId} not found for reset-size`);
        return res.status(404).json({ error: 'Session not found' });
      }

      // Check if session is running
      if (session.status !== 'running') {
        logger.error(`session ${sessionId} is not running (status: ${session.status})`);
        return res.status(400).json({ error: 'Session is not running' });
      }

      // A page that left the view a while ago gives the size back only if it still owns it
      // and no other page shows the session (pty/size-owner.ts sizeGiveBackDecision). Without
      // a page id (native apps), reset as before.
      const body = (req.body ?? {}) as { clientId?: unknown };
      const clientId = typeof body.clientId === 'string' && body.clientId ? body.clientId : null;
      const outcome = ptyManager.resetSessionSize(
        sessionId,
        clientId
          ? { clientId, viewedElsewhere: config.isSessionViewed?.(sessionId, clientId) === true }
          : undefined
      );
      if (outcome.reset) {
        logger.log(colors.green(`session ${sessionId} size reset to terminal size`));
      } else {
        logger.debug(`session ${sessionId} size kept (${outcome.reason})`);
      }

      res.json({ success: true, reset: outcome.reset, reason: outcome.reason });
    } catch (error) {
      logger.error('error resetting session size via PTY service:', error);
      if (error instanceof PtyError) {
        res.status(500).json({ error: 'Failed to reset session size', details: error.message });
      } else {
        res.status(500).json({ error: 'Failed to reset session size' });
      }
    }
  });

  // The voice copilot reads and acts through these same functions (services/copilot).
  config.exposeSessionAccess?.({
    snapshot: () =>
      listLocalSessions({ git: false, agentTitlesMaxAgeMs: 10_000, choicesMaxAgeMs: 400 }),
    chat: async (sessionId) => {
      const session = ptyManager.getSession(sessionId);
      if (!session?.pid || session.status !== 'running') return { available: false, messages: [] };
      const programPid = ptyManager.programRootPid(session) ?? session.pid;
      return readSessionChat({ ...session, pid: session.pid }, programPid);
    },
    prompt: (sessionId) => readPrompt(sessionId),
    input: async (sessionId, input) => localInput(sessionId, input),
    answer: (sessionId, body) => answerMenu(sessionId, body),
    reply: (sessionId, body) => replyToMenu(sessionId, body),
  });

  /**
   * Claude's own `/restart` (2026-10-31, claude-update-restart.ts): typed into its idle prompt,
   * Enter only once its command menu offers it, else the typed text is taken out again.
   */
  async function restartClaudeInPlace(sessionId: string): Promise<RestartResult> {
    const session = ptyManager.getSession(sessionId);
    if (session?.status !== 'running') {
      return { ok: false, error: 'Session is not running', untouched: true };
    }
    if (session.multiplexer?.mode === 'watch') {
      return { ok: false, error: 'Session is read-only', untouched: true };
    }
    const screenText = async () =>
      cellsToText((await terminalManager.getBufferSnapshot(sessionId)).cells, false);
    const typed = '/restart';
    ptyManager.sendInput(sessionId, { text: typed });
    for (let waited = 0; waited < 3000; waited += 500) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (restartCommandOffered(await screenText())) {
        ptyManager.sendInput(sessionId, { key: 'enter' });
        return { ok: true, sessionId };
      }
    }
    for (let i = 0; i < typed.length; i++) ptyManager.sendInput(sessionId, { key: 'backspace' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const cleared =
      claudeInputDraft((await terminalManager.getBufferSnapshot(sessionId)).cells) === false;
    return cleared
      ? { ok: false, error: 'Claude does not offer /restart', untouched: true }
      : { ok: false, error: 'Claude does not offer /restart and its input did not clear' };
  }

  config.exposeClaudeRestart?.({
    inPlace: restartClaudeInPlace,
    reopen: async (sessionId) => {
      const answer = await reopenSession(sessionId, {}, 'update');
      const reopened = answer.body.sessionId;
      return answer.status === 200 && typeof reopened === 'string' && answer.body.replaced
        ? { ok: true, sessionId: reopened }
        : {
            ok: false,
            error: String(answer.body.details ?? answer.body.error ?? `status ${answer.status}`),
          };
    },
    screen: async (sessionId) => {
      if (!terminalManager.canSnapshotCheaply(sessionId, LARGE_REPLAY_MAX_BYTES)) return undefined;
      const snapshot = await terminalManager.getBufferSnapshot(sessionId);
      return {
        draft: claudeInputDraft(snapshot.cells),
        menu: (await readScreenChoices(sessionId)) !== null,
        updateNotice: updateNoticeOnScreen(cellsToText(snapshot.cells, false)).installed,
      };
    },
    claudeStatus: liveClaudeStatus,
  });

  return router;
}

// Generate recommendations based on Tailscale status
function generateTailscaleRecommendations(
  tailscaleStatus: { isRunning: boolean; output: string },
  serveStatus: { configured: boolean; error?: string }
): string[] {
  const recommendations: string[] = [];

  if (!tailscaleStatus.isRunning) {
    recommendations.push('Install and start Tailscale to enable secure access');
  } else if (!serveStatus.configured) {
    if (serveStatus.error) {
      recommendations.push(`Fix Tailscale Serve error: ${serveStatus.error}`);
    } else {
      recommendations.push('Enable Tailscale Serve integration in settings');
    }
  } else {
    recommendations.push('Tailscale integration is working correctly');
  }

  return recommendations;
}

// Generate a unique session ID
function generateSessionId(): string {
  // Generate UUID v4
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }

  // Set version (4) and variant bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  // Convert to hex string with dashes
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * How long the server waits for the Mac app to open a Terminal window. 2026-10-20: it gave up
 * at 10 s while the app's AppleScript may take 15 s (TerminalLauncher.appleScriptLaunchTimeout,
 * plus ~0.5 s for typing terminals): the window opened after the server had already started a
 * web session for the same command, so it ran twice. Longer than the app's limit.
 */
export const TERMINAL_SPAWN_TIMEOUT_MS = 20_000;
/** How long a resume sent to a Terminal window claims its conversation until the session shows. */
export const TERMINAL_RESUME_CLAIM_MS = 30_000;

// Request terminal spawn from Mac app via control socket
export async function requestTerminalSpawn(params: {
  sessionId: string;
  sessionName: string;
  command: string[];
  workingDir: string;
  titleMode?: TitleMode;
  gitRepoPath?: string;
  gitBranch?: string;
  gitAheadCount?: number;
  gitBehindCount?: number;
  gitHasChanges?: boolean;
  gitIsWorktree?: boolean;
  gitMainRepoPath?: string;
}): Promise<{ success: boolean; error?: string; mayStillOpen?: boolean }> {
  try {
    // Not connected: nothing will open, a web session is the fallback.
    if (!controlUnixHandler.isMacAppConnected()) {
      return { success: false, error: 'Mac app not connected' };
    }
    // Create control message for terminal spawn
    const message = createControlMessage(
      'terminal',
      'spawn',
      {
        sessionId: params.sessionId,
        workingDirectory: params.workingDir,
        // argv: the Mac app quotes each element (2026-10-20: a joined `command` string ran
        // raw in the Terminal shell, so an argument with a space, a quote or `;` split or ran
        // as shell syntax; that string is gone on both sides).
        commandArgs: params.command,
        terminalPreference: null, // Let Mac app use default terminal
        gitRepoPath: params.gitRepoPath,
        gitBranch: params.gitBranch,
        gitAheadCount: params.gitAheadCount,
        gitBehindCount: params.gitBehindCount,
        gitHasChanges: params.gitHasChanges,
        gitIsWorktree: params.gitIsWorktree,
        gitMainRepoPath: params.gitMainRepoPath,
      },
      params.sessionId
    );

    logger.debug(`requesting terminal spawn via control socket for session ${params.sessionId}`);

    // Send the message and wait for response
    const response = await controlUnixHandler.sendControlMessage(
      message,
      TERMINAL_SPAWN_TIMEOUT_MS
    );

    if (!response) {
      // No answer in time: the window may still open, so no fallback may start it again.
      return {
        success: false,
        error: 'No response from Mac app',
        mayStillOpen: controlUnixHandler.isMacAppConnected(),
      };
    }

    if (response.error) {
      return {
        success: false,
        error: response.error,
      };
    }

    const success = (response.payload as TerminalSpawnResponse)?.success === true;
    return {
      success,
      error: success ? undefined : 'Terminal spawn failed',
    };
  } catch (error) {
    logger.error('failed to spawn terminal:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
