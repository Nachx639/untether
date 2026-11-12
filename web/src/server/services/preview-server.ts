/**
 * The preview listener: a second HTTP server in the Untether process, on its own port, so
 * previewed apps run on an origin of their own (2026-10-03, see preview-proxy.ts). It serves
 * the ticket login, `/preview/<port>/…` and its HMR sockets, and nothing else: no /api, no
 * Untether UI, no main-origin auth.
 */

import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import express from 'express';
import { guardUpgradeSocket } from '../middleware/ws-auth-reject.js';
import { CSP_REPORT_PATH } from '../utils/csp.js';
import { PREVIEW_LOGIN_PATH, type PreviewProxy, UNTETHER_SERVER_HEADER } from './preview-proxy.js';

/** Preview port from `--preview-port` / UNTETHER_PREVIEW_PORT ("off" disables), else main + 1. */
export function resolvePreviewPort(
  flag: string | null | undefined,
  env: string | undefined,
  mainPort: number
): { port: number | null; error?: string } {
  const raw = (flag ?? env ?? '').trim();
  if (raw === 'off' || raw === 'false') return { port: null };
  const port = raw ? Number(raw) : mainPort + 1;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { port: null, error: `invalid preview port: ${raw}` };
  }
  if (port === mainPort)
    return { port: null, error: 'preview port must differ from the main port' };
  return { port };
}

/**
 * True when a request to the MAIN origin comes from the preview origin (a previewed app
 * calling Untether's API with ambient credentials such as Tailscale identity headers).
 */
export function isFromPreviewOrigin(
  origin: string | undefined,
  previewPort: number | null,
  previewOrigin?: string | null
): boolean {
  if (!origin || origin === 'null') return false;
  try {
    const url = new URL(origin);
    if (previewOrigin && url.origin === previewOrigin) return true;
    if (!previewPort) return false;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return port === previewPort;
  } catch {
    return false;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Whether a browser's `Origin` names the host the request was sent to: its own Host header or,
 * behind a local proxy such as `tailscale serve`, X-Forwarded-Host (a browser cannot set that
 * header on a cross-origin request without a CORS preflight, which this server never grants).
 */
export function originMatchesHost(origin: string, headers: http.IncomingHttpHeaders): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  const originPort = url.port || defaultPort;
  const originHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const candidates = [
    headerValue(headers.host),
    ...(headerValue(headers['x-forwarded-host']) ?? '').split(','),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);
  return candidates.some((candidate) => {
    try {
      const host = new URL(`${url.protocol}//${candidate}`);
      return (
        host.hostname.toLowerCase().replace(/^\[|\]$/g, '') === originHost &&
        (host.port || defaultPort) === originPort
      );
    } catch {
      return false;
    }
  });
}

/**
 * Why a browser request to the MAIN origin's API must be refused, or null. Untether's own
 * UI only calls its API same-origin; a previewed app (same site, other port) must not reach
 * it with ambient credentials (Tailscale identity headers, local bypass). WebKit sends
 * `Origin: null` for a no-cors POST from the preview page (found 2026-10-03), so the Origin
 * port alone isn't enough: opaque origins and same-site/cross-site fetches are refused too.
 * Non-browser clients (ut, the Mac app, HQ) send neither header and are unaffected.
 */
export function foreignApiRequestReason(
  headers: http.IncomingHttpHeaders,
  previewPort: number | null,
  previewOrigin?: string | null,
  method?: string
): string | null {
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  if (isFromPreviewOrigin(origin, previewPort, previewOrigin)) return 'preview origin';
  if (origin === 'null') return 'opaque origin';
  const site = headers['sec-fetch-site'];
  if ((site === 'same-site' || site === 'cross-site') && headers['sec-fetch-mode'] !== 'navigate') {
    return `${site} request`;
  }
  // 2026-10-20 (security audit): browsers without Sec-Fetch-* (older Safari, embedded views)
  // could open /ws or POST cross-site, and a DNS-rebound page is "same-origin" to the
  // browser. A WebSocket upgrade or a state-changing request whose Origin is not the host
  // it was sent to is refused. Requests without Origin (ut, the Mac app, HQ) are unaffected.
  const upgrade = headerValue(headers.upgrade)?.toLowerCase() === 'websocket';
  const safeMethod = !method || /^(GET|HEAD|OPTIONS)$/i.test(method);
  if (origin && (upgrade || !safeMethod) && !originMatchesHost(origin, headers)) {
    return 'cross-origin request';
  }
  return null;
}

/**
 * Main-origin middleware: refuses foreign browser requests to /api (see above) and anything
 * from the preview origin, and answers 404 for `/preview/…` (previews used to live there;
 * old service workers' update checks then unregister). `/preview/<id>` is the app's own
 * preview view and is served like any client route.
 */
export function mainOriginPreviewGuard(
  getPreviewPort: () => number | null,
  previewOrigin?: string | null
): express.RequestHandler {
  return (req, res, next) => {
    // CSP reports: WebKit posts them no-cors with `Origin: null`, which the rule below
    // refuses; the endpoint takes no credentials and only logs a clipped line (utils/csp.ts).
    if (req.path === CSP_REPORT_PATH) {
      next();
      return;
    }
    // Express mounts /api case-insensitively, so /API and mixed-case paths need this guard too.
    const isApi = /^\/api(?:\/|$)/i.test(req.path);
    const reason = isApi
      ? foreignApiRequestReason(req.headers, getPreviewPort(), previewOrigin, req.method)
      : isFromPreviewOrigin(req.headers.origin, getPreviewPort(), previewOrigin)
        ? 'preview origin'
        : null;
    if (reason) {
      res.status(403).type('text/plain').send(`Forbidden (${reason})`);
      return;
    }
    // Old preview paths are /preview/<port>/…; /preview/<id> is the app's preview view (a
    // client-side route) and goes on.
    if (req.path === '/preview' || /^\/preview\/\d+(\/|$)/.test(req.path)) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    next();
  };
}

export function createPreviewApp(proxy: PreviewProxy): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Origin-Agent-Cluster', '?1');
    // Another Untether's proxy must recognize this origin and never preview it.
    res.setHeader(UNTETHER_SERVER_HEADER, '1');
    next();
  });
  app.get(PREVIEW_LOGIN_PATH, (req, res) => proxy.handleLogin(req, res));
  app.use(proxy.redirectStrayLoad);
  app.use((req, res, next) => {
    void proxy.handleRequest(req, res, next);
  });
  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  return app;
}

export function createPreviewServer(proxy: PreviewProxy): http.Server {
  const server = http.createServer(createPreviewApp(proxy));
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    guardUpgradeSocket(socket);
    void proxy.handleUpgrade(req, socket, head);
  });
  return server;
}
