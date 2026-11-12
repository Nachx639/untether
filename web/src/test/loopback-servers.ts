import type * as http from 'node:http';
import { createRequire } from 'node:module';
import type * as net from 'node:net';

/**
 * Test servers listen on 127.0.0.1, never on the wildcard.
 *
 * A server listening with no host binds the dual-stack wildcard [::], while supertest and the
 * tests connect to 127.0.0.1. On macOS a listener bound to 127.0.0.1 on that same port, in any
 * process on the machine, wins those connections (the more specific bind wins, and SO_REUSEADDR
 * lets it bind on top of the wildcard). 2026-10-04: in about one full run in seven a route test
 * got someone else's answer: worktrees.test 404 instead of 200, mac-sessions.test 404 instead
 * of 409, git-routes.test 401, tasks.test a foreign 200, auth.test "socket hang up". lsof at the
 * failure showed a local agent gateway's MCP loopback listener on 127.0.0.1 at the test server's
 * port, serving the request. Bound to 127.0.0.1, the port cannot be shared: whoever comes second
 * gets EADDRINUSE instead of silently taking the traffic.
 *
 * Both patches go through require, so a test's vi.mock('net') neither sees nor drops them.
 */

const PATCHED = Symbol.for('untether.test.loopbackServers');
const STARTING = Symbol('starting');
/** On a server we started: how many requests still use it. */
const USERS = Symbol('users');
const LOOPBACK = '127.0.0.1';

type Callback = (err: unknown, res: unknown) => void;

interface SupertestTest {
  app: http.Server & { [STARTING]?: true; [USERS]?: number };
  url: string;
  _server?: http.Server;
  [STARTING]?: true;
  end(fn?: Callback): SupertestTest;
  serverAddress(app: http.Server, path: string): string;
}

export function installLoopbackServers(): void {
  const require = createRequire(import.meta.url);
  const netModule = require('node:net') as typeof net;
  const serverProto = netModule.Server.prototype as net.Server & { [PATCHED]?: true };
  if (serverProto[PATCHED]) return;
  serverProto[PATCHED] = true;

  // The guard: a TCP listen on port 0 without a host is exactly the bind that can be hijacked.
  const listen = serverProto.listen as (...args: unknown[]) => net.Server;
  serverProto.listen = function (this: net.Server, ...args: unknown[]) {
    const [first, second] = args;
    const options =
      typeof first === 'object' && first !== null ? (first as net.ListenOptions) : null;
    if (
      (first === 0 && typeof second !== 'string') ||
      (options?.port === 0 && !options.host && options.path === undefined)
    ) {
      throw new Error(
        `a test server on port 0 without a host binds the wildcard, where another process's ` +
          `127.0.0.1 listener on the same port takes its connections: listen(0, '${LOOPBACK}') ` +
          `and wait for 'listening' (src/test/loopback-servers.ts)`
      );
    }
    return listen.apply(this, args);
  } as typeof serverProto.listen;

  // supertest's request(app) calls app.listen(0) and reads the port at once, which works only
  // for the wildcard (with a host the bind waits for a lookup). Listen on 127.0.0.1 instead and
  // send the request once the port is known.
  const { Test } = require('supertest') as { Test: { prototype: SupertestTest } };
  Test.prototype.serverAddress = function (this: SupertestTest, app: http.Server, path: string) {
    const address = app.address();
    if (address && typeof address === 'object') return `http://${LOOPBACK}:${address.port}${path}`;
    this[STARTING] = true;
    // An agent shares one server: the first request starts it, the others wait for it.
    if (!this.app[STARTING]) {
      this.app[STARTING] = true;
      this.app[USERS] = 0;
      app.once('listening', () => delete this.app[STARTING]);
      // Not this._server: supertest closes that when this request ends, while the agent's
      // other requests may still be on it (read ECONNRESET). The last one closes it (end).
      app.listen(0, LOOPBACK);
    }
    return `http://${LOOPBACK}:0${path}`;
  };

  const end = Test.prototype.end;
  Test.prototype.end = function (this: SupertestTest, fn?: Callback) {
    const server = this.app;
    if (server[USERS] === undefined) return end.call(this, fn);
    server[USERS] += 1;
    const done: Callback = (err, res) => {
      server[USERS] = (server[USERS] ?? 1) - 1;
      if (server[USERS] > 0 || !server.listening) return fn?.(err, res);
      delete server[USERS];
      server.close(() => fn?.(err, res));
    };
    if (!this[STARTING]) return end.call(this, done);
    delete this[STARTING];
    const send = () => {
      server.off('error', fail);
      const { port } = server.address() as net.AddressInfo;
      this.url = this.url.replace(`://${LOOPBACK}:0`, `://${LOOPBACK}:${port}`);
      end.call(this, done);
    };
    const fail = (error: Error) => {
      server.off('listening', send);
      delete server[USERS];
      fn?.(error, undefined);
    };
    if (server.listening) {
      send();
    } else {
      server.once('listening', send);
      server.once('error', fail);
    }
    return this;
  };
}
