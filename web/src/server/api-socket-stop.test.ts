import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../test/helpers/rm-test-dir.js';

// 2026-11-11 (server audit): a server that stopped after its replacement had started deleted
// api.sock, which by then was the new server's: `ut` could not reach the server that was
// running until the next restart. Real unix sockets in a throwaway control dir.
describe('api.sock when a server stops', () => {
  let dir: string;
  let previous: string | undefined;
  let ApiSocketServer: typeof import('./api-socket-server.js').ApiSocketServer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vtt-stop-'));
    previous = process.env.UNTETHER_CONTROL_DIR;
    process.env.UNTETHER_CONTROL_DIR = dir;
    ({ ApiSocketServer } = await import('./api-socket-server.js'));
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.UNTETHER_CONTROL_DIR;
    else process.env.UNTETHER_CONTROL_DIR = previous;
    rmSync(dir, RM_TEST_DIR);
  });

  const connects = (socketPath: string) =>
    new Promise<boolean>((resolve) => {
      const client = net.createConnection(socketPath);
      client.once('connect', () => {
        client.destroy();
        resolve(true);
      });
      client.once('error', () => resolve(false));
    });

  it('deletes its own socket', async () => {
    const server = new ApiSocketServer();
    await server.start();
    const socketPath = join(dir, 'api.sock');
    expect(await connects(socketPath)).toBe(true);
    server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("leaves a newer server's socket where it is, still answering", async () => {
    const socketPath = join(dir, 'api.sock');
    const old = new ApiSocketServer();
    await old.start();
    const replacement = new ApiSocketServer();
    await replacement.start();
    const inode = statSync(socketPath).ino;

    old.stop();
    expect(existsSync(socketPath)).toBe(true);
    expect(statSync(socketPath).ino).toBe(inode);
    expect(await connects(socketPath)).toBe(true);
    // Nothing of the rescue is left beside it.
    replacement.stop();
    expect(existsSync(socketPath)).toBe(false);
  });
});
