import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Reads never hold a shutdown: GETs include event streams that never end. What changes
 * something (an upload, an answer being typed into a session, a git push) gets to finish
 * (closeConnectionsForShutdown).
 */
const UNTRACKED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface InflightRequests {
  /** Registered before any other middleware, so it sees every request. */
  middleware: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  /** Tracked requests whose response has not closed yet. */
  count: () => number;
}

export function createInflightRequests(): InflightRequests {
  let inFlight = 0;
  return {
    middleware: (req, res, next) => {
      if (!UNTRACKED_METHODS.has(req.method ?? '')) {
        inFlight++;
        // 'close' follows a finished response and an aborted one alike; once() counts it once.
        res.once('close', () => {
          inFlight--;
        });
      }
      next();
    },
    count: () => inFlight,
  };
}
