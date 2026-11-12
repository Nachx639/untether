/**
 * The connector's transport (2026-10-31): its own HTTP listener, apart from the main server.
 *
 * - Bound to 127.0.0.1 only (UNTETHER_CONNECTOR_BIND changes it, and the doctor and the
 *   exposure sweep then say so), on UNTETHER_CONNECTOR_PORT or the main port + 3 (4023);
 *   "off" turns it off. Docker Desktop and OrbStack containers on this Mac reach it as
 *   http://host.docker.internal:4023: their traffic to the host arrives on its loopback.
 *   The main server binds every interface and may sit behind Tailscale, a tunnel or HQ: the
 *   connector is never mounted there, so none of them exposes it.
 * - Listening only while an active token exists (sync() after every change): with none there
 *   is no port at all.
 * - Only these routes, each with `Authorization: Bearer <token>`; nothing else of Untether is
 *   reachable through it. No CORS: a web page can't use it from a browser.
 *     GET  /api/connector/info
 *     POST /api/connector/messages            { text, images?, from? }
 *     GET  /api/connector/messages/:id
 *     GET  /api/connector/replies?after=&limit=
 *     GET  /api/connector/tasks?all=1
 *     GET  /api/connector/events               (text/event-stream)
 *     POST /mcp                                (MCP, streamable HTTP, JSON answers)
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import * as http from 'http';
import { every } from '../../utils/periodic-loop.js';
import { handleMcp } from './connector-mcp.js';
import {
  BODY_BYTES_MAX,
  CONNECTOR_HTTP_STATUS,
  ConnectorError,
  type ConnectorService,
} from './connector-service.js';
import type { ConnectorChannelInfo, ConnectorTokens } from './connector-tokens.js';

export const CONNECTOR_DEFAULT_BIND = '127.0.0.1';
/** How often a live stream looks for changes; a comment keeps idle proxies from closing it. */
const STREAM_POLL_MS = 5_000;
const STREAM_PING_MS = 25_000;

/** The port: UNTETHER_CONNECTOR_PORT, "off", or the main port + 3. */
export function resolveConnectorPort(
  env: string | undefined,
  mainPort: number
): { port: number | null; error?: string } {
  const value = env?.trim();
  if (!value) return { port: mainPort + 3 };
  if (value === 'off') return { port: null };
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === mainPort) {
    return { port: null, error: `UNTETHER_CONNECTOR_PORT must be a free port, got "${value}"` };
  }
  return { port };
}

export const isLoopback = (host: string) =>
  host === '127.0.0.1' || host === '::1' || host === 'localhost';

type Authed = Request & { channel?: ConnectorChannelInfo };

function sendError(res: Response, error: unknown): void {
  if (error instanceof ConnectorError) {
    if (error.retryAfterSec) res.setHeader('Retry-After', String(error.retryAfterSec));
    res.status(CONNECTOR_HTTP_STATUS[error.code]).json({
      error: error.code,
      message: error.message,
      ...(error.retryAfterSec ? { retryAfterSec: error.retryAfterSec } : {}),
    });
    return;
  }
  res.status(500).json({ error: 'internal', message: 'Something failed on the Untether side' });
}

export function createConnectorApp(service: ConnectorService): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    // No CORS answer: a browser page never gets to call it.
    if (req.method === 'OPTIONS') {
      res.status(403).end();
      return;
    }
    next();
  });
  const auth =
    (op: string) =>
    (req: Authed, res: Response, next: NextFunction): void => {
      try {
        req.channel = service.authenticate(req.get('authorization'), op);
        next();
      } catch (error) {
        if (error instanceof ConnectorError && error.code === 'unauthorized') {
          res.setHeader('WWW-Authenticate', 'Bearer realm="untether-connector"');
        }
        sendError(res, error);
      }
    };
  const json = express.json({ limit: BODY_BYTES_MAX, strict: true });
  const handle =
    (fn: (req: Authed, channel: ConnectorChannelInfo) => Promise<unknown> | unknown, code = 200) =>
    async (req: Authed, res: Response) => {
      try {
        res.status(code).json(await fn(req, req.channel as ConnectorChannelInfo));
      } catch (error) {
        sendError(res, error);
      }
    };

  app.get(
    '/api/connector/info',
    auth('info'),
    handle((_req, channel) => service.info(channel))
  );
  app.post(
    '/api/connector/messages',
    auth('send'),
    json,
    handle((req, channel) => service.send(channel, req.body ?? {}), 202)
  );
  app.get(
    '/api/connector/messages/:id',
    auth('message'),
    handle((req, channel) => service.message(channel, String(req.params.id)))
  );
  app.get(
    '/api/connector/replies',
    auth('replies'),
    handle((req, channel) => {
      const after = Number(req.query.after ?? 0);
      const limit = Number(req.query.limit ?? 50);
      if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1) {
        throw new ConnectorError('bad-request', 'after and limit must be whole numbers');
      }
      return service.replies(channel, after, limit);
    })
  );
  app.get(
    '/api/connector/tasks',
    auth('tasks'),
    handle((req, channel) => ({
      tasks: service.tasks(channel, req.query.all === '1' || req.query.all === 'true'),
    }))
  );
  app.get('/api/connector/events', auth('events'), (req: Authed, res: Response) => {
    const channel = req.channel as ConnectorChannelInfo;
    let stream: ReturnType<ConnectorService['streamer']>;
    try {
      stream = service.streamer(channel);
    } catch (error) {
      sendError(res, error);
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    let first = true;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        // A token revoked meanwhile ends the stream.
        if (!service.stillValid(channel)) {
          res.write('event: revoked\ndata: {}\n\n');
          res.end();
          return;
        }
        const { tasks, gone, replies } = await stream.poll();
        if (first) {
          res.write(`event: snapshot\ndata: ${JSON.stringify({ tasks })}\n\n`);
          first = false;
        } else {
          for (const task of tasks) res.write(`event: task\ndata: ${JSON.stringify(task)}\n\n`);
          for (const id of gone) res.write(`event: task-gone\ndata: ${JSON.stringify({ id })}\n\n`);
        }
        for (const reply of replies) res.write(`event: reply\ndata: ${JSON.stringify(reply)}\n\n`);
      } catch {
        // the next tick tries again
      } finally {
        busy = false;
      }
    };
    void tick();
    const poll = every('connector stream poll', tick, STREAM_POLL_MS);
    const ping = every('connector stream ping', () => res.write(': ping\n\n'), STREAM_PING_MS);
    const close = () => {
      clearInterval(poll);
      clearInterval(ping);
      stream.close();
    };
    req.on('close', close);
    res.on('close', close);
  });

  app.post('/mcp', auth('mcp'), json, async (req: Authed, res: Response) => {
    try {
      const answer = await handleMcp(service, req.channel as ConnectorChannelInfo, req.body);
      if (answer === null) {
        res.status(202).end();
        return;
      }
      res.status(200).json(answer);
    } catch (error) {
      sendError(res, error);
    }
  });
  // No server-to-client stream and no sessions to end (streamable HTTP lets both be refused).
  app.all('/mcp', auth('mcp'), (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method-not-allowed', message: 'POST JSON-RPC to /mcp' });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not-found', message: 'No such connector route' });
  });
  // Bad JSON, a body too big: a JSON error, never an HTML page or a stack.
  app.use(
    (
      error: { type?: string; status?: number },
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      if (error?.type === 'entity.too.large') {
        res.status(413).json({ error: 'too-large', message: `At most ${BODY_BYTES_MAX} bytes` });
        return;
      }
      if (error?.type === 'entity.parse.failed' || error?.status === 400) {
        res.status(400).json({ error: 'bad-request', message: 'The body must be JSON' });
        return;
      }
      sendError(res, error);
    }
  );
  return app;
}

/** The listener: open while an active token exists, closed otherwise. */
export class ConnectorListener {
  private server: http.Server | null = null;
  private starting: Promise<void> | null = null;
  private listeningOn: { host: string; port: number } | null = null;

  constructor(
    private readonly options: {
      tokens: ConnectorTokens;
      app: express.Express;
      port: () => number | null;
      host?: string;
      log?: (message: string) => void;
    }
  ) {}

  get host(): string {
    return this.options.host || CONNECTOR_DEFAULT_BIND;
  }

  /** Where it listens now, if it does. */
  address(): { host: string; port: number } | null {
    return this.listeningOn;
  }

  /** Opens or closes it to match the tokens. */
  async sync(): Promise<void> {
    if (this.starting) await this.starting;
    const want = this.options.tokens.hasActive() ? this.options.port() : null;
    if (want === null) {
      if (this.server) await this.stop();
      return;
    }
    if (this.server && this.listeningOn?.port === want) return;
    if (this.server) await this.stop();
    this.starting = this.listen(want).finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      const server = http.createServer(this.options.app);
      server.requestTimeout = 60_000;
      server.headersTimeout = 15_000;
      server.on('error', (error: NodeJS.ErrnoException) => {
        this.options.log?.(
          `connector: cannot listen on ${this.host}:${port} (${error.code ?? error.message})`
        );
        this.server = null;
        this.listeningOn = null;
        resolve();
      });
      server.listen(port, this.host, () => {
        this.server = server;
        this.listeningOn = { host: this.host, port };
        this.options.log?.(`connector: listening on http://${this.host}:${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listeningOn = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.options.log?.('connector: closed (no active token)');
  }
}
