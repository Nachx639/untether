import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testServerArgs } from '../test/utils/server-utils.js';
import {
  isLoopbackBindAddress,
  leftoverServeRoutesRefusal,
  parseArgs,
  unsafeNoAuthReason,
  watchParentWhenUnauthenticated,
} from './server.js';
import { shouldAdvertiseMDNS } from './server-config.js';
import { serveRoutesToPort } from './services/tailscale-serve-service.js';

// 2026-10-20 (security audit): a `--port 0 --no-auth` test server on 0.0.0.0 ran for two days.
describe('--no-auth stays on this computer', () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
  });

  const parse = (...args: string[]) => {
    process.argv = ['node', 'cli', ...args];
    return parseArgs();
  };

  it('binds 127.0.0.1 when --no-auth comes without --bind', () => {
    expect(parse('--port', '0', '--no-auth').bind).toBe('127.0.0.1');
    expect(parse('--port', '0').bind).toBeNull(); // authenticated: unchanged default
    expect(parse('--no-auth', '--bind', '0.0.0.0').bind).toBe('0.0.0.0');
  });

  // 2026-11-11: "Locked to this Mac" was only a label: the server stayed on the network.
  it('listens on loopback only when Tailscale Serve is on, whatever --bind says', () => {
    expect(parse('--enable-tailscale-serve').bind).toBe('127.0.0.1');
    expect(parse('--enable-tailscale-serve', '--bind', '0.0.0.0').bind).toBe('127.0.0.1');
    expect(parse('--bind', '192.168.1.5', '--enable-tailscale-serve').bind).toBe('127.0.0.1');
    expect(
      parse('--enable-tailscale-serve', '--enable-tailscale-funnel', '--bind', '::').bind
    ).toBe('127.0.0.1');
    expect(parse('--enable-tailscale-serve', '--bind', '::1').bind).toBe('::1');
    expect(parse('--bind', '0.0.0.0').bind).toBe('0.0.0.0'); // without Serve: as asked
    expect(shouldAdvertiseMDNS(true, parse('--enable-tailscale-serve').bind ?? '0.0.0.0')).toBe(
      false
    );
  });

  it('refuses --no-auth on a network address or with a tunnel unless told it is unsafe', () => {
    expect(unsafeNoAuthReason(parse('--no-auth'))).toBeNull();
    expect(unsafeNoAuthReason(parse('--no-auth', '--bind', '0.0.0.0'))).toMatch(/0\.0\.0\.0/);
    expect(unsafeNoAuthReason(parse('--no-auth', '--bind', '192.168.1.5'))).toMatch(/network/);
    expect(unsafeNoAuthReason(parse('--no-auth', '--ngrok'))).toMatch(/--ngrok/);
    expect(unsafeNoAuthReason(parse('--no-auth', '--enable-tailscale-serve'))).toMatch(/tailscale/);
    expect(
      unsafeNoAuthReason(parse('--no-auth', '--bind', '0.0.0.0', '--unsafe-no-auth-on-network'))
    ).toBeNull();
    expect(unsafeNoAuthReason(parse('--bind', '0.0.0.0'))).toBeNull();
  });

  // 2026-10-20: CMD ["--no-auth"] behind the entrypoint's --bind 0.0.0.0 was refused at start.
  it('the Docker images start: their default arguments are allowed', () => {
    for (const file of ['Dockerfile.npm', 'Dockerfile.standalone']) {
      const text = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
      const cmd = text.match(/^CMD (\[.*\])$/m)?.[1];
      expect(cmd, file).toBeDefined();
      // Both entrypoints run the server with `--bind 0.0.0.0 "$@"`.
      const config = parse('--bind', '0.0.0.0', ...(JSON.parse(cmd as string) as string[]));
      expect(unsafeNoAuthReason(config), file).toBeNull();
      expect(config.bind, file).toBe('0.0.0.0');
    }
  });

  it('announces mDNS only when the network can reach the server', () => {
    // 2026-11-10 (iOS audit): bound to loopback it was still announced, and the iPhone app
    // listed a Mac it could not connect to
    expect(shouldAdvertiseMDNS(true, '0.0.0.0')).toBe(true);
    expect(shouldAdvertiseMDNS(true, '192.168.1.5')).toBe(true);
    expect(shouldAdvertiseMDNS(true, '127.0.0.1')).toBe(false);
    expect(shouldAdvertiseMDNS(true, '::1')).toBe(false);
    expect(shouldAdvertiseMDNS(false, '0.0.0.0')).toBe(false);
  });

  it('knows loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost']) {
      expect(isLoopbackBindAddress(a), a).toBe(true);
    }
    for (const a of ['0.0.0.0', '::', '192.168.1.5', '100.64.0.1']) {
      expect(isLoopbackBindAddress(a), a).toBe(false);
    }
  });

  it('test servers always get a loopback bind', () => {
    expect(testServerArgs(['--port', '0', '--no-auth'])).toEqual([
      '--port',
      '0',
      '--no-auth',
      '--bind',
      '127.0.0.1',
    ]);
    expect(testServerArgs(['--bind', '::1'])).toEqual(['--bind', '::1']);
  });
});

describe('an unauthenticated server exits with its parent', () => {
  afterEach(() => vi.useRealTimers());

  it('notices being re-parented', () => {
    vi.useFakeTimers();
    let ppid = 4242;
    const onOrphaned = vi.fn();
    const stop = watchParentWhenUnauthenticated({ noAuth: true }, onOrphaned, {
      ppid: () => ppid,
      env: {},
      stdinIsPipe: () => false,
    });
    vi.advanceTimersByTime(5000);
    expect(onOrphaned).not.toHaveBeenCalled();
    ppid = 1;
    vi.advanceTimersByTime(2000);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
    expect(onOrphaned.mock.calls[0][0]).toMatch(/4242/);
    stop?.();
  });

  it('in test mode, notices its stdin pipe closing', () => {
    const stdin = Object.assign(new EventEmitter(), { resume: vi.fn() });
    const onOrphaned = vi.fn();
    watchParentWhenUnauthenticated({ noAuth: false }, onOrphaned, {
      ppid: () => 4242,
      env: { UNTETHER_EXIT_WITH_PARENT: '1' },
      stdin: stdin as never,
      stdinIsPipe: () => true,
      intervalMs: 60_000,
    })?.();
    // Stopped watchers ignore it; a live one fires once.
    stdin.emit('end');
    expect(onOrphaned).not.toHaveBeenCalled();
    watchParentWhenUnauthenticated({ noAuth: false }, onOrphaned, {
      ppid: () => 4242,
      env: { UNTETHER_EXIT_WITH_PARENT: '1' },
      stdin: stdin as never,
      stdinIsPipe: () => true,
      intervalMs: 60_000,
    });
    stdin.emit('end');
    stdin.emit('close');
    expect(onOrphaned).toHaveBeenCalledTimes(1);
    expect(onOrphaned).toHaveBeenCalledWith('stdin closed');
  });

  it("leaves the Mac app's authenticated server alone", () => {
    expect(
      watchParentWhenUnauthenticated({ noAuth: false }, vi.fn(), { env: {}, ppid: () => 4242 })
    ).toBeNull();
  });
});

// 2026-10-20: a Serve/Funnel route left by an unclean shutdown forwarded to a later --no-auth
// server on the same port.
describe('a leftover Tailscale route refuses an unauthenticated start', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const noAuth = { noAuth: true, unsafeNoAuthOnNetwork: false, enableTailscaleServe: false };

  it('refuses when a route forwards to the port, starts when none does', async () => {
    vi.stubEnv('UNTETHER_TAILSCALE_BIN', '/nonexistent/fake-tailscale');
    const refusal = await leftoverServeRoutesRefusal(noAuth, 4020, async () => [
      'mac.tailnet.ts.net:443/ -> http://127.0.0.1:4020',
    ]);
    expect(refusal).toMatch(/Tailscale still forwards to port 4020/);
    expect(refusal).toMatch(/mac\.tailnet\.ts\.net/);
    expect(await leftoverServeRoutesRefusal(noAuth, 4020, async () => [])).toBeNull();
    // Signed-in servers, the explicit unsafe flag and port 0 never ask.
    const ask = vi.fn(async () => ['x']);
    expect(await leftoverServeRoutesRefusal({ ...noAuth, noAuth: false }, 4020, ask)).toBeNull();
    expect(
      await leftoverServeRoutesRefusal({ ...noAuth, unsafeNoAuthOnNetwork: true }, 4020, ask)
    ).toBeNull();
    expect(await leftoverServeRoutesRefusal(noAuth, 0, ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });

  it('finds routes to the port in background and foreground, web and TCP configs', () => {
    const status = {
      Web: {
        'mac.ts.net:443': {
          Handlers: {
            '/': { Proxy: 'http://127.0.0.1:4020' },
            '/x': { Proxy: 'http://127.0.0.1:40200' },
          },
        },
      },
      TCP: { '8443': { TCPForward: '127.0.0.1:4020' } },
      Foreground: {
        n1: { Web: { 'mac.ts.net:8443': { Handlers: { '/': { Proxy: 'localhost:4020' } } } } },
      },
    };
    expect(serveRoutesToPort(status, 4020)).toEqual([
      'mac.ts.net:443/ -> http://127.0.0.1:4020',
      'tcp:8443 -> 127.0.0.1:4020',
      'mac.ts.net:8443/ -> localhost:4020',
    ]);
    expect(serveRoutesToPort(status, 4021)).toEqual([]);
    expect(serveRoutesToPort(null, 4020)).toEqual([]);
  });
});
