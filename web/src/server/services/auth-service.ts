import * as crypto from 'crypto';
import * as fs from 'fs';
import * as jwt from 'jsonwebtoken';
import * as os from 'os';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { every } from '../utils/periodic-loop.js';
import { authenticate as pamAuthenticate } from './authenticate-pam-loader.js';

const logger = createLogger('auth-service');
const JWT_SECRET_BYTES = 64;
const DEFAULT_TOKEN_LIFETIME = '24h' as const;
/** "Keep me signed in on this device": phones would otherwise ask for the password daily. */
const REMEMBERED_TOKEN_LIFETIME = '30d' as const;
const JWT_SECRET_PATTERN = new RegExp(`^[0-9a-f]{${JWT_SECRET_BYTES * 2}}$`);
const JWT_SECRET_CREATE_ATTEMPTS = 3;
/**
 * Pending SSH challenges kept at most. 2026-10-20 (security audit): /api/auth/challenge is
 * unauthenticated and every call added one, unbounded.
 */
export const MAX_PENDING_CHALLENGES = 100;
/** Revoked token ids kept at most (each only until its token expires anyway). */
const MAX_REVOKED_TOKENS = 10_000;
const ACCOUNT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;

/**
 * The account this server runs as: the only one whose password or SSH keys can sign in.
 * 2026-10-20 (security audit): any macOS account's password was accepted, and the SSH
 * challenge looked any name up with `id <name>` (a name starting with "-" was an option).
 */
export function serverOwnerUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || '';
  }
}

/** Whether `userId` is the server owner's account name (validated, never passed to a command). */
export function isServerOwner(userId: unknown, owner = serverOwnerUsername()): boolean {
  return typeof userId === 'string' && ACCOUNT_NAME.test(userId) && !!owner && userId === owner;
}

interface ThrottleOptions {
  /** Failures allowed from one client before it has to wait. */
  freeFailures: number;
  /** Failures allowed from everyone together before every client has to wait. */
  globalFreeFailures: number;
  baseDelayMs: number;
  maxDelayMs: number;
  globalMaxDelayMs: number;
  /**
   * The most a client without failures of its own waits because of the global bucket.
   * 2026-10-20: an attacker failing from many addresses held the global backoff (up to 60 s)
   * and locked the owner out of signing in; for a clean client it is now a short slow-down.
   */
  globalSlowdownMs: number;
  /** Failures older than this are forgotten. */
  forgetAfterMs: number;
  maxClients: number;
}

const LOOPBACK_CLIENTS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Whether a login client key (see loginClientKey in routes/auth.ts) is left out of the global
 * bucket: a direct tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48) or loopback without
 * forwarding headers (keys of forwarded requests start with "fwd:", whose address the sender
 * chooses, so those are never exempt). 2026-10-20: failures from outside kept the owner's own
 * devices waiting; their failures still count against their own bucket.
 */
export function isGlobalThrottleExempt(client: string): boolean {
  if (LOOPBACK_CLIENTS.has(client)) return true;
  const v4 = client.startsWith('::ffff:') ? client.slice(7) : client;
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(v4);
  if (m) {
    const second = Number(m[1]);
    return second >= 64 && second <= 127;
  }
  return /^fd7a:115c:a1e0:/i.test(client);
}

/**
 * In-memory backoff for login attempts: per client and for all clients together, doubling
 * from 1 s after a few failures. 2026-10-20 (security audit): /api/auth/password had no
 * limit at all, so a password could be guessed at full speed from the tailnet or LAN.
 */
export class LoginThrottle {
  private readonly options: ThrottleOptions;
  private readonly clients = new Map<
    string,
    { failures: number; blockedUntil: number; at: number }
  >();
  private global = { failures: 0, blockedUntil: 0, at: 0 };

  constructor(
    options: Partial<ThrottleOptions> = {},
    private readonly now: () => number = Date.now
  ) {
    this.options = {
      freeFailures: 5,
      globalFreeFailures: 20,
      baseDelayMs: 1000,
      maxDelayMs: 15 * 60_000,
      globalMaxDelayMs: 60_000,
      globalSlowdownMs: 2000,
      forgetAfterMs: 15 * 60_000,
      maxClients: 1000,
      ...options,
    };
  }

  private delay(failures: number, free: number, max: number): number {
    if (failures <= free) return 0;
    return Math.min(max, this.options.baseDelayMs * 2 ** Math.min(30, failures - free - 1));
  }

  /** Milliseconds `client` must wait before its next attempt; 0 when it may try now. */
  retryAfterMs(client: string): number {
    const t = this.now();
    if (t - this.global.at > this.options.forgetAfterMs)
      this.global = { failures: 0, blockedUntil: 0, at: t };
    const entry = this.clients.get(client);
    if (entry && t - entry.at > this.options.forgetAfterMs) this.clients.delete(client);
    const mine = this.clients.get(client);
    const own = mine?.blockedUntil ?? 0;
    if (isGlobalThrottleExempt(client)) return Math.max(0, own - t);
    let globalWait = this.global.blockedUntil - t;
    // Only clients that failed themselves wait out the whole global backoff.
    if (!mine?.failures) globalWait = Math.min(globalWait, this.options.globalSlowdownMs);
    return Math.max(0, own - t, globalWait);
  }

  recordFailure(client: string): void {
    const t = this.now();
    const entry = this.clients.get(client) ?? { failures: 0, blockedUntil: 0, at: t };
    entry.failures++;
    entry.at = t;
    entry.blockedUntil =
      t + this.delay(entry.failures, this.options.freeFailures, this.options.maxDelayMs);
    this.clients.delete(client);
    this.clients.set(client, entry);
    while (this.clients.size > this.options.maxClients) {
      const oldest = this.clients.keys().next().value;
      if (oldest === undefined) break;
      this.clients.delete(oldest);
    }
    if (isGlobalThrottleExempt(client)) return;
    this.global.failures++;
    this.global.at = t;
    this.global.blockedUntil =
      t +
      this.delay(
        this.global.failures,
        this.options.globalFreeFailures,
        this.options.globalMaxDelayMs
      );
  }

  recordSuccess(client: string): void {
    this.clients.delete(client);
    this.global = { failures: 0, blockedUntil: 0, at: this.now() };
  }
}

interface AuthChallenge {
  challengeId: string;
  challenge: Buffer;
  timestamp: number;
  userId: string;
}

interface AuthResult {
  success: boolean;
  userId?: string;
  token?: string;
  error?: string;
}

interface SSHKeyAuth {
  publicKey: string;
  signature: string;
  challengeId: string;
}

type TokenPayload = jwt.JwtPayload & { userId: string; iatMs?: number };

function tokenId(token: string, payload: TokenPayload): string {
  return payload.jti ?? `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
}

function issuedAtMs(payload: TokenPayload): number {
  return typeof payload.iatMs === 'number' ? payload.iatMs : (payload.iat ?? 0) * 1000;
}

function safeEqual(a: string, b: string): boolean {
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

export class AuthService {
  private challenges = new Map<string, AuthChallenge>();
  private jwtSecret: string;
  private challengeTimeout = 5 * 60 * 1000; // 5 minutes
  /**
   * Logged-out tokens (id → expiry, ms) and per-user "logged out everywhere" times.
   * 2026-10-20 (security audit): logout did not revoke anything, a copied token kept working
   * for up to 30 days.
   * 2026-10-20: they were in memory only, so any restart (app restart, crash, update) brought a
   * logged-out token back to life. They are kept in a small 0600 file next to the JWT secret
   * (~/.untether/revoked-tokens.json, same account-global place and same reasoning: the
   * secret outlives restarts, so must its revocations). Expired entries are dropped on save.
   */
  private revokedTokens = new Map<string, number>();
  private loggedOutAt = new Map<string, number>();
  private revocationsPath: string | null = null;

  constructor() {
    // Resolve the JWT signing secret. Priority:
    //   1. JWT_SECRET env var (explicit operator override)
    //   2. persisted secret on disk (~/.untether/jwt-secret)
    //   3. freshly generated secret, persisted for next time
    // Persisting is essential: without it a new random secret is created on every
    // server start, instantly invalidating every previously-issued token and causing
    // 401 storms from open clients after a restart.
    // Environment-only deployments do not persist revocations. Mix in a fresh boot secret
    // so restarting invalidates ALL their tokens instead of resurrecting logged-out ones.
    this.jwtSecret = process.env.JWT_SECRET
      ? crypto
          .createHmac('sha256', process.env.JWT_SECRET)
          .update(this.generateSecret())
          .digest('hex')
      : this.loadOrCreateSecret();
    // With an operator-given JWT_SECRET nothing is written to disk.
    if (!process.env.JWT_SECRET) {
      this.revocationsPath = path.join(os.homedir(), '.untether', 'revoked-tokens.json');
      this.loadRevocations();
    }

    // Clean up expired challenges every minute
    every('auth challenge cleanup', () => this.cleanupExpiredChallenges(), 60000);
  }

  private generateSecret(): string {
    return crypto.randomBytes(JWT_SECRET_BYTES).toString('hex');
  }

  private hasFileErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
  }

  private readPersistedSecret(secretPath: string): string | null {
    try {
      const existing = fs.readFileSync(secretPath, 'utf8').trim();
      if (!JWT_SECRET_PATTERN.test(existing)) {
        logger.warn('Persisted JWT secret is invalid; regenerating');
        try {
          fs.unlinkSync(secretPath);
        } catch (error) {
          if (!this.hasFileErrorCode(error, 'ENOENT')) throw error;
        }
        return null;
      }

      fs.chmodSync(secretPath, 0o600);
      logger.debug('Loaded persisted JWT secret');
      return existing;
    } catch (error) {
      if (this.hasFileErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  private publishSecret(secretPath: string, secret: string): boolean {
    const tempPath = `${secretPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, secret, { flag: 'wx', mode: 0o600 });
      try {
        fs.linkSync(tempPath, secretPath);
        return true;
      } catch (error) {
        if (this.hasFileErrorCode(error, 'EEXIST')) return false;
        throw error;
      }
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch (error) {
        if (!this.hasFileErrorCode(error, 'ENOENT')) {
          logger.warn(`Failed to remove temporary JWT secret ${tempPath}:`, error);
        }
      }
    }
  }

  /**
   * Load the JWT signing secret from disk, generating and persisting one if absent.
   * Falls back to an in-memory secret if disk access fails, so auth still works
   * (tokens just won't survive a restart in that degraded case).
   */
  private loadOrCreateSecret(): string {
    // Account-global location, mirroring VapidManager (~/.untether/vapid). Deliberately
    // NOT derived from UNTETHER_CONTROL_DIR: the mac app points that at the per-session
    // control dir, which can be cleaned/rotated — losing the secret there would silently
    // regenerate it and reintroduce the restart 401 storm.
    const secretDir = path.join(os.homedir(), '.untether');
    const secretPath = path.join(secretDir, 'jwt-secret');

    try {
      // Private (2026-10-20): a fresh ~/.untether was created 0755.
      fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });

      for (let attempt = 0; attempt < JWT_SECRET_CREATE_ATTEMPTS; attempt++) {
        const existing = this.readPersistedSecret(secretPath);
        if (existing) return existing;

        const secret = this.generateSecret();
        if (this.publishSecret(secretPath, secret)) {
          logger.log(`Generated and persisted new JWT secret at ${secretPath}`);
          return secret;
        }
      }

      throw new Error('JWT secret changed repeatedly during startup');
    } catch (error) {
      logger.error(
        'Failed to persist JWT secret; using in-memory secret (tokens will not survive a restart):',
        error
      );
      return this.generateSecret();
    }
  }

  private loadRevocations(): void {
    if (!this.revocationsPath) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.revocationsPath, 'utf8')) as {
        tokens?: Record<string, unknown>;
        loggedOutAt?: Record<string, unknown>;
      };
      const now = Date.now();
      for (const [id, expiresAt] of Object.entries(data.tokens ?? {})) {
        if (typeof expiresAt === 'number' && expiresAt > now) this.revokedTokens.set(id, expiresAt);
      }
      for (const [user, at] of Object.entries(data.loggedOutAt ?? {})) {
        if (typeof at === 'number') this.loggedOutAt.set(user, at);
      }
    } catch (error) {
      if (!this.hasFileErrorCode(error, 'ENOENT')) {
        logger.warn(`Could not read token revocations: ${error}`);
      }
    }
  }

  private saveRevocations(): void {
    if (!this.revocationsPath) return;
    const now = Date.now();
    const tokens: Record<string, number> = {};
    for (const [id, expiresAt] of this.revokedTokens) {
      if (expiresAt > now) tokens[id] = expiresAt;
    }
    const tempPath = `${this.revocationsPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.revocationsPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        tempPath,
        JSON.stringify({ tokens, loggedOutAt: Object.fromEntries(this.loggedOutAt) }),
        { mode: 0o600 }
      );
      fs.renameSync(tempPath, this.revocationsPath);
    } catch (error) {
      logger.warn(`Could not save token revocations (they last until a restart): ${error}`);
    }
  }

  private cleanupExpiredChallenges(): void {
    const now = Date.now();
    for (const [id, challenge] of this.challenges.entries()) {
      if (now - challenge.timestamp > this.challengeTimeout) {
        this.challenges.delete(id);
      }
    }
    for (const [id, expiresAt] of this.revokedTokens) {
      if (expiresAt <= now) this.revokedTokens.delete(id);
    }
  }

  /**
   * Authenticate user with SSH key (priority method)
   */
  async authenticateWithSSHKey(sshKeyAuth: SSHKeyAuth): Promise<AuthResult> {
    try {
      const challenge = this.challenges.get(sshKeyAuth.challengeId);
      if (!challenge) {
        return { success: false, error: 'Invalid or expired challenge' };
      }

      // Verify the signature using the original public key string
      const signatureBuffer = Buffer.from(sshKeyAuth.signature, 'base64');
      const isValidSignature = this.verifySSHSignature(
        challenge.challenge,
        signatureBuffer,
        sshKeyAuth.publicKey
      );

      if (!isValidSignature) {
        return { success: false, error: 'Invalid SSH key signature' };
      }

      // Check if this key is authorized for the user
      const isAuthorized = await this.checkSSHKeyAuthorization(
        challenge.userId,
        sshKeyAuth.publicKey
      );
      if (!isAuthorized) {
        return { success: false, error: 'SSH key not authorized for this user' };
      }

      // Clean up challenge
      this.challenges.delete(sshKeyAuth.challengeId);

      // Generate JWT token
      const token = this.generateToken(challenge.userId);

      return {
        success: true,
        userId: challenge.userId,
        token,
      };
    } catch (error) {
      console.error('SSH key authentication error:', error);
      return { success: false, error: 'SSH key authentication failed' };
    }
  }

  /**
   * Authenticate user with PAM (fallback method)
   */
  async authenticateWithPassword(
    userId: string,
    password: string,
    options: { remember?: boolean } = {}
  ): Promise<AuthResult> {
    const lifetime = options.remember ? REMEMBERED_TOKEN_LIFETIME : DEFAULT_TOKEN_LIFETIME;
    try {
      // Check environment variables first (for testing and simple deployments)
      const envUsername = process.env.UNTETHER_USERNAME;
      const envPassword = process.env.UNTETHER_PASSWORD;

      if (envUsername && envPassword) {
        // Use environment variable authentication
        if (
          typeof userId === 'string' &&
          typeof password === 'string' &&
          safeEqual(userId, envUsername) &&
          safeEqual(password, envPassword)
        ) {
          const token = this.generateToken(userId, lifetime);
          return {
            success: true,
            userId,
            token,
          };
        } else {
          return { success: false, error: 'Invalid username or password' };
        }
      }

      // Fall back to PAM authentication, for the account this server runs as only: another
      // account's password must not open this account's terminals (2026-10-20, audit).
      if (!isServerOwner(userId) || typeof password !== 'string') {
        return { success: false, error: 'Invalid username or password' };
      }
      const isValid = await this.verifyPAMCredentials(userId, password);
      if (!isValid) {
        return { success: false, error: 'Invalid username or password' };
      }

      const token = this.generateToken(userId, lifetime);

      return {
        success: true,
        userId,
        token,
      };
    } catch (error) {
      console.error('PAM authentication error:', error);
      return { success: false, error: 'Authentication failed' };
    }
  }

  /**
   * Create authentication challenge for SSH key auth
   */
  createChallenge(userId: string): { challengeId: string; challenge: string } {
    const challengeId = crypto.randomUUID();
    const challenge = crypto.randomBytes(32);
    if (this.challenges.size >= MAX_PENDING_CHALLENGES) this.cleanupExpiredChallenges();
    while (this.challenges.size >= MAX_PENDING_CHALLENGES) {
      const oldest = this.challenges.keys().next().value;
      if (oldest === undefined) break;
      this.challenges.delete(oldest);
    }

    this.challenges.set(challengeId, {
      challengeId,
      challenge,
      timestamp: Date.now(),
      userId,
    });

    return {
      challengeId,
      challenge: challenge.toString('base64'),
    };
  }

  /**
   * Verify JWT token
   */
  verifyToken(token: string): { valid: boolean; userId?: string } {
    try {
      const payload = jwt.verify(token, this.jwtSecret) as TokenPayload;
      if (this.revokedTokens.has(tokenId(token, payload))) return { valid: false };
      const loggedOut = this.loggedOutAt.get(payload.userId);
      if (loggedOut !== undefined && issuedAtMs(payload) < loggedOut) return { valid: false };
      return { valid: true, userId: payload.userId };
    } catch (_error) {
      return { valid: false };
    }
  }

  /** Logout: this token stops working now (kept across restarts until it expires). */
  revokeToken(token: string): boolean {
    let payload: TokenPayload;
    try {
      payload = jwt.verify(token, this.jwtSecret) as TokenPayload;
    } catch {
      return false;
    }
    const expiresAt = (payload.exp ?? Math.floor(Date.now() / 1000) + 30 * 86400) * 1000;
    if (this.revokedTokens.size >= MAX_REVOKED_TOKENS) this.cleanupExpiredChallenges();
    if (this.revokedTokens.size >= MAX_REVOKED_TOKENS) {
      // Full of live revocations: log this user out everywhere instead (covers this token).
      this.revokeAllForUser(payload.userId);
      return true;
    }
    this.revokedTokens.set(tokenId(token, payload), expiresAt);
    this.saveRevocations();
    return true;
  }

  /** "Log out everywhere": every token issued to `userId` until now stops working. */
  revokeAllForUser(userId: string): void {
    this.loggedOutAt.set(userId, Date.now());
    this.saveRevocations();
  }

  /**
   * Generate JWT token (public wrapper for Tailscale auth)
   */
  generateTokenForUser(userId: string): string {
    return this.generateToken(userId);
  }

  /**
   * Generate JWT token
   */
  private generateToken(
    userId: string,
    expiresIn:
      | typeof DEFAULT_TOKEN_LIFETIME
      | typeof REMEMBERED_TOKEN_LIFETIME = DEFAULT_TOKEN_LIFETIME
  ): string {
    const now = Date.now();
    // jti: what logout revokes; iatMs: issue time precise enough to compare with a logout
    // made in the same second.
    return jwt.sign(
      { userId, iat: Math.floor(now / 1000), iatMs: now, jti: crypto.randomUUID() },
      this.jwtSecret,
      { expiresIn }
    );
  }

  /**
   * Verify credentials using PAM
   */
  private async verifyPAMCredentials(username: string, password: string): Promise<boolean> {
    return new Promise((resolve) => {
      pamAuthenticate(username, password, (err: Error | null) => {
        if (err) {
          console.error('PAM authentication failed:', err.message);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Verify SSH signature
   */
  private verifySSHSignature(challenge: Buffer, signature: Buffer, publicKeyStr: string): boolean {
    try {
      // Basic sanity checks
      if (!challenge || !signature || !publicKeyStr) {
        console.error('Missing required parameters for signature verification');
        return false;
      }

      const keyParts = publicKeyStr.trim().split(/\s+/);
      if (keyParts.length < 2) {
        console.error('Invalid SSH public key format');
        return false;
      }

      const keyType = keyParts[0];
      const keyData = keyParts[1];

      if (keyType === 'ssh-ed25519') {
        // Check signature length
        if (signature.length !== 64) {
          console.error(`Invalid Ed25519 signature length: ${signature.length} (expected 64)`);
          return false;
        }

        // Decode the SSH public key
        const sshKeyBuffer = Buffer.from(keyData, 'base64');

        // Parse SSH wire format: length + "ssh-ed25519" + length + 32-byte key
        let offset = 0;

        // Skip algorithm name length and value
        const algLength = sshKeyBuffer.readUInt32BE(offset);
        offset += 4 + algLength;

        // Read public key length and value
        const keyLength = sshKeyBuffer.readUInt32BE(offset);
        offset += 4;

        if (keyLength !== 32) {
          console.error(`Invalid Ed25519 key length: ${keyLength} (expected 32)`);
          return false;
        }

        const rawPublicKey = sshKeyBuffer.subarray(offset, offset + 32);

        // Create a Node.js public key object
        const publicKey = crypto.createPublicKey({
          key: Buffer.concat([
            Buffer.from([0x30, 0x2a]), // DER sequence header
            Buffer.from([0x30, 0x05]), // Algorithm identifier sequence
            Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]), // Ed25519 OID
            Buffer.from([0x03, 0x21, 0x00]), // Public key bit string
            rawPublicKey,
          ]),
          format: 'der',
          type: 'spki',
        });

        // Verify the signature
        const isValid = crypto.verify(null, challenge, publicKey, signature);
        console.log(`🔐 Ed25519 signature verification: ${isValid ? 'PASSED' : 'FAILED'}`);
        return isValid;
      }

      console.error(`Unsupported key type: ${keyType}`);
      return false;
    } catch (error) {
      console.error('SSH signature verification failed:', error);
      return false;
    }
  }

  /**
   * Check if SSH key is authorized for user
   */
  private async checkSSHKeyAuthorization(userId: string, publicKey: string): Promise<boolean> {
    try {
      if (!isServerOwner(userId)) return false;
      const authorizedKeysPath = path.join(os.homedir(), '.ssh', 'authorized_keys');

      if (!fs.existsSync(authorizedKeysPath)) {
        return false;
      }

      const authorizedKeys = fs.readFileSync(authorizedKeysPath, 'utf8');
      const [keyType, keyData] = publicKey.trim().split(/\s+/);
      if (!keyType || !keyData) return false;

      // Untether grants full account access and cannot enforce SSH options (command=,
      // from=, restrict, etc.). Only bare, active entries may authorize that access.
      return authorizedKeys.split(/\r?\n/).some((line) => {
        const [type, data] = line.trim().split(/\s+/);
        return type === keyType && data === keyData;
      });
    } catch (error) {
      console.error('Error checking SSH key authorization:', error);
      return false;
    }
  }

  /**
   * Get current system user
   */
  getCurrentUser(): string {
    return process.env.USER || process.env.USERNAME || 'unknown';
  }

  /**
   * Check if user exists on system
   */
  async userExists(userId: unknown): Promise<boolean> {
    // Only the owner can sign in, so only the owner "exists": no lookup, no process spawned
    // per unauthenticated request (2026-10-20, audit: `spawnSync('id', [userId])`).
    return isServerOwner(userId);
  }
}
