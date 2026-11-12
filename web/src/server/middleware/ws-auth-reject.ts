/**
 * Refusing a WebSocket upgrade that failed the login check.
 *
 * 2026-10-20: every refusal was a bare `HTTP/1.1 401` before the upgrade, which a browser
 * only sees as close code 1006 ("abnormal"), the same as a network drop. A device whose
 * token had expired (probably the TV) reconnected with it every ~30 s all day and never went
 * to the login page. A token that was sent and refused (auth middleware: TOKEN_INVALID_ERROR)
 * now gets the upgrade and an immediate close with WS_CLOSE_TOKEN_INVALID, which the client
 * answers by going to login. Without any credentials it stays a plain 401.
 */
import type * as http from 'http';
import type { Duplex } from 'stream';
import type { WebSocketServer } from 'ws';
import { TOKEN_INVALID_ERROR } from './auth.js';

/** Close code: the token sent is expired or invalid, log in again (4000-4999: application). */
export const WS_CLOSE_TOKEN_INVALID = 4401;

/**
 * An upgrade socket survives its client going away while the handler still awaits (the login
 * check, the preview's dev-server probes). 2026-11-10: Node hands the socket to 'upgrade'
 * with no 'error' listener of its own, so a connection reset in that window was an unhandled
 * 'error' event: an uncaught exception, which stops the whole server (cli.ts). Call it first,
 * before any await.
 */
export function guardUpgradeSocket(socket: Duplex): void {
  socket.on('error', () => socket.destroy());
}

export function rejectUnauthenticatedUpgrade(
  wss: Pick<WebSocketServer, 'handleUpgrade'>,
  request: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  auth: { tokenInvalid?: boolean }
): void {
  if (auth.tokenInvalid) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.close(WS_CLOSE_TOKEN_INVALID, TOKEN_INVALID_ERROR);
    });
    return;
  }
  const body = JSON.stringify({ error: 'Authentication required' });
  socket.write(
    'HTTP/1.1 401 Unauthorized\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body
  );
  socket.destroy();
}
