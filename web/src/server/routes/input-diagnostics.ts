/**
 * Input diagnostics over HTTP, for signed-in callers (services/input-diagnostics.ts):
 *   POST /api/diag/input              a batch of measures from a device with the mode on
 *   GET  /api/diag/input?since=24h    the summary `ut diag input` prints, as JSON
 */
import { type Request, type Response, Router } from 'express';
import { DiagInputError, type InputDiagStore, parseSince } from '../services/input-diagnostics.js';
import { createMinuteLimiter } from './logs.js';

/** A device sends a batch every few seconds with the line on screen, one a minute without. */
export const DIAG_BATCHES_PER_MINUTE = 60;
export const MAX_DIAG_BATCH_BYTES = 256 * 1024;

export function createInputDiagnosticsRoutes(options: {
  store: InputDiagStore;
  now?: () => number;
}): Router {
  const router = Router();
  const underRateLimit = createMinuteLimiter(DIAG_BATCHES_PER_MINUTE, options.now);

  router.post('/diag/input', (req: Request, res: Response) => {
    const declared = Number(req.headers['content-length']);
    const size = Number.isFinite(declared)
      ? declared
      : Buffer.byteLength(JSON.stringify(req.body ?? null));
    if (size > MAX_DIAG_BATCH_BYTES) return res.status(413).json({ error: 'Batch too large' });
    const who =
      (req as Request & { userId?: string }).userId ?? req.socket?.remoteAddress ?? 'unknown';
    if (!underRateLimit(who)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Too many batches' });
    }
    try {
      options.store.record(req.body);
      res.status(204).send();
    } catch (error) {
      if (!(error instanceof DiagInputError)) throw error;
      res.status(400).json({ error: 'bad-request', message: error.message });
    }
  });

  router.get('/diag/input', (req: Request, res: Response) => {
    const since = parseSince(typeof req.query.since === 'string' ? req.query.since : '24h');
    if (since === null) {
      return res.status(400).json({ error: 'bad-request', message: 'since: 30m, 24h, 7d…' });
    }
    res.json(options.store.summary(since));
  });

  return router;
}
