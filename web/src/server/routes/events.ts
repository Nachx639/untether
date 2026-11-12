/**
 * The public event log over HTTP (event-log.ts), for signed-in callers (mounted after the /api
 * auth middleware):
 *   GET /api/events?after=<id>&types=task,session&project=<dir>&limit=<n>   one page (JSON)
 *   GET /api/events/stream?after=<id>&types=…&project=…                    text/event-stream
 * The stream resumes from Last-Event-ID (what EventSource sends on reconnect) or `after`:
 * every event once, in order, also across server restarts.
 */
import { type Request, type Response, Router } from 'express';
import {
  type EventLog,
  type EventQuery,
  EventQueryError,
  parseEventQuery,
} from '../services/event-log.js';
import { resolveProjectRepo } from '../services/task-commands.js';
import { every } from '../utils/periodic-loop.js';

const STREAM_PING_MS = 25_000;
const STREAM_PAGE = 500;

export interface EventRoutesOptions {
  eventLog: EventLog;
  resolveProject?: (dir: string) => Promise<string | null>;
  pingMs?: number;
}

function queryInput(req: Request): Record<string, unknown> {
  const pick = (name: string) =>
    typeof req.query[name] === 'string' ? req.query[name] : undefined;
  return {
    after: pick('after'),
    types: pick('types') ?? pick('type'),
    project: pick('project'),
    limit: pick('limit'),
  };
}

export function createEventRoutes(options: EventRoutesOptions): Router {
  const router = Router();
  const { eventLog } = options;
  const resolveProject = options.resolveProject ?? resolveProjectRepo;

  const parse = async (req: Request, res: Response, input: Record<string, unknown>) => {
    try {
      const { wait: _wait, ...query } = await parseEventQuery(input, resolveProject);
      return query;
    } catch (error) {
      if (!(error instanceof EventQueryError)) throw error;
      res.status(400).json({ error: 'bad-request', message: error.message });
      return null;
    }
  };

  router.get('/events', async (req: Request, res: Response) => {
    const query = await parse(req, res, queryInput(req));
    if (query) res.json(eventLog.read(query));
  });

  router.get('/events/stream', async (req: Request, res: Response) => {
    const input = queryInput(req);
    const lastEventId = req.get('Last-Event-ID');
    if (lastEventId) input.after = lastEventId;
    const query = await parse(req, res, input);
    if (!query) return;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // no-transform: the compression middleware would hold the stream back.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    let cursor = query.after ?? 0;
    let closed = false;
    // Reads are synchronous: a pump never interleaves with another, and an event recorded
    // while one runs is read by the next one its listener starts.
    const pump = () => {
      if (closed) return;
      for (;;) {
        const pageQuery: EventQuery = { ...query, after: cursor, limit: STREAM_PAGE };
        const page = eventLog.read(pageQuery);
        if (page.reset)
          res.write(`event: reset\ndata: ${JSON.stringify({ lastId: page.lastId })}\n\n`);
        if (page.gap) {
          res.write(
            `event: gap\ndata: ${JSON.stringify({ after: cursor, oldestId: page.oldestId })}\n\n`
          );
        }
        for (const event of page.events) {
          res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        cursor = page.cursor;
        if (page.events.length < STREAM_PAGE) return;
      }
    };
    const off = eventLog.subscribe(() => pump());
    pump();
    const ping = every(
      'events stream ping',
      () => res.write(': ping\n\n'),
      options.pingMs ?? STREAM_PING_MS
    );
    const close = () => {
      closed = true;
      clearInterval(ping);
      off();
    };
    req.on('close', close);
    res.on('close', close);
  });

  return router;
}
