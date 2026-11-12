// Idle Claude sessions: restarted on a Claude Code update, suspended to free memory.
import { execFile } from 'child_process';
import * as path from 'path';
import { isForwardedSession } from '../shared/forwarded-session.js';
import { TASK_FINAL_STATES } from '../shared/tasks.js';
import type { AppContext } from './server-context.js';
import {
  findClaudeTranscript,
  readClaudeStatuses,
  readProcessTable,
} from './services/claude-chat.js';
import { ClaudeUpdateRestarter, parseClaudeVersion } from './services/claude-update-restart.js';
import { clampIdleMinutes, SessionSuspender } from './services/session-suspender.js';
import { checkLoadGate } from './services/task-verify.js';
import { createLogger } from './utils/logger.js';
import { every } from './utils/periodic-loop.js';

const logger = createLogger('server');

export function setupIdleClaude(ctx: AppContext) {
  const {
    controlDir: CONTROL_DIR,
    configService,
    liveConversations,
    projectSettings,
    ptyManager,
    pushNotificationService,
    terminalManager,
    wsV3Hub,
  } = ctx;
  // 2026-10-31: idle Claude sessions kept open for days stayed on the old version after Claude
  // Code updated itself ("Update installed · /restart to apply"). With the user's
  // restartUpdatedClaude setting (off by default) they are restarted on the installed one, one
  // at a time, when nothing would be lost (claude-update-restart.ts).
  let installedClaude: { at: number; version: string | undefined } | null = null;
  const claudeUpdateRestarter = new ClaudeUpdateRestarter({
    enabled: () =>
      configService.getConfig().restartUpdatedClaude === true && !!ctx.claudeRestartActions,
    installedVersion: async () => {
      if (installedClaude && Date.now() - installedClaude.at < 5 * 60_000) {
        return installedClaude.version;
      }
      const version = await new Promise<string | undefined>((resolve) => {
        execFile('claude', ['--version'], { timeout: 10_000 }, (error, stdout) =>
          resolve(error ? undefined : parseClaudeVersion(String(stdout)))
        );
      });
      installedClaude = { at: Date.now(), version };
      return version;
    },
    // The session list carries no input time: it comes from the PTY manager (2026-10-31: the
    // "nobody typed for 2 min" rule read undefined and never held a restart).
    sessions: () =>
      ptyManager.listSessions().map((session) => ({
        id: session.id,
        status: session.status,
        lastInputTimestamp: ptyManager.lastInputAt(session.id),
      })),
    claudeStatus: async (sessionId) => ctx.claudeRestartActions?.claudeStatus(sessionId),
    screen: async (sessionId) => ctx.claudeRestartActions?.screen(sessionId),
    // A task being prepared, checked or merged reads its session (and its idle finish).
    heldBy: (sessionId) => {
      const task = ctx.taskScheduler
        ?.list()
        .find(
          (candidate) =>
            candidate.sessionId === sessionId &&
            ['preparing', 'verifying', 'merging'].includes(candidate.state)
        );
      return task ? `task ${task.id} is ${task.state}` : null;
    },
    loadOk: () => !checkLoadGate.sample().high,
    restartInPlace: async (sessionId) =>
      ctx.claudeRestartActions
        ? ctx.claudeRestartActions.inPlace(sessionId)
        : { ok: false, error: 'not ready', untouched: true },
    reopen: async (sessionId) =>
      ctx.claudeRestartActions
        ? ctx.claudeRestartActions.reopen(sessionId)
        : { ok: false, error: 'not ready' },
    markUpdated: (sessionId, from, to) =>
      ptyManager.setClaudeUpdatedTo(sessionId, {
        ...(from ? { from } : {}),
        to,
        at: new Date().toISOString(),
      }),
    statePath: path.join(CONTROL_DIR, 'claude-update-restarts.json'),
    log: (message) => logger.log(message),
    warn: (message) => logger.warn(message),
  });
  const _claudeUpdateRestartInterval = every(
    'claude update restart',
    () => {
      claudeUpdateRestarter.tick().catch((error) => {
        logger.warn(`claude update restart look failed: ${error}`);
      });
    },
    60_000
  );
  _claudeUpdateRestartInterval.unref?.();

  // 2026-10-31: the Mac ran out of memory with 10–14 Claude sessions open (150–250 MB each plus
  // ~10 MCP servers). With the user's suspendIdleClaude setting, a shielded Claude session idle
  // for suspendIdleMinutes (120) is suspended when every rule agrees (session-suspender.ts) and
  // wakes, same id, when tapped or when anything is typed into it.
  const roleHold = (sessionId: string): string | null => {
    const openTasks = (ctx.taskScheduler?.list() ?? []).filter(
      (task) => !TASK_FINAL_STATES.includes(task.state)
    );
    const own = openTasks.find((task) => task.sessionId === sessionId);
    if (own) return `task ${own.id.slice(0, 8)} (${own.state}) runs in it`;
    const repo =
      ctx.orchestrator?.repoOf(sessionId) ??
      projectSettings.list().find(({ settings }) => settings.orchestratorSessionId === sessionId)
        ?.repoPath;
    const orchestrated = openTasks.filter(
      (task) => task.orchestratorSessionId === sessionId || (!!repo && task.repoPath === repo)
    );
    if (orchestrated.length > 0) {
      return `it orchestrates ${orchestrated.length} open task(s)`;
    }
    const waiting = ctx.orchestrator?.waitingWork(sessionId);
    return waiting ? `waiting to reach it: ${waiting}` : null;
  };
  ctx.sessionSuspender = new SessionSuspender({
    enabled: () =>
      configService.getConfig().suspendIdleClaude === true && !!ctx.claudeRestartActions,
    idleMinutes: () => clampIdleMinutes(configService.getConfig().suspendIdleMinutes),
    sessions: () =>
      ptyManager.listSessions().map((session) => ({
        id: session.id,
        status: session.status,
        shielded: session.shielded,
        command: session.command,
        workingDir: session.workingDir,
        claudeSessionId: session.claudeSessionId,
        keepAwake: session.keepAwake,
        suspended: session.suspended,
        external: isForwardedSession(session) || !!session.multiplexer,
        lastInputAt: ptyManager.lastInputAt(session.id),
        lastOutputAt: terminalManager.outputModifiedAt(session.id),
      })),
    claude: async (sessionId) => {
      const session = ptyManager.getSession(sessionId);
      const pid = session ? ptyManager.programRootPid(session) : undefined;
      return pid ? (await readClaudeStatuses([pid])).get(pid) : undefined;
    },
    transcriptPath: (cwd, conversation) => findClaudeTranscript(cwd, conversation),
    screen: async (sessionId) => {
      const look = await ctx.claudeRestartActions?.screen(sessionId);
      return look ? { draft: look.draft, menu: look.menu } : undefined;
    },
    watched: (sessionId) => wsV3Hub.isSessionWatched(sessionId),
    processView: async () => {
      const table = await readProcessTable();
      return {
        children: table.children,
        args: table.args,
        startMs: (pid) => {
          const start = table.starts.get(pid);
          const ms = start ? Date.parse(start) : Number.NaN;
          return Number.isNaN(ms) ? undefined : ms;
        },
      };
    },
    heldBy: roleHold,
    roleOf: (sessionId) => {
      const repo =
        ctx.orchestrator?.repoOf(sessionId) ??
        projectSettings.list().find(({ settings }) => settings.orchestratorSessionId === sessionId)
          ?.repoPath;
      const tasks = (ctx.taskScheduler?.list() ?? [])
        .filter((task) => task.sessionId === sessionId || task.orchestratorSessionId === sessionId)
        .map((task) => task.id);
      return { ...(repo ? { orchestratorOf: repo } : {}), ...(tasks.length ? { tasks } : {}) };
    },
    suspend: (sessionId, record, tree, lastInputSeen) =>
      ptyManager.suspendShieldedSession(sessionId, record, tree, lastInputSeen),
    sendInput: (sessionId, input) => ptyManager.sendInput(sessionId, input),
    resume: (sessionId) => ptyManager.resumeSuspendedSession(sessionId),
    setSuspension: (sessionId, record) => ptyManager.setSessionSuspension(sessionId, record),
    liveElsewhere: async (conversation) => (await liveConversations()).has(conversation),
    log: (message) => logger.log(message),
    warn: (message) => logger.warn(message),
    // Why a session stays awake, when that changes: the debug log is where it can be read
    // (2026-11-11: GET /sessions/:id/suspend-status, which nobody called, is gone).
    debug: (message) => logger.debug(message),
    alert: (sessionId, error) => {
      const session = ptyManager.getSession(sessionId);
      const title = session?.userTitle || session?.claudeTitle || session?.name || sessionId;
      pushNotificationService
        ?.sendNotification({
          type: 'session-wake-failed',
          title: `Untether: «${title}» no se pudo reanudar`,
          body: error,
          tag: `wake-failed-${sessionId}`,
          data: { sessionId },
        })
        .catch((pushError) => logger.warn(`wake failure push not sent: ${pushError}`));
    },
  });
  // Once a minute (the e2e test sets a shorter look with UNTETHER_SUSPEND_TICK_MS).
  const suspendTickMs = Number(process.env.UNTETHER_SUSPEND_TICK_MS) || 60_000;
  const _sessionSuspendInterval = every(
    'session suspend',
    () => {
      ctx.sessionSuspender
        ?.tick()
        .catch((error) => logger.warn(`session suspend look failed: ${error}`));
    },
    suspendTickMs
  );
  _sessionSuspendInterval.unref?.();
  // A suspension or a wake cut short by a server restart is settled once sessions are back.
  setTimeout(() => {
    ctx.sessionSuspender
      ?.reconcile()
      .catch((error) => logger.warn(`session suspend reconcile: ${error}`));
  }, 15_000).unref?.();
}
