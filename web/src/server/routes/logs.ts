import { type Request, type Response, Router } from 'express';
import * as fs from 'fs';
import { createLogger, flushLogger, getLogFilePath, logFromModule } from '../utils/logger.js';
import { endOnReadError } from '../utils/stream-response.js';

const logger = createLogger('logs');

interface LogRoutesConfig {
  /** Clock for the client-log rate limit (tests). */
  now?: () => number;
}

/**
 * Limits for POST /logs/client. 2026-10-20 (security audit): it took 10 MB bodies without a
 * login and wrote them to the server log. It needs a login now (middleware/auth.ts), and one
 * client may send at most 256 KB per entry and 120 entries a minute.
 */
export const MAX_CLIENT_LOG_BYTES = 256 * 1024;
export const CLIENT_LOGS_PER_MINUTE = 120;

/** The most `GET /logs/raw?tail=` answers. */
export const MAX_LOG_TAIL_BYTES = 4 * 1024 * 1024;

/** A fixed one-minute window per client: true while `key` is still under `limit`. */
export function createMinuteLimiter(limit: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const t = now();
    let entry = windows.get(key);
    if (!entry || t - entry.start >= 60_000) {
      if (windows.size >= 1000) windows.clear();
      entry = { start: t, count: 0 };
      windows.set(key, entry);
    }
    entry.count++;
    return entry.count <= limit;
  };
}

interface ClientLogRequest {
  level: 'log' | 'warn' | 'error' | 'debug';
  module: string;
  args: unknown[];
}

export function createLogRoutes(config: LogRoutesConfig = {}): Router {
  const router = Router();
  const underRateLimit = createMinuteLimiter(CLIENT_LOGS_PER_MINUTE, config.now);

  // Client-side logging endpoint
  router.post('/logs/client', (req: Request, res: Response) => {
    try {
      const declared = Number(req.headers['content-length']);
      const size = Number.isFinite(declared)
        ? declared
        : Buffer.byteLength(JSON.stringify(req.body ?? null));
      if (size > MAX_CLIENT_LOG_BYTES) {
        return res.status(413).json({ error: 'Log entry too large' });
      }
      const who =
        (req as Request & { userId?: string }).userId ?? req.socket?.remoteAddress ?? 'unknown';
      if (!underRateLimit(who)) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Too many log entries' });
      }

      const { level, module, args } = (req.body ?? {}) as ClientLogRequest;

      // Validate input
      if (!level || !module || typeof module !== 'string' || !Array.isArray(args)) {
        return res.status(400).json({
          error: 'Invalid log request. Required: level, module, args[]',
        });
      }

      // Validate level
      if (!['log', 'warn', 'error', 'debug'].includes(level)) {
        return res.status(400).json({
          error: 'Invalid log level. Must be: log, warn, error, or debug',
        });
      }

      // Add [FE] prefix to module name to distinguish frontend logs from server logs
      const clientModule = `[FE] ${module}`;

      // Map client levels to server levels (uppercase)
      const serverLevel = level.toUpperCase();

      // Log to server log file via logFromModule
      logFromModule(serverLevel === 'LOG' ? 'LOG' : serverLevel, clientModule, args);

      res.status(204).send();
    } catch (error) {
      logger.error('Failed to process client log:', error);
      res.status(500).json({ error: 'Failed to process log' });
    }
  });

  // Get raw log file. `?tail=<bytes>` answers only its end, from the first whole line on: the
  // file grows to 50 MB before it rotates and the iOS log viewer refreshes every 2 seconds
  // (2026-11-10: it downloaded the whole file each time).
  router.get('/logs/raw', async (req: Request, res: Response) => {
    try {
      const logPath = getLogFilePath();

      // Check if log file exists - if not, return empty content
      if (!fs.existsSync(logPath)) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send('');
      }

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      const tail = Math.min(Number(req.query.tail), MAX_LOG_TAIL_BYTES);
      const size = fs.statSync(logPath).size;
      if (Number.isInteger(tail) && tail > 0 && size > tail) {
        // Asynchronous: up to 4 MB every 2 seconds must not hold the event loop
        const buffer = Buffer.alloc(tail);
        const file = await fs.promises.open(logPath, 'r');
        let read = 0;
        try {
          read = (await file.read(buffer, 0, tail, size - tail)).bytesRead;
        } finally {
          await file.close();
        }
        // The cut falls inside a line: start at the next one
        const firstLine = buffer.subarray(0, read).indexOf(0x0a) + 1;
        return res.send(buffer.subarray(firstLine, read));
      }

      // Stream the log file
      const stream = fs.createReadStream(logPath);
      endOnReadError(stream, res);
      stream.pipe(res);
    } catch (error) {
      logger.error('Failed to read log file:', error);
      res.status(500).json({ error: 'Failed to read log file' });
    }
  });

  // Get log stats/info
  router.get('/logs/info', (_req: Request, res: Response) => {
    try {
      const logPath = getLogFilePath();

      if (!fs.existsSync(logPath)) {
        return res.json({
          exists: false,
          size: 0,
          lastModified: null,
          path: logPath,
        });
      }

      const stats = fs.statSync(logPath);

      res.json({
        exists: true,
        size: stats.size,
        sizeHuman: formatBytes(stats.size),
        lastModified: stats.mtime,
        path: logPath,
      });
    } catch (error) {
      logger.error('Failed to get log info:', error);
      res.status(500).json({ error: 'Failed to get log info' });
    }
  });

  // Clear log file (for development/debugging)
  router.delete('/logs/clear', (_req: Request, res: Response) => {
    try {
      const logPath = getLogFilePath();

      if (fs.existsSync(logPath)) {
        fs.truncateSync(logPath, 0);
        logger.log('Log file cleared');
      }

      res.status(204).send();
    } catch (error) {
      logger.error('Failed to clear log file:', error);
      res.status(500).json({ error: 'Failed to clear log file' });
    }
  });

  // Flush log buffer (for testing)
  router.post('/logs/flush', async (_req: Request, res: Response) => {
    try {
      await flushLogger();
      res.status(204).send();
    } catch (error) {
      logger.error('Failed to flush log buffer:', error);
      res.status(500).json({ error: 'Failed to flush log buffer' });
    }
  });

  return router;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}
