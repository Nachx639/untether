// startServer: listening, the preview listener, tunnels, HQ registration and mDNS.
import { apiSocketServer } from './api-socket-server.js';
import {
  bindAddressFor,
  listenPortFor,
  resolveRemoteUrl,
  shouldAdvertiseMDNS,
} from './server-config.js';
import type { AppContext } from './server-context.js';
import { CloudflareService } from './services/cloudflare-service.js';
import { ControlDirWatcher } from './services/control-dir-watcher.js';
import { HQClient } from './services/hq-client.js';
import { mdnsService } from './services/mdns-service.js';
import { NgrokService } from './services/ngrok-service.js';
import { resolvePreviewPort } from './services/preview-server.js';
import { tailscaleServeService } from './services/tailscale-serve-service.js';
import { colors } from './utils/colors.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('server');

interface GlobalTunnelState {
  __ngrokService?: NgrokService;
  __cloudflareService?: CloudflareService;
}

export const globalTunnelState = global as typeof global & GlobalTunnelState;

export function createStartServer(ctx: AppContext) {
  const {
    controlDir: CONTROL_DIR,
    config,
    previewRegistry,
    previewServer,
    ptyManager,
    pushNotificationService,
    remoteRegistry,
    server,
  } = ctx;
  // Start server function
  const startServer = () => {
    const requestedPort = listenPortFor(config);

    logger.log(`Starting server on port ${requestedPort}`);

    // Remove all existing error listeners first to prevent duplicates
    server.removeAllListeners('error');

    // Add error handler for port already in use
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${requestedPort} is already in use`);

        // Provide more helpful error message in development mode
        const isDevelopment = !process.env.BUILD_DATE || process.env.NODE_ENV === 'development';
        if (isDevelopment) {
          logger.error(colors.yellow('\nDevelopment mode options:'));
          logger.error(
            `  1. Run server on different port: ${colors.cyan('pnpm run dev:server --port 4021')}`
          );
          logger.error(`  2. Use environment variable: ${colors.cyan('PORT=4021 pnpm run dev')}`);
          logger.error(
            '  3. Stop the existing server (check Activity Monitor for untether processes)'
          );
        } else {
          logger.error(
            'Please use a different port with --port <number> or stop the existing server'
          );
        }
        process.exit(9); // Exit with code 9 to indicate port conflict
      } else {
        logger.error('Server error:', error);
        process.exit(1);
      }
    });

    // Regular TCP mode
    logger.log(`Starting server on port ${requestedPort}`);
    // Use the requested bind address - don't force localhost just because Tailscale is enabled
    // The Mac app will handle binding logic based on actual Tailscale Serve status
    const bindAddress = bindAddressFor(config);
    server.listen(requestedPort, bindAddress, () => {
      const address = server.address();
      const actualPort =
        typeof address === 'string' ? requestedPort : address?.port || requestedPort;
      const displayAddress = bindAddress === '0.0.0.0' ? 'localhost' : bindAddress;
      logger.log(colors.green(`Untether Server running on http://${displayAddress}:${actualPort}`));

      // Update API socket server with actual port information
      apiSocketServer.setServerInfo(actualPort, `http://${displayAddress}:${actualPort}`);
      // Previews of a port that is now refused (Untether's own, denied) go away.
      previewRegistry.removeRefused();

      // Dev-server preview listener (separate origin), same bind address. A failure leaves
      // Untether running with previews disabled.
      const preview = resolvePreviewPort(
        config.previewPort,
        process.env.UNTETHER_PREVIEW_PORT,
        actualPort
      );
      if (preview.error) logger.error(`Previews disabled: ${preview.error}`);
      if (preview.port !== null) {
        const requestedPreviewPort = preview.port;
        previewServer.on('error', (error: NodeJS.ErrnoException) => {
          ctx.previewListenPort = null;
          logger.error(
            `Previews disabled: cannot listen on ${bindAddress}:${requestedPreviewPort} (${error.code ?? error.message})`
          );
        });
        previewServer.listen(requestedPreviewPort, bindAddress, () => {
          const previewAddress = previewServer.address();
          ctx.previewListenPort =
            previewAddress && typeof previewAddress === 'object'
              ? previewAddress.port
              : requestedPreviewPort;
          logger.log(
            colors.green(`Dev-server previews on http://${displayAddress}:${ctx.previewListenPort}`)
          );
          previewRegistry.removeRefused();
        });
      }

      if (config.noAuth) {
        logger.warn(colors.yellow('Authentication: DISABLED (--no-auth)'));
        logger.warn('Anyone can access this server without authentication');
      } else if (config.disallowUserPassword) {
        logger.log(colors.green('Authentication: SSH KEYS ONLY (--disallow-user-password)'));
        logger.log(colors.gray('Password authentication is disabled'));
      } else {
        logger.log(colors.green('Authentication: SYSTEM USER PASSWORD'));
        if (config.enableSSHKeys) {
          logger.log(colors.green('SSH Key Authentication: ENABLED'));
        } else {
          logger.log(
            colors.gray('SSH Key Authentication: DISABLED (use --enable-ssh-keys to enable)')
          );
        }
      }

      // Validate Tailscale configuration
      if (config.enableTailscaleFunnel && !config.enableTailscaleServe) {
        logger.error('Tailscale Funnel requires Tailscale Serve to be enabled');
        process.exit(1);
      }

      // Start Tailscale Serve if requested
      if (config.enableTailscaleServe) {
        logger.info(colors.blue('Starting Tailscale Serve integration...'));

        tailscaleServeService
          .start(actualPort, config.enableTailscaleFunnel)
          .then(() => {
            logger.info(colors.green('Tailscale Serve: ENABLED'));
            if (config.enableTailscaleFunnel) {
              logger.warn(colors.yellow('Tailscale Funnel: ENABLED - PUBLIC INTERNET ACCESS'));
            }
            logger.info(
              colors.gray('Users will be auto-authenticated via Tailscale identity headers')
            );
            logger.info(
              colors.gray(
                `Access via HTTPS on your Tailscale hostname (e.g., https://hostname.tailnet.ts.net)`
              )
            );
          })
          .catch((error) => {
            logger.error(colors.red('❌ Failed to start Tailscale Serve:'), error.message);
            logger.warn(
              colors.yellow(
                '⚠️ Untether will continue running, but Tailscale Serve is not available'
              )
            );
            logger.info(colors.blue('💻 You can manually configure Tailscale Serve with:'));
            logger.info(colors.gray(`  tailscale serve ${actualPort}`));
          });
      }

      // Start ngrok tunnel if requested
      if (config.enableNgrok) {
        logger.log(colors.blue('Starting ngrok tunnel...'));

        const ngrokService = new NgrokService({
          port: actualPort,
          authToken: config.ngrokAuthToken || undefined,
          domain: config.ngrokDomain || undefined,
          region: config.ngrokRegion || undefined,
        });
        globalTunnelState.__ngrokService = ngrokService;

        ngrokService
          .start()
          .then((tunnel) => {
            logger.log(colors.green('Ngrok tunnel: ENABLED'));
            logger.log(colors.green(`Public URL: ${tunnel.publicUrl}`));
            logger.log(colors.gray('Your Untether server is now accessible from the internet'));
          })
          .catch((error) => {
            logger.error(colors.red('Failed to start ngrok tunnel:'), error.message);
            logger.warn(
              colors.yellow(
                'Untether will continue running locally, but ngrok tunnel is not available'
              )
            );
            if (!config.ngrokAuthToken) {
              logger.log(
                colors.blue('Tip: Set an auth token with --ngrok-auth for better reliability')
              );
            }
          });
      }

      // Start Cloudflare tunnel if requested
      if (config.enableCloudflare) {
        logger.log(colors.blue('Starting Cloudflare tunnel...'));

        const cloudflareService = new CloudflareService(actualPort);
        globalTunnelState.__cloudflareService = cloudflareService;

        cloudflareService
          .start()
          .then((tunnel) => {
            logger.log(colors.green('Cloudflare tunnel: ENABLED'));
            logger.log(colors.green(`Public URL: ${tunnel.publicUrl}`));
            logger.log(colors.gray('Your Untether server is now accessible from the internet'));
            logger.log(colors.gray('Note: Cloudflare Quick Tunnels have usage limits'));
          })
          .catch((error) => {
            logger.error(colors.red('Failed to start Cloudflare tunnel:'), error.message);
            logger.warn(
              colors.yellow(
                'Untether will continue running locally, but Cloudflare tunnel is not available'
              )
            );
            logger.log(
              colors.blue(
                'Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/'
              )
            );
          });
      }

      // Log local bypass status
      if (config.allowLocalBypass) {
        logger.log(colors.yellow('Local Bypass: ENABLED'));
        if (config.localAuthToken) {
          logger.log(colors.gray('Local connections require auth token'));
        } else {
          logger.warn('Local bypass has no auth token: every local connection must log in');
        }
      }

      // Initialize HQ client now that we know the actual port
      if (
        config.hqUrl &&
        config.remoteName &&
        (config.noHqAuth || (config.hqUsername && config.hqPassword))
      ) {
        // The URL the HQ will use to connect back to this remote. An explicit
        // --remote-url wins; otherwise it's derived from --bind (see
        // resolveRemoteUrl for the hostname-fallback caveat).
        const remoteUrl = resolveRemoteUrl(config.remoteUrl, bindAddress, actualPort);
        ctx.hqClient = new HQClient(
          config.hqUrl,
          config.hqUsername || 'no-auth',
          config.hqPassword || 'no-auth',
          config.remoteName,
          remoteUrl,
          ctx.remoteBearerToken || ''
        );
        if (config.noHqAuth) {
          logger.log(
            colors.yellow(
              `Remote mode: ${config.remoteName} registering WITHOUT HQ authentication (--no-hq-auth)`
            )
          );
        } else {
          logger.log(
            colors.green(`Remote mode: ${config.remoteName} will accept Bearer token for HQ access`)
          );
          logger.debug('Bearer authentication configured for HQ callbacks');
        }
      }

      // Send message to parent process if running as child (for testing)
      // Skip in vitest environment to avoid channel conflicts
      if (process.send && !process.env.VITEST) {
        process.send({ type: 'server-started', port: actualPort });
      }

      // Register with HQ if configured
      if (ctx.hqClient) {
        logger.log(`Registering with HQ at ${config.hqUrl}`);
        // Register immediately and keep retrying after each bounded request. If
        // this host is evicted while asleep, it rejoins after waking without a
        // Untether restart. See HQClient.startHeartbeat.
        ctx.hqClient.startHeartbeat();
      }

      // Start control directory watcher
      ctx.controlDirWatcher = new ControlDirWatcher({
        controlDir: CONTROL_DIR,
        remoteRegistry,
        isHQMode: config.isHQMode,
        hqClient: ctx.hqClient,
        ptyManager,
        pushNotificationService: pushNotificationService || undefined,
      });
      ctx.controlDirWatcher.start();
      logger.debug('Started control directory watcher');

      // Start mDNS advertisement if enabled
      if (shouldAdvertiseMDNS(config.enableMDNS, bindAddress)) {
        mdnsService.startAdvertising(actualPort).catch((err) => {
          logger.warn('Failed to start mDNS advertisement:', err);
        });
      } else {
        logger.debug('mDNS advertisement disabled (by option, or listening on loopback only)');
      }
    });
  };
  return startServer;
}
