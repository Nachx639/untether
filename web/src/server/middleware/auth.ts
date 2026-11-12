import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces, hostname as osHostname } from 'node:os';
import type { NextFunction, Request, Response } from 'express';
import { COPILOT_PATH } from '../../shared/copilot-protocol.js';
import type { AuthService } from '../services/auth-service.js';
import { isTrustedTailscaleProcess } from '../services/tailscale-peer.js';
import { findTailscaleExecutable } from '../services/tailscale-serve-service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('auth');

interface AuthConfig {
  enableSSHKeys: boolean;
  disallowUserPassword: boolean;
  noAuth: boolean;
  isHQMode: boolean;
  bearerToken?: string; // Token that HQ must use to authenticate with this remote
  authService?: AuthService; // Enhanced auth service for JWT tokens
  allowLocalBypass?: boolean; // Allow localhost connections to bypass auth
  localAuthToken?: string; // Token for localhost authentication
  allowTailscaleAuth?: boolean; // Allow Tailscale identity headers for authentication
  /** --unsafe-no-auth-on-network: no-auth also answers requests relayed by Tailscale. */
  noAuthOnNetwork?: boolean;
  /** Whether a request's TCP peer is Tailscale's proxy (tests replace the lsof lookup). */
  tailscalePeerCheck?: (req: Request) => Promise<boolean>;
  /** The Tailscale logins allowed to sign in (tests replace the `tailscale status` lookup). */
  tailscaleOwners?: () => Promise<string[]>;
}

/**
 * Whether a request came through Tailscale Serve or Funnel: its identity or Funnel headers, or
 * forwarding headers naming a *.ts.net host.
 */
export function isRelayedByTailscale(req: Pick<Request, 'headers'>): boolean {
  const headers = req.headers ?? {};
  if (headers['tailscale-user-login'] || headers['tailscale-funnel-request']) return true;
  const host = headers['x-forwarded-host'];
  const first = (Array.isArray(host) ? host[0] : host)?.split(',')[0]?.trim().toLowerCase();
  return !!first && /\.ts\.net(:\d+)?$/.test(first);
}

export interface AuthenticatedRequest extends Request {
  userId?: string;
  authMethod?: 'ssh-key' | 'password' | 'hq-bearer' | 'no-auth' | 'local-bypass' | 'tailscale';
  isHQRequest?: boolean;
  tailscaleUser?: TailscaleUser;
}

const loopbackAddresses = new Set(['127.0.0.1', '::1', 'localhost']);

export function normalizeAddress(address: string): string {
  const withoutBrackets =
    address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const withoutScope = withoutBrackets.split('%', 1)[0];
  return withoutScope.startsWith('::ffff:') ? withoutScope.slice(7) : withoutScope;
}

export function isLocalMachineAddress(address: string, interfaces = networkInterfaces()): boolean {
  const normalizedAddress = normalizeAddress(address);
  if (loopbackAddresses.has(normalizedAddress)) {
    return true;
  }

  const addressVersion = isIP(normalizedAddress);
  if (addressVersion === 0) {
    return false;
  }

  const localAddresses = new BlockList();
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      const localAddress = normalizeAddress(entry.address);
      const localAddressVersion = isIP(localAddress);
      if (localAddressVersion !== 0) {
        localAddresses.addAddress(localAddress, localAddressVersion === 4 ? 'ipv4' : 'ipv6');
      }
    }
  }

  return localAddresses.check(normalizedAddress, addressVersion === 4 ? 'ipv4' : 'ipv6');
}

// Helper function to check if request is from localhost or, with a valid token, this machine.
function isLocalRequest(req: Request, allowLocalInterface: boolean): boolean {
  const clientIp = req.socket.remoteAddress || '';
  const ipIsLocal =
    loopbackAddresses.has(normalizeAddress(clientIp)) ||
    (allowLocalInterface && isLocalMachineAddress(clientIp));

  // Additional security checks to prevent spoofing
  const noForwardedFor = !req.headers['x-forwarded-for'];
  const noRealIP = !req.headers['x-real-ip'];
  const noForwardedHost = !req.headers['x-forwarded-host'];

  // Check hostname
  const hostIsLocal =
    loopbackAddresses.has(normalizeAddress(req.hostname)) ||
    (allowLocalInterface && isLocalMachineAddress(req.hostname));

  logger.debug(
    `Local request check - IP: ${clientIp}, Host: ${req.hostname}, ` +
      `Forwarded headers: ${!noForwardedFor || !noRealIP || !noForwardedHost}`
  );

  return ipIsLocal && noForwardedFor && noRealIP && noForwardedHost && hostIsLocal;
}

// Helper function to check if request is from localhost (for reverse proxy scenarios)
function isFromLocalhostAddress(req: Request): boolean {
  const remoteAddr = req.socket.remoteAddress;
  return remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
}

// Type definition for Tailscale headers
interface TailscaleHeaders {
  'tailscale-user-login'?: string;
  'tailscale-user-name'?: string;
  'tailscale-user-profile-pic'?: string;
}

// Type for validated Tailscale user information
export interface TailscaleUser {
  login: string;
  name: string;
  profilePic?: string;
}

// Helper function to check if request has valid Tailscale headers
function getTailscaleUser(req: Request): TailscaleUser | null {
  // Type-safe header access
  const headers = req.headers as unknown as TailscaleHeaders;

  const login = headers['tailscale-user-login'];
  const name = headers['tailscale-user-name'];
  const profilePic = headers['tailscale-user-profile-pic'];

  // Must have at least login to be valid
  if (!login) {
    return null;
  }

  return {
    login,
    name: name || login, // Fallback to login if name not provided
    profilePic,
  };
}

/** Repeats of one unauthorized request within this window are counted, not logged each time. */
export const UNAUTHORIZED_LOG_WINDOW_MS = 60 * 60 * 1000;
const unauthorizedSeen = new Map<string, { at: number; repeats: number }>();

/**
 * The log line for a request refused for lack of credentials, or null when the same one
 * (method, path, address) was logged within the last hour: it is counted and the next line
 * says how many came meanwhile. 2026-10-03: Untether.app's git monitor asks for
 * /git/repo-info without credentials every ~10 min (fixed in its source, not yet in the
 * installed build), two ERROR lines each time in a log that now keeps earlier runs. Only
 * the logging is grouped: every such request is still refused.
 */
export function unauthorizedLogLine(
  method: string,
  path: string,
  ip: string | undefined,
  now = Date.now(),
  /** Who asked, so the next unexplained 401 can be traced: credential kind, user agent. */
  details?: string
): string | null {
  const key = `${method} ${path} ${ip ?? '?'}`;
  const seen = unauthorizedSeen.get(key);
  if (seen && now - seen.at < UNAUTHORIZED_LOG_WINDOW_MS) {
    seen.repeats++;
    return null;
  }
  if (unauthorizedSeen.size >= 500) unauthorizedSeen.clear();
  unauthorizedSeen.set(key, { at: now, repeats: 0 });
  const meanwhile = seen?.repeats ? ` (${seen.repeats} more like it since the last line)` : '';
  return `Unauthorized request to ${method} ${path} from ${ip}${details ? ` [${details}]` : ''}${meanwhile}`;
}

/** The 401 body for a token that was sent but is expired or invalid: log in again. */
export const TOKEN_INVALID_ERROR = 'token_invalid';

const invalidTokenSeen = new Map<string, { at: number; repeats: number }>();

/**
 * The log line for a rejected (expired, invalid) token, or null when this client (address and
 * user agent) had one logged within the last hour; the next line says how many came meanwhile.
 * 2026-10-20: a device with a dead token reconnected its WebSocket every ~30 s all day,
 * "Invalid query token" ~116 lines an hour in ~/.untether/log.txt.
 */
export function invalidTokenLogLine(
  kind: 'query' | 'bearer',
  ip: string | undefined,
  userAgent: string | undefined,
  now = Date.now()
): string | null {
  const agent = (userAgent ?? '-').slice(0, 120);
  const key = `${kind} ${ip ?? '?'} ${agent}`;
  const seen = invalidTokenSeen.get(key);
  if (seen && now - seen.at < UNAUTHORIZED_LOG_WINDOW_MS) {
    seen.repeats++;
    return null;
  }
  if (invalidTokenSeen.size >= 500) invalidTokenSeen.clear();
  invalidTokenSeen.set(key, { at: now, repeats: 0 });
  const meanwhile = seen?.repeats ? ` (${seen.repeats} more since the last line)` : '';
  return `Invalid ${kind === 'query' ? 'query' : 'JWT'} token from ${ip ?? '?'} [user-agent: ${agent}]${meanwhile}`;
}

/**
 * One TCP connection as `lsof -F pcn` lists it: the process and the connection's
 * `local->remote` addresses.
 */
export interface LsofSocket {
  pid: number;
  command: string;
  local: { host: string; port: number };
  remote: { host: string; port: number };
}

/** Parses `lsof -nP -F pcn` output into its TCP connections. */
export function parseLsofSockets(output: string): LsofSocket[] {
  const sockets: LsofSocket[] = [];
  let pid = 0;
  let command = '';
  const endpoint = (text: string) => {
    const at = text.lastIndexOf(':');
    return { host: text.slice(0, at).replace(/^\[|\]$/g, ''), port: Number(text.slice(at + 1)) };
  };
  for (const line of output.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      pid = Number(value);
      command = '';
    } else if (tag === 'c') {
      command = value;
    } else if (tag === 'n' && value.includes('->')) {
      const [local, remote] = value.split('->');
      sockets.push({ pid, command, local: endpoint(local), remote: endpoint(remote) });
    }
  }
  return sockets;
}

/** Process names Tailscale's proxy runs as (lsof truncates names to 15 characters). */
const TAILSCALE_PROCESS = /tailscale|ipnextension/i;

/**
 * Whether the loopback connection `peerPort → serverPort` is a Tailscale candidate, given
 * `lsof` output for that port. Both our end and a Tailscale peer must be visible: an
 * invisible peer could be any other local user's process, not just the root-owned proxy.
 * Process names are only a filter: verifyTailscalePeer must also verify the peer's owner
 * and executable before trusting any identity headers.
 */
export function isTailscalePeer(
  sockets: LsofSocket[],
  serverPort: number,
  peerPort: number,
  ownPid = process.pid
): boolean {
  const ownEnd = sockets.some(
    (s) => s.pid === ownPid && s.local.port === serverPort && s.remote.port === peerPort
  );
  if (!ownEnd) return false;
  // The client end, whoever holds it (this process too: a request we sent ourselves).
  const peers = sockets.filter((s) => s.local.port === peerPort && s.remote.port === serverPort);
  return peers.length > 0 && peers.every((s) => TAILSCALE_PROCESS.test(s.command));
}

const LSOF = existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';

function lsofPort(port: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      LSOF,
      ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpcn'],
      { timeout: 3000, maxBuffer: 1024 * 1024 },
      // lsof exits 1 when it lists nothing; whatever it printed is still parsed.
      (_error, stdout) => resolve(typeof stdout === 'string' ? stdout : '')
    );
  });
}

const tailscalePeerVerdicts = new WeakMap<object, { verdict: Promise<boolean> }>();

/**
 * How long a refused lsof verdict stays cached for a connection.
 * 2026-10-20: a single failed lsof (timeout under load, transient empty listing) was cached for
 * the whole keep-alive connection, so every later request on it was refused. Only "yes" is kept
 * for the connection's life; "no" is re-checked after a few seconds.
 */
export const TAILSCALE_PEER_NEGATIVE_TTL_MS = 5_000;

/**
 * Whether this request's connection really comes from `tailscale serve` (cached per socket:
 * one lsof per proxied connection, not per request).
 * 2026-10-20 (security audit): Tailscale-User-Login was trusted from any 127.0.0.1 connection
 * that also sent X-Forwarded-* headers, so any local process (or a browser page able to send
 * those headers) could sign in as the owner and mint a token at /api/auth/tailscale-token.
 * `tailscale serve` cannot add a secret header, and `tailscale whois` on X-Forwarded-For only
 * checks headers the forger also chooses. A socket match alone is insufficient: process
 * names are forgeable, so the owner's identity and executable signature or protection are
 * checked too.
 */
export function verifyTailscalePeer(req: Request): Promise<boolean> {
  const socket = req.socket as (Request['socket'] & object) | undefined;
  if (!socket) return Promise.resolve(false);
  const cached = tailscalePeerVerdicts.get(socket);
  if (cached) return cached.verdict;
  const serverPort = socket.localPort;
  const peerPort = socket.remotePort;
  const verdict =
    serverPort && peerPort
      ? lsofPort(peerPort)
          .then(async (out) => {
            const sockets = parseLsofSockets(out);
            if (!isTailscalePeer(sockets, serverPort, peerPort)) return false;
            const peers = sockets.filter(
              (s) => s.local.port === peerPort && s.remote.port === serverPort
            );
            const trusted = await Promise.all(
              [...new Set(peers.map((s) => s.pid))].map(isTrustedTailscaleProcess)
            );
            return trusted.every(Boolean);
          })
          .catch(() => false)
      : Promise.resolve(false);
  const entry = { verdict };
  tailscalePeerVerdicts.set(socket, entry);
  void verdict.then((ok) => {
    if (ok) return;
    // Negative verdicts expire (see TAILSCALE_PEER_NEGATIVE_TTL_MS).
    const timer = setTimeout(() => {
      if (tailscalePeerVerdicts.get(socket) === entry) tailscalePeerVerdicts.delete(socket);
    }, TAILSCALE_PEER_NEGATIVE_TTL_MS);
    timer.unref?.();
  });
  return verdict;
}

/**
 * The Tailscale user of a request proxied by `tailscale serve`, or why it is refused.
 * Null when the request carries no Tailscale identity.
 */
async function tailscaleIdentity(
  req: Request,
  config: AuthConfig
): Promise<{ user: TailscaleUser } | { refused: string } | null> {
  const tailscaleUser = getTailscaleUser(req);
  if (!tailscaleUser) return null;
  // Security check: Ensure request is from localhost (Tailscale Serve proxy)
  if (!isFromLocalhostAddress(req)) {
    logger.warn(
      `Tailscale headers present but request not from localhost: ${req.socket.remoteAddress}`
    );
    return { refused: 'Invalid request origin' };
  }
  // Additional check: Verify proxy headers exist
  const hasProxyHeaders = !!(
    req.headers['x-forwarded-proto'] &&
    req.headers['x-forwarded-for'] &&
    req.headers['x-forwarded-host']
  );
  if (!hasProxyHeaders) {
    logger.warn('Tailscale headers present but missing proxy headers');
    return { refused: 'Invalid proxy configuration' };
  }
  const peerCheck = config.tailscalePeerCheck ?? verifyTailscalePeer;
  if (!(await peerCheck(req).catch(() => false))) {
    const line = unauthorizedLogLine('TAILSCALE', req.path, req.socket.remoteAddress);
    if (line) logger.warn(`${line}: identity headers not sent by Tailscale's proxy`);
    return { refused: 'Unverified Tailscale proxy' };
  }
  const owners = await (config.tailscaleOwners ?? tailscaleOwnerLogins)().catch(() => []);
  const login = tailscaleUser.login.toLowerCase();
  if (!owners.some((owner) => owner.toLowerCase() === login)) {
    logger.warn(`Refused Tailscale identity ${tailscaleUser.login}: not this Mac's owner`);
    return { refused: "Tailscale user is not this Mac's owner" };
  }
  return { user: tailscaleUser };
}

/** The login of this Mac's Tailscale user in `tailscale status --json` (Self.UserID). */
export function ownerLoginFromStatus(json: string): string | null {
  try {
    const status = JSON.parse(json) as {
      Self?: { UserID?: number | string };
      User?: Record<string, { LoginName?: string }>;
    };
    const id = status.Self?.UserID;
    const login = id === undefined ? undefined : status.User?.[String(id)]?.LoginName;
    return typeof login === 'string' && login ? login : null;
  } catch {
    return null;
  }
}

const OWNER_CACHE_MS = 5 * 60_000;
let ownerCache: { logins: string[]; at: number } | undefined;

/**
 * Who may sign in through Tailscale Serve: UNTETHER_TAILSCALE_LOGINS (comma list) if set,
 * otherwise the Mac's own Tailscale user. Empty (everyone refused) when neither is known.
 * 2026-10-29 (security sweep): any login of the tailnet (a relative, a guest, a device shared
 * from another tailnet) was signed in as the owner and could mint a token at
 * /api/auth/tailscale-token, i.e. run commands on this Mac.
 */
async function tailscaleOwnerLogins(): Promise<string[]> {
  const configured = (process.env.UNTETHER_TAILSCALE_LOGINS ?? '')
    .split(',')
    .map((login) => login.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  if (ownerCache && Date.now() - ownerCache.at < OWNER_CACHE_MS) return ownerCache.logins;
  const bin = await findTailscaleExecutable();
  if (!bin) return [];
  const stdout = await new Promise<string>((resolve) => {
    execFile(bin, ['status', '--json'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (_e, out) =>
      resolve(typeof out === 'string' ? out : '')
    );
  });
  const owner = ownerLoginFromStatus(stdout);
  if (!owner) return [];
  // Only a known owner is cached: a failed lookup is retried on the next request.
  ownerCache = { logins: [owner], at: Date.now() };
  return ownerCache.logins;
}

/**
 * Routes that answer without a login, by exact path (relative to /api). 2026-10-20 (audit):
 * `req.path.startsWith('/auth')` exempted any future /auth* route (and /authority…).
 * 2026-10-04: the whole of /logs and /push used to be open, so anyone who could reach the
 * server could read the server log or subscribe their own push endpoint. 2026-10-20:
 * POST /logs/client needs a login too (the client only sends logs signed in or in no-auth).
 * 2026-11-08 (audit): /auth/current-user and /auth/avatar/:id left the Mac's account name
 * and profile photo open to any tailnet/LAN peer. Both need a login now; the sign-in screen
 * no longer depends on them (the server derives the owner for password/SSH, see routes/auth.ts)
 * and an already-authenticated owner (Tailscale, no-auth, token) still reaches them.
 */
const PUBLIC_AUTH_ROUTES = new Set([
  '/auth/challenge',
  '/auth/ssh-key',
  '/auth/password',
  '/auth/verify',
  '/auth/config',
  '/auth/tailscale-token',
  '/auth/logout',
]);

export function isPublicAuthRoute(path: string): boolean {
  return PUBLIC_AUTH_ROUTES.has(path);
}

/**
 * GET /api/health answers without a login: liveness and the connection topology that discovery
 * needs stay public (iOS probes it unauthenticated to find HTTPS/Funnel; see server-static.ts),
 * but the version/build/uptime/pid/mode fingerprint is shown only to a signed-in caller. This
 * annotates the request with the identity when one can be proven and never rejects. Mirrors
 * authenticate()'s accept paths; there is no WebSocket query token (health is not an upgrade).
 * 2026-11-08 (audit): health used to hand its full fingerprint to anyone who could reach the
 * server.
 */
async function annotateHealthIdentity(
  req: AuthenticatedRequest,
  config: AuthConfig
): Promise<void> {
  if (config.noAuth) {
    // A no-auth server is for this Mac only: a local, non-relayed request is the owner.
    if (!isRelayedByTailscale(req) && isAllowedNoAuthHost(req.headers?.host)) {
      req.authMethod = 'no-auth';
      req.userId = 'no-auth-user';
    }
    return;
  }
  if (config.allowTailscaleAuth) {
    const identity = await tailscaleIdentity(req, config);
    if (identity && 'user' in identity) {
      req.authMethod = 'tailscale';
      req.userId = identity.user.login;
      req.tailscaleUser = identity.user;
      return;
    }
  }
  const providedLocalToken = req.headers['x-untether-local'];
  const hasValidLocalToken =
    typeof providedLocalToken === 'string' &&
    Boolean(config.localAuthToken) &&
    providedLocalToken === config.localAuthToken;
  if (config.allowLocalBypass && hasValidLocalToken && isLocalRequest(req, true)) {
    req.authMethod = 'local-bypass';
    req.userId = 'local-user';
    return;
  }
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (config.bearerToken && token === config.bearerToken) {
      req.authMethod = 'hq-bearer';
      req.isHQRequest = config.isHQMode;
      return;
    }
    if (config.authService) {
      const verification = config.authService.verifyToken(token);
      if (verification.valid && verification.userId) {
        req.userId = verification.userId;
        req.authMethod = config.enableSSHKeys ? 'ssh-key' : 'password';
      }
    }
  }
}

/** Extra host names an unauthenticated server answers to (UNTETHER_ALLOWED_HOSTS, comma list). */
function allowedHostsFromEnv(): string[] {
  return (process.env.UNTETHER_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** The host name of a Host header value, lowercased, without port or trailing dot. */
export function hostHeaderName(host: string): string {
  const value = host.trim().toLowerCase();
  const name = value.startsWith('[')
    ? value.slice(1, value.indexOf(']') > 0 ? value.indexOf(']') : undefined)
    : value.split(':').length === 2
      ? value.split(':')[0]
      : value;
  return name.replace(/\.$/, '');
}

/**
 * Whether an unauthenticated server should answer a request for `host`: IP literals,
 * localhost, this computer's names, Tailscale MagicDNS names and UNTETHER_ALLOWED_HOSTS.
 * 2026-10-20 (security audit): DNS rebinding (attacker.example resolving to 127.0.0.1) let
 * any web page drive a --no-auth server; such a request carries the attacker's Host name.
 */
export function isAllowedNoAuthHost(
  host: string | undefined,
  extra: string[] = allowedHostsFromEnv(),
  machineName = osHostname()
): boolean {
  if (!host) return true; // HTTP/1.0 clients; every browser sends Host.
  const name = hostHeaderName(host);
  if (!name) return false;
  if (isIP(name) !== 0) return true;
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name.endsWith('.ts.net')) return true;
  const machine = machineName.toLowerCase().replace(/\.$/, '');
  const short = machine.split('.')[0];
  if (name === machine || name === short || name === `${short}.local`) return true;
  return extra.includes(name);
}

/** WebSocket upgrades are the only requests that may carry their token in `?token=`. */
function acceptsQueryToken(req: Request): boolean {
  const upgrade = req.headers?.upgrade;
  return (
    typeof upgrade === 'string' &&
    upgrade.toLowerCase() === 'websocket' &&
    (req.path === '/ws' || req.path === COPILOT_PATH)
  );
}

export function createAuthMiddleware(config: AuthConfig) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await authenticate(req, res, next);
    } catch (error) {
      logger.error('Auth middleware error:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Authentication failed' });
    }
  };

  async function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    // Health is public but only shows its detail to a signed-in caller: annotate identity when
    // provable, never reject. Handled before the no-auth/Host/relay guards so a plain discovery
    // probe still gets the minimal body (server-static.ts decides minimal vs. detail).
    if (req.path === '/health') {
      await annotateHealthIdentity(req, config);
      return next();
    }

    // Skip auth for the sign-in routes and Tailscale status: an explicit list (see above).
    if (isPublicAuthRoute(req.path) || req.path === '/sessions/tailscale/status') {
      // Special case: If Tailscale auth is enabled and we have valid headers,
      // set the auth info even for /auth endpoints so the client knows we're authenticated
      if (config.allowTailscaleAuth && req.path !== '/sessions/tailscale/status') {
        const identity = await tailscaleIdentity(req, config);
        if (identity && 'user' in identity) {
          req.authMethod = 'tailscale';
          req.userId = identity.user.login;
          req.tailscaleUser = identity.user;
        }
      }
      return next();
    }

    // If no auth is required, allow all requests
    if (config.noAuth) {
      // DNS rebinding: a page on attacker.example resolved to 127.0.0.1 is same-origin to the
      // browser, but its Host header still names attacker.example (2026-10-20, audit).
      if (!isAllowedNoAuthHost(req.headers?.host)) {
        logger.warn(`Refused unauthenticated request for unknown Host: ${req.headers?.host}`);
        return res.status(403).json({ error: 'Unknown host' });
      }
      // A request relayed by Tailscale Serve/Funnel: a route left over from an earlier server
      // (2026-10-20) would otherwise hand the tailnet, or the internet, an unauthenticated shell.
      if (!config.noAuthOnNetwork && isRelayedByTailscale(req)) {
        logger.warn('Refused unauthenticated request relayed by Tailscale Serve/Funnel');
        return res.status(403).json({ error: 'Sign-in is off: this server is for this Mac only' });
      }
      req.authMethod = 'no-auth';
      req.userId = 'no-auth-user'; // Set a default user ID for no-auth mode
      return next();
    }

    // Why a Tailscale identity was refused, reported if nothing else authenticates the request.
    let tailscaleRefusal: string | undefined;

    // Check for Tailscale authentication if enabled
    if (config.allowTailscaleAuth) {
      const identity = await tailscaleIdentity(req, config);
      // 2026-10-20: a refused Tailscale identity (lsof check failed, odd proxy headers) used to
      // answer 401 at once, locking out a phone that also carried a valid bearer token. The
      // identity is simply not used; the request goes on to the token checks below.
      if (identity && 'refused' in identity) {
        tailscaleRefusal = identity.refused;
      } else if (identity) {
        const tailscaleUser = identity.user;
        // Log Tailscale authentication
        logger.info(`Tailscale authentication successful for user: ${tailscaleUser.login}`);
        logger.info(
          `User details - Name: ${tailscaleUser.name}, Has profile pic: ${!!tailscaleUser.profilePic}`
        );

        req.authMethod = 'tailscale';
        req.userId = tailscaleUser.login;
        req.tailscaleUser = tailscaleUser;
        return next();
      }
    }

    // Check for local bypass if enabled
    const providedLocalToken = req.headers['x-untether-local'];
    const hasValidLocalToken =
      typeof providedLocalToken === 'string' &&
      Boolean(config.localAuthToken) &&
      providedLocalToken === config.localAuthToken;

    // Fails closed (2026-10-27): without a configured token no local request bypasses the
    // login; it used to let every local process in when the token went missing.
    if (config.allowLocalBypass && isLocalRequest(req, hasValidLocalToken)) {
      if (hasValidLocalToken) {
        logger.debug('Local request authenticated with token');
        req.authMethod = 'local-bypass';
        req.userId = 'local-user';
        return next();
      }
      logger.debug(
        config.localAuthToken
          ? 'Local request missing or invalid token'
          : 'Local bypass refused: no local auth token configured'
      );
    }

    // Only log auth requests that might be problematic (no header or failures)
    // Remove verbose logging for successful token auth to reduce spam

    const authHeader = req.headers.authorization;
    // `?token=` only for WebSocket upgrades (browsers cannot set headers there): in any
    // other URL it ends up in logs, history and Referer (2026-10-20, audit).
    const tokenQuery =
      acceptsQueryToken(req) && typeof req.query?.token === 'string' ? req.query.token : undefined;

    // A token was sent and refused (expired, signed by another key): the answer says so
    // (TOKEN_INVALID_ERROR, WebSocket close 4401) so the client logs in again instead of
    // retrying the same token forever.
    let tokenRejected = false;
    const logInvalidToken = (kind: 'query' | 'bearer') => {
      tokenRejected = true;
      const line = invalidTokenLogLine(kind, req.ip, req.headers?.['user-agent']);
      if (line) logger.error(line);
    };

    // Check for Bearer token
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);

      // In HQ mode, check if this is a valid HQ-to-remote bearer token
      if (config.isHQMode && config.bearerToken && token === config.bearerToken) {
        logger.debug('Valid HQ bearer token authentication');
        req.isHQRequest = true;
        req.authMethod = 'hq-bearer';
        return next();
      }

      // If we have enhanced auth service and SSH keys are enabled, try JWT token validation
      if (config.authService && config.enableSSHKeys) {
        const verification = config.authService.verifyToken(token);
        if (verification.valid && verification.userId) {
          req.userId = verification.userId;
          req.authMethod = 'ssh-key'; // JWT tokens are issued for SSH key auth
          return next();
        }
      } else if (config.authService) {
        const verification = config.authService.verifyToken(token);
        if (verification.valid && verification.userId) {
          req.userId = verification.userId;
          req.authMethod = 'password'; // Password auth only
          return next();
        }
      }

      // For non-HQ mode, check if bearer token matches remote expectation
      if (!config.isHQMode && config.bearerToken && token === config.bearerToken) {
        logger.debug('Valid remote bearer token authentication');
        req.authMethod = 'hq-bearer';
        return next();
      }

      logInvalidToken('bearer');
    }

    // Check for token in query parameter (WebSocket v3 + other non-header clients)
    if (tokenQuery && config.authService) {
      const verification = config.authService.verifyToken(tokenQuery);
      if (verification.valid && verification.userId) {
        logger.debug(`Valid query token for user: ${verification.userId}`);
        req.userId = verification.userId;
        req.authMethod = config.enableSSHKeys ? 'ssh-key' : 'password';
        return next();
      }
      logInvalidToken('query');
    }

    if (tokenRejected) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="Untether", error="invalid_token"');
      res.status(401).json({ error: TOKEN_INVALID_ERROR });
      return;
    }

    // No valid auth provided
    const authorization = req.headers.authorization;
    const credential = !authorization
      ? 'no credentials'
      : authorization.startsWith('Bearer ')
        ? 'bearer token not accepted'
        : 'unsupported credentials';
    const line = unauthorizedLogLine(
      req.method,
      req.path,
      req.ip,
      Date.now(),
      `${credential}; user-agent: ${(req.headers?.['user-agent'] ?? '-').slice(0, 120)}`
    );
    if (line) logger.error(line);
    res.setHeader('WWW-Authenticate', 'Bearer realm="Untether"');
    res.status(401).json({ error: tailscaleRefusal ?? 'Authentication required' });
  }
}
