// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreLocalStorage, setupLocalStorageMock } from '../../test/utils/component-helpers.js';
import { AuthClient, decodeJwtExp } from './auth-client.js';

const authLogger = vi.hoisted(() => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({ createLogger: () => authLogger }));

const TOKEN_KEY = 'untether_auth_token';
const USER_KEY = 'untether_user_data';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

function store(token: string, loginTime: number) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(
    USER_KEY,
    JSON.stringify({ userId: 'alex', authMethod: 'password', loginTime })
  );
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const DAY = 24 * 60 * 60 * 1000;

describe('SSH authentication logging', () => {
  beforeEach(() => {
    setupLocalStorageMock();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreLocalStorage();
  });

  it.each(['direct', 'automatic'] as const)(
    'keeps the token and full response out of %s SSH login logs',
    async (flow) => {
      // Synthetic values only; never use a real authentication response here.
      const response = {
        success: true,
        userId: 'test-user',
        token: 'ssh-login-regression-token',
        diagnostic: 'server-response-only',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url) => {
          if (url === '/api/auth/challenge') {
            return new Response(JSON.stringify({ challengeId: 'test', challenge: 'challenge' }));
          }
          if (url === '/api/auth/ssh-key') return new Response(JSON.stringify(response));
          throw new Error('Unexpected request');
        })
      );
      const client = new AuthClient();
      const agent = client.getSSHAgent();
      vi.spyOn(agent, 'sign').mockResolvedValue({
        signature: 'test-signature',
        algorithm: 'Ed25519',
      });
      vi.spyOn(agent, 'getPublicKey').mockReturnValue('test-public-key');
      vi.spyOn(agent, 'listKeys').mockReturnValue([
        {
          id: 'test-key',
          name: 'Test key',
          publicKey: 'test-public-key',
          algorithm: 'Ed25519',
          encrypted: false,
          fingerprint: 'test-fingerprint',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result =
        flow === 'direct'
          ? await client.authenticateWithSSHKey('test-user', 'test-key')
          : await client.authenticate('test-user');

      expect(result).toEqual(response);
      expect(client.isAuthenticated()).toBe(true);
      expect(client.getAuthHeader()).toEqual({ Authorization: `Bearer ${response.token}` });
      expect(localStorage.getItem(TOKEN_KEY)).toBe(response.token);
      expect(authLogger.log).toHaveBeenCalled();
      // Inspect the raw logger arguments so redaction cannot hide an unsafe call site.
      const logs = JSON.stringify(Object.values(authLogger).flatMap((mock) => mock.mock.calls));
      expect(logs.includes(response.token)).toBe(false);
      expect(logs.includes(response.diagnostic)).toBe(false);
    }
  );
});

// Audit 2026-10-20: "Recordar 30 días" showed the login screen the next day, and a
// network hiccup during the startup verify logged the iPhone out.
describe('AuthClient token lifetime and verification', () => {
  beforeEach(() => {
    setupLocalStorageMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreLocalStorage();
  });

  it('reads the exp claim of a JWT, or null', () => {
    expect(decodeJwtExp(jwt({ exp: 1_900_000_000 }))).toBe(1_900_000_000);
    expect(decodeJwtExp(jwt({ sub: 'x' }))).toBeNull();
    expect(decodeJwtExp('not-a-jwt')).toBeNull();
    expect(decodeJwtExp('a.%%%.c')).toBeNull();
  });

  it('keeps a remembered (30-day) token valid two days after login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ valid: true }), { status: 200 }))
    );
    const exp = Math.floor((Date.now() + 28 * DAY) / 1000);
    store(jwt({ exp }), Date.now() - 2 * DAY);
    const client = new AuthClient();
    await flush();
    expect(client.isAuthenticated()).toBe(true);
  });

  it('treats an expired JWT as signed out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
    store(jwt({ exp: Math.floor((Date.now() - 1000) / 1000) }), Date.now() - 1000);
    expect(new AuthClient().isAuthenticated()).toBe(false);
  });

  it('stays signed in when verify fails on the network or returns non-JSON', async () => {
    const exp = Math.floor((Date.now() + DAY) / 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Load failed');
      })
    );
    store(jwt({ exp }), Date.now());
    const offline = new AuthClient();
    await flush();
    expect(offline.isAuthenticated()).toBe(true);
    expect(localStorage.getItem(TOKEN_KEY)).not.toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>portal</html>', { status: 200 }))
    );
    const portal = new AuthClient();
    await flush();
    expect(portal.isAuthenticated()).toBe(true);
    expect(await portal.verifyToken()).toBe(true);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad gateway', { status: 502 }))
    );
    expect(await portal.verifyToken()).toBe(true);
  });

  it('stays signed in on a 401 that does not refuse the token (a proxy, 2026-10-20 review)', async () => {
    const exp = Math.floor((Date.now() + DAY) / 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Unauthorized</html>', { status: 401 }))
    );
    store(jwt({ exp }), Date.now());
    const client = new AuthClient();
    await flush();
    expect(client.isAuthenticated()).toBe(true);
    expect(await client.verifyToken()).toBe(true);
  });

  it('signs out when the server explicitly rejects the token', async () => {
    const exp = Math.floor((Date.now() + DAY) / 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ valid: false }), { status: 401 }))
    );
    store(jwt({ exp }), Date.now());
    const client = new AuthClient();
    // 2026-11-11: the app is told, so it can say why and show the login.
    const rejected = vi.fn();
    client.onTokenRejected(rejected);
    await flush();
    expect(client.isAuthenticated()).toBe(false);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(rejected).toHaveBeenCalledTimes(1);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ valid: false }), { status: 200 }))
    );
    store(jwt({ exp }), Date.now());
    const other = new AuthClient();
    await flush();
    expect(other.isAuthenticated()).toBe(false);
  });
});

// Audit 2026-11-08: current-user needs a session now; a 401 before signing in is expected, not
// an error, so the sign-in screen stays neutral and password/SSH sign-in still works.
describe('AuthClient.getCurrentSystemUser', () => {
  beforeEach(() => {
    setupLocalStorageMock();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreLocalStorage();
  });

  it('returns the user id when signed in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ userId: 'owner' }), { status: 200 }))
    );
    expect(await new AuthClient().getCurrentSystemUser()).toBe('owner');
  });

  it('returns null on a 401 (not signed in) instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401 })
      )
    );
    expect(await new AuthClient().getCurrentSystemUser()).toBeNull();
  });

  it('throws on other failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 }))
    );
    await expect(new AuthClient().getCurrentSystemUser()).rejects.toThrow();
  });
});
