// The remaining /api routes, and the control and API sockets.
import * as fs from 'fs';
import * as path from 'path';
import { apiSocketServer } from './api-socket-server.js';
import { createAwaySummaryRoutes } from './routes/away-summary.js';
import { createClaudeHistoryRoutes } from './routes/claude-history.js';
import { createConfigRoutes } from './routes/config.js';
import { createConfirmationRoutes } from './routes/confirmations.js';
import { createDictationRoutes } from './routes/dictation.js';
import { createEventRoutes } from './routes/events.js';
import { createFileRoutes } from './routes/files.js';
import { createFilesystemRoutes } from './routes/filesystem.js';
import { createGitRoutes } from './routes/git.js';
import { createGitShipRoutes } from './routes/git-ship.js';
import { createInputDiagnosticsRoutes } from './routes/input-diagnostics.js';
import { createLogRoutes } from './routes/logs.js';
import { createMultiplexerRoutes } from './routes/multiplexer.js';
import { createPreviewRoutes } from './routes/preview.js';
import { createProjectRoutes } from './routes/projects.js';
import { createPushRoutes } from './routes/push.js';
import { createQuickActionsRoutes } from './routes/quick-actions.js';
import { createRemoteRoutes } from './routes/remotes.js';
import { createRepositoryRoutes } from './routes/repositories.js';
import { createShareApiRoutes } from './routes/share.js';
import { createTaskRoutes } from './routes/tasks.js';
import { createTestNotificationRouter } from './routes/test-notification.js';
import { createTtsRoutes } from './routes/tts.js';
import { createWorktreeRoutes } from './routes/worktrees.js';
import type { AppContext } from './server-context.js';
import { GroupOrderStore } from './services/group-order.js';
import { colors } from './utils/colors.js';
import { createLogger } from './utils/logger.js';
import { VapidManager } from './utils/vapid-manager.js';
import { controlUnixHandler } from './websocket/control-unix-handler.js';

const logger = createLogger('server');

export async function mountRoutes(ctx: AppContext) {
  const {
    app,
    config,
    configService,
    identifyPreviewPort,
    liveConversations,
    macSessionsNow,
    macSessionsScanner,
    macSessionsStart,
    macShareStart,
    mainListenPort,
    previewHealth,
    previewProxy,
    previewPublicOrigin,
    previewRegistry,
    projectSettings,
    ptyManager,
    pushNotificationService,
    remoteRegistry,
    sessionMonitor,
    shareRoutesConfig,
    stableTmux,
    taskCommands,
    vapidManager,
  } = ctx;
  // The home's group order the user chose (2026-11-07): it follows renamed project folders.
  const groupOrder = new GroupOrderStore(
    path.join(path.dirname(ctx.controlDir), 'group-order.json'),
    (message, error) => logger.warn(`${message}${error ? `: ${error}` : ''}`)
  );
  projectSettings.followedBy('group order', (moved) => groupOrder.projectsMoved(moved));
  app.use(
    '/api',
    createTaskRoutes({
      configService,
      scheduler: () => ctx.taskScheduler,
      commands: taskCommands,
      orchestrators: () => ctx.orchestrator?.list() ?? [],
      pinnedProjects: () =>
        projectSettings
          .pinned()
          .map((repoPath) => ({ repoPath, git: fs.existsSync(path.join(repoPath, '.git')) })),
      groupOrder: () => groupOrder.get(),
      sessionOrder: () => groupOrder.getSessions(),
      collapsedGroups: () => groupOrder.getCollapsed(),
    })
  );
  app.use(
    '/api',
    createProjectRoutes({
      settings: projectSettings,
      scheduler: () => ctx.taskScheduler,
      commands: taskCommands,
      orchestrator: () => ctx.orchestrator,
      groupOrder,
      newProjectParent: {
        get: () => configService.getConfig().newProjectParent,
        set: (dir) =>
          configService.updateConfig({ ...configService.getConfig(), newProjectParent: dir }),
      },
    })
  );
  app.use('/api', createConfirmationRoutes({ commands: taskCommands }));
  // The public event log (`ut events`): GET /api/events and its stream.
  app.use('/api', createEventRoutes({ eventLog: ctx.eventLog }));
  app.use('/api', createInputDiagnosticsRoutes({ store: ctx.inputDiag }));
  logger.debug('Mounted task, project and confirmation routes');

  app.use('/api', createShareApiRoutes(shareRoutesConfig));
  app.use(
    '/api',
    createPreviewRoutes({
      previewProxy,
      previewRegistry,
      getOwnPort: mainListenPort,
      getPreviewPort: () => ctx.previewListenPort,
      previewOrigin: previewPublicOrigin,
      sessionExists: (sessionId) => ptyManager.getSession(sessionId) !== null,
      sessionRunning: (sessionId) => ptyManager.getSession(sessionId)?.status === 'running',
      sessionName: (sessionId) => ptyManager.getSession(sessionId)?.name,
      health: previewHealth,
      identifyPort: identifyPreviewPort,
    })
  );

  app.use(
    '/api',
    createRemoteRoutes({
      remoteRegistry,
      isHQMode: config.isHQMode,
    })
  );
  logger.debug('Mounted remote routes');

  // Mount filesystem routes
  app.use('/api', createFilesystemRoutes());
  logger.debug('Mounted filesystem routes');

  // Mount log routes
  app.use('/api', createLogRoutes());
  logger.debug('Mounted log routes');

  // Mount file routes
  app.use('/api', createFileRoutes());
  logger.debug('Mounted file routes');

  // Mount repository routes
  app.use('/api', createRepositoryRoutes());
  logger.debug('Mounted repository routes');

  // Mount config routes
  app.use(
    '/api',
    createConfigRoutes({
      configService,
      isShieldAvailable: () => ptyManager.isShieldAvailable(),
      installedAppPath: () => ctx.installedApp?.current()?.appPath,
      ...(stableTmux ? { stableTmux } : {}),
      macSessions: macSessionsStart,
      macShare: macShareStart,
    })
  );
  logger.debug('Mounted config routes');

  // Mount Claude Code conversation history routes
  app.use(
    '/api',
    createClaudeHistoryRoutes({
      liveConversations: async () => {
        // With the section on, a fresh scan names them, so the phone can read or open them.
        if (macSessionsNow().enabled) await macSessionsScanner.scan().catch(() => undefined);
        return liveConversations();
      },
    })
  );
  // "While you were away": what an agent session did since the user last looked
  app.use('/api', createAwaySummaryRoutes({ ptyManager }));
  // One-tap prompts on the phone, from the project's .untether/quick-actions.json
  app.use('/api', createQuickActionsRoutes({ ptyManager }));
  // Voice dictation transcribed on the Mac (works in every phone browser)
  app.use('/api', createDictationRoutes());
  // Replies read aloud by a local voice (voice mode)
  app.use('/api', createTtsRoutes());
  logger.debug('Mounted Claude history routes');

  // Mount Git routes
  app.use('/api', createGitRoutes());
  // Ship from the phone: commit, push and open a PR for a session's repository
  app.use('/api', createGitShipRoutes({ ptyManager }));
  logger.debug('Mounted Git routes');

  // Mount worktree routes
  app.use('/api', createWorktreeRoutes());
  logger.debug('Mounted worktree routes');

  // Mount multiplexer routes (unified tmux/zellij interface)
  app.use('/api/multiplexer', createMultiplexerRoutes({ ptyManager }));
  logger.debug('Mounted multiplexer routes');

  // Mount push notification routes - always mount even if VAPID is not initialized
  // This ensures proper error responses instead of 404s
  app.use(
    '/api',
    createPushRoutes({
      vapidManager: vapidManager || new VapidManager(), // Pass a dummy instance if null
      pushNotificationService,
      sessionMonitor,
    })
  );
  logger.debug('Mounted push notification routes');

  // Mount test notification router
  app.use('/api', createTestNotificationRouter({ sessionMonitor, pushNotificationService }));
  logger.debug('Mounted test notification routes');

  // Initialize control socket
  try {
    await controlUnixHandler.start();
    logger.log(colors.green('Control UNIX socket: READY'));
  } catch (error) {
    logger.error('Failed to initialize control socket:', error);
    logger.warn('Mac control features will not be available.');
    // Depending on the desired behavior, you might want to exit here
    // For now, we'll let the server continue without these features.
  }

  // Initialize API socket for CLI commands
  try {
    await apiSocketServer.start();
    logger.log(colors.green('API socket server: READY'));
  } catch (error) {
    logger.error('Failed to initialize API socket server:', error);
    logger.warn('ut commands will not work via socket.');
  }
}
