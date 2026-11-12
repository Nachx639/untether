import * as crypto from 'crypto';
import * as fs from 'fs';
import * as jwt from 'jsonwebtoken';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthService,
  isGlobalThrottleExempt,
  isServerOwner,
  LoginThrottle,
  MAX_PENDING_CHALLENGES,
} from './auth-service.js';
import { authenticate as pamAuthenticate } from './authenticate-pam-loader.js';

// Mock modules
vi.mock('fs');
vi.mock('os');
vi.mock('./authenticate-pam-loader.js', () => ({
  authenticate: vi.fn((_user: string, _pw: string, done: (err: Error | null) => void) =>
    done(null)
  ),
}));

// Mock logger to avoid path issues
vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('AuthService JWT secret persistence', () => {
  const mockHomeDir = '/home/testuser';
  const secretPath = path.join(mockHomeDir, '.untether', 'jwt-secret');
  let savedJwtSecret: string | undefined;

  const createFsError = (code: string, message: string) => {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    return error;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // The constructor schedules a cleanup interval; fake timers keep it from lingering.
    vi.useFakeTimers();

    savedJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = undefined;
    delete process.env.JWT_SECRET;

    vi.mocked(os.homedir).mockReturnValue(mockHomeDir);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw createFsError('ENOENT', 'file not found');
    });
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
    vi.mocked(fs.chmodSync).mockImplementation(() => undefined);
    vi.mocked(fs.linkSync).mockImplementation(() => undefined);
    vi.mocked(fs.unlinkSync).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = savedJwtSecret;
    }
  });

  it('generates and persists a secret (0600) when none exists on disk', () => {
    new AuthService();

    expect(fs.mkdirSync).toHaveBeenCalledWith(path.join(mockHomeDir, '.untether'), {
      recursive: true,
      mode: 0o700,
    });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [tempPath, writtenSecret, opts] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(tempPath).toMatch(`${secretPath}.`);
    expect(typeof writtenSecret).toBe('string');
    expect((writtenSecret as string).length).toBeGreaterThan(0);
    expect(opts).toEqual({ flag: 'wx', mode: 0o600 });
    expect(fs.linkSync).toHaveBeenCalledWith(tempPath, secretPath);
    expect(fs.unlinkSync).toHaveBeenCalledWith(tempPath);
  });

  it('loads the existing secret without rewriting, so tokens survive a restart', () => {
    // First "boot": no file → generates + persists. Capture the generated secret.
    const instanceA = new AuthService();
    const persistedSecret = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const token = instanceA.generateTokenForUser('alice');

    // Second "boot" (server restart): file now present with the same secret.
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHomeDir);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(persistedSecret);

    const instanceB = new AuthService();

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.chmodSync).toHaveBeenCalledWith(secretPath, 0o600);
    // The token minted before the restart still verifies after it — the whole point.
    expect(instanceB.verifyToken(token)).toEqual({ valid: true, userId: 'alice' });
  });

  it('regenerates invalid persisted secrets instead of accepting weak signing keys', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('short');

    new AuthService();

    expect(fs.unlinkSync).toHaveBeenCalledWith(secretPath);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const writtenSecret = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(writtenSecret).toMatch(/^[0-9a-f]{128}$/);
  });

  it('uses JWT_SECRET env var and never touches disk when it is set', () => {
    process.env.JWT_SECRET = 'env-provided-secret';

    const service = new AuthService();

    expect(fs.existsSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    // Token signed with the env secret round-trips.
    const token = service.generateTokenForUser('bob');
    expect(service.verifyToken(token)).toEqual({ valid: true, userId: 'bob' });
  });

  it('falls back to an in-memory secret without throwing when disk access fails', () => {
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });

    let service: AuthService | undefined;
    expect(() => {
      service = new AuthService();
    }).not.toThrow();

    // Auth still works in-process despite the persistence failure.
    const token = (service as AuthService).generateTokenForUser('carol');
    expect((service as AuthService).verifyToken(token)).toEqual({ valid: true, userId: 'carol' });
  });

  it('never resurrects tokens after an environment-only deployment restarts', () => {
    process.env.JWT_SECRET = 'restart-test-secret';
    const first = new AuthService();
    const phone = first.generateTokenForUser('owner');
    const laptop = first.generateTokenForUser('owner');
    const other = first.generateTokenForUser('other');
    expect(first.verifyToken(other).valid).toBe(true);
    expect(first.revokeToken(phone)).toBe(true);
    vi.advanceTimersByTime(1);
    first.revokeAllForUser('owner');
    expect(first.verifyToken(phone).valid).toBe(false);
    expect(first.verifyToken(laptop).valid).toBe(false);

    const restarted = new AuthService();
    for (const token of [phone, laptop, other]) {
      expect(restarted.verifyToken(token).valid).toBe(false);
    }
    expect(restarted.verifyToken(restarted.generateTokenForUser('owner')).valid).toBe(true);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('loads the winner when another process creates the secret concurrently', () => {
    const concurrentSecret = 'ab'.repeat(64);
    vi.mocked(fs.readFileSync)
      .mockImplementationOnce(() => {
        throw createFsError('ENOENT', 'file not found');
      })
      .mockReturnValue(concurrentSecret);
    vi.mocked(fs.linkSync).mockImplementationOnce(() => {
      throw createFsError('EEXIST', 'file already exists');
    });

    const service = new AuthService();
    const token = jwt.sign({ userId: 'race-winner' }, concurrentSecret);

    const tempPath = vi.mocked(fs.writeFileSync).mock.calls[0][0];
    expect(fs.writeFileSync).toHaveBeenCalledWith(tempPath, expect.any(String), {
      flag: 'wx',
      mode: 0o600,
    });
    expect(fs.linkSync).toHaveBeenCalledWith(tempPath, secretPath);
    expect(service.verifyToken(token)).toEqual({ valid: true, userId: 'race-winner' });
  });

  it('a logged-out token stays revoked after a restart, in a private file (2026-10-20)', () => {
    const files = new Map<string, string>();
    vi.mocked(fs.writeFileSync).mockImplementation((file, data) => {
      files.set(String(file), String(data));
    });
    vi.mocked(fs.linkSync).mockImplementation((from, to) => {
      files.set(String(to), files.get(String(from)) ?? '');
    });
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      files.set(String(to), files.get(String(from)) ?? '');
      files.delete(String(from));
    });
    vi.mocked(fs.readFileSync).mockImplementation(((file: fs.PathOrFileDescriptor) => {
      const content = files.get(String(file));
      if (content === undefined) throw createFsError('ENOENT', 'file not found');
      return content;
    }) as typeof fs.readFileSync);
    const first = new AuthService();
    const phone = first.generateTokenForUser('owner');
    const laptop = first.generateTokenForUser('owner');
    first.revokeToken(phone);
    const revocations = path.join(mockHomeDir, '.untether', 'revoked-tokens.json');
    expect(files.has(revocations)).toBe(true);
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('revoked-tokens.json'),
      expect.any(String),
      { mode: 0o600 }
    );
    const restarted = new AuthService();
    expect(restarted.verifyToken(phone).valid).toBe(false);
    expect(restarted.verifyToken(laptop).valid).toBe(true);
  });
});

describe('AuthService password token lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('JWT_SECRET', 'lifetime-test-secret');
    vi.stubEnv('UNTETHER_USERNAME', 'alice');
    vi.stubEnv('UNTETHER_PASSWORD', 'pw');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each([
    [{}, 24 * 3600],
    [{ remember: true }, 30 * 24 * 3600],
  ])('signs a password login with options %j for %i seconds', async (options, seconds) => {
    const result = await new AuthService().authenticateWithPassword('alice', 'pw', options);

    const payload = jwt.decode(result.token as string) as { iat: number; exp: number };
    expect(payload.exp - payload.iat).toBe(seconds);
  });
});

describe('AuthService sign-in hardening (2026-10-20 audit)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('JWT_SECRET', 'hardening-test-secret');
    vi.stubEnv('UNTETHER_USERNAME', '');
    vi.stubEnv('UNTETHER_PASSWORD', '');
    vi.mocked(os.userInfo).mockReturnValue({ username: 'owner' } as never);
    vi.mocked(pamAuthenticate).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("accepts only the server owner's account password (PAM is not even asked otherwise)", async () => {
    const service = new AuthService();
    await expect(service.authenticateWithPassword('someone-else', 'pw')).resolves.toMatchObject({
      success: false,
    });
    expect(pamAuthenticate).not.toHaveBeenCalled();
    await expect(service.authenticateWithPassword('owner', 'pw')).resolves.toMatchObject({
      success: true,
      userId: 'owner',
    });
    expect(pamAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('knows only the owner, without running any command, and never an option-like name', async () => {
    const service = new AuthService();
    await expect(service.userExists('owner')).resolves.toBe(true);
    await expect(service.userExists('root')).resolves.toBe(false);
    await expect(service.userExists('-owner')).resolves.toBe(false);
    await expect(service.userExists(['owner'])).resolves.toBe(false);
    expect(isServerOwner('-x', '-x')).toBe(false);
  });

  it('keeps at most MAX_PENDING_CHALLENGES challenges, dropping the oldest', () => {
    const service = new AuthService();
    const first = service.createChallenge('owner').challengeId;
    for (let i = 0; i < MAX_PENDING_CHALLENGES + 50; i++) service.createChallenge('owner');
    const challenges = (service as unknown as { challenges: Map<string, unknown> }).challenges;
    expect(challenges.size).toBe(MAX_PENDING_CHALLENGES);
    expect(challenges.has(first)).toBe(false);
  });

  it('logout revokes that token only; logging out everywhere ends every older one', () => {
    const service = new AuthService();
    const phone = service.generateTokenForUser('owner');
    const laptop = service.generateTokenForUser('owner');
    expect(service.revokeToken(phone)).toBe(true);
    expect(service.verifyToken(phone).valid).toBe(false);
    expect(service.verifyToken(laptop).valid).toBe(true);
    expect(service.revokeToken('not-a-token')).toBe(false);

    vi.advanceTimersByTime(10);
    service.revokeAllForUser('owner');
    expect(service.verifyToken(laptop).valid).toBe(false);
    vi.advanceTimersByTime(10);
    // A sign-in after it (same second) works.
    expect(service.verifyToken(service.generateTokenForUser('owner')).valid).toBe(true);
  });
});

describe('SSH authorized_keys entries', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const field = (data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, data]);
  };
  const keyData = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(rawKey)]).toString(
    'base64'
  );
  const key = `ssh-ed25519 ${keyData}`;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('JWT_SECRET', 'ssh-authorization-test');
    vi.mocked(os.userInfo).mockReturnValue({ username: 'owner' } as never);
    vi.mocked(os.homedir).mockReturnValue('/home/owner');
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each([
    [`${key} owner`, true],
    [`  ssh-ed25519\t${keyData}\towner\r\n`, true],
    [`# ${key}`, false],
    [`  #${key}`, false],
    [`command="echo limited access" ${key}`, false],
    [`from="192.0.2.1" ${key}`, false],
    [`restrict ${key}`, false],
    [`no-pty ${key}`, false],
    [`ssh-rsa ${keyData}`, false],
    [`ssh-ed25519 ${keyData}extra`, false],
    [`ssh-ed25519 unrelated comment containing ${key}`, false],
  ])('authorizes an exact unrestricted active entry: %s', async (entries, allowed) => {
    vi.mocked(fs.readFileSync).mockReturnValue(entries);
    const service = new AuthService();
    const challenge = service.createChallenge('owner');
    const signature = crypto.sign(null, Buffer.from(challenge.challenge, 'base64'), privateKey);
    const result = await service.authenticateWithSSHKey({
      challengeId: challenge.challengeId,
      publicKey: key,
      signature: signature.toString('base64'),
    });
    expect(result.success).toBe(allowed);
    expect(Boolean(result.token)).toBe(allowed);
    expect(fs.readFileSync).toHaveBeenCalledWith('/home/owner/.ssh/authorized_keys', 'utf8');
  });
});

describe('LoginThrottle', () => {
  it('doubles the wait per client after the free failures, and limits everyone together', () => {
    let t = 0;
    const throttle = new LoginThrottle({ freeFailures: 2, globalFreeFailures: 4 }, () => t);
    throttle.recordFailure('a');
    throttle.recordFailure('a');
    expect(throttle.retryAfterMs('a')).toBe(0);
    throttle.recordFailure('a');
    expect(throttle.retryAfterMs('a')).toBe(1000);
    expect(throttle.retryAfterMs('b')).toBe(0);
    throttle.recordFailure('a');
    expect(throttle.retryAfterMs('a')).toBe(2000);
    // A fifth failure overall (from anyone) makes everyone wait.
    throttle.recordFailure('c');
    expect(throttle.retryAfterMs('b')).toBe(1000);
    t += 16 * 60_000;
    expect(throttle.retryAfterMs('a')).toBe(0);
    throttle.recordSuccess('a');
    expect(throttle.retryAfterMs('b')).toBe(0);
  });

  it('keeps the global backoff to a short slow-down for clean clients and exempts the tailnet and loopback (2026-10-20)', () => {
    const t = 0;
    const throttle = new LoginThrottle({ freeFailures: 2, globalFreeFailures: 2 }, () => t);
    for (let i = 0; i < 10; i++) throttle.recordFailure(`fwd:203.0.113.${i}`);
    // The attackers' own addresses wait the whole global backoff...
    expect(throttle.retryAfterMs('fwd:203.0.113.1')).toBeGreaterThan(2000);
    // ...a client without failures only a short slow-down, the tailnet and loopback not at all.
    expect(throttle.retryAfterMs('fwd:198.51.100.9')).toBe(2000);
    expect(throttle.retryAfterMs('100.101.7.8')).toBe(0);
    expect(throttle.retryAfterMs('::ffff:100.64.0.1')).toBe(0);
    expect(throttle.retryAfterMs('127.0.0.1')).toBe(0);
    // A forged forwarded tailnet address is not exempt.
    expect(throttle.retryAfterMs('fwd:100.101.7.8')).toBe(2000);
    // Exempt clients still have their own bucket and do not feed the global one.
    const quiet = new LoginThrottle({ freeFailures: 2, globalFreeFailures: 2 }, () => t);
    for (let i = 0; i < 3; i++) quiet.recordFailure('127.0.0.1');
    expect(quiet.retryAfterMs('127.0.0.1')).toBe(1000);
    expect(quiet.retryAfterMs('fwd:198.51.100.9')).toBe(0);
  });

  it('knows which client keys are exempt from the global bucket', () => {
    expect(isGlobalThrottleExempt('100.64.0.0')).toBe(true);
    expect(isGlobalThrottleExempt('100.127.255.255')).toBe(true);
    expect(isGlobalThrottleExempt('100.128.0.1')).toBe(false);
    expect(isGlobalThrottleExempt('100.63.0.1')).toBe(false);
    expect(isGlobalThrottleExempt('fd7a:115c:a1e0::1')).toBe(true);
    expect(isGlobalThrottleExempt('::1')).toBe(true);
    expect(isGlobalThrottleExempt('fwd:127.0.0.1')).toBe(false);
    expect(isGlobalThrottleExempt('192.168.1.2')).toBe(false);
  });
});
