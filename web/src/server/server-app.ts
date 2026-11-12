// createApp: builds the Untether server from the setup steps in server-*.ts, in order.

import express from 'express';
import { createServer } from 'http';
import * as os from 'os';
import * as path from 'path';
import { WebSocketServer } from 'ws';
import { COPILOT_MAX_UTTERANCE_BYTES } from '../shared/copilot-protocol.js';
import { TASK_FINAL_STATES } from '../shared/tasks.js';
import type { PtyManager } from './pty/index.js';
import { setupAppUpdate } from './server-app-update.js';
import { type Config, parseArgs, showHelp, validateConfig } from './server-config.js';
import type { AppContext } from './server-context.js';
import {
  mountApiAuth,
  setupAuth,
  setupClaudeStatus,
  setupCore,
  wirePreviewOpen,
} from './server-core.js';
import { setupDoctor } from './server-doctor.js';
import { setupIdleClaude } from './server-idle-claude.js';
import { createStartServer } from './server-listen.js';
import { setupPush, wireMonitorPushes, wireSessionPushes } from './server-push.js';
import { mountRoutes } from './server-routes.js';
import { setupSessions } from './server-sessions.js';
import { mountClientRoutes, mountHealthRoute, setupStatic } from './server-static.js';
import { setupOrchestrator, setupTasks, wireTaskSocket } from './server-tasks.js';
import { setupWebSockets } from './server-websocket.js';
import type { AgentEventService } from './services/agent-event-service.js';
import { CheckResults, setCheckResults } from './services/check-results.js';
import { CheckSlots } from './services/check-slots.js';
import type { ConfigService } from './services/config-service.js';
import type { ConnectorListener } from './services/connector/connector-http.js';
import type { ControlDirWatcher } from './services/control-dir-watcher.js';
import type { CopilotService } from './services/copilot/service.js';
import { EventLog } from './services/event-log.js';
import { ExitedSessionCleanup } from './services/exited-session-cleanup.js';
import type { HQClient } from './services/hq-client.js';
import { InputDiagStore } from './services/input-diagnostics.js';
import type { PreviewRegistry } from './services/preview-registry.js';
import type { PushNotificationService } from './services/push-notification-service.js';
import type { RemoteRegistry } from './services/remote-registry.js';
import { trimFinishedRecordings } from './services/session-recordings.js';
import type { TaskScheduler } from './services/task-scheduler.js';
import { checkLimiter, checkLoadGate, currentCheckLoad } from './services/task-verify.js';
import type { TerminalManager } from './services/terminal-manager.js';
import type { InflightRequests } from './utils/inflight-requests.js';
import { createLogger, logFromModule } from './utils/logger.js';
import { getVersionInfo, printVersionBanner } from './version.js';

const logger = createLogger('server');

export interface AppInstance {
  app: express.Application;
  server: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  startServer: () => void;
  config: Config;
  configService: ConfigService;
  exitedSessionCleanup: ExitedSessionCleanup;
  ptyManager: PtyManager;
  terminalManager: TerminalManager;
  remoteRegistry: RemoteRegistry | null;
  hqClient: HQClient | null;
  controlDirWatcher: ControlDirWatcher | null;
  pushNotificationService: PushNotificationService | null;
  taskScheduler: TaskScheduler | null;
  previewRegistry: PreviewRegistry;
  inflightRequests: InflightRequests;
  /** "Share with phone": stops its jobs and kills any osascript still running. */
  disposeMacShare: () => void;
  /** The voice copilot (null without the session routes' access). */
  copilotService: CopilotService | null;
  agentEvents: AgentEventService;
  /** The project connector's listener (connector-http.ts): closed at shutdown. */
  connectorListener: ConnectorListener | null;
}

// Track if app has been created
let appCreated = false;

export async function createApp(): Promise<AppInstance> {
  // Prevent multiple app instances
  if (appCreated) {
    logger.error('App already created, preventing duplicate instance');
    throw new Error('Duplicate app creation detected');
  }
  appCreated = true;

  const config = parseArgs();

  // Check if help was requested
  if (config.showHelp) {
    showHelp();
    process.exit(0);
  }

  // Check if version was requested
  if (config.showVersion) {
    const versionInfo = getVersionInfo();
    console.log(`Untether Server v${versionInfo.version}`);
    console.log(`Built: ${versionInfo.buildDate}`);
    console.log(`Platform: ${versionInfo.platform}/${versionInfo.arch}`);
    console.log(`Node: ${versionInfo.nodeVersion}`);
    process.exit(0);
  }

  // Print version banner on startup
  printVersionBanner();

  validateConfig(config);

  logger.log('Initializing Untether server components');
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  // The voice copilot's socket: audio both ways, so no deflate; one utterance at most 2 MB.
  const copilotWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: COPILOT_MAX_UTTERANCE_BYTES,
  });

  // Control directory for session data
  const CONTROL_DIR =
    process.env.UNTETHER_CONTROL_DIR || path.join(os.homedir(), '.untether/control');

  // The checks that passed, by the tree they ran on: the merge pipeline's verification runs and
  // the runs agents start share them (check-results.ts).
  const checkResults = new CheckResults({
    file: path.join(CONTROL_DIR, 'check-results.json'),
    log: (message) => logger.warn(message),
  });
  setCheckResults(checkResults);

  const ctx = {
    config,
    app,
    server,
    wss,
    copilotWss,
    controlDir: CONTROL_DIR,
    eventLog: new EventLog({
      dir: path.join(CONTROL_DIR, 'events'),
      onError: (message) => logger.warn(message),
    }),
    inputDiag: new InputDiagStore({
      dir: path.join(CONTROL_DIR, 'diag'),
      // With the client's own lines ([FE]), where ./scripts/utlog.sh and /logs show them.
      log: (line) => logFromModule('LOG', '[FE] input-diag', [line]),
      onError: (message) => logger.warn(message),
    }),
    // The same limiter as the merge pipeline's checks (task-verify.ts), for runs agents and
    // scripts start; its tickets are looked at every few seconds.
    checkSlots: new CheckSlots({
      limiter: checkLimiter,
      gate: checkLoadGate,
      maxWaitSec: () => currentCheckLoad().maxSlotWaitSec,
      file: path.join(CONTROL_DIR, 'check-slots.json'),
      log: (message) => logger.log(message),
      // A check that passed on the very same files is not run again (check-results.ts).
      results: checkResults,
      onRun: (run) => {
        if (run.taskId) ctx.taskScheduler?.noteAgentCheck(run.taskId, run);
      },
    }),
    previewListenPort: null,
    taskScheduler: null,
    taskOrphanReaper: null,
    orchestrator: null,
    sessionSuspender: null,
    installedApp: null,
    doctorReport: null,
    hqClient: null,
    controlDirWatcher: null,
    remoteBearerToken: null,
    deliverTaskInput: null,
    answerTrustDialog: null,
    answerScreenMenu: null,
    claudeRestartActions: null,
    sessionKeptForTasks,
  } as Partial<AppContext> as AppContext;

  Object.assign(ctx, await setupCore(ctx));
  Object.assign(ctx, await setupPush(ctx));
  Object.assign(ctx, setupClaudeStatus(ctx));
  wireMonitorPushes(ctx);
  Object.assign(ctx, setupAuth(ctx));
  Object.assign(ctx, setupStatic(ctx));
  wirePreviewOpen(ctx);
  wireSessionPushes(ctx);
  mountApiAuth(ctx);
  // After the /api auth middleware so GET /api/health is annotated with the caller's identity
  // (optional auth): the fingerprint detail is for signed-in callers only (server-static.ts).
  mountHealthRoute(ctx);
  Object.assign(ctx, setupSessions(ctx));
  Object.assign(ctx, setupTasks(ctx));
  setupIdleClaude(ctx);
  wireTaskSocket(ctx);
  setupOrchestrator(ctx);
  Object.assign(ctx, setupAppUpdate(ctx));
  setupDoctor(ctx);
  await mountRoutes(ctx);
  setupWebSockets(ctx);
  mountClientRoutes(ctx);
  const startServer = createStartServer(ctx);

  /**
   * Sessions an open task or an orchestrator still needs (their Resume / reopen / the
   * scheduler's sessionReplaced point at them): neither "Clean exited" nor the hourly cleanup
   * removes them. Read when a cleanup runs, after the scheduler and orchestrator exist.
   * 2026-10-20: createSessionRoutes had `keepOnExitedCleanup` but nothing passed it, so "Clean
   * exited" deleted the session of a task waiting for review and "Que lo arregle" had nothing
   * to reopen.
   */
  function sessionKeptForTasks(sessionId: string): boolean {
    const openTasks = (ctx.taskScheduler?.list() ?? []).filter(
      (task) => !TASK_FINAL_STATES.includes(task.state)
    );
    if (
      openTasks.some(
        (task) => task.sessionId === sessionId || task.orchestratorSessionId === sessionId
      )
    ) {
      return true;
    }
    if (ctx.orchestrator?.list().some((entry) => entry.sessionId === sessionId)) return true;
    // An orchestrator restore() brings back (its session exited with the server).
    return ctx.projectSettings
      .list()
      .some(({ settings }) => settings.orchestratorSessionId === sessionId);
  }

  // Opt-in removal of old finished sessions (Settings > Clean up finished sessions)
  const exitedSessionCleanup = new ExitedSessionCleanup({
    controlPath: CONTROL_DIR,
    listSessions: () => ctx.sessionManager.listSessions(),
    cleanupSession: (sessionId) => {
      ctx.ptyManager.cleanupSession(sessionId);
      if (config.isHQMode && ctx.remoteRegistry) {
        ctx.remoteRegistry.removeSessionFromRemote(sessionId);
      }
    },
    getDays: () => ctx.configService.getConfig().autoCleanupExitedAfterDays,
    // A suspended session (session-suspender.ts) is paused, not finished.
    keep: (session) => !!session.suspended || sessionKeptForTasks(session.id),
    // 2026-11-01: finished sessions kept whole recordings (3.1 GB for two days of them).
    trimRecordings: () =>
      trimFinishedRecordings({
        controlPath: CONTROL_DIR,
        listSessions: () => ctx.sessionManager.listSessions(),
        settings: () => ctx.configService.getConfig().recordings,
        keep: (session) => sessionKeptForTasks(session.id),
      }),
  });

  return {
    app,
    server,
    wss,
    startServer,
    config,
    configService: ctx.configService,
    exitedSessionCleanup,
    ptyManager: ctx.ptyManager,
    terminalManager: ctx.terminalManager,
    remoteRegistry: ctx.remoteRegistry,
    hqClient: ctx.hqClient,
    controlDirWatcher: ctx.controlDirWatcher,
    pushNotificationService: ctx.pushNotificationService,
    taskScheduler: ctx.taskScheduler,
    previewRegistry: ctx.previewRegistry,
    inflightRequests: ctx.inflightRequests,
    disposeMacShare: ctx.disposeMacShare,
    copilotService: ctx.copilotService,
    agentEvents: ctx.agentEvents,
    connectorListener: ctx.connectorListener,
  };
}
