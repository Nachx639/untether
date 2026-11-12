// Core of createApp: previews, base middleware, config, PTY manager, agent events, shares,
// Claude status pushes, auth/HQ/WebSocket hub and the /api auth middleware.

import { randomUUID as uuidv4 } from 'node:crypto';
import compression from 'compression';
import * as fs from 'fs';
import helmet from 'helmet';
import * as path from 'path';
import { parseScreenChoices } from '../shared/claude-screen.js';
import { cellsToText } from '../shared/terminal-text-formatter.js';
import type { Session } from '../shared/types.js';
import { ServerEventType } from '../shared/types.js';
import { apiSocketServer } from './api-socket-server.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { apiJsonParsers, SMALL_JSON_PATHS, smallJsonParser } from './middleware/json-body.js';
import { PtyManager } from './pty/index.js';
import { ProcessUtils } from './pty/process-utils.js';
import { createAuthRoutes } from './routes/auth.js';
import { processGitEvent } from './routes/git.js';
import { createUtOpenHandler } from './routes/preview.js';
import type { AppContext } from './server-context.js';
import { AgentEventService } from './services/agent-event-service.js';
import { SignalLedger } from './services/agent-events.js';
import { AuthService } from './services/auth-service.js';
import { BackupExclusion } from './services/backup-exclusion.js';
import { CastOutputHub } from './services/cast-output-hub.js';
import { readClaudeStatuses } from './services/claude-chat.js';
import {
  claudeHookFiles,
  ensureClaudeHookFiles,
  withClaudeHooks,
} from './services/claude-hooks.js';
import { startClaudeSessionIdRecorder } from './services/claude-session-id.js';
import {
  BACKGROUND,
  ClaudeStatusNotifier,
  watchedSessions,
} from './services/claude-status-notifier.js';
import { codexRolloutPath, readCodexChat } from './services/codex-chat.js';
import { CodexMenus, CodexSessions, codexSightings } from './services/codex-session-status.js';
import {
  codexIdFromRollout,
  codexThreadTitle,
  startCodexThreadRecorder,
} from './services/codex-thread.js';
import { ConfigService } from './services/config-service.js';
import { FlakyTestStore } from './services/flaky-tests.js';
import { isGeminiCommand, readGeminiChat } from './services/gemini-chat.js';
import { GitStatusHub } from './services/git-status-hub.js';
import { createProviderLauncher } from './services/model-provider-launch.js';
import { probeHttp } from './services/preview-candidates.js';
import { isUntetherServer, PreviewHealthMonitor } from './services/preview-health.js';
import {
  createPreviewProxy,
  normalizeOrigin,
  parseDeniedPorts,
  previewPortError,
  UNTETHER_SERVER_HEADER,
} from './services/preview-proxy.js';
import {
  PREVIEW_PUSH_DELAY_MS,
  type PreviewOpenEvent,
  PreviewRegistry,
  parseOpenTarget,
  previewReadyPush,
  previewsFileFor,
} from './services/preview-registry.js';
import { createPreviewServer, mainOriginPreviewGuard } from './services/preview-server.js';
import { RemoteRegistry } from './services/remote-registry.js';
import {
  createResourceMonitor,
  memoryShortage,
  taskAdmissionFrom,
} from './services/resource-monitor.js';
import { MENU_READ_LINES } from './services/screen-menu.js';
import { SessionMonitor } from './services/session-monitor.js';
import { SessionReplacements } from './services/session-replacements.js';
import { SessionStateEvents, sessionStateOf } from './services/session-state-events.js';
import type { WakeResult } from './services/session-suspender.js';
import { ShareStore, sharesFileFor } from './services/share-store.js';
import { findInstalledTmux, setStableTmuxBinary } from './services/shielded-tmux.js';
import { StableTmux, stableTmuxDir } from './services/stable-tmux.js';
import { resolveProjectRepo } from './services/task-commands.js';
import {
  checkDiskFrom,
  checkLoadFrom,
  setCheckDiskSettings,
  setCheckLoadSettings,
  setCheckMemoryShort,
  setCheckRoom,
} from './services/task-verify.js';
import { startTerminalClaudeRecorder } from './services/terminal-claude.js';
import { LARGE_REPLAY_MAX_BYTES, TerminalManager } from './services/terminal-manager.js';
import { WsV3Hub } from './services/ws-v3-hub.js';
import { colors } from './utils/colors.js';
import { createCspReportRoutes } from './utils/csp.js';
import { createInflightRequests } from './utils/inflight-requests.js';
import { createLogger } from './utils/logger.js';
import { every } from './utils/periodic-loop.js';

const logger = createLogger('server');

export async function setupCore(ctx: AppContext) {
  const { controlDir: CONTROL_DIR, app, config, server } = ctx;

  // Dev-server previews are served by a second listener on their own port, a separate
  // origin (see preview-proxy.ts / preview-server.ts); it starts after the main server. The
  // main origin serves no preview content, and refuses requests coming from that origin.
  // Previews persist next to the control dir (~/.untether/previews.json), so they outlive
  // the session that opened them and a restart; each control dir has its own file.
  const previewRegistry = new PreviewRegistry({ file: previewsFileFor(CONTROL_DIR) });
  const loadedPreviews = previewRegistry.load();
  logger.debug(`Loaded ${loadedPreviews.loaded} previews from ${previewsFileFor(CONTROL_DIR)}`);
  const previewPublicOrigin = normalizeOrigin(process.env.UNTETHER_PREVIEW_ORIGIN);
  const mainListenPort = () => {
    const address = server.address();
    return address && typeof address === 'object' ? address.port : config.port;
  };
  const previewProxy = createPreviewProxy({
    getOwnPorts: () => [mainListenPort(), ctx.previewListenPort],
    isUntetherAuthorization: (value) =>
      value.startsWith('Bearer ') &&
      (ctx.authService.verifyToken(value.slice(7)).valid ||
        value.slice(7) === ctx.remoteBearerToken),
    deniedPorts: parseDeniedPorts(process.env.UNTETHER_PREVIEW_DENY_PORTS),
    // Another Untether answered through the proxy: its row goes too.
    onUntetherPort: () => previewRegistry.removeRefused(),
  });
  // Untether's own ports, UNTETHER_PREVIEW_DENY_PORTS and other Untether servers are
  // never previews, however they're announced (2026-10-03: a `curl` to 4020 became one).
  previewRegistry.setPortFilter((port) => previewProxy.portError(port));
  /** Asks the port whether it is an Untether server; then portError refuses it. */
  const identifyPreviewPort = async (port: number) => {
    if (previewProxy.portError(port)) return;
    if (await isUntetherServer(port)) previewProxy.noteUntetherPort(port);
  };
  previewRegistry.setNewPortVetter(async (port) => {
    await identifyPreviewPort(port);
    if (previewProxy.portError(port)) return false;
    // An API with no page at / is no preview (2026-10-23: a task that mentioned the Atlas
    // bridge on 8787 got a preview of {"error":{"code":"not_found"}}). Not answering yet (a
    // dev server announces its URL before it listens) still counts.
    return !(await probeHttp(port))?.noPage;
  });
  // Live/down of each registered dev server, for the preview rows (preview-health.ts).
  const previewHealth = new PreviewHealthMonitor({
    registry: previewRegistry,
    onUntether: (port) => previewProxy.noteUntetherPort(port),
  });
  previewHealth.start();
  server.once('close', () => {
    previewHealth.stop();
    previewRegistry.flush();
  });
  const previewServer = createPreviewServer(previewProxy);
  server.once('close', () => {
    previewServer.close();
    previewServer.closeAllConnections?.();
  });
  // First of all middleware, so it sees every request: a shutdown lets the ones that change
  // something finish (closeConnectionsForShutdown).
  const inflightRequests = createInflightRequests();
  app.use(inflightRequests.middleware);
  // Marks every response as Untether's, so another Untether's preview proxy never shows
  // this server (see UNTETHER_SERVER_HEADER).
  app.use((_req, res, next) => {
    res.setHeader(UNTETHER_SERVER_HEADER, '1');
    next();
  });
  app.use(mainOriginPreviewGuard(() => ctx.previewListenPort, previewPublicOrigin));

  // Add security headers with Helmet
  app.use(
    helmet({
      contentSecurityPolicy: false, // We handle CSP ourselves for the web terminal
      crossOriginEmbedderPolicy: false, // Allow embedding in iframes for integrations
    })
  );
  logger.debug('Configured security headers with helmet');

  // Add compression middleware with Brotli support
  app.use(
    compression({
      // Enable Brotli compression with highest priority
      level: 6, // Balanced compression level
    })
  );
  logger.debug('Configured compression middleware');

  // CSP violation reports come from browsers without credentials: before the auth middleware,
  // and before the global JSON parser, which would otherwise parse an `application/json`
  // report up to 10 MB and bypass the route's own 16 KB limit (2026-10-04).
  app.use(createCspReportRoutes((line) => logger.warn(line)));

  // JSON bodies (middleware/json-body.ts): the small-body routes here, before the login
  // check; the 10 MB parser only after it (below, next to authMiddleware).
  app.use(SMALL_JSON_PATHS, smallJsonParser());
  logger.debug('Configured express middleware');

  // Ensure control directory exists
  if (!fs.existsSync(CONTROL_DIR)) {
    fs.mkdirSync(CONTROL_DIR, { recursive: true });
    logger.log(colors.green(`Created control directory: ${CONTROL_DIR}`));
  } else {
    logger.debug(`Using existing control directory: ${CONTROL_DIR}`);
  }

  // Initialize configuration service (before the PTY manager: it picks the tmux binary)
  const configService = new ConfigService();
  configService.startWatching();
  logger.debug('Initialized configuration service');
  // Tasks' checks wait while the Mac is over config.json's checkLoad threshold.
  setCheckLoadSettings(() => checkLoadFrom(configService.getConfig().checkLoad));
  // …and while the disk of their repo or worktree is under config.json's checkDisk.
  setCheckDiskSettings(() => checkDiskFrom(configService.getConfig().checkDisk));
  // One cheap global sampler of memory, swap and load (2026-11-01): new tasks of any project
  // start only with room for them (config.json taskAdmission), and checks wait on it too.
  const resourceMonitor = createResourceMonitor({
    settings: () => taskAdmissionFrom(configService.getConfig().taskAdmission),
    stateFile: path.join(CONTROL_DIR, 'admission-state.json'),
  });
  resourceMonitor.start();
  setCheckMemoryShort(() => memoryShortage(resourceMonitor.history(), resourceMonitor.settings()));
  // Checks take slots past the fixed ones only while the Mac has room for a task (2026-11-11).
  setCheckRoom(() => (resourceMonitor.room()?.fits ?? 0) > 0);
  // Tests that failed in a task's check under load and passed on the rerun (2026-11-02), per
  // project, for `ut doctor`.
  const flakyTests = new FlakyTestStore(path.join(CONTROL_DIR, 'flaky-under-load.json'));
  // Untether's disposable folders out of Time Machine (2026-11-02, backup-exclusion.ts); never
  // under tests (they would mark real folders through the real tmutil).
  const backupExclusion = new BackupExclusion({
    enabled: () => !process.env.VITEST && configService.getConfig().excludeFromBackups !== false,
    protectedDirs: [path.dirname(CONTROL_DIR)],
    log: (message) => logger.warn(message),
  });

  // The stable, user-signed tmux copy (2026-10-31, stable-tmux.ts): with a signing identity in
  // Settings every tmux call runs ~/.untether/bin/tmux, whose macOS permissions survive tmux
  // upgrades. Only the user's own server (macOS, the default control dir, not under tests):
  // a test server must never sign or replace the user's copy.
  const stableTmux =
    process.platform === 'darwin' && !process.env.UNTETHER_CONTROL_DIR && !process.env.VITEST
      ? new StableTmux({
          dir: stableTmuxDir(),
          identity: () => configService.getConfig().tmuxSigningIdentity,
          source: findInstalledTmux,
          activate: setStableTmuxBinary,
          serverAnswers: (bin) => ptyManager.shieldAnswersWith(bin),
        })
      : null;
  stableTmux?.activateIfReady();
  let tmuxSigningIdentity = configService.getConfig().tmuxSigningIdentity;
  configService.onConfigChange((next) => {
    if (next.tmuxSigningIdentity === tmuxSigningIdentity) return;
    tmuxSigningIdentity = next.tmuxSigningIdentity;
    void stableTmux?.refresh();
  });

  // Initialize PTY manager with fallback support
  await PtyManager.initialize();
  const ptyManager = new PtyManager(CONTROL_DIR);
  logger.debug('Initialized PTY manager');

  // The agents' state from their own events (agent-events.ts, 2026-11-01): the Claude Code
  // sessions Untether starts get its hooks (claude-hooks.ts, never the user's own settings),
  // Codex's rollout is followed. The screen is what is left when neither is there.
  const hookFiles = claudeHookFiles(path.dirname(CONTROL_DIR));
  ptyManager.setSpawnRewriter((command) => {
    // Written again when missing or changed: Claude would not start on a missing --settings.
    const files = ensureClaudeHookFiles(hookFiles, (message) => logger.warn(message));
    return files ? withClaudeHooks(command, files.settings) : command;
  });

  // External model providers (model-providers.ts, 2026-11-08): one launcher shared by tasks and
  // interactive sessions. Opt-in; nothing is read from the Keychain until a provider session
  // starts. A shielded provider session comes back against its provider on restore/wake.
  const providerLauncher = createProviderLauncher({
    providers: () => configService.getConfig().modelProviders,
    untetherDir: path.dirname(CONTROL_DIR),
  });
  ptyManager.setProviderEnvResolver(async (marker) => {
    const launch = await providerLauncher.resolve(marker);
    return launch ? { env: launch.env, unset: launch.unset } : null;
  });
  // Every session a Codex runs in: started with `codex`, or typed in a shell (2026-11-10: only
  // the first kind was followed, so the list knew nothing of the second).
  const codexSessions = new CodexSessions({
    sessions: () =>
      ptyManager
        .listSessions()
        .map((session) => ({ ...session, pid: ptyManager.programRootPid(session) })),
    onGone: (sessionId) => {
      if (agentEvents.tracker.get(sessionId)?.source === 'codex-rollout') {
        agentEvents.forget(sessionId);
      }
    },
    onError: (sessionId, error) => logger.debug(`Codex of ${sessionId} not looked up: ${error}`),
  });
  const agentEvents = new AgentEventService({
    eventsDir: hookFiles.eventsDir,
    codexRollout: (sessionId) => {
      const ref = codexSessions.ref(sessionId);
      return ref ? codexRolloutPath(ref) : null;
    },
    log: (message) => logger.warn(message),
  });
  const agentSignals = new SignalLedger((message) => logger.log(message));
  // Agent sessions' states for the public event log, whatever the agent (event-log.ts).
  const sessionStates = new SessionStateEvents({
    record: (event) => ctx.eventLog.record(event),
    latest: (sessionId) => ctx.eventLog.latestSessionState(sessionId),
    session: (sessionId) => {
      const session = ptyManager.getSession(sessionId);
      return session
        ? { name: session.userTitle || session.name, dir: session.workingDir }
        : undefined;
    },
    resolveProject: resolveProjectRepo,
    onError: (message) => logger.warn(message),
  });
  ptyManager.on('sessionExited', (sessionId: string) => sessionStates.exited(sessionId));
  /** When each session's Claude was last seen going busy (agent-events doctor check). */
  const claudeBusySeen = new Map<string, number>();
  let agentEventsLooking = false;
  const _agentEventsInterval = every(
    'agent events',
    () => {
      if (agentEventsLooking) return;
      agentEventsLooking = true;
      void (async () => {
        // Starting or running (a suspended one starts again with a SessionStart of its own).
        const running = ptyManager.listSessions().filter((session) => session.status !== 'exited');
        await codexSessions.refresh();
        const codex = codexSessions.ids();
        agentEvents.poll(new Set(running.map((session) => session.id)), codex);
        // Claude's come from its status notifier (setupClaudeStatus); Codex's from its rollout,
        // just read; Gemini's from its chat file (cached until it changes).
        for (const sessionId of codex) {
          const snapshot = agentEvents.snapshot(sessionId);
          const seen = snapshot ? sessionStateOf(snapshot.state) : undefined;
          if (seen) sessionStates.observe(sessionId, 'codex', seen.state, { reason: seen.reason });
        }
        for (const session of running) {
          if (session.status !== 'running' || !isGeminiCommand(session.command)) continue;
          const chat = readGeminiChat(session);
          sessionStates.observe(session.id, 'gemini', chat.status === 'busy' ? 'busy' : 'idle');
        }
      })()
        .catch((error) => logger.warn(`agent events poll failed: ${error}`))
        .finally(() => {
          agentEventsLooking = false;
        });
    },
    3000
  );
  _agentEventsInterval.unref?.();

  // Shielded sessions kept running in tmux while the server was down: attach to them again
  // before any cleanup looks at their (dead) client pid.
  await ptyManager.reattachShieldedSessions();
  // Renew the stable tmux copy now if tmux changed while the server was down (no await: a
  // signing may take a while, and every tmux call meanwhile uses what activateIfReady chose).
  void stableTmux?.refresh();

  const sessionManager = ptyManager.getSessionManager();

  previewRegistry.setSessionNames((sessionId) => ptyManager.getSession(sessionId)?.name);

  // Initialize Terminal Manager for server-side terminal state
  const terminalManager = new TerminalManager(CONTROL_DIR);

  // Read-only share links of a session (services/share-store.ts, routes/share.ts).
  // The viewer's title: the one the user gave the session, else Claude's conversation title
  // when there is one (what the app's lists show), else the session's name; Claude's is read
  // at most every 15 s, the feed polls every 1.5 s.
  const shareTitles = new Map<string, { title: string; at: number }>();
  const shareTitle = async (session: Session): Promise<string> => {
    if (session.userTitle) return session.userTitle;
    const cached = shareTitles.get(session.id);
    if (cached && Date.now() - cached.at < 15_000) return cached.title;
    let title = session.name || session.id;
    try {
      const pid = session.status === 'running' ? ptyManager.programRootPid(session) : undefined;
      const status = pid ? (await readClaudeStatuses([pid])).get(pid) : undefined;
      if (status?.title) title = status.title;
    } catch {
      // No Claude status: the session's name.
    }
    shareTitles.set(session.id, { title, at: Date.now() });
    return title;
  };
  const shareStore = new ShareStore({ file: sharesFileFor(CONTROL_DIR) });
  shareStore.load();
  // Every store keyed by session id follows a session reopened as another (Blindar, Llevar a
  // Untether, Resume Claude) from this one registry (2026-10-25: moving an orchestrator out of
  // its Terminal window must carry its role, its tasks, its confirmations and its links).
  const sessionReplacements = new SessionReplacements((message) => logger.warn(message));
  sessionReplacements.followedBy('share links', shareStore.replacementFollower());
  const shareRoutesConfig = {
    store: shareStore,
    sessionExists: (sessionId: string) => ptyManager.getSession(sessionId) !== null,
    readScreen: async (sessionId: string) => {
      const session = ptyManager.getSession(sessionId);
      if (!session) return null;
      const snapshot = await terminalManager.getBufferSnapshot(sessionId);
      return {
        title: await shareTitle(session),
        running: session.status === 'running',
        text: cellsToText(snapshot.cells, false).replace(/\s+$/u, ''),
        cols: snapshot.cols,
      };
    },
  };
  logger.debug('Initialized terminal manager');

  // Initialize cast output hub + git status hub for WebSocket v3
  const castOutputHub = new CastOutputHub(sessionManager);
  const gitStatusHub = new GitStatusHub();
  logger.debug('Initialized v3 cast output + git status hubs');

  // Initialize session monitor with PTY manager
  const sessionMonitor = new SessionMonitor(ptyManager);
  await sessionMonitor.initialize();

  // Set the session monitor on PTY manager for data tracking
  ptyManager.setSessionMonitor(sessionMonitor);
  ptyManager.setOutputObserver((sessionId, data) => previewRegistry.trackOutput(sessionId, data));
  logger.debug('Initialized session monitor');

  return {
    previewRegistry,
    previewPublicOrigin,
    mainListenPort,
    previewProxy,
    identifyPreviewPort,
    previewHealth,
    previewServer,
    inflightRequests,
    configService,
    resourceMonitor,
    flakyTests,
    backupExclusion,
    stableTmux,
    ptyManager,
    providerLauncher,
    hookFiles,
    agentEvents,
    codexSessions,
    agentSignals,
    sessionStates,
    claudeBusySeen,
    sessionManager,
    terminalManager,
    sessionReplacements,
    shareRoutesConfig,
    castOutputHub,
    gitStatusHub,
    sessionMonitor,
  };
}

export function setupClaudeStatus(ctx: AppContext) {
  const { claudeBusySeen, ptyManager, pushNotificationService, sessionManager, terminalManager } =
    ctx;
  // Tasks from the phone (run now or at a time); created once the session routes exist.
  // Projects' orchestrators (P7): their tasks' events go to them; created with the tasks.
  // Idle Claude sessions suspended to free memory (2026-10-31); created with the restarter.
  /** 'running' for a suspended session: paused, not gone (orchestrators, tasks, doctor). */
  const statusSeenByRoles = (sessionId: string): string | undefined => {
    const session = ptyManager.getSession(sessionId);
    return session?.suspended ? 'running' : session?.status;
  };
  const wakeSuspended = (
    sessionId: string,
    why: string,
    options: { byUser?: boolean } = {}
  ): Promise<WakeResult> =>
    ctx.sessionSuspender
      ? ctx.sessionSuspender.wake(sessionId, why, options)
      : Promise.resolve(
          ptyManager.getSession(sessionId)?.suspended
            ? { ok: false, error: 'Untether is still starting' }
            : { ok: true, sessionId }
        );

  // The menu a Codex waits on (approval, trust, update), read like the phone reads a screen
  // (screen-menu.ts), for the list, the answer sheet and the "Codex needs you" push.
  const codexMenus = new CodexMenus({
    read: async (sessionId) => {
      const recent = await terminalManager.getRecentText(sessionId, MENU_READ_LINES);
      return parseScreenChoices(recent.text, {
        cols: recent.cols,
        wrappedRows: recent.wrappedRows,
        visibleRows: recent.rows,
      });
    },
    canRead: (sessionId) => terminalManager.canSnapshotCheaply(sessionId),
    changeCount: (sessionId) => terminalManager.getChangeCount(sessionId),
  });

  // Push "Claude finished / needs you" from Claude Code's own session status. Built with push
  // off too: tasks follow their sessions through its transitions (2026-10-18: without push a
  // task never left "running").
  const claudeNotifier = new ClaudeStatusNotifier(
    () => watchedSessions(ptyManager),
    (payload) => {
      if (!pushNotificationService) return;
      logger.log(`Agent status push: ${payload.title}`);
      pushNotificationService.sendNotification(payload).catch((error) => {
        logger.warn(`Failed to send agent status notification: ${error}`);
      });
    },
    undefined,
    (error) => logger.warn(`Claude status check failed: ${error}`),
    // The prompt on screen travels in the push, so the answer sheet opens with its options.
    async (sessionId) => {
      // Once, when Claude starts to wait: a long session's replay is worth it here (the
      // push then carries the options; without them its sheet replayed it anyway).
      if (!terminalManager.canSnapshotCheaply(sessionId, LARGE_REPLAY_MAX_BYTES)) return null;
      // Read like the phone reads it (see readScreenChoices in routes/sessions.ts).
      const recent = await terminalManager.getRecentText(sessionId, 60);
      return parseScreenChoices(recent.text, {
        cols: recent.cols,
        wrappedRows: recent.wrappedRows,
        visibleRows: recent.rows,
      });
    },
    {
      log: (message) => logger.log(message),
      refreshPids: () => ptyManager.refreshProgramPids(),
      // Across restarts: a turn that ends while the server restarts is still pushed.
      stateFile: path.join(ctx.controlDir, 'claude-status.json'),
      // Codex's "finished" and "needs you" (2026-11-10), from its rollout: the sessions it
      // runs in were looked up by the agent events' own timer.
      readAgents: (sessions) =>
        codexSightings(sessions, {
          ref: (sessionId) => ctx.codexSessions.ref(sessionId),
          snapshot: (sessionId) => ctx.agentEvents.snapshot(sessionId),
          // The thread's name first, as the list shows it (codex-thread.ts).
          title: (ref) => {
            const thread = ref.resumedThreadId ?? codexIdFromRollout(codexRolloutPath(ref));
            return (thread ? codexThreadTitle(thread) : undefined) ?? readCodexChat(ref).title;
          },
          withMenu: (sessionId, own) => codexMenus.status(sessionId, own),
        }),
    }
  );
  // Task sessions: their status drives the task, and their plain "finished" gives way to the
  // task's own push (one push, not two).
  claudeNotifier.onTransition((sessionId, previous, status, claude, agent) => {
    // Codex's are for the push only: its tasks follow its rollout themselves, and its states
    // reach the event log from the agent events' timer.
    if (agent !== 'claude') return;
    // The doctor's agent-events check: a hooked Claude seen at work must have sent events.
    if (status === 'busy') {
      claudeBusySeen.set(sessionId, Date.now());
      if (claudeBusySeen.size > 500)
        claudeBusySeen.delete(claudeBusySeen.keys().next().value as string);
    }
    ctx.taskScheduler?.onClaudeTransition(sessionId, previous, status, claude);
    ctx.orchestrator?.onClaudeTransition(sessionId, status);
    // Messages between agents typed into it before are read now (agent-messages.ts).
    if (status === 'busy') ctx.taskCommands?.messages.turnStarted(sessionId);
    ctx.sessionStates.observe(
      sessionId,
      'claude',
      status === BACKGROUND
        ? 'busy'
        : status === 'waiting'
          ? 'waiting'
          : status === 'busy'
            ? 'busy'
            : 'idle',
      { background: status === BACKGROUND }
    );
  });
  // A rewriter's null drops the push (2026-10-18: `?? payload` had turned it back into the
  // push, so a task session's plain "finished" still went out next to the task's own).
  claudeNotifier.setPayloadRewriter((payload) => {
    const forTask = ctx.taskScheduler ? ctx.taskScheduler.rewritePush(payload) : payload;
    if (!forTask) return null;
    return ctx.orchestrator ? ctx.orchestrator.rewritePush(forTask) : forTask;
  });
  claudeNotifier.start();

  // Running Claude sessions nobody looked at in the list (a Terminal-window `ut claude`, a
  // session left alone): record their conversation now, so "Resume Claude" works once they exit.
  startClaudeSessionIdRecorder({
    listSessions: () => sessionManager.listSessions(),
    rootPid: (session) => ptyManager.programRootPid(session),
    save: (sessionId, claudeSessionId) => ptyManager.setClaudeSessionId(sessionId, claudeSessionId),
  });
  // The Codex thread of every running session (its command, or typed in its shell; shielded
  // or not), so "Resume", Blindar and a restore go on with `codex resume <id>` (2026-11-10).
  startCodexThreadRecorder({
    listSessions: () => sessionManager.listSessions(),
    rootPid: (session) => ptyManager.programRootPid(session),
    save: (sessionId, threadId) => ptyManager.setCodexThreadId(sessionId, threadId),
    recordingPath: (sessionId) => sessionManager.getSessionPaths(sessionId)?.stdoutPath,
  });
  // Terminals where Claude runs under any script or alias: seen by its process, so a lost tmux
  // brings them back on their conversation.
  startTerminalClaudeRecorder({
    listSessions: () => sessionManager.listSessions(),
    rootPid: (session) => ptyManager.programRootPid(session),
    save: (sessionId, record) => ptyManager.setTerminalClaude(sessionId, record),
    isAlive: (pid) => ProcessUtils.isProcessRunning(pid),
    providers: () => ctx.configService.getConfig().modelProviders,
    rebuildProviderEnv: (marker) => ptyManager.rebuildProviderEnv(marker),
  });
  return { statusSeenByRoles, wakeSuspended, codexMenus };
}

export function setupAuth(ctx: AppContext) {
  const {
    castOutputHub,
    config,
    gitStatusHub,
    ptyManager,
    pushNotificationService,
    sessionMonitor,
    terminalManager,
    wakeSuspended,
  } = ctx;
  // Initialize HQ components
  let remoteRegistry: RemoteRegistry | null = null;

  if (config.isHQMode) {
    remoteRegistry = new RemoteRegistry();
    logger.log(colors.green('Running in HQ mode'));
    logger.debug('Initialized remote registry for HQ mode');
  } else if (
    config.hqUrl &&
    config.remoteName &&
    (config.noHqAuth || (config.hqUsername && config.hqPassword))
  ) {
    // Generate bearer token for this remote server
    ctx.remoteBearerToken = uuidv4();
    logger.debug(`Generated bearer token for remote server: ${config.remoteName}`);
  }

  // Initialize authentication service
  const authService = new AuthService();
  logger.debug('Initialized authentication service');

  // Initialize v3 WebSocket hub (single-socket terminal transport)
  const wsV3Hub = new WsV3Hub({
    ptyManager,
    terminalManager,
    castOutputHub,
    gitStatusHub,
    sessionMonitor,
    remoteRegistry,
    isHQMode: config.isHQMode,
  });
  wsV3Hub.setWakeSuspended(
    async (sessionId) => (await wakeSuspended(sessionId, 'typed into', { byUser: true })).ok
  );
  pushNotificationService?.setAttentionView({
    isSessionViewed: (sessionId) => wsV3Hub.isSessionBeingViewed(sessionId),
    wasSeenSince: (key, since) => wsV3Hub.wasSeenSince(key, since),
    isAnyClientActive: () => wsV3Hub.isAnyClientActive(),
  });
  // The owner of a session's size counts while it shows the session (pty/size-owner.ts).
  ptyManager.setClientViewingCheck((clientId, sessionId) =>
    wsV3Hub.isClientViewing(clientId, sessionId)
  );
  // A Mac-window session's size goes back to its window when its owning page is away a while.
  ptyManager.setClientPresenceChecks({
    awayMs: (clientId, sessionId) => wsV3Hub.clientAwayMs(clientId, sessionId),
    viewedElsewhere: (sessionId, clientId) => wsV3Hub.isSessionBeingViewed(sessionId, clientId),
  });
  pushNotificationService?.setPreviewViewedFilter((previewId) =>
    wsV3Hub.isPreviewBeingViewed(previewId)
  );
  logger.debug('Initialized WebSocket v3 hub');

  // Set up authentication
  const authMiddleware = createAuthMiddleware({
    enableSSHKeys: config.enableSSHKeys,
    disallowUserPassword: config.disallowUserPassword,
    noAuth: config.noAuth,
    isHQMode: config.isHQMode,
    bearerToken: ctx.remoteBearerToken || undefined, // Token that HQ must use to auth with us
    authService, // Add enhanced auth service for JWT tokens
    allowLocalBypass: config.allowLocalBypass,
    localAuthToken: config.localAuthToken || undefined,
    allowTailscaleAuth: config.enableTailscaleServe,
    noAuthOnNetwork: config.unsafeNoAuthOnNetwork,
  });
  return { remoteRegistry, authService, wsV3Hub, authMiddleware };
}

export function wirePreviewOpen(ctx: AppContext) {
  const {
    identifyPreviewPort,
    mainListenPort,
    previewHealth,
    previewProxy,
    previewRegistry,
    ptyManager,
    pushNotificationService,
    sessionMonitor,
  } = ctx;
  // Dev-server previews outlive their session (only its output buffer goes); `ut open`
  // shows the preview on screens viewing the session and pushes "Preview ready" (skipped
  // while that preview is on screen).
  ptyManager.on('sessionExited', (sessionId: string) =>
    previewRegistry.forgetSessionOutput(sessionId)
  );
  const utOpen = createUtOpenHandler({
    registry: previewRegistry,
    sessionExists: (sessionId) => ptyManager.getSession(sessionId) !== null,
    portError: (port) =>
      previewPortError(port, [mainListenPort(), ctx.previewListenPort]) ??
      previewProxy.portError(port),
  });
  // `ut git-event` through the API socket runs the same handler as POST /api/git/event.
  apiSocketServer.setGitEventHandler(processGitEvent);
  apiSocketServer.setPreviewOpenHandler(async (request) => {
    const target = typeof request.target === 'string' ? parseOpenTarget(request.target) : null;
    if (target) await identifyPreviewPort(target.port);
    return utOpen(request);
  });
  previewRegistry.on('open', (event: PreviewOpenEvent) => {
    const openedIn = ptyManager.getSession(event.sessionId);
    const where = openedIn?.userTitle || openedIn?.name || event.sessionId;
    sessionMonitor?.emit('notification', {
      type: ServerEventType.PreviewOpen,
      sessionId: event.sessionId,
      sessionName: where,
      port: event.port,
      path: event.path,
      previewId: event.id,
      timestamp: new Date().toISOString(),
    });
    void previewHealth.check(event.port);
    // A screen showing the session switches to the preview view on this event; the push
    // waits a moment so that screen can say so (VIEWING) and the push is then skipped.
    setTimeout(() => {
      pushNotificationService?.sendNotification(previewReadyPush(event, where)).catch((error) => {
        logger.debug(`preview-ready push failed: ${error}`);
      });
    }, PREVIEW_PUSH_DELAY_MS).unref?.();
  });
}

export function mountApiAuth(ctx: AppContext) {
  const { app, authMiddleware, authService, config } = ctx;
  // Apply auth middleware to all API routes (including auth routes for Tailscale header detection)
  app.use('/api', authMiddleware);
  logger.debug('Applied authentication middleware to /api routes');
  const jsonParsers = apiJsonParsers();
  app.use('/api', jsonParsers.api);
  app.use(jsonParsers.other);

  // Mount authentication routes (auth middleware will skip these but still check Tailscale headers)
  app.use(
    '/api/auth',
    createAuthRoutes({
      authService,
      enableSSHKeys: config.enableSSHKeys,
      disallowUserPassword: config.disallowUserPassword,
      noAuth: config.noAuth,
    })
  );
  logger.debug('Mounted authentication routes');
}
