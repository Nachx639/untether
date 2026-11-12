import type { Server } from 'http';
import type { WebSocket } from 'ws';
import { every } from './periodic-loop.js';

/** Longest a shutdown waits for requests in flight before every connection is cut. */
const SHUTDOWN_MAX_DRAIN_MS = 5000;
/** How often it looks whether they ended; the first look also lets the close frames go out. */
const SHUTDOWN_POLL_MS = 50;

/**
 * Ends what keeps `server.close()` from finishing: idle keep-alive sockets at once, WebSockets
 * with "going away" (1001; phones reconnect to the next server by themselves), and whatever
 * is still open, event streams included, as soon as `inFlight()` (inflight-requests.ts) is
 * down to zero, at the latest after SHUTDOWN_MAX_DRAIN_MS. Without it every restart waited
 * for the 5 s timeout and was killed before logging its close (2026-10-03: 5.5 s without a
 * server on each deploy); a fixed 300 ms cut instead broke uploads, answers being typed into
 * a session and git pushes still in flight (2026-10-03, review).
 */
export function closeConnectionsForShutdown(
  server: Pick<Server, 'closeIdleConnections' | 'closeAllConnections'>,
  wss: { clients: Iterable<Pick<WebSocket, 'close' | 'terminate'>> },
  inFlight: () => number
): void {
  server.closeIdleConnections();
  for (const client of wss.clients) client.close(1001, 'Server restarting');
  const cutAll = () => {
    clearInterval(poll);
    clearTimeout(deadline);
    server.closeAllConnections();
    for (const client of wss.clients) client.terminate();
  };
  const poll = every(
    'shutdown connections poll',
    () => {
      if (inFlight() === 0) cutAll();
    },
    SHUTDOWN_POLL_MS
  );
  const deadline = setTimeout(cutAll, SHUTDOWN_MAX_DRAIN_MS);
  poll.unref();
  deadline.unref();
}
