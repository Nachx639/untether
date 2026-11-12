// startUntetherServer: startup guards, createApp, periodic cleanups and graceful shutdown.
import { createApp } from './server-app.js';
import {
  bindAddressFor,
  leftoverServeRoutesRefusal,
  listenPortFor,
  parseArgs,
  watchParentWhenUnauthenticated,
} from './server-config.js';
import { globalTunnelState } from './server-listen.js';
import { mdnsService } from './services/mdns-service.js';
import { setShuttingDown } from './services/shutdown-state.js';
import { tailscaleServeService } from './services/tailscale-serve-service.js';
import { colors } from './utils/colors.js';
import { closeLogger, createLogger, initLogger, setDebugMode } from './utils/logger.js';
import { every } from './utils/periodic-loop.js';
import { closeConnectionsForShutdown } from './utils/shutdown-connections.js';
import { waitForFreePort } from './utils/startup-port.js';

const logger = createLogger('server');

// Track if server has been started
let serverStarted = false;

// Export a function to start the server

export async function startUntetherServer() {
  // Initialize logger if not already initialized (preserves debug mode from CLI)
  initLogger();

  // Prevent multiple server instances
  if (serverStarted) {
    logger.error('Server already started, preventing duplicate instance');
    logger.error('This should not happen - duplicate server startup detected');
    process.exit(1);
  }
  serverStarted = true;

  // Before anything touches the control dir: a second server on a running one's port used to
  // re-attach its shielded sessions and unlink its control socket, then die on EADDRINUSE,
  // leaving those sessions listed as exited (2026-10-03). Wait for the port instead (a
  // restart thus also outlasts its predecessor's shutdown) and leave untouched if it stays taken.
  const startupConfig = parseArgs();
  if (!startupConfig.showHelp && !startupConfig.showVersion) {
    // An unauthenticated or test server must not outlive whoever started it (see
    // watchParentWhenUnauthenticated): SIGTERM runs the normal graceful shutdown.
    watchParentWhenUnauthenticated(startupConfig, (why) => {
      logger.warn(`Shutting down: ${why} (unauthenticated or test server)`);
      process.kill(process.pid, 'SIGTERM');
      setTimeout(() => process.exit(1), 10_000).unref();
    });
    const port = listenPortFor(startupConfig);
    const free = await waitForFreePort(port, bindAddressFor(startupConfig), {
      onWait: () =>
        logger.log(
          colors.yellow(`Port ${port} is busy: waiting for it before touching any session`)
        ),
    });
    if (!free) {
      logger.error(
        `Port ${port} is already in use (another Untether server?): not starting, no session touched`
      );
      process.exit(9); // Same code as a port conflict at listen time
    }
    const leftover = await leftoverServeRoutesRefusal(startupConfig, port);
    if (leftover) {
      logger.error(leftover);
      process.exit(1);
    }
  }

  logger.debug('Creating Untether application instance');
  // Create and configure the app
  const appInstance = await createApp();
  const {
    startServer,
    server,
    wss,
    terminalManager,
    remoteRegistry,
    hqClient,
    controlDirWatcher,
    config,
    configService,
    exitedSessionCleanup,
    taskScheduler,
    previewRegistry,
    inflightRequests,
    disposeMacShare,
    copilotService,
    connectorListener,
    agentEvents,
  } = appInstance;

  // Update debug mode based on config or environment variable
  if (config.debug || process.env.DEBUG === 'true') {
    setDebugMode(true);
    logger.log(colors.gray('Debug logging enabled'));
  }

  startServer();

  // Remove finished sessions past the user's chosen age: now, then hourly (off by default)
  exitedSessionCleanup.start();

  // Cleanup old terminals every 5 minutes
  const _terminalCleanupInterval = every(
    'terminal cleanup',
    () => {
      terminalManager.cleanup(5 * 60 * 1000); // 5 minutes
    },
    5 * 60 * 1000
  );
  logger.debug('Started terminal cleanup interval (5 minutes)');

  // Graceful shutdown
  let localShuttingDown = false;
  let shutdownSignalAt = 0;
  /** A second SIGTERM/SIGINT this soon after the first is the same request (see shutdown). */
  const REPEATED_SIGNAL_GRACE_MS = 5000;

  const shutdown = async () => {
    if (localShuttingDown) {
      // 2026-10-20: the Mac app's SIGTERM to the process group plus its wrapper's forwarded
      // one arrived together, and the second "forced" exit(1) before any cleanup ran. A
      // repeat within a few seconds is the same request; a later one (Ctrl-C twice) forces.
      if (Date.now() - shutdownSignalAt < REPEATED_SIGNAL_GRACE_MS) {
        logger.debug('Repeated shutdown signal ignored: already shutting down');
        return;
      }
      logger.warn('Force exit...');
      process.exit(1);
    }

    localShuttingDown = true;
    shutdownSignalAt = Date.now();
    setShuttingDown(true);
    logger.log(colors.yellow('\nShutting down...'));

    try {
      // Tailscale Serve first: its route must not outlive this server (2026-10-20, a later
      // --no-auth server inherited it), and a slow step below must not use up the time the
      // Mac app waits before SIGKILL (ServerProcess.gracefulStopSeconds, 8 s).
      if (config.enableTailscaleServe && tailscaleServeService.isRunning()) {
        logger.log('Stopping Tailscale Serve...');
        await tailscaleServeService.stop();
        logger.debug('Stopped Tailscale Serve service');
      }

      // Clear cleanup intervals
      clearInterval(_terminalCleanupInterval);
      exitedSessionCleanup.stop();
      logger.debug('Cleared cleanup intervals');

      taskScheduler?.stop();
      // The agents' states as they are now: the next server takes them back (2026-11-03).
      agentEvents.flush(true);
      // The copilot's claude processes and pages go with the server.
      copilotService?.shutdown();
      // No share job goes on, and no osascript outlives the server.
      disposeMacShare();
      await connectorListener?.stop().catch(() => undefined);
      // Pending preview changes (pin, rename, last seen) to previews.json.
      previewRegistry.flush();

      // Stop configuration service watcher
      configService.stopWatching();
      logger.debug('Stopped configuration service watcher');

      // Stop mDNS advertisement if it was started
      if (mdnsService.isActive()) {
        await mdnsService.stopAdvertising();
        logger.debug('Stopped mDNS advertisement');
      }

      // Stop ngrok tunnel if it was started
      const ngrokService = globalTunnelState.__ngrokService;
      if (ngrokService?.isActive()) {
        logger.log('Stopping ngrok tunnel...');
        await ngrokService.stop();
        logger.debug('Stopped ngrok tunnel');
      }

      // Stop Cloudflare tunnel if it was started
      const cloudflareService = globalTunnelState.__cloudflareService;
      if (cloudflareService?.isActive()) {
        logger.log('Stopping Cloudflare tunnel...');
        await cloudflareService.stop();
        logger.debug('Stopped Cloudflare tunnel');
      }

      // Stop control directory watcher
      if (controlDirWatcher) {
        controlDirWatcher.stop();
        logger.debug('Stopped control directory watcher');
      }

      // Stop UNIX socket server
      try {
        const { controlUnixHandler } = await import('./websocket/control-unix-handler.js');
        controlUnixHandler.stop();
        logger.debug('Stopped UNIX socket server');
      } catch (_error) {
        // Ignore if module not loaded
      }

      if (hqClient) {
        logger.debug('Destroying HQ client connection');
        await hqClient.destroy();
      }

      if (remoteRegistry) {
        logger.debug('Destroying remote registry');
        remoteRegistry.destroy();
      }

      server.close(() => {
        logger.log(colors.green('Server closed successfully'));
        closeLogger();
        process.exit(0);
      });
      // Phones' keep-alive sockets, event streams and WebSockets would hold close() open
      // until the timeout below; every restart was down 5.5 s (2026-10-03). Uploads, answers
      // and pushes in flight still get to finish.
      closeConnectionsForShutdown(server, wss, inflightRequests.count);

      // Force exit if graceful shutdown fails: a second after the drain's 5 s limit, so a
      // request that never ends is cut and the server still closes cleanly.
      setTimeout(() => {
        logger.warn('Graceful shutdown timeout, forcing exit...');
        closeLogger();
        process.exit(1);
      }, 6000);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      closeLogger();
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  logger.debug('Registered signal handlers for graceful shutdown');
}
