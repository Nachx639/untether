import { execFile as execFileCallback } from 'child_process';
import type { Request, Response } from 'express';
import { Router } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type { AuthenticatedRequest, TailscaleUser } from '../middleware/auth.js';
import { normalizeAddress } from '../middleware/auth.js';
import {
  type AuthService,
  isServerOwner,
  LoginThrottle,
  serverOwnerUsername,
} from '../services/auth-service.js';

const execFileAsync = promisify(execFileCallback);

interface AuthRoutesConfig {
  authService: AuthService;
  enableSSHKeys?: boolean;
  disallowUserPassword?: boolean;
  noAuth?: boolean;
  /** Backoff for password and SSH key sign-in (tests pass their own clock). */
  loginThrottle?: LoginThrottle;
  /** Backoff for SSH challenges: generous, they are cheap now but unauthenticated. */
  challengeThrottle?: LoginThrottle;
}

/** Loopback peers: where `tailscale serve` / Funnel (and any proxy on this Mac) connect from. */
const LOOPBACK_PROXIES = ['127.0.0.1', '::1'];

/**
 * Addresses whose X-Forwarded-For we trust: loopback (the proxy `tailscale serve` runs on this
 * Mac) plus UNTETHER_TRUSTED_PROXIES (comma list of exact addresses, opt-in) for a proxy on
 * another host. Any other peer's X-Forwarded-For is ignored.
 *
 * 2026-11-08 (second review): the first audit fix trusted nobody by default, so every request
 * relayed by Serve/Funnel was keyed `127.0.0.1`. That put the owner's phone and every internet
 * client in ONE backoff bucket (anyone failing a few passwords locked the owner out for up to
 * 15 min) and, being loopback, exempt from the global limit. Loopback stays trusted; the hop
 * read is the last one, the one the proxy itself wrote (see loginClientKey).
 */
export function trustedProxyAddresses(value = process.env.UNTETHER_TRUSTED_PROXIES): Set<string> {
  return new Set(
    [...LOOPBACK_PROXIES, ...(value ?? '').split(',')]
      .map((entry) => normalizeAddress(entry.trim()))
      .filter(Boolean)
  );
}

/**
 * Who is signing in, for the backoff bucket: the TCP peer address, unless that peer is a
 * trusted proxy (loopback or UNTETHER_TRUSTED_PROXIES) — then the last X-Forwarded-For hop that
 * is not itself a trusted proxy, i.e. the client the proxy forwarded for. Hops to its left were
 * written by the client and are never read, so a forged header cannot rotate buckets: a proxy
 * that replaces the header (`tailscale serve`) leaves exactly the client, one that appends
 * leaves the client last. 2026-11-08 (audit): it used to trust the FIRST hop from any loopback
 * peer. The global limit still applies on top (`fwd:` keys are never exempt). This is the one
 * function that reads a forwarding header for identity/limits; everything else uses the socket
 * address or presence-only checks.
 */
export function loginClientKey(req: Request, trusted = trustedProxyAddresses()): string {
  const remote = normalizeAddress(req.socket?.remoteAddress ?? '') || 'unknown';
  if (!trusted.has(remote)) return remote;
  const forwarded = getHeaderValue(req.headers['x-forwarded-for']);
  const hops = (forwarded ?? '')
    .split(',')
    .map((hop) => normalizeAddress(hop.trim()))
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trusted.has(hops[i])) return `fwd:${hops[i].slice(0, 64)}`;
  }
  return remote;
}

/** Answers 429 when `client` must wait, true when it may try now. */
function throttled(throttle: LoginThrottle, client: string, res: Response): boolean {
  const waitMs = throttle.retryAfterMs(client);
  if (waitMs <= 0) return false;
  const seconds = Math.ceil(waitMs / 1000);
  res.setHeader('Retry-After', String(seconds));
  res.status(429).json({
    success: false,
    error: `Too many failed attempts. Try again in ${seconds} s.`,
    retryAfter: seconds,
  });
  return true;
}

function isFromLocalhost(req: AuthenticatedRequest): boolean {
  const remoteAddr = req.socket.remoteAddress;
  return remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
}

function hasProxyHeaders(req: AuthenticatedRequest): boolean {
  return Boolean(
    req.headers['x-forwarded-proto'] &&
      req.headers['x-forwarded-for'] &&
      req.headers['x-forwarded-host']
  );
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function getTailscaleLogin(req: AuthenticatedRequest): string | undefined {
  return getHeaderValue(req.headers['tailscale-user-login']);
}

function getConfiguredPasswordUserId(): string | undefined {
  const username = process.env.UNTETHER_USERNAME;
  return username && process.env.UNTETHER_PASSWORD ? username : undefined;
}

const avatarCache = new Map<string, { mtimeMs: number; dataUrl: string | null }>();
const avatarConversions = new Map<string, Promise<string | null>>();

/**
 * The account picture (often HEIC) as a 256 px JPEG data URL, via macOS `sips`. This route is
 * unauthenticated: results (failures included) are cached per file version and concurrent
 * requests share one conversion, so it can't be used to spawn `sips` repeatedly.
 */
function pictureAsJpegDataUrl(picturePath: string): Promise<string | null> {
  let pending = avatarConversions.get(picturePath);
  if (!pending) {
    pending = convertPicture(picturePath).finally(() => avatarConversions.delete(picturePath));
    avatarConversions.set(picturePath, pending);
  }
  return pending;
}

async function convertPicture(picturePath: string): Promise<string | null> {
  let mtimeMs: number;
  try {
    ({ mtimeMs } = await fs.promises.stat(picturePath));
  } catch {
    return null;
  }
  const cached = avatarCache.get(picturePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.dataUrl;
  try {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ut-avatar-'));
    try {
      const out = path.join(dir, 'avatar.jpg');
      await promisify(execFileCallback)('sips', [
        '-s',
        'format',
        'jpeg',
        '-Z',
        '256',
        picturePath,
        '--out',
        out,
      ]);
      const dataUrl = `data:image/jpeg;base64,${(await fs.promises.readFile(out)).toString('base64')}`;
      avatarCache.set(picturePath, { mtimeMs, dataUrl });
      return dataUrl;
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  } catch {
    avatarCache.set(picturePath, { mtimeMs, dataUrl: null });
    return null;
  }
}

interface AvatarResult {
  avatar: string | null;
  source?: 'dscl' | 'picture_file' | 'picture_path';
}

/** dscl results (successes and failures) cached per user and refreshed after this long. */
const AVATAR_CACHE_TTL_MS = 60_000;
const avatarResultCache = new Map<string, { at: number; result: AvatarResult }>();
const avatarLookups = new Map<string, Promise<AvatarResult>>();

/** Read JPEGPhoto, then the Picture attribute, from Directory Services. Spawns `dscl`. */
async function lookupAvatarFromDirectory(userId: string): Promise<AvatarResult> {
  try {
    const { stdout } = await execFileAsync('dscl', ['.', '-read', `/Users/${userId}`, 'JPEGPhoto']);
    if (stdout.includes('JPEGPhoto:')) {
      const hexLines = stdout
        .split('\n')
        .slice(1)
        .filter((line) => line.trim() && !line.startsWith('dsAttrTypeNative'));
      if (hexLines.length > 0) {
        const hexData = hexLines.join('').replace(/\s/g, '');
        const base64 = Buffer.from(hexData, 'hex').toString('base64');
        return { avatar: `data:image/jpeg;base64,${base64}`, source: 'dscl' };
      }
    }
  } catch {
    // No JPEGPhoto; fall through to the Picture attribute.
  }
  try {
    const { stdout } = await execFileAsync('dscl', ['.', '-read', `/Users/${userId}`, 'Picture']);
    if (stdout.includes('Picture:')) {
      const picturePath = stdout.split('Picture:')[1].trim();
      if (picturePath && picturePath !== 'Picture:') {
        // Browsers can't load a local path (and often not HEIC): send a small JPEG instead.
        const dataUrl = await pictureAsJpegDataUrl(picturePath);
        return dataUrl
          ? { avatar: dataUrl, source: 'picture_file' }
          : { avatar: picturePath, source: 'picture_path' };
      }
    }
  } catch {
    // No Picture attribute.
  }
  return { avatar: null };
}

/**
 * The owner's avatar, cached (successes and failures, TTL) with concurrent requests sharing one
 * lookup, so the route can't be used to spawn `dscl` repeatedly. 2026-11-08 (audit): it ran two
 * `dscl` processes on every request, uncached and unbounded.
 */
export function getAvatar(userId: string): Promise<AvatarResult> {
  const cached = avatarResultCache.get(userId);
  if (cached && Date.now() - cached.at < AVATAR_CACHE_TTL_MS) return Promise.resolve(cached.result);
  let pending = avatarLookups.get(userId);
  if (!pending) {
    pending = lookupAvatarFromDirectory(userId)
      .then((result) => {
        avatarResultCache.set(userId, { at: Date.now(), result });
        return result;
      })
      .finally(() => avatarLookups.delete(userId));
    avatarLookups.set(userId, pending);
  }
  return pending;
}

/** Clears the avatar caches. Tests only. */
export function resetAvatarCachesForTest(): void {
  avatarResultCache.clear();
  avatarLookups.clear();
  avatarCache.clear();
  avatarConversions.clear();
}

export function createAuthRoutes(config: AuthRoutesConfig): Router {
  const router = Router();
  const { authService } = config;
  // 2026-10-20 (security audit): password sign-in had no brute-force limit.
  const loginThrottle = config.loginThrottle ?? new LoginThrottle();
  const challengeThrottle =
    config.challengeThrottle ??
    new LoginThrottle({ freeFailures: 30, globalFreeFailures: 300, maxDelayMs: 60_000 });

  /**
   * Create authentication challenge for SSH key auth
   * POST /api/auth/challenge
   */
  router.post('/challenge', async (req, res) => {
    if (!config.enableSSHKeys) {
      return res.status(403).json({ error: 'SSH key authentication is disabled' });
    }
    try {
      // The challenge always targets the account this server runs as (SSH keys are its
      // authorized_keys): derived server-side, the client sends no user id, so the sign-in
      // screen needs no system-user leak (2026-11-08 audit).
      const userId = serverOwnerUsername();

      // Every challenge counts against the client: they are unauthenticated (2026-10-20).
      const client = loginClientKey(req);
      if (throttled(challengeThrottle, client, res)) return;
      challengeThrottle.recordFailure(client);

      // Only the account this server runs as can sign in (validated, no process spawned)
      const userExists = await authService.userExists(userId);
      if (!userExists) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Create challenge
      const challenge = authService.createChallenge(userId);

      res.json({
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
      });
    } catch (error) {
      console.error('Error creating auth challenge:', error);
      res.status(500).json({ error: 'Failed to create authentication challenge' });
    }
  });

  /**
   * Authenticate with SSH key
   * POST /api/auth/ssh-key
   */
  router.post('/ssh-key', async (req, res) => {
    if (!config.enableSSHKeys) {
      return res.status(403).json({ error: 'SSH key authentication is disabled' });
    }
    try {
      const { challengeId, publicKey, signature } = req.body ?? {};

      if (
        typeof challengeId !== 'string' ||
        typeof publicKey !== 'string' ||
        typeof signature !== 'string' ||
        !challengeId ||
        !publicKey ||
        !signature
      ) {
        return res.status(400).json({
          error: 'Challenge ID, public key, and signature are required',
        });
      }

      const client = loginClientKey(req);
      if (throttled(loginThrottle, client, res)) return;

      const result = await authService.authenticateWithSSHKey({
        challengeId,
        publicKey,
        signature,
      });

      if (result.success) loginThrottle.recordSuccess(client);
      else loginThrottle.recordFailure(client);

      if (result.success) {
        res.json({
          success: true,
          token: result.token,
          userId: result.userId,
          authMethod: 'ssh-key',
        });
      } else {
        res.status(401).json({
          success: false,
          error: result.error,
        });
      }
    } catch (error) {
      console.error('Error authenticating with SSH key:', error);
      res.status(500).json({ error: 'SSH key authentication failed' });
    }
  });

  /**
   * Authenticate with password
   * POST /api/auth/password
   */
  router.post('/password', async (req, res) => {
    if (config.disallowUserPassword) {
      return res.status(403).json({ error: 'Password authentication is disabled' });
    }
    try {
      const { password, remember } = req.body ?? {};

      if (!password || typeof password !== 'string') {
        return res.status(400).json({
          error: 'Password is required',
        });
      }

      // Backoff per client and overall, before the password is even looked at.
      const client = loginClientKey(req);
      if (throttled(loginThrottle, client, res)) return;

      // The principal is derived server-side — the configured username, or the account this
      // server runs as — so the sign-in screen needs no system-user leak (2026-11-08 audit).
      // authenticateWithPassword still enforces it (env match / isServerOwner).
      const passwordUserId = getConfiguredPasswordUserId() ?? serverOwnerUsername();
      const result = await authService.authenticateWithPassword(passwordUserId, password, {
        remember: remember === true,
      });

      if (result.success) loginThrottle.recordSuccess(client);
      else loginThrottle.recordFailure(client);

      if (result.success) {
        res.json({
          success: true,
          token: result.token,
          userId: result.userId,
          authMethod: 'password',
        });
      } else {
        res.status(401).json({
          success: false,
          error: result.error,
        });
      }
    } catch (error) {
      console.error('Error authenticating with password:', error);
      res.status(500).json({ error: 'Password authentication failed' });
    }
  });

  /**
   * Verify current authentication status
   * GET /api/auth/verify
   */
  router.get('/verify', (req, res) => {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ valid: false, error: 'No token provided' });
      }

      const token = authHeader.slice(7);
      const verification = authService.verifyToken(token);

      if (verification.valid) {
        res.json({
          valid: true,
          userId: verification.userId,
        });
      } else {
        res.status(401).json({
          valid: false,
          error: 'Invalid or expired token',
        });
      }
    } catch (error) {
      console.error('Error verifying token:', error);
      res.status(500).json({ error: 'Token verification failed' });
    }
  });

  /**
   * Get current system user (for initial auth)
   * GET /api/auth/current-user
   */
  router.get('/current-user', (_req, res) => {
    try {
      const currentUser = authService.getCurrentUser();
      res.json({ userId: currentUser });
    } catch (error) {
      console.error('Error getting current user:', error);
      res.status(500).json({ error: 'Failed to get current user' });
    }
  });

  /**
   * Get authentication configuration
   * GET /api/auth/config
   */
  router.get('/config', (req: AuthenticatedRequest, res) => {
    try {
      interface AuthConfigResponse {
        enableSSHKeys: boolean;
        disallowUserPassword: boolean;
        noAuth: boolean;
        passwordAuthMode: 'system' | 'configured';
        tailscaleAuth?: boolean;
        authenticatedUser?: string;
        tailscaleUser?: TailscaleUser;
      }

      const response: AuthConfigResponse = {
        enableSSHKeys: config.enableSSHKeys || false,
        disallowUserPassword: config.disallowUserPassword || false,
        noAuth: config.noAuth || false,
        passwordAuthMode: getConfiguredPasswordUserId() ? 'configured' : 'system',
      };

      // If user is authenticated via Tailscale, indicate this
      if (req.authMethod === 'tailscale' && req.userId) {
        response.tailscaleAuth = true;
        response.authenticatedUser = req.userId;
        response.tailscaleUser = req.tailscaleUser;
      }

      res.json(response);
    } catch (error) {
      console.error('Error getting auth config:', error);
      res.status(500).json({ error: 'Failed to get auth config' });
    }
  });

  /**
   * Get JWT token for Tailscale authenticated users (for WebSocket auth)
   * POST /api/auth/tailscale-token
   */
  router.post('/tailscale-token', (req: AuthenticatedRequest, res) => {
    try {
      // Only allow Tailscale-authenticated users to get tokens
      if (req.authMethod !== 'tailscale') {
        return res.status(401).json({
          error: 'This endpoint is only available for Tailscale authenticated users',
        });
      }

      if (!req.userId) {
        return res.status(401).json({
          error: 'No user ID found in Tailscale authentication',
        });
      }

      // Validate that the request is actually coming from the local Tailscale proxy
      if (!isFromLocalhost(req)) {
        return res.status(401).json({
          error: 'Invalid request origin',
        });
      }

      if (!hasProxyHeaders(req)) {
        return res.status(401).json({
          error: 'Invalid proxy configuration',
        });
      }

      const tailscaleLogin = getTailscaleLogin(req);
      if (!tailscaleLogin || tailscaleLogin !== req.userId) {
        return res.status(401).json({
          error: 'Invalid Tailscale identity headers',
        });
      }

      // Generate a JWT token for WebSocket authentication
      // Use the private generateToken method via a wrapper in AuthService
      const token = authService.generateTokenForUser(req.userId);

      res.json({
        success: true,
        token,
        userId: req.userId,
        authMethod: 'tailscale',
        expiresIn: '24h',
      });
    } catch (error) {
      console.error('Error generating Tailscale token:', error);
      res.status(500).json({ error: 'Failed to generate token' });
    }
  });

  /**
   * Get user avatar (macOS only)
   * GET /api/auth/avatar/:userId
   */
  router.get('/avatar/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      // Validate userId to prevent command injection: alphanumerics, dots, hyphens, underscores.
      if (!userId || !/^[a-zA-Z0-9._-]+$/.test(userId) || userId.length > 255) {
        return res.status(400).json({ error: 'Invalid user ID format' });
      }

      // Check if we're on macOS
      if (process.platform !== 'darwin') {
        return res.json({ avatar: null, platform: process.platform });
      }

      // Only the account this server runs as has an avatar here. Any other id is answered without
      // spawning a process (2026-11-08 audit). The route also requires a login (middleware/auth).
      if (!isServerOwner(userId)) {
        return res.status(404).json({ error: 'Avatar not found' });
      }

      // Cached per user (successes and failures) and coalesced, so dscl runs at most once per TTL.
      const result = await getAvatar(userId);
      res.json({
        avatar: result.avatar,
        platform: 'darwin',
        ...(result.source ? { source: result.source } : {}),
      });
    } catch (error) {
      console.error('Error getting user avatar:', error);
      res.status(500).json({ error: 'Failed to get user avatar' });
    }
  });

  /**
   * Logout: the token sent stops working on this server (2026-10-20, audit: logout used to be
   * client-side only, a copied token stayed valid for up to 30 days). `{ "everywhere": true }`
   * also ends every other token of that user. Revocations live in memory (see auth-service).
   * POST /api/auth/logout
   */
  router.post('/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const verification = authService.verifyToken(token);
      if (verification.valid && verification.userId) {
        authService.revokeToken(token);
        if (req.body?.everywhere === true) authService.revokeAllForUser(verification.userId);
      }
    }
    res.json({ success: true, message: 'Logged out successfully' });
  });

  return router;
}
