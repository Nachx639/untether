import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { UntetherSocketClient } from './socket-client.js';
import { MessageBuilder, MessageType } from './socket-protocol.js';

// 2026-11-10: a request the server answered with an ERROR frame, or whose connection it
// closed, waited out its whole timeout and failed as "Request timeout".
describe('UntetherSocketClient.sendMessageWithResponse', () => {
  let dir: string;
  let server: net.Server;
  let onRequest: (socket: net.Socket) => void;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-sock-'));
    server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => onRequest(socket));
    });
    await new Promise<void>((resolve) => server.listen(path.join(dir, 's'), resolve));
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, RM_TEST_DIR);
  });

  async function ask(): Promise<unknown> {
    const client = new UntetherSocketClient(path.join(dir, 's'));
    client.on('error', () => {});
    await client.connect();
    try {
      return await client.sendMessageWithResponse(
        MessageType.STATUS_REQUEST,
        {},
        MessageType.STATUS_RESPONSE,
        5000
      );
    } finally {
      client.disconnect();
    }
  }

  it("fails with the server's own error", async () => {
    onRequest = (socket) =>
      socket.write(MessageBuilder.error('BAD', 'the status could not be read'));
    const started = Date.now();
    await expect(ask()).rejects.toThrow('the status could not be read');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('fails at once when the server closes the connection', async () => {
    onRequest = (socket) => socket.destroy();
    const started = Date.now();
    await expect(ask()).rejects.toThrow('closed the connection');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
