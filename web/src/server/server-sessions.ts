// Session routes, "On this Mac" / "Share with phone" and the voice copilot.

import * as os from 'os';
import * as path from 'path';
import { createCopilotRoutes } from './routes/copilot.js';
import { createMacSessionsRoutes } from './routes/mac-sessions.js';
import { createSessionRoutes } from './routes/sessions.js';
import type { AppContext } from './server-context.js';
import { userHoldOf } from './server-tasks.js';
import { processTable, readProcessTable } from './services/claude-chat.js';
import { askClaudeOnce } from './services/claude-oneshot.js';
import { codexAgentStatus } from './services/codex-session-status.js';
import { DEFAULT_MODEL } from './services/copilot/brain.js';
import { CopilotService } from './services/copilot/service.js';
import type { SessionAccess } from './services/copilot/session-access.js';
import { MacAttach } from './services/mac-sessions/attach.js';
import { openInNewWindow } from './services/mac-sessions/new-window.js';
import { OsascriptRunner } from './services/mac-sessions/osascript.js';
import { MacSessionsScanner } from './services/mac-sessions/scanner.js';
import { screenLock } from './services/mac-sessions/screen-lock.js';
import {
  type MacSessionsStartOptions,
  macSessionsSettings,
} from './services/mac-sessions/settings.js';
import { MacShare } from './services/mac-sessions/share.js';
import {
  type MacShareStartOptions,
  macShareSettings,
} from './services/mac-sessions/share-settings.js';
import { tmuxVersion } from './services/mac-sessions/tmux-run.js';
import { closeIdleTerminalWindow } from './services/move-to-untether.js';
import { createScreenMenu } from './services/screen-menu.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('server');

export function setupSessions(ctx: AppContext) {
  const {
    controlDir: CONTROL_DIR,
    app,
    config,
    configService,
    previewRegistry,
    ptyManager,
    remoteRegistry,
    sessionReplacements,
    terminalManager,
    wakeSuspended,
    wsV3Hub,
  } = ctx;
  // What runs on this computer outside Untether ("On this Mac", docs/mac-sessions.md). Its
  // live Claude conversations are never resumed here, even with the section off.
  const macSessionsStart: MacSessionsStartOptions = {
    cliDisabled: config.noMacSessions,
    hqMode: config.isHQMode,
  };
  const macSessionsNow = () => macSessionsSettings(configService.getConfig(), macSessionsStart);
  // "Share with phone" (docs/mac-sessions.md): an idle Claude in a Terminal or iTerm2 tab is
  // closed there and reopened in the same tab through ut. Off unless turned on.
  const macShareStart: MacShareStartOptions = {
    ...macSessionsStart,
    shareCliDisabled: config.noMacShare,
    noAuth: config.noAuth,
  };
  let macShare: MacShare | undefined;
  const macSessionsScanner = new MacSessionsScanner({
    settings: macSessionsNow,
    table: processTable,
    utSessions: () => ptyManager.listSessions(),
    tmuxVersion: () => tmuxVersion(),
    controlPath: CONTROL_DIR,
    share: () => macShare,
  });
  // The only osascript runner, made on the first share: every call killed at 5 s, and
  // whatever still runs at shutdown too.
  let osascriptRunner: OsascriptRunner | undefined;
  const shareMenu = createScreenMenu({
    recentText: (sessionId, lines) => terminalManager.getRecentText(sessionId, lines),
    sendInput: (sessionId, input) => ptyManager.sendInput(sessionId, input),
  });
  if (process.platform === 'darwin') {
    macShare = new MacShare({
      settings: () => macShareSettings(configService.getConfig(), macShareStart),
      scanner: macSessionsScanner,
      // A ps of its own: the shared table may be 2 s old, and a close acts on what it reads.
      freshTable: () => readProcessTable(),
      screenLock: () => screenLock(),
      runner: {
        run: (app, script, args) => {
          osascriptRunner ??= new OsascriptRunner();
          return osascriptRunner.run(app, script, args);
        },
      },
      sigterm: (pid) => process.kill(pid, 'SIGTERM'),
      openWindow: (app, command) => openInNewWindow(app, command),
      utSessions: () => ptyManager.listSessions(),
      screen: {
        ...shareMenu,
        pressEnter: (sessionId) => ptyManager.sendInput(sessionId, { key: 'enter' }),
      },
      controlDir: CONTROL_DIR,
      defaultControlDir: path.join(os.homedir(), '.untether', 'control'),
    });
  }
  const disposeMacShare = () => {
    macShare?.dispose();
    osascriptRunner?.dispose();
  };
  // Live outside this server's sessions, plus conversations a share closed and hasn't reopened
  // yet: neither History nor a resume may open one of those a second time.
  const liveConversations = async () => {
    const live = await macSessionsScanner.liveClaudeConversations();
    for (const [id, where] of macShare?.pendingConversations() ?? []) {
      if (!live.has(id)) live.set(id, where);
    }
    return live;
  };

  // Mount routes
  let copilotAccess: SessionAccess | null = null;
  app.use(
    '/api',
    createSessionRoutes({
      ptyManager,
      terminalManager,
      remoteRegistry,
      isHQMode: config.isHQMode,
      previewRegistry,
      shieldNewSessionsByDefault: () => configService.getConfig().shieldNewSessions !== false,
      // Codex's state from its rollout, read up to now (the sessions it runs in are looked
      // up every 3 s, server-core.ts), and the menu it waits on, off its screen.
      codex: {
        runs: (sessionId) => ctx.codexSessions.ref(sessionId) !== undefined,
        status: (sessionId) =>
          ctx.codexSessions.ref(sessionId)
            ? ctx.codexMenus.status(
                sessionId,
                codexAgentStatus(ctx.agentEvents.snapshot(sessionId))
              )
            : Promise.resolve(undefined),
        answered: (sessionId) => ctx.codexMenus.forget(sessionId),
      },
      // The cards' one line (agent-explain.ts): Claude's fast level when the installation
      // names one, else haiku. Missing setting = on.
      agentExplain: {
        enabled: () => configService.getConfig().agentExplain !== false,
        ask: (systemPrompt, question) =>
          askClaudeOnce(
            {
              timeoutMs: 45_000,
              model: configService.getConfig().taskModels?.claude?.fast ?? DEFAULT_MODEL,
              cwd: os.tmpdir(),
              purpose: 'card line',
            },
            systemPrompt,
            question
          ),
      },
      // A task's agent stuck on a menu Untether does not answer is told to the user once.
      userHold: (sessionId) => userHoldOf(ctx)(sessionId),
      exposeInitialInput: (deliver) => {
        ctx.deliverTaskInput = (sessionId, text, agent, options) =>
          deliver(sessionId, text, agent, {
            ...options,
            // A task's input is never the user's own typing: it waits for theirs.
            notUsers: true,
            onDialogWaiting: () => ctx.taskScheduler?.agentChoiceOnScreen(sessionId),
            // Why a task's message waits behind the user's own input (2026-11-10).
            onUserHold: (why) => ctx.taskScheduler?.inputHeldByUser(sessionId, why),
          });
      },
      exposeTrustDialogAnswer: (answer) => {
        ctx.answerTrustDialog = answer;
      },
      exposeMenuAnswer: (answer) => {
        ctx.answerScreenMenu = answer;
      },
      exposeClaudeRestart: (actions) => {
        ctx.claudeRestartActions = actions;
      },
      liveClaudeConversations: liveConversations,
      // An interactive session against an external model provider (model-providers.ts).
      providerInteractive: (marker, command) => ctx.providerLauncher.interactive(marker, command),
      exposeSessionAccess: (access) => {
        copilotAccess = access;
      },
      isSessionViewed: (sessionId, exceptClientId) =>
        wsV3Hub.isSessionBeingViewed(sessionId, exceptClientId),
      sessionReplacements,
      // Llevar a Untether: the window a `ut` session left, closed when nothing else is in it.
      closeTerminalWindow: async (app, tty) => {
        if (process.platform !== 'darwin') return 'unavailable';
        return closeIdleTerminalWindow(
          (scriptApp, script, args) => {
            osascriptRunner ??= new OsascriptRunner();
            return osascriptRunner.run(scriptApp, script, args);
          },
          app,
          tty
        );
      },
      keepOnExitedCleanup: (sessionId) => ctx.sessionKeptForTasks(sessionId),
      wakeSuspended,
      suspendByUser: (sessionId) =>
        ctx.sessionSuspender
          ? ctx.sessionSuspender.suspendByUser(sessionId)
          : Promise.resolve({
              ok: false as const,
              blockers: [{ kind: 'unknown' as const, reason: 'the suspender is not running' }],
            }),
    })
  );
  logger.debug('Mounted session routes');

  // The voice copilot («Conversar»): built here, started by the first page that opens it.
  const copilotService = copilotAccess
    ? new CopilotService({
        access: copilotAccess,
        sessionEvents: ptyManager,
        refreshPids: () => ptyManager.refreshProgramPids(),
        dataDir: path.dirname(CONTROL_DIR),
      })
    : null;
  if (copilotService) app.use('/api', createCopilotRoutes(copilotService));

  // "On this Mac": the user's own tmux sessions and the agents running outside Untether
  // (docs/mac-sessions.md), behind the same login as the rest of /api.
  app.use(
    '/api',
    createMacSessionsRoutes({
      settings: macSessionsNow,
      scanner: macSessionsScanner,
      attach: new MacAttach({ scanner: macSessionsScanner, ptyManager }),
      ...(macShare ? { share: macShare } : {}),
    })
  );
  logger.debug('Mounted Mac sessions routes');
  // A session that ended may have held a tmux session open (Disconnect): the next poll scans.
  ptyManager.on('sessionExited', () => macSessionsScanner.invalidate());
  return {
    macSessionsStart,
    macSessionsNow,
    macShareStart,
    macSessionsScanner,
    shareMenu,
    disposeMacShare,
    liveConversations,
    copilotService,
  };
}
