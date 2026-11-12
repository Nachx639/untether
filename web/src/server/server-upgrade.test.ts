import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ServerInstance, startTestServer, stopServer } from '../test/utils/server-utils.js';

describe('WebSocket upgrade request parsing', () => {
  let server: ServerInstance;

  beforeAll(async () => {
    server = await startTestServer({
      args: ['--port', '0', '--preview-port', 'off'],
      env: { NODE_ENV: 'test' },
      logOutput: false,
      waitForHealth: true,
    });
  }, 30_000);

  afterAll(async () => {
    if (server) await stopServer(server.process);
  });

  // Use TCP so the HTTP client cannot normalize or reject the malformed Host/target.
  function upgrade(target: string, host: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(server.port, '127.0.0.1');
      let response = '';
      socket.setEncoding('utf8');
      socket.setTimeout(3000, () => socket.destroy(new Error('Upgrade socket did not close')));
      socket.on('error', reject);
      socket.on('data', (data) => {
        response += data;
      });
      socket.on('close', () => resolve(response));
      socket.on('connect', () => {
        // No credentials, Origin or Sec-Fetch-Site headers: this reaches URL parsing.
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
        );
      });
    });
  }

  it.each([
    ['/ws', '['],
    ['/copilot', '['],
    ['/unknown', '['],
    ['/ws', 'localhost:invalid'],
    ['http://[/ws', 'localhost'],
  ])('rejects target %s with Host %s without stopping the server', async (target, host) => {
    expect(await upgrade(target, host)).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(server.process.exitCode).toBeNull();
    expect(server.process.signalCode).toBeNull();
    const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(health.ok).toBe(true);
    // A subsequent well-formed upgrade still reaches authentication.
    expect(await upgrade('/ws', 'localhost')).toMatch(/^HTTP\/1\.1 401 Unauthorized\r\n/);
  });

  it('keeps unknown WebSocket paths at 404', async () => {
    expect(await upgrade('/unknown', 'localhost')).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
  });
});
