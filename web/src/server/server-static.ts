// The web client: static files, index.html and its client-side routes, /api/health.
import express from 'express';
import * as path from 'path';
import { SHELL_VERSION_URL } from '../shared/shell-version.js';
import type { AuthenticatedRequest } from './middleware/auth.js';
import { createShareViewRoutes } from './routes/share.js';
import type { AppContext } from './server-context.js';
import { tailscaleServeService } from './services/tailscale-serve-service.js';
import { APP_CSP, CSP_HEADER } from './utils/csp.js';
import { createLogger } from './utils/logger.js';
import { IndexHtml, LookVersions, ShellVersion } from './utils/shell-version.js';
import { staticCacheControl } from './utils/static-cache.js';
import { getVersionInfo } from './version.js';

let tailnetName: { at: number; name: string | undefined } | undefined;
/** This Mac's tailnet name is asked for at most this often. */
const TAILNET_NAME_TTL_MS = 60_000;

/**
 * This Mac's name in its tailnet (`tailscale status --json`, Self.DNSName), remembered for a
 * minute. 2026-11-10: /api/health ran it with execFileSync and no timeout on every request
 * (the Mac app polls every 15 s, and the route needs no login): the event loop stood still for
 * each call, and for good when tailscaled did not answer.
 */
export async function tailnetDnsName(
  executable: string,
  now: () => number = Date.now
): Promise<string | undefined> {
  if (tailnetName && now() - tailnetName.at < TAILNET_NAME_TTL_MS) return tailnetName.name;
  const { execFile } = await import('child_process');
  const name = await new Promise<string | undefined>((resolve) => {
    execFile(
      executable,
      ['status', '--json'],
      { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(undefined);
        try {
          const dnsName = (JSON.parse(stdout) as { Self?: { DNSName?: string } }).Self?.DNSName;
          // Without its trailing dot.
          resolve(dnsName ? dnsName.replace(/\.$/, '') : undefined);
        } catch {
          resolve(undefined);
        }
      }
    );
  });
  tailnetName = { at: now(), name };
  return name;
}

const logger = createLogger('server');

interface TailscaleConnectionInfo {
  available: boolean;
  isRunning: boolean;
  httpsAvailable: boolean;
  isPublic: boolean;
  funnel: boolean;
  mode: string;
  hostname?: string;
  httpsUrl?: string;
}

export interface ConnectionInfo {
  http: {
    port: number | null;
    url: string;
  };
  tailscale?: TailscaleConnectionInfo;
  sslAvailable?: boolean;
  isPublic?: boolean;
  tailscaleUrl?: string;
}

export function setupStatic(ctx: AppContext) {
  const { app } = ctx;
  // Serve static files with .html extension handling and caching headers
  // In production/bundled mode, use the package directory; in development, use cwd
  const getPublicPath = () => {
    // First check if BUILD_PUBLIC_PATH is set (used by Mac app bundle)
    if (process.env.BUILD_PUBLIC_PATH) {
      logger.info(`Using BUILD_PUBLIC_PATH: ${process.env.BUILD_PUBLIC_PATH}`);
      return process.env.BUILD_PUBLIC_PATH;
    }
    // More precise npm package detection:
    // 1. Check if we're explicitly in an npm package structure
    // 2. The file should be in node_modules/untether/lib/
    // 3. Or check for our specific package markers
    const isNpmPackage = (() => {
      // Most reliable: check if we're in node_modules/untether structure
      if (__filename.includes(path.join('node_modules', 'untether', 'lib'))) {
        return true;
      }

      // Secondary check: if we're in a lib directory, verify it's actually an npm package
      // by checking for the existence of package.json in the parent directory
      if (path.basename(__dirname) === 'lib') {
        const parentDir = path.dirname(__dirname);
        const packageJsonPath = path.join(parentDir, 'package.json');
        try {
          const packageJson = require(packageJsonPath);
          // Verify this is actually our package
          return packageJson.name === 'untether';
        } catch {
          // Not a valid npm package structure
          return false;
        }
      }

      return false;
    })();

    if (process.env.UNTETHER_BUNDLED === 'true' || process.env.BUILD_DATE || isNpmPackage) {
      // In bundled/production/npm mode, find package root
      // When bundled, __dirname is /path/to/package/dist, so go up one level
      // When globally installed, we need to find the package root
      let packageRoot = __dirname;

      // If we're in the dist directory, go up one level
      if (path.basename(packageRoot) === 'dist') {
        packageRoot = path.dirname(packageRoot);
      }

      // For npm package context, if we're in lib directory, go up one level
      if (path.basename(packageRoot) === 'lib') {
        packageRoot = path.dirname(packageRoot);
      }

      // Look for package.json to confirm we're in the right place
      const publicPath = path.join(packageRoot, 'public');
      const indexPath = path.join(publicPath, 'index.html');

      // If index.html exists, we found the right path
      if (require('fs').existsSync(indexPath)) {
        return publicPath;
      }

      // Fallback: try going up from the bundled CLI location
      // The bundled CLI might be in node_modules/untether/dist/
      return path.join(__dirname, '..', 'public');
    } else {
      // In development mode, use current working directory
      return path.join(process.cwd(), 'public');
    }
  };

  const publicPath = getPublicPath();
  const isDevelopment = !process.env.BUILD_DATE || process.env.NODE_ENV === 'development';

  // The client's shell as one version (utils/shell-version.ts, 2026-10-04): index.html names it
  // in its asset URLs (`?v=<id>`) and the service worker caches and serves it whole.
  const shellVersion = new ShellVersion(publicPath, (manifest) => {
    const { js, css } = manifest.build;
    logger.warn(
      js && css && js !== css
        ? `client shell: bundle build ${js} with stylesheet build ${css}; phones keep the previous version until the stylesheet is rebuilt (is the CSS watcher running?)`
        : 'client shell: a chunk the bundle imports is missing; phones keep the previous version'
    );
  });
  const indexHtml = new IndexHtml(
    path.join(publicPath, 'index.html'),
    shellVersion,
    () => ctx.configService?.getConfig().look,
    new LookVersions(publicPath)
  );
  app.get(SHELL_VERSION_URL, async (_req, res, next) => {
    try {
      const manifest = await shellVersion.settled();
      res.setHeader('Cache-Control', 'no-cache');
      if (!manifest) {
        res.status(404).json({ error: 'no client build' });
        return;
      }
      res.json(manifest);
    } catch (error) {
      next(error);
    }
  });
  // The app's page (also for its client-side routes below), with the report-only CSP. Never
  // cached by the browser: it names the shell version to load.
  const sendIndexHtml = async (res: express.Response) => {
    let html: string;
    try {
      html = await indexHtml.render();
    } catch (error) {
      logger.warn('index.html could not be rendered:', error);
      res.status(404).send('404 - Page not found');
      return;
    }
    res.setHeader(CSP_HEADER, APP_CSP);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  };
  app.get(['/', '/index.html'], (_req, res) => {
    void sendIndexHtml(res);
  });

  app.use(
    express.static(publicPath, {
      extensions: ['html'], // This allows /logs to resolve to /logs.html
      maxAge: isDevelopment ? 0 : '1d',
      // Cache-Control per file: see utils/static-cache.ts.
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        // Report-only Content-Security-Policy on the app's pages (utils/csp.ts); not on the
        // manual test pages under test/, whose inline scripts would only add report noise.
        if (filePath.endsWith('.html') && !filePath.includes(`${path.sep}test${path.sep}`)) {
          res.setHeader(CSP_HEADER, APP_CSP);
        }
        const cacheControl = staticCacheControl(filePath, isDevelopment);
        if (cacheControl) res.setHeader('Cache-Control', cacheControl);
      },
    })
  );
  logger.debug(
    `Serving static files from: ${publicPath} ${isDevelopment ? 'with revalidation on every request (dev mode)' : 'with caching headers'}`
  );

  return { publicPath, isDevelopment, sendIndexHtml };
}

export function mountHealthRoute(ctx: AppContext) {
  const { app, config } = ctx;
  // Health check endpoint.
  //
  // 2026-11-08 (audit) + orchestrator decision: an unauthenticated probe gets liveness (`status`)
  // and the connection topology needed to DISCOVER how to connect — ports, and under
  // `connections.tailscale` the httpsAvailable / isPublic / httpsUrl / funnel flags plus the
  // top-level `tailscaleUrl`. Only the fingerprint (version, buildDate, uptime, pid, mode, and
  // the timestamp) is reserved for a signed-in caller.
  //
  // Those topology fields stay public ON PURPOSE: iOS probes /api/health UNAUTHENTICATED, before
  // it has any credential for the server, to decide whether to connect over HTTPS/Funnel —
  // `ServerListViewModel.checkServerHealth` / `probeAndUpdateServerCapabilities` read
  // `connections.tailscale.{httpsAvailable,isPublic,httpsUrl,funnel}` and `connections.{sslAvailable,isPublic}`,
  // and `TailscaleDiscoveryService.probeServer` reads `tailscaleUrl` and `connections.tailscale.{httpsUrl,funnel}`.
  // Gating them behind a session breaks that discovery (an earlier round did, and had to be
  // reverted) — do not re-gate them without first moving iOS discovery to an authenticated path.
  // Consumers that only check liveness read the status code (Mac `ServerManager.checkHealth`,
  // iOS `APIClient.checkHealth`, HQ `remote-registry`). The auth middleware annotated req with any
  // provable identity without rejecting (middleware/auth.ts).
  app.get('/api/health', async (req, res) => {
    const authed = Boolean(
      (req as AuthenticatedRequest).userId || (req as AuthenticatedRequest).authMethod
    );

    // Get connection information
    const connections: ConnectionInfo = {
      http: {
        port: config.port,
        url: `http://localhost:${config.port}`,
      },
    };

    let responseTailscaleUrl: string | undefined;

    // Check if Tailscale is enabled and get status
    if (config.enableTailscaleServe) {
      try {
        const tailscaleStatus = await tailscaleServeService.getStatus();

        // Get Tailscale hostname if available
        let tailscaleHostname: string | undefined;
        let tailscaleUrl: string | undefined;

        if (tailscaleStatus.isRunning && !tailscaleStatus.isPermanentlyDisabled) {
          try {
            // Get Tailscale hostname from status
            tailscaleHostname = await tailnetDnsName(
              await tailscaleServeService.getExecutablePath()
            );
            if (tailscaleHostname) tailscaleUrl = `https://${tailscaleHostname}`;
          } catch (error) {
            logger.debug('Failed to get Tailscale hostname:', error);
          }
        }

        // HTTPS is only available when Funnel (public mode) is enabled
        // In private mode, HTTPS doesn't work from mobile devices due to self-signed certs
        const httpsActuallyAvailable =
          tailscaleStatus.isRunning &&
          !tailscaleStatus.isPermanentlyDisabled &&
          (tailscaleStatus.funnelEnabled || false);
        const tailscaleAvailable =
          tailscaleStatus.isRunning && !tailscaleStatus.isPermanentlyDisabled;

        connections.tailscale = {
          available: tailscaleAvailable,
          isRunning: tailscaleStatus.isRunning,
          httpsAvailable: httpsActuallyAvailable,
          isPublic: tailscaleStatus.funnelEnabled || false,
          funnel: tailscaleStatus.funnelEnabled || false,
          mode: tailscaleStatus.actualMode || 'private',
          hostname: tailscaleHostname,
          httpsUrl: httpsActuallyAvailable ? tailscaleUrl : undefined,
        };
        connections.sslAvailable = httpsActuallyAvailable;
        connections.isPublic = tailscaleStatus.funnelEnabled || false;

        // Add the HTTPS URL at the top level for easy access only if actually available
        if (httpsActuallyAvailable && tailscaleUrl) {
          connections.tailscaleUrl = tailscaleUrl;
          responseTailscaleUrl = tailscaleUrl;
        }
      } catch (error) {
        logger.debug('Failed to get Tailscale status for health endpoint:', error);
        connections.tailscale = {
          available: false,
          isRunning: false,
          httpsAvailable: false,
          isPublic: false,
          funnel: false,
          mode: 'private',
        };
        connections.sslAvailable = false;
        connections.isPublic = false;
      }
    } else {
      connections.sslAvailable = false;
      connections.isPublic = false;
    }

    // Public to any probe: liveness + the connection topology discovery needs.
    const base = {
      status: 'healthy',
      connections,
      ...(responseTailscaleUrl ? { tailscaleUrl: responseTailscaleUrl } : {}),
    };
    if (!authed) {
      res.json(base);
      return;
    }

    // Signed-in only: the fingerprint.
    const versionInfo = getVersionInfo();
    res.json({
      ...base,
      timestamp: new Date().toISOString(),
      mode: config.isHQMode ? 'hq' : 'remote',
      version: versionInfo.version,
      buildDate: versionInfo.buildDate,
      uptime: versionInfo.uptime,
      pid: versionInfo.pid,
    });
  });
}

export function mountClientRoutes(ctx: AppContext) {
  const { app, publicPath, sendIndexHtml, shareRoutesConfig } = ctx;
  // Public read-only view of a shared session: its own small page, no login, no API.
  app.use(createShareViewRoutes(shareRoutesConfig));

  // index.html for client-side routes (but not API routes); `/` is served above, before the
  // static files.
  // Handle /session/:id routes by serving the same index.html
  app.get('/session/:id', (_req, res) => {
    void sendIndexHtml(res);
  });

  // Handle /worktrees route by serving the same index.html
  app.get('/worktrees', (_req, res) => {
    void sendIndexHtml(res);
  });

  // A dev-server preview as its own view (/preview/<id>). The guard above 404s the numeric
  // /preview/<port>/… paths, which belong to the preview origin.
  app.get('/preview/:id', (_req, res) => {
    void sendIndexHtml(res);
  });

  // Phone mission control (all agent sessions) is a client-side route too
  app.get('/agents', (_req, res) => {
    void sendIndexHtml(res);
  });

  // Handle /file-browser route by serving the same index.html
  app.get('/file-browser', (_req, res) => {
    void sendIndexHtml(res);
  });

  // 404 handler for all other routes
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'API endpoint not found' });
    } else {
      res.status(404).sendFile(path.join(publicPath, '404.html'), (err) => {
        if (err) {
          res.status(404).send('404 - Page not found');
        }
      });
    }
  });
}
