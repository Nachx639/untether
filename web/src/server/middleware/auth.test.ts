import type { NetworkInterfaceInfo } from 'node:os';
import { networkInterfaces } from 'node:os';
import type { NextFunction, Response } from 'express';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthRoutes } from '../routes/auth.js';
import type { AuthService } from '../services/auth-service.js';
import {
  type AuthenticatedRequest,
  createAuthMiddleware,
  invalidTokenLogLine,
  isAllowedNoAuthHost,
  isLocalMachineAddress,
  isPublicAuthRoute,
  isRelayedByTailscale,
  isTailscalePeer,
  ownerLoginFromStatus,
  parseLsofSockets,
  TAILSCALE_PEER_NEGATIVE_TTL_MS,
  UNAUTHORIZED_LOG_WINDOW_MS,
  unauthorizedLogLine,
  verifyTailscalePeer,
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

type AuthConfig = Parameters<typeof createAuthMiddleware>[0];

/**
 * The flags the server always passes are off unless a test turns them on. The Mac's Tailscale
 * owner is one of the two logins the tests sign in as.
 */
function authMiddleware(config: Partial<AuthConfig>) {
  return createAuthMiddleware({
    enableSSHKeys: false,
    disallowUserPassword: false,
    noAuth: false,
    isHQMode: false,
    tailscaleOwners: async () => ['user@example.com', 'owner@example.com'],
    ...config,
  });
}

describe('Auth Middleware', () => {
  let app: express.Express;
  let mockAuthService: AuthService;
  let mockNext: NextFunction;
  let mockRes: Response;

  beforeEach(() => {
    app = express();
    app.use(express.json());

    // Mock auth service
    mockAuthService = {
      verifyPassword: vi.fn(),
      generateAuthToken: vi.fn(),
      verifyAuthToken: vi.fn(),
      verifyToken: vi.fn(), // Add the correct method name
      revokeAuthToken: vi.fn(),
      isSSHKeyAuthenticated: vi.fn(),
      authenticateWithSSHKey: vi.fn(),
      markSSHKeyAuthenticated: vi.fn(),
      clearSSHKeyAuthentication: vi.fn(),
    } as unknown as AuthService;

    mockNext = vi.fn();
    mockRes = {
      setHeader: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as Response;

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('No Auth Mode', () => {
    it('should bypass authentication when noAuth is true', async () => {
      const middleware = authMiddleware({ noAuth: true });

      app.use('/api', middleware);
      app.get('/api/test', (_req, res) => res.json({ success: true }));

      const response = await request(app).get('/api/test');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
    });
  });

  describe('Tailscale Authentication', () => {
    it('should authenticate user with valid Tailscale headers from localhost', async () => {
      const middleware = authMiddleware({
        allowTailscaleAuth: true,
        authService: mockAuthService,
        tailscalePeerCheck: async () => true,
      });

      app.use('/api', middleware);
      app.get('/api/test', (req: AuthenticatedRequest, res) => {
        res.json({
          success: true,
          userId: req.userId,
          authMethod: req.authMethod,
          tailscaleUser: req.tailscaleUser,
        });
      });

      const response = await request(app)
        .get('/api/test')
        .set('tailscale-user-login', 'user@example.com')
        .set('tailscale-user-name', 'Test User')
        .set('tailscale-user-profile-pic', 'https://example.com/pic.jpg')
        .set('x-forwarded-proto', 'https')
        .set('x-forwarded-for', '100.64.0.1')
        .set('x-forwarded-host', 'myhost.tailnet.ts.net');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        userId: 'user@example.com',
        authMethod: 'tailscale',
        tailscaleUser: {
          login: 'user@example.com',
          name: 'Test User',
          profilePic: 'https://example.com/pic.jpg',
        },
      });
    });

    it('should reject Tailscale headers without proxy headers', async () => {
      const middleware = authMiddleware({
        allowTailscaleAuth: true,
        authService: mockAuthService,
        tailscalePeerCheck: async () => true,
      });

      app.use('/api', middleware);
      app.get('/api/test', (_req, res) => res.json({ success: true }));

      const response = await request(app)
        .get('/api/test')
        .set('tailscale-user-login', 'user@example.com')
        .set('tailscale-user-name', 'Test User');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Invalid proxy configuration' });
    });

    it('should reject Tailscale headers from non-localhost', async () => {
      const middleware = authMiddleware({
        allowTailscaleAuth: true,
        authService: mockAuthService,
        tailscalePeerCheck: async () => true,
      });

      // Create a custom request to control remoteAddress
      const req = {
        headers: {
          'tailscale-user-login': 'user@example.com',
          'tailscale-user-name': 'Test User',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '100.64.0.1',
          'x-forwarded-host': 'myhost.tailnet.ts.net',
        },
        socket: {
          remoteAddress: '192.168.1.100', // Non-localhost IP
        },
        path: '/test',
      } as unknown as AuthenticatedRequest;

      await middleware(req, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid request origin' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle missing Tailscale login header', async () => {
      const middleware = authMiddleware({
        allowTailscaleAuth: true,
        authService: mockAuthService,
        tailscalePeerCheck: async () => true,
      });

      app.use('/api', middleware);
      app.get('/api/test', (_req, res) => res.json({ success: true }));

      const response = await request(app)
        .get('/api/test')
        .set('tailscale-user-name', 'Test User')
        .set('x-forwarded-proto', 'https')
        .set('x-forwarded-for', '100.64.0.1')
        .set('x-forwarded-host', 'myhost.tailnet.ts.net');

      expect(response.status).toBe(401);
    });

    it('should set tailscale auth info on /api/auth endpoints', async () => {
      const middleware = authMiddleware({
        allowTailscaleAuth: true,
        authService: mockAuthService,
        tailscalePeerCheck: async () => true,
      });

      app.use('/api', middleware);
      app.get('/api/auth/config', (req: AuthenticatedRequest, res) => {
        res.json({
          authMethod: req.authMethod,
          userId: req.userId,
          tailscaleUser: req.tailscaleUser,
        });
      });

      const response = await request(app)
        .get('/api/auth/config')
        .set('tailscale-user-login', 'user@example.com')
        .set('tailscale-user-name', 'Test User')
        .set('x-forwarded-proto', 'https')
        .set('x-forwarded-for', '100.64.0.1')
        .set('x-forwarded-host', 'myhost.tailnet.ts.net');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        authMethod: 'tailscale',
        userId: 'user@example.com',
      });
    });
  });

  describe('Local Bypass Authentication', () => {
    it('should allow local requests that carry the local auth token', async () => {
      const middleware = authMiddleware({
        allowLocalBypass: true,
        localAuthToken: 'secret-token',
        authService: mockAuthService,
      });

      app.use('/api', middleware);
      app.get('/api/test', (req: AuthenticatedRequest, res) => {
        res.json({
          success: true,
          authMethod: req.authMethod,
          userId: req.userId,
        });
      });

      // Supertest automatically sets host to 127.0.0.1 for local requests
      const response = await request(app).get('/api/test').set('x-untether-local', 'secret-token');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        success: true,
        authMethod: 'local-bypass',
        userId: 'local-user',
      });
    });

    it('fails closed: without a configured token no local request bypasses the login', async () => {
      // 2026-10-27 (security sweep): a missing token let every local process in.
      const middleware = authMiddleware({
        allowLocalBypass: true,
        authService: mockAuthService,
      });

      app.use('/api', middleware);
      app.get('/api/test', (_req, res) => res.json({ success: true }));

      expect((await request(app).get('/api/test')).status).toBe(401);
      expect((await request(app).get('/api/test').set('x-untether-local', '')).status).toBe(401);
      expect((await request(app).get('/api/test').set('x-untether-local', 'anything')).status).toBe(
        401
      );
    });

    it('should require token for local bypass when localAuthToken is set', async () => {
      const middleware = authMiddleware({
        allowLocalBypass: true,
        localAuthToken: 'secret-token',
        authService: mockAuthService,
      });

      app.use('/api', middleware);
      app.get('/api/test', (_req, res) => res.json({ success: true }));

      // Without token
      const response1 = await request(app).get('/api/test');
      expect(response1.status).toBe(401);

      // With wrong token
      const response2 = await request(app).get('/api/test').set('x-untether-local', 'wrong-token');
      expect(response2.status).toBe(401);

      // With correct token
      const response3 = await request(app).get('/api/test').set('x-untether-local', 'secret-token');
      expect(response3.status).toBe(200);
    });

    it('should accept a valid local token from a non-loopback interface', async () => {
      const localInterfaceAddress = Object.values(networkInterfaces())
        .flatMap((addresses) => addresses ?? [])
        .find((entry) => !entry.internal)?.address;
      expect(localInterfaceAddress).toBeDefined();

      const middleware = authMiddleware({
        allowLocalBypass: true,
        localAuthToken: 'secret-token',
        authService: mockAuthService,
      });
      const req = {
        headers: {
          host: localInterfaceAddress,
          'x-untether-local': 'secret-token',
        },
        hostname: localInterfaceAddress?.includes(':')
          ? `[${localInterfaceAddress}]`
          : localInterfaceAddress,
        socket: {
          remoteAddress: localInterfaceAddress,
        },
        path: '/test',
      } as unknown as AuthenticatedRequest;

      await middleware(req, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(req.authMethod).toBe('local-bypass');
    });

    it('should reject a valid local token from a remote address', async () => {
      const middleware = authMiddleware({
        allowLocalBypass: true,
        localAuthToken: 'secret-token',
        authService: mockAuthService,
      });
      const req = {
        headers: {
          host: 'localhost',
          'x-untether-local': 'secret-token',
        },
        hostname: 'localhost',
        socket: {
          remoteAddress: '203.0.113.10',
        },
        query: {},
        path: '/test',
      } as unknown as AuthenticatedRequest;

      await middleware(req, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(401);
    });

    it('should reject requests with forwarded headers even from localhost', async () => {
      const middleware = authMiddleware({
        allowLocalBypass: true,
        authService: mockAuthService,
      });

      app.use('/api', middleware);
      app.get('/api/test', (_req, res) => res.json({ success: true }));

      const response = await request(app).get('/api/test').set('X-Forwarded-For', '192.168.1.100');

      expect(response.status).toBe(401);
    });
  });

  describe('Bearer Token Authentication', () => {
    it('should authenticate with valid bearer token', async () => {
      mockAuthService.verifyToken = vi.fn().mockReturnValue({ valid: true, userId: 'test-user' });

      const middleware = authMiddleware({
        authService: mockAuthService,
        enableSSHKeys: true,
      });

      app.use('/api', middleware);
      app.get('/api/test', (req: AuthenticatedRequest, res) => {
        res.json({
          success: true,
          userId: req.userId,
          authMethod: req.authMethod,
        });
      });

      const response = await request(app)
        .get('/api/test')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        success: true,
        userId: 'test-user',
        authMethod: 'ssh-key',
      });
      expect(mockAuthService.verifyToken).toHaveBeenCalledWith('valid-token');
    });

    it('should reject invalid bearer token', async () => {
      mockAuthService.verifyToken = vi.fn().mockReturnValue({ valid: false });

      const middleware = authMiddleware({
        authService: mockAuthService,
      });

      app.use('/api', middleware);
      app.get('/api/test', (_req, res) => res.json({ success: true }));

      const response = await request(app)
        .get('/api/test')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(401);
    });
  });

  describe('Security Validations', () => {
    it('skips auth only for the listed sign-in routes', async () => {
      const middleware = authMiddleware({
        authService: mockAuthService,
      });

      app.use('/api', middleware);
      app.use('/api', (_req, res) => res.json({ success: true }));

      for (const path of ['/api/auth/password', '/api/auth/config']) {
        expect((await request(app).post(path)).status, path).toBe(200);
      }
      // 2026-10-20: `startsWith('/auth')` opened any future /auth* route.
      // 2026-11-08: current-user and avatar need a login now (no system-user/photo leak).
      for (const path of [
        '/api/auth/login',
        '/api/authority',
        '/api/auth/avatar/a/b',
        '/api/auth/avatar/alex',
        '/api/auth/current-user',
      ]) {
        expect((await request(app).post(path)).status, path).toBe(401);
      }
      expect(isPublicAuthRoute('/auth/tailscale-token')).toBe(true);
      expect(isPublicAuthRoute('/auth/current-user')).toBe(false);
      expect(isPublicAuthRoute('/auth/avatar/alex')).toBe(false);
      expect(isPublicAuthRoute('/authx')).toBe(false);
    });

    // 2026-10-20 (audit): it took 10 MB bodies from anyone; the client only sends logs
    // signed in (or in no-auth mode).
    it('requires a login for client logging', async () => {
      const middleware = authMiddleware({
        authService: mockAuthService,
      });

      app.use(middleware);
      app.post('/logs/client', (_req, res) => res.json({ success: true }));

      expect((await request(app).post('/logs/client')).status).toBe(401);
    });

    // 2026-10-04: all of /logs and /push were open. Anyone who could reach the server could read
    // the server log (what was typed into terminals) or subscribe a push endpoint of their own
    // and receive every Claude reply and permission request.
    it.each([
      ['get', '/logs/raw'],
      ['get', '/logs/info'],
      ['delete', '/logs/clear'],
      ['post', '/logs/flush'],
      ['post', '/push/subscribe'],
      ['post', '/push/unsubscribe'],
      ['post', '/push/test'],
      ['get', '/push/status'],
      ['get', '/push/vapid-public-key'],
      ['get', '/logs/client'],
    ] as const)('requires a login for %s %s', async (method, path) => {
      const middleware = authMiddleware({
        authService: mockAuthService,
      });

      app.use(middleware);
      app[method](path, (_req, res) => res.json({ success: true }));

      const response = await request(app)[method](path);
      expect(response.status).toBe(401);
    });

    it('should require auth for other endpoints when no auth method succeeds', async () => {
      const middleware = authMiddleware({
        authService: mockAuthService,
      });

      app.use('/api', middleware);
      app.get('/api/sessions', (_req, res) => res.json({ success: true }));

      const response = await request(app).get('/api/sessions');
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Authentication required' });
    });
  });

  describe('IPv6 localhost handling', () => {
    it('should recognize IPv4-mapped and scoped local interface addresses', () => {
      const interfaces = {
        en0: [
          {
            address: '192.0.2.10',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '192.0.2.10/24',
          },
          {
            address: 'fe80::1234%en0',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: 'fe80::1234/64',
            scopeid: 4,
          },
          {
            address: '2001:db8::1',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: '2001:db8::1/64',
            scopeid: 0,
          },
        ],
      } as unknown as NodeJS.Dict<NetworkInterfaceInfo[]>;

      expect(isLocalMachineAddress('::ffff:192.0.2.10', interfaces)).toBe(true);
      expect(isLocalMachineAddress('fe80::1234%en0', interfaces)).toBe(true);
      expect(isLocalMachineAddress('[2001:0DB8:0000:0000:0000:0000:0000:0001]', interfaces)).toBe(
        true
      );
      expect(isLocalMachineAddress('203.0.113.10', interfaces)).toBe(false);
    });

    it('should accept ::1 as localhost for Tailscale auth', async () => {
      const middleware = authMiddleware({
        allowTailscaleAuth: true,
        authService: mockAuthService,
        tailscalePeerCheck: async () => true,
      });

      const req = {
        headers: {
          'tailscale-user-login': 'user@example.com',
          'tailscale-user-name': 'Test User',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '100.64.0.1',
          'x-forwarded-host': 'myhost.tailnet.ts.net',
        },
        socket: {
          remoteAddress: '::1', // IPv6 localhost
        },
        path: '/test',
      } as unknown as AuthenticatedRequest;

      await middleware(req, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should accept ::ffff:127.0.0.1 as localhost for Tailscale auth', async () => {
      const middleware = authMiddleware({
        allowTailscaleAuth: true,
        authService: mockAuthService,
        tailscalePeerCheck: async () => true,
      });

      const req = {
        headers: {
          'tailscale-user-login': 'user@example.com',
          'tailscale-user-name': 'Test User',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '100.64.0.1',
          'x-forwarded-host': 'myhost.tailnet.ts.net',
        },
        socket: {
          remoteAddress: '::ffff:127.0.0.1', // IPv4-mapped IPv6
        },
        path: '/test',
      } as unknown as AuthenticatedRequest;

      await middleware(req, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });
});

describe('logging refused requests', () => {
  it('logs a repeated one once an hour, then says how many came meanwhile', () => {
    const at = 1_000_000;
    const ask = (offset: number) =>
      unauthorizedLogLine('GET', '/git/repo-info', '127.0.0.1', at + offset);
    expect(ask(0)).toBe('Unauthorized request to GET /git/repo-info from 127.0.0.1');
    expect(ask(10 * 60 * 1000)).toBeNull();
    expect(ask(20 * 60 * 1000)).toBeNull();
    expect(
      unauthorizedLogLine(
        'POST',
        '/git/event',
        '127.0.0.1',
        at + 1,
        'no credentials; user-agent: node'
      )
    ).toBe(
      'Unauthorized request to POST /git/event from 127.0.0.1 [no credentials; user-agent: node]'
    );
    expect(ask(UNAUTHORIZED_LOG_WINDOW_MS + 1)).toBe(
      'Unauthorized request to GET /git/repo-info from 127.0.0.1 (2 more like it since the last line)'
    );
  });
});

describe("Tailscale identity needs Tailscale's own connection (2026-10-20 audit)", () => {
  const tailscaleHeaders = {
    'tailscale-user-login': 'owner@example.com',
    'tailscale-user-name': 'Owner',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '100.64.0.7',
    'x-forwarded-host': 'mac.tailnet.ts.net',
  };

  it('refuses identity headers that a local process forged', async () => {
    const app = express();
    app.use(
      '/api',
      authMiddleware({ allowTailscaleAuth: true, tailscalePeerCheck: async () => false })
    );
    app.use('/api', (req: AuthenticatedRequest, res) =>
      res.json({ authMethod: req.authMethod ?? null })
    );

    const api = await request(app).get('/api/sessions').set(tailscaleHeaders);
    expect(api.status).toBe(401);
    // The sign-in routes still answer, but without a Tailscale identity to mint a token from.
    const config = await request(app).get('/api/auth/config').set(tailscaleHeaders);
    expect(config.status).toBe(200);
    expect(config.body.authMethod).toBeNull();
  });

  it('really checks the connection: a request from this process is not Tailscale', async () => {
    // Real lsof, real socket: supertest's client end belongs to this very process.
    const app = express();
    app.use('/api', authMiddleware({ allowTailscaleAuth: true }));
    app.get('/api/test', (_req, res) => res.json({ ok: true }));
    const response = await request(app).get('/api/test').set(tailscaleHeaders);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Unverified Tailscale proxy' });
  });

  it('a refused Tailscale identity still lets a valid bearer token in (2026-10-20)', async () => {
    const authService = {
      verifyToken: vi.fn((token: string) =>
        token === 'good' ? { valid: true, userId: 'owner' } : { valid: false }
      ),
    } as unknown as AuthService;
    const app = express();
    app.use(
      '/api',
      authMiddleware({
        allowTailscaleAuth: true,
        authService,
        tailscalePeerCheck: async () => false,
      })
    );
    app.get('/api/test', (req: AuthenticatedRequest, res) =>
      res.json({ authMethod: req.authMethod })
    );
    const ok = await request(app)
      .get('/api/test')
      .set(tailscaleHeaders)
      .set('Authorization', 'Bearer good');
    expect(ok.status).toBe(200);
    expect(ok.body.authMethod).toBe('password');
    const none = await request(app).get('/api/test').set(tailscaleHeaders);
    expect(none.status).toBe(401);
    expect(none.body).toEqual({ error: 'Unverified Tailscale proxy' });
  });

  it('forgets a refused verdict after a few seconds (2026-10-20)', async () => {
    vi.useFakeTimers();
    try {
      const req = { socket: { remoteAddress: '127.0.0.1' } } as never;
      const first = verifyTailscalePeer(req);
      await expect(first).resolves.toBe(false);
      expect(verifyTailscalePeer(req)).toBe(first);
      await vi.advanceTimersByTimeAsync(TAILSCALE_PEER_NEGATIVE_TTL_MS + 1);
      expect(verifyTailscalePeer(req)).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches the verdict per connection and refuses a socket without ports', async () => {
    const req = { socket: { remoteAddress: '127.0.0.1' } } as never;
    const first = verifyTailscalePeer(req);
    expect(verifyTailscalePeer(req)).toBe(first);
    await expect(first).resolves.toBe(false);
  });

  const lsof = (lines: string[]) => `${lines.join('\n')}\n`;
  const own = ['p500', 'cnode', 'f20', 'n127.0.0.1:4020->127.0.0.1:61000'];

  it('requires a visible Tailscale peer for both IPv4 and IPv6', () => {
    expect(isTailscalePeer(parseLsofSockets(lsof(own)), 4020, 61000, 500)).toBe(false);
    const appStore = [...own, 'p800', 'cIPNExtension', 'f9', 'n127.0.0.1:61000->127.0.0.1:4020'];
    expect(isTailscalePeer(parseLsofSockets(lsof(appStore)), 4020, 61000, 500)).toBe(true);
    const ipv6 = ['p500', 'cnode', 'f20', 'n[::1]:4020->[::1]:61000'];
    expect(isTailscalePeer(parseLsofSockets(lsof(ipv6)), 4020, 61000, 500)).toBe(false);
    const daemon = [...ipv6, 'p800', 'ctailscaled', 'f9', 'n[::1]:61000->[::1]:4020'];
    expect(isTailscalePeer(parseLsofSockets(lsof(daemon)), 4020, 61000, 500)).toBe(true);
  });

  it('an invisible peer cannot mint a token or access the API without an Untether token', async () => {
    const authService = {
      generateTokenForUser: vi.fn(() => 'test-token'),
      verifyToken: vi.fn((token: string) => ({ valid: token === 'good', userId: 'owner' })),
    } as unknown as AuthService;
    const app = express();
    app.use(
      '/api',
      authMiddleware({
        allowTailscaleAuth: true,
        authService,
        tailscalePeerCheck: async () =>
          isTailscalePeer(parseLsofSockets(lsof(own)), 4020, 61000, 500),
      })
    );
    app.use('/api/auth', createAuthRoutes({ authService }));
    app.get('/api/sessions', (_req, res) => res.sendStatus(204));

    const login = await request(app).post('/api/auth/tailscale-token').set(tailscaleHeaders);
    expect(login.status).toBe(401);
    expect(login.body).not.toHaveProperty('token');
    expect(authService.generateTokenForUser).not.toHaveBeenCalled();
    expect((await request(app).get('/api/sessions').set(tailscaleHeaders)).status).toBe(401);
    const authenticated = await request(app)
      .get('/api/sessions')
      .set(tailscaleHeaders)
      .set('Authorization', 'Bearer good');
    expect(authenticated.status).toBe(204);
  });

  it("refuses a peer that is one of this user's processes, or when lsof shows nothing", () => {
    const browser = [...own, 'p900', 'cGoogle Chrome H', 'f31', 'n127.0.0.1:61000->127.0.0.1:4020'];
    expect(isTailscalePeer(parseLsofSockets(lsof(browser)), 4020, 61000, 500)).toBe(false);
    const self = [...own, 'f21', 'n127.0.0.1:61000->127.0.0.1:4020'];
    expect(isTailscalePeer(parseLsofSockets(lsof(self)), 4020, 61000, 500)).toBe(false);
    expect(isTailscalePeer(parseLsofSockets(''), 4020, 61000, 500)).toBe(false);
  });
});

describe("Tailscale identity must be this Mac's owner (2026-10-29 sweep)", () => {
  const guestHeaders = {
    'tailscale-user-login': 'guest@example.com',
    'tailscale-user-name': 'Guest',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '100.64.0.9',
    'x-forwarded-host': 'mac.tailnet.ts.net',
  };

  function app(owners: () => Promise<string[]>) {
    const authService = {
      generateTokenForUser: vi.fn(() => 'test-token'),
      verifyToken: vi.fn(() => ({ valid: false })),
    } as unknown as AuthService;
    const server = express();
    server.use(
      '/api',
      authMiddleware({
        allowTailscaleAuth: true,
        authService,
        tailscalePeerCheck: async () => true,
        tailscaleOwners: owners,
      })
    );
    server.use('/api/auth', createAuthRoutes({ authService }));
    server.get('/api/sessions', (req: AuthenticatedRequest, res) =>
      res.json({ userId: req.userId })
    );
    return { server, authService };
  }

  it('another tailnet user, through the real proxy, gets neither the API nor a token', async () => {
    const { server, authService } = app(async () => ['Owner@Example.com']);
    const api = await request(server).get('/api/sessions').set(guestHeaders);
    expect(api.status).toBe(401);
    expect(api.body).toEqual({ error: "Tailscale user is not this Mac's owner" });
    const token = await request(server).post('/api/auth/tailscale-token').set(guestHeaders);
    expect(token.status).toBe(401);
    expect(token.body).not.toHaveProperty('token');
    expect(authService.generateTokenForUser).not.toHaveBeenCalled();

    // The owner (login compared without case) still signs in and gets a token.
    const owner = { ...guestHeaders, 'tailscale-user-login': 'owner@example.com' };
    const ownerApi = await request(server).get('/api/sessions').set(owner);
    expect(ownerApi.status).toBe(200);
    expect(ownerApi.body).toEqual({ userId: 'owner@example.com' });
    const ownerToken = await request(server).post('/api/auth/tailscale-token').set(owner);
    expect(ownerToken.status).toBe(200);
    expect(ownerToken.body.token).toBe('test-token');
  });

  it('fails closed when the owner is unknown or the lookup fails', async () => {
    for (const owners of [async () => [], () => Promise.reject(new Error('no tailscale'))]) {
      const { server } = app(owners);
      const owner = { ...guestHeaders, 'tailscale-user-login': 'owner@example.com' };
      expect((await request(server).get('/api/sessions').set(owner)).status).toBe(401);
    }
  });

  it("reads the owner from `tailscale status --json` (Self.UserID's LoginName)", () => {
    const status = {
      Self: { UserID: 42 },
      User: {
        '42': { ID: 42, LoginName: 'owner@example.com' },
        '7': { ID: 7, LoginName: 'guest@example.com' },
      },
    };
    expect(ownerLoginFromStatus(JSON.stringify(status))).toBe('owner@example.com');
    expect(ownerLoginFromStatus(JSON.stringify({ ...status, Self: {} }))).toBeNull();
    expect(ownerLoginFromStatus(JSON.stringify({ Self: { UserID: 42 } }))).toBeNull();
    expect(ownerLoginFromStatus('')).toBeNull();
  });
});

describe('no-auth host allowlist (DNS rebinding, 2026-10-20 audit)', () => {
  it("answers this computer's names and addresses only", () => {
    for (const host of [
      'localhost:4020',
      '127.0.0.1:4020',
      '[::1]:4020',
      '192.168.1.20:4020',
      'app.localhost',
      'mac.tailnet.ts.net',
      'MyMac.local:4020',
      'mymac',
      undefined,
    ]) {
      expect(isAllowedNoAuthHost(host, [], 'MyMac.local'), String(host)).toBe(true);
    }
    for (const host of [
      'attacker.example',
      'attacker.example:4020',
      'localhost.attacker.example',
    ]) {
      expect(isAllowedNoAuthHost(host, [], 'MyMac.local'), host).toBe(false);
    }
    expect(isAllowedNoAuthHost('tunnel.example.org', ['tunnel.example.org'], 'MyMac')).toBe(true);
  });

  it('refuses a no-auth request relayed by Tailscale Serve/Funnel (2026-10-20)', async () => {
    const app = express();
    app.use('/api', authMiddleware({ noAuth: true }));
    app.get('/api/sessions', (_req, res) => res.json({ ok: true }));
    const viaServe = await request(app)
      .get('/api/sessions')
      .set('Host', 'mac.tailnet.ts.net')
      .set('X-Forwarded-Host', 'mac.tailnet.ts.net')
      .set('X-Forwarded-For', '100.64.0.7');
    expect(viaServe.status).toBe(403);
    const viaFunnel = await request(app)
      .get('/api/sessions')
      .set('Host', 'localhost:4020')
      .set('Tailscale-Funnel-Request', '?1');
    expect(viaFunnel.status).toBe(403);
    expect(isRelayedByTailscale({ headers: { 'tailscale-user-login': 'a@b' } } as never)).toBe(
      true
    );
    // The same server started with --unsafe-no-auth-on-network answers them.
    const open = express();
    open.use('/api', authMiddleware({ noAuth: true, noAuthOnNetwork: true }));
    open.get('/api/sessions', (_req, res) => res.json({ ok: true }));
    const allowed = await request(open)
      .get('/api/sessions')
      .set('Host', 'mac.tailnet.ts.net')
      .set('X-Forwarded-Host', 'mac.tailnet.ts.net');
    expect(allowed.status).toBe(200);
  });

  it('refuses a no-auth request whose Host is a rebound name', async () => {
    const app = express();
    app.use('/api', authMiddleware({ noAuth: true }));
    app.get('/api/sessions', (_req, res) => res.json({ ok: true }));
    const rebound = await request(app).get('/api/sessions').set('Host', 'attacker.example:4020');
    expect(rebound.status).toBe(403);
    const local = await request(app).get('/api/sessions').set('Host', 'localhost:4020');
    expect(local.status).toBe(200);
  });
});

describe('?token= only on WebSocket upgrades (2026-10-20 audit)', () => {
  const authService = {
    verifyToken: vi.fn((token: string) =>
      token === 'good' ? { valid: true, userId: 'owner' } : { valid: false }
    ),
  } as unknown as AuthService;

  it('ignores ?token= on ordinary API requests', async () => {
    const app = express();
    app.use('/api', authMiddleware({ authService }));
    app.get('/api/sessions', (_req, res) => res.json({ ok: true }));
    expect((await request(app).get('/api/sessions?token=good')).status).toBe(401);
    const header = await request(app).get('/api/sessions').set('Authorization', 'Bearer good');
    expect(header.status).toBe(200);
  });

  it('accepts it on the /ws and /copilot upgrades', async () => {
    const middleware = authMiddleware({ authService });
    for (const path of ['/ws', '/copilot']) {
      const next = vi.fn();
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
      const req = {
        path,
        method: 'GET',
        headers: { upgrade: 'websocket' },
        query: { token: 'good' },
        socket: { remoteAddress: '100.64.0.7' },
      } as unknown as AuthenticatedRequest;
      await middleware(req, res as unknown as Response, next);
      expect(next, path).toHaveBeenCalled();
      expect(req.userId).toBe('owner');
    }
  });
});

// 2026-10-20: a device with an expired token retried its WebSocket every ~30 s all day.
describe('an expired or invalid token', () => {
  const authService = {
    verifyToken: vi.fn((token: string) =>
      token === 'good' ? { valid: true, userId: 'owner' } : { valid: false }
    ),
  } as unknown as AuthService;

  it('answers 401 token_invalid, so the client logs in again', async () => {
    const app = express();
    app.use('/api', authMiddleware({ authService }));
    app.get('/api/sessions', (_req, res) => res.json({ ok: true }));
    const bad = await request(app).get('/api/sessions').set('Authorization', 'Bearer expired');
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: 'token_invalid' });
    // No credentials at all: the usual answer.
    const none = await request(app).get('/api/sessions');
    expect(none.body).toEqual({ error: 'Authentication required' });
  });

  it('on the /ws upgrade too (?token=)', async () => {
    const middleware = authMiddleware({ authService });
    const next = vi.fn();
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })), setHeader: vi.fn() };
    const req = {
      path: '/ws',
      method: 'GET',
      headers: { upgrade: 'websocket', 'user-agent': 'TV' },
      query: { token: 'expired' },
      socket: { remoteAddress: '100.64.0.9' },
    } as unknown as AuthenticatedRequest;
    await middleware(req, res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: 'token_invalid' });
  });

  it('is logged once per client per hour, with the count of repeats', () => {
    const t0 = Date.parse('2026-10-20T10:00:00Z');
    expect(invalidTokenLogLine('query', '100.64.0.42', 'TV', t0)).toMatch(/Invalid query token/);
    for (let i = 1; i <= 5; i++) {
      expect(invalidTokenLogLine('query', '100.64.0.42', 'TV', t0 + i * 30_000)).toBeNull();
    }
    // Another client is its own line.
    expect(invalidTokenLogLine('query', '100.64.0.43', 'TV', t0 + 1000)).not.toBeNull();
    expect(
      invalidTokenLogLine('query', '100.64.0.42', 'TV', t0 + UNAUTHORIZED_LOG_WINDOW_MS + 1)
    ).toMatch(/5 more since the last line/);
  });
});

describe('health optional auth (2026-11-08 audit)', () => {
  let mockAuthService: AuthService;
  beforeEach(() => {
    mockAuthService = { verifyToken: vi.fn() } as unknown as AuthService;
  });

  const healthApp = (config: Partial<AuthConfig>) => {
    const app = express();
    app.use(express.json());
    app.use('/api', authMiddleware(config));
    // Echoes whatever identity the middleware annotated (server-static.ts decides minimal vs detail).
    app.get('/api/health', (req: AuthenticatedRequest, res) =>
      res.json({ userId: req.userId ?? null, authMethod: req.authMethod ?? null })
    );
    return app;
  };

  it('lets an unauthenticated probe through with no identity', async () => {
    const res = await request(healthApp({ authService: mockAuthService })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: null, authMethod: null });
  });

  it('annotates the identity for a valid bearer token', async () => {
    vi.mocked(mockAuthService.verifyToken).mockReturnValue({ valid: true, userId: 'owner' });
    const res = await request(healthApp({ authService: mockAuthService }))
      .get('/api/health')
      .set('Authorization', 'Bearer good');
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('owner');
    expect(res.body.authMethod).toBe('password');
  });

  it('never rejects health for a bad bearer token (stays public)', async () => {
    vi.mocked(mockAuthService.verifyToken).mockReturnValue({ valid: false });
    const res = await request(healthApp({ authService: mockAuthService }))
      .get('/api/health')
      .set('Authorization', 'Bearer bad');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: null, authMethod: null });
  });
});
