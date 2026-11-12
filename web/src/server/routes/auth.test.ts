import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import {
  type AuthService,
  isGlobalThrottleExempt,
  LoginThrottle,
  serverOwnerUsername,
} from '../services/auth-service.js';
import {
  createAuthRoutes,
  loginClientKey,
  resetAvatarCachesForTest,
  trustedProxyAddresses,
} from './auth.js';

// Mock the logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Count `dscl`/`sips` spawns so the avatar cache can be asserted (no real process is run).
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', () => ({ execFile: execFileMock }));

describe('Auth Routes', () => {
  let app: express.Express;
  let mockAuthService: AuthService;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Mock auth service
    mockAuthService = {
      verifyToken: vi.fn(),
      generateTokenForUser: vi.fn(),
      createChallenge: vi.fn(),
      authenticateWithSSHKey: vi.fn(),
      authenticateWithPassword: vi.fn(),
      getCurrentUser: vi.fn(),
      userExists: vi.fn(),
    } as unknown as AuthService;

    // Mock middleware to set auth info on request
    const mockAuthMiddleware = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
      // Default to no auth
      req.authMethod = undefined;
      req.userId = undefined;
      req.tailscaleUser = undefined;
      next();
    };

    app.use(mockAuthMiddleware);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe('GET /api/auth/config', () => {
    it('should report system password authentication by default', async () => {
      vi.stubEnv('UNTETHER_USERNAME', '');
      vi.stubEnv('UNTETHER_PASSWORD', '');
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));

      const response = await request(app).get('/api/auth/config');

      expect(response.status).toBe(200);
      expect(response.body.passwordAuthMode).toBe('system');
      expect(response.body).not.toHaveProperty('passwordUserId');
    });

    it('should report configured password authentication when both credentials are set', async () => {
      vi.stubEnv('UNTETHER_USERNAME', 'configured-user');
      vi.stubEnv('UNTETHER_PASSWORD', 'configured-password');
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));

      const response = await request(app).get('/api/auth/config');

      expect(response.status).toBe(200);
      expect(response.body.passwordAuthMode).toBe('configured');
      expect(response.body).not.toHaveProperty('passwordUserId');
    });
  });

  describe('POST /api/auth/password', () => {
    it.each(['system', 'configured'])(
      'rejects disabled %s password auth before checking credentials',
      async (mode) => {
        vi.stubEnv('UNTETHER_USERNAME', mode === 'configured' ? 'configured-user' : '');
        vi.stubEnv('UNTETHER_PASSWORD', mode === 'configured' ? 'test-password' : '');
        vi.mocked(mockAuthService.authenticateWithPassword).mockResolvedValue({
          success: true,
          userId: 'owner',
          token: 'test-token',
        });
        app.use(
          '/api/auth',
          createAuthRoutes({
            authService: mockAuthService,
            enableSSHKeys: true,
            disallowUserPassword: true,
          })
        );

        const response = await request(app).post('/api/auth/password').send({
          userId: 'owner',
          password: 'test-password',
        });

        expect(response.status).toBe(403);
        expect(response.body).not.toHaveProperty('token');
        expect(mockAuthService.authenticateWithPassword).not.toHaveBeenCalled();
      }
    );

    it('should keep the configured username server-side', async () => {
      vi.stubEnv('UNTETHER_USERNAME', 'configured-user');
      vi.stubEnv('UNTETHER_PASSWORD', 'configured-password');
      mockAuthService.authenticateWithPassword = vi.fn().mockResolvedValue({
        success: true,
        userId: 'configured-user',
        token: 'test-token',
      });
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));

      const response = await request(app).post('/api/auth/password').send({
        userId: 'system-user',
        password: 'configured-password',
      });

      expect(response.status).toBe(200);
      expect(mockAuthService.authenticateWithPassword).toHaveBeenCalledWith(
        'configured-user',
        'configured-password',
        { remember: false }
      );
    });

    it('derives the server owner in system mode, ignoring any client-sent user id', async () => {
      vi.stubEnv('UNTETHER_USERNAME', '');
      vi.stubEnv('UNTETHER_PASSWORD', '');
      mockAuthService.authenticateWithPassword = vi.fn().mockResolvedValue({
        success: true,
        userId: 'owner',
        token: 'test-token',
      });
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));

      const response = await request(app).post('/api/auth/password').send({
        userId: 'someone-else',
        password: 'mac-password',
      });

      expect(response.status).toBe(200);
      expect(mockAuthService.authenticateWithPassword).toHaveBeenCalledWith(
        serverOwnerUsername(),
        'mac-password',
        { remember: false }
      );
    });

    it('requires a password but not a user id', async () => {
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));
      const response = await request(app).post('/api/auth/password').send({ userId: 'owner' });
      expect(response.status).toBe(400);
      expect(mockAuthService.authenticateWithPassword).not.toHaveBeenCalled();
    });
  });

  describe('SSH authentication methods', () => {
    it.each([false, undefined])(
      'rejects challenges and sign-in when enableSSHKeys is %s',
      async (enableSSHKeys) => {
        vi.mocked(mockAuthService.userExists).mockResolvedValue(true);
        vi.mocked(mockAuthService.createChallenge).mockReturnValue({
          challengeId: 'c',
          challenge: 'x',
        });
        vi.mocked(mockAuthService.authenticateWithSSHKey).mockResolvedValue({
          success: true,
          userId: 'owner',
          token: 'test-token',
        });
        app.use('/api/auth', createAuthRoutes({ authService: mockAuthService, enableSSHKeys }));

        const challenge = await request(app).post('/api/auth/challenge').send({ userId: 'owner' });
        expect(challenge.status).toBe(403);
        expect(challenge.body).not.toHaveProperty('challenge');
        expect(mockAuthService.userExists).not.toHaveBeenCalled();
        expect(mockAuthService.createChallenge).not.toHaveBeenCalled();

        const login = await request(app).post('/api/auth/ssh-key').send({
          challengeId: 'c',
          publicKey: 'test-key',
          signature: 'test-signature',
        });
        expect(login.status).toBe(403);
        expect(login.body).not.toHaveProperty('token');
        expect(mockAuthService.authenticateWithSSHKey).not.toHaveBeenCalled();
      }
    );

    it('allows challenges and SSH sign-in in SSH-only mode', async () => {
      vi.mocked(mockAuthService.userExists).mockResolvedValue(true);
      vi.mocked(mockAuthService.createChallenge).mockReturnValue({
        challengeId: 'c',
        challenge: 'x',
      });
      vi.mocked(mockAuthService.authenticateWithSSHKey).mockResolvedValue({
        success: true,
        userId: 'owner',
        token: 'test-token',
      });
      app.use(
        '/api/auth',
        createAuthRoutes({
          authService: mockAuthService,
          enableSSHKeys: true,
          disallowUserPassword: true,
        })
      );

      const challenge = await request(app).post('/api/auth/challenge').send({ userId: 'owner' });
      expect(challenge.status).toBe(200);
      expect(challenge.body.challengeId).toBe('c');
      const login = await request(app).post('/api/auth/ssh-key').send({
        challengeId: 'c',
        publicKey: 'test-key',
        signature: 'test-signature',
      });
      expect(login.status).toBe(200);
      expect(login.body.token).toBe('test-token');
    });
  });

  describe('POST /api/auth/tailscale-token', () => {
    it('should generate token for Tailscale authenticated users', async () => {
      const mockToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
      mockAuthService.generateTokenForUser = vi.fn().mockReturnValue(mockToken);

      const forceLocalhost = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
        Object.defineProperty(req.socket, 'remoteAddress', {
          value: '127.0.0.1',
          configurable: true,
        });
        next();
      };

      // Mock middleware to simulate Tailscale auth
      const tailscaleAuthMiddleware = (
        req: AuthenticatedRequest,
        _res: Response,
        next: NextFunction
      ) => {
        req.authMethod = 'tailscale';
        req.userId = 'user@example.com';
        req.tailscaleUser = {
          login: 'user@example.com',
          name: 'Test User',
          profilePic: 'https://example.com/pic.jpg',
        };
        next();
      };

      app.use('/api/auth', forceLocalhost, tailscaleAuthMiddleware);
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));

      const response = await request(app)
        .post('/api/auth/tailscale-token')
        .set('x-forwarded-for', '100.64.0.1')
        .set('x-forwarded-proto', 'https')
        .set('x-forwarded-host', 'example.ts.net')
        .set('tailscale-user-login', 'user@example.com');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        token: mockToken,
        userId: 'user@example.com',
        authMethod: 'tailscale',
        expiresIn: '24h',
      });
      expect(mockAuthService.generateTokenForUser).toHaveBeenCalledWith('user@example.com');
    });

    it('should reject requests missing proxy headers', async () => {
      const forceLocalhost = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
        Object.defineProperty(req.socket, 'remoteAddress', {
          value: '127.0.0.1',
          configurable: true,
        });
        next();
      };

      const tailscaleAuthMiddleware = (
        req: AuthenticatedRequest,
        _res: Response,
        next: NextFunction
      ) => {
        req.authMethod = 'tailscale';
        req.userId = 'user@example.com';
        req.tailscaleUser = {
          login: 'user@example.com',
          name: 'Test User',
        };
        next();
      };

      app.use('/api/auth', forceLocalhost, tailscaleAuthMiddleware);
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));

      const response = await request(app)
        .post('/api/auth/tailscale-token')
        .set('tailscale-user-login', 'user@example.com');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: 'Invalid proxy configuration',
      });
      expect(mockAuthService.generateTokenForUser).not.toHaveBeenCalled();
    });

    it('should reject requests not from localhost', async () => {
      const forceRemote = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
        Object.defineProperty(req.socket, 'remoteAddress', {
          value: '10.0.0.5',
          configurable: true,
        });
        next();
      };

      const tailscaleAuthMiddleware = (
        req: AuthenticatedRequest,
        _res: Response,
        next: NextFunction
      ) => {
        req.authMethod = 'tailscale';
        req.userId = 'user@example.com';
        req.tailscaleUser = {
          login: 'user@example.com',
          name: 'Test User',
        };
        next();
      };

      app.use('/api/auth', forceRemote, tailscaleAuthMiddleware);
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));

      const response = await request(app)
        .post('/api/auth/tailscale-token')
        .set('x-forwarded-for', '100.64.0.1')
        .set('x-forwarded-proto', 'https')
        .set('x-forwarded-host', 'example.ts.net')
        .set('tailscale-user-login', 'user@example.com');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: 'Invalid request origin',
      });
      expect(mockAuthService.generateTokenForUser).not.toHaveBeenCalled();
    });

    it('should reject when Tailscale login header mismatches userId', async () => {
      const forceLocalhost = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
        Object.defineProperty(req.socket, 'remoteAddress', {
          value: '127.0.0.1',
          configurable: true,
        });
        next();
      };

      const tailscaleAuthMiddleware = (
        req: AuthenticatedRequest,
        _res: Response,
        next: NextFunction
      ) => {
        req.authMethod = 'tailscale';
        req.userId = 'user@example.com';
        req.tailscaleUser = {
          login: 'user@example.com',
          name: 'Test User',
        };
        next();
      };

      app.use('/api/auth', forceLocalhost, tailscaleAuthMiddleware);
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));

      const response = await request(app)
        .post('/api/auth/tailscale-token')
        .set('x-forwarded-for', '100.64.0.1')
        .set('x-forwarded-proto', 'https')
        .set('x-forwarded-host', 'example.ts.net')
        .set('tailscale-user-login', 'other@example.com');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: 'Invalid Tailscale identity headers',
      });
      expect(mockAuthService.generateTokenForUser).not.toHaveBeenCalled();
    });

    it('should reject non-Tailscale authenticated requests', async () => {
      // Mock middleware to simulate non-Tailscale auth
      const nonTailscaleAuthMiddleware = (
        req: AuthenticatedRequest,
        _res: Response,
        next: NextFunction
      ) => {
        req.authMethod = 'password';
        req.userId = 'user@example.com';
        next();
      };

      app.use('/api/auth', nonTailscaleAuthMiddleware);
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));

      const response = await request(app).post('/api/auth/tailscale-token');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: 'This endpoint is only available for Tailscale authenticated users',
      });
      expect(mockAuthService.generateTokenForUser).not.toHaveBeenCalled();
    });

    it('should reject requests without user ID', async () => {
      // Mock middleware to simulate Tailscale auth without userId
      const tailscaleAuthNoUserMiddleware = (
        req: AuthenticatedRequest,
        _res: Response,
        next: NextFunction
      ) => {
        req.authMethod = 'tailscale';
        req.userId = undefined; // No user ID
        next();
      };

      app.use('/api/auth', tailscaleAuthNoUserMiddleware);
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));

      const response = await request(app).post('/api/auth/tailscale-token');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: 'No user ID found in Tailscale authentication',
      });
      expect(mockAuthService.generateTokenForUser).not.toHaveBeenCalled();
    });

    it('should handle AuthService errors gracefully', async () => {
      mockAuthService.generateTokenForUser = vi.fn().mockImplementation(() => {
        throw new Error('Token generation failed');
      });

      const forceLocalhost = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
        Object.defineProperty(req.socket, 'remoteAddress', {
          value: '127.0.0.1',
          configurable: true,
        });
        next();
      };

      // Mock middleware to simulate Tailscale auth
      const tailscaleAuthMiddleware = (
        req: AuthenticatedRequest,
        _res: Response,
        next: NextFunction
      ) => {
        req.authMethod = 'tailscale';
        req.userId = 'user@example.com';
        next();
      };

      app.use('/api/auth', forceLocalhost, tailscaleAuthMiddleware);
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));

      const response = await request(app)
        .post('/api/auth/tailscale-token')
        .set('x-forwarded-for', '100.64.0.1')
        .set('x-forwarded-proto', 'https')
        .set('x-forwarded-host', 'example.ts.net')
        .set('tailscale-user-login', 'user@example.com');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to generate token',
      });
      expect(mockAuthService.generateTokenForUser).toHaveBeenCalledWith('user@example.com');
    });

    it('should reject unauthenticated requests', async () => {
      // No auth middleware - request remains unauthenticated
      app.use('/api/auth', createAuthRoutes({ authService: mockAuthService }));

      const response = await request(app).post('/api/auth/tailscale-token');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: 'This endpoint is only available for Tailscale authenticated users',
      });
      expect(mockAuthService.generateTokenForUser).not.toHaveBeenCalled();
    });
  });
});

describe('sign-in hardening (2026-10-20 audit)', () => {
  const service = (overrides: Partial<Record<keyof AuthService, unknown>> = {}) =>
    ({
      verifyToken: vi.fn(() => ({ valid: true, userId: 'owner' })),
      revokeToken: vi.fn(() => true),
      revokeAllForUser: vi.fn(),
      authenticateWithPassword: vi.fn(async () => ({ success: false, error: 'Invalid' })),
      authenticateWithSSHKey: vi.fn(async () => ({ success: false, error: 'Invalid' })),
      userExists: vi.fn(async (id: string) => id === 'owner'),
      createChallenge: vi.fn(() => ({ challengeId: 'c', challenge: 'x' })),
      ...overrides,
    }) as unknown as AuthService;

  const appWith = (authService: AuthService, now: { t: number }) => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/auth',
      createAuthRoutes({
        authService,
        enableSSHKeys: true,
        loginThrottle: new LoginThrottle({}, () => now.t),
        challengeThrottle: new LoginThrottle({ freeFailures: 3 }, () => now.t),
      })
    );
    return app;
  };

  it('backs off after repeated wrong passwords, without even checking them', async () => {
    const now = { t: 1_000_000 };
    const authService = service();
    const app = appWith(authService, now);
    const attempt = () =>
      request(app).post('/api/auth/password').send({ userId: 'owner', password: 'guess' });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(401); // the 6th is checked, and starts the backoff
    const waiting = await attempt();
    expect(waiting.status).toBe(429);
    expect(waiting.headers['retry-after']).toBe('1');
    expect(authService.authenticateWithPassword).toHaveBeenCalledTimes(6);
    now.t += 1000;
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429); // now 2 s
  });

  it('a correct password resets the backoff', async () => {
    const now = { t: 1_000_000 };
    let correct = false;
    const authService = service({
      authenticateWithPassword: vi.fn(async () =>
        correct ? { success: true, userId: 'owner', token: 't' } : { success: false }
      ),
    });
    const app = appWith(authService, now);
    const attempt = () =>
      request(app).post('/api/auth/password').send({ userId: 'owner', password: 'pw' });
    for (let i = 0; i < 6; i++) await attempt();
    now.t += 60_000;
    correct = true;
    expect((await attempt()).status).toBe(200);
    correct = false;
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
  });

  it('challenges target the server owner, ignoring client input, and are rate-limited', async () => {
    const now = { t: 1_000_000 };
    const authService = service({ userExists: vi.fn(async () => true) });
    const app = appWith(authService, now);
    // Three free, the fourth is still answered and starts the backoff, the fifth waits. The
    // client-sent user id is ignored: the challenge always targets the account this server runs as.
    for (const status of [200, 200, 200, 200, 429]) {
      const res = await request(app).post('/api/auth/challenge').send({ userId: 'attacker' });
      expect(res.status).toBe(status);
    }
    expect(authService.userExists).toHaveBeenCalledWith(serverOwnerUsername());
    expect(authService.userExists).not.toHaveBeenCalledWith('attacker');
  });

  it('logout revokes the token it was sent, and everywhere on request', async () => {
    const authService = service();
    const app = appWith(authService, { t: 0 });
    await request(app).post('/api/auth/logout').set('Authorization', 'Bearer tok');
    expect(authService.revokeToken).toHaveBeenCalledWith('tok');
    expect(authService.revokeAllForUser).not.toHaveBeenCalled();
    await request(app)
      .post('/api/auth/logout')
      .set('Authorization', 'Bearer tok')
      .send({ everywhere: true });
    expect(authService.revokeAllForUser).toHaveBeenCalledWith('owner');
  });
});

describe('avatar: owner only, cached (2026-11-08 audit)', () => {
  const ownerAvatarApp = () => {
    const app = express();
    app.use(express.json());
    const svc = { getCurrentUser: vi.fn(), userExists: vi.fn() } as unknown as AuthService;
    app.use('/api/auth', createAuthRoutes({ authService: svc }));
    return app;
  };

  beforeEach(() => {
    resetAvatarCachesForTest();
    // Empty dscl output: no JPEGPhoto, no Picture → avatar null, but dscl was still spawned.
    execFileMock.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        cb: (e: unknown, r: { stdout: string; stderr: string }) => void
      ) => cb(null, { stdout: '', stderr: '' })
    );
  });

  afterEach(() => execFileMock.mockReset());

  it('answers a non-owner id with 404 and never spawns a process', async () => {
    if (process.platform !== 'darwin') return; // dscl path is macOS-only
    const app = ownerAvatarApp();
    const res = await request(app).get('/api/auth/avatar/not-the-owner');
    expect(res.status).toBe(404);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('serves the owner avatar and caches it so dscl is not re-spawned', async () => {
    if (process.platform !== 'darwin') return;
    const app = ownerAvatarApp();
    const owner = serverOwnerUsername();

    const first = await request(app).get(`/api/auth/avatar/${owner}`);
    expect(first.status).toBe(200);
    const spawnsAfterFirst = execFileMock.mock.calls.length;
    expect(spawnsAfterFirst).toBeGreaterThan(0);

    const second = await request(app).get(`/api/auth/avatar/${owner}`);
    expect(second.status).toBe(200);
    // Cached within the TTL: no new dscl spawn.
    expect(execFileMock.mock.calls.length).toBe(spawnsAfterFirst);
  });
});

describe('loginClientKey: X-Forwarded-For only behind a trusted proxy (2026-11-08 audit)', () => {
  const reqFrom = (remote: string, xff?: string): Request =>
    ({
      socket: { remoteAddress: remote },
      headers: xff ? { 'x-forwarded-for': xff } : {},
    }) as unknown as Request;

  it('ignores X-Forwarded-For from a peer that is not a trusted proxy', () => {
    const key = loginClientKey(reqFrom('127.0.0.1', '1.2.3.4'), new Set());
    expect(key).toBe('127.0.0.1');
  });

  it('keys each client relayed by tailscale serve apart, never on the shared 127.0.0.1 (review 2026-11-08)', () => {
    // Default trust (no UNTETHER_TRUSTED_PROXIES): loopback is the Serve/Funnel proxy. Keying all
    // of them on 127.0.0.1 put the owner and every internet client in one bucket, and loopback
    // is exempt from the global limit.
    const trusted = trustedProxyAddresses('');
    const owner = loginClientKey(reqFrom('127.0.0.1', '100.101.102.103'), trusted);
    const stranger = loginClientKey(reqFrom('::ffff:127.0.0.1', '198.51.100.7'), trusted);
    expect(owner).toBe('fwd:100.101.102.103');
    expect(stranger).toBe('fwd:198.51.100.7');
    expect(isGlobalThrottleExempt(stranger)).toBe(false);
    // A local request without a proxy header is still the loopback bucket.
    expect(loginClientKey(reqFrom('127.0.0.1'), trusted)).toBe('127.0.0.1');
  });

  it('a client-written X-Forwarded-For cannot rotate buckets through an appending proxy', () => {
    const trusted = trustedProxyAddresses('');
    for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      expect(loginClientKey(reqFrom('127.0.0.1', `${forged}, 203.0.113.50`), trusted)).toBe(
        'fwd:203.0.113.50'
      );
    }
  });

  it('a direct peer cannot pick its bucket with X-Forwarded-For', () => {
    const trusted = trustedProxyAddresses('');
    expect(loginClientKey(reqFrom('192.168.1.20', '127.0.0.1'), trusted)).toBe('192.168.1.20');
  });

  it('ignores X-Forwarded-For from an untrusted peer', () => {
    const trusted = new Set(['10.0.0.1']);
    const key = loginClientKey(reqFrom('203.0.113.9', '1.2.3.4'), trusted);
    expect(key).toBe('203.0.113.9');
  });

  it('uses the last untrusted hop when the peer is a trusted proxy', () => {
    const trusted = new Set(['10.0.0.1']);
    // client -> some-proxy(5.6.7.8) -> trusted(10.0.0.1): the real client is the last untrusted hop.
    const key = loginClientKey(reqFrom('10.0.0.1', '9.9.9.9, 5.6.7.8, 10.0.0.1'), trusted);
    expect(key).toBe('fwd:5.6.7.8');
  });

  it('normalizes IPv4-mapped IPv6 socket and header addresses', () => {
    const trusted = new Set(['10.0.0.1']);
    const key = loginClientKey(reqFrom('::ffff:10.0.0.1', '::ffff:5.6.7.8'), trusted);
    expect(key).toBe('fwd:5.6.7.8');
  });
});
