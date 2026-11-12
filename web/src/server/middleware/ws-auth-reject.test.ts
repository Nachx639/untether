import * as http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { rejectUnauthenticatedUpgrade, WS_CLOSE_TOKEN_INVALID } from './ws-auth-reject.js';

describe('rejectUnauthenticatedUpgrade', () => {
  let server: http.Server | undefined;
  afterEach(
    () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  );

  async function listen(tokenInvalid: boolean) {
    const wss = new WebSocketServer({ noServer: true });
    const listening = http.createServer();
    server = listening;
    listening.on('upgrade', (request, socket, head) =>
      rejectUnauthenticatedUpgrade(wss, request, socket, head, { tokenInvalid })
    );
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
    return `ws://127.0.0.1:${(listening.address() as AddressInfo).port}/ws?token=x`;
  }

  it('closes with 4401 token_invalid when a token was refused', async () => {
    const ws = new WebSocket(await listen(true));
    const [code, reason] = await new Promise<[number, string]>((resolve) =>
      ws.on('close', (c, r) => resolve([c, r.toString()]))
    );
    expect(code).toBe(WS_CLOSE_TOKEN_INVALID);
    expect(reason).toBe('token_invalid');
  });

  it('answers a plain 401 without credentials', async () => {
    const ws = new WebSocket(await listen(false));
    const status = await new Promise<number | undefined>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('error', () => resolve(undefined));
    });
    expect(status).toBe(401);
  });
});
