/**
 * Mac Sessions API ("On this Mac", shared/mac-sessions.ts): the list, the read-only conversation
 * of an agent in it, opening one of its tmux sessions, switching how an opened one behaves, and
 * "Share with phone" for an agent in a Terminal or iTerm2 tab (shared/mac-share.ts).
 * Mounted after the auth middleware, like the rest of /api: there is no bypass of its own.
 *
 * Clients only send ids the server made. What an id names (a socket, a pid, a tmux target) is
 * looked up in the latest scan, never taken from the request: an `-S` path from a client would
 * let it make the server connect to any socket. Answers are never cached.
 */
import { type Request, type Response, Router } from 'express';
import {
  isMacSessionId,
  type MacOpenMode,
  type MacSessionsErrorCode,
  type MacSizing,
} from '../../shared/mac-sessions.js';
import {
  isMacShareJobId,
  type MacShareErrorCode,
  type MacSharePlanRequest,
} from '../../shared/mac-share.js';
import type { SessionInfo } from '../../shared/types.js';
import { type ProcessTable, processTable } from '../services/claude-chat.js';
import { parseUtcStart } from '../services/codex-process.js';
import { type MacAttach, MacSessionsError } from '../services/mac-sessions/attach.js';
import type { MacSessionsScanner } from '../services/mac-sessions/scanner.js';
import type { MacSessionsSettings } from '../services/mac-sessions/settings.js';
import { type MacShare, MacShareError } from '../services/mac-sessions/share.js';
import { chatAnswer, readSessionChat } from '../services/session-chat.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mac-sessions');

export interface MacSessionsRouteOptions {
  /** The effective settings (config.json, env, CLI, platform, HQ), read on every request. */
  settings: () => MacSessionsSettings;
  scanner: Pick<MacSessionsScanner, 'scan' | 'resolve'>;
  attach: Pick<MacAttach, 'open' | 'setMode'>;
  /** The shared process table unless given (tests). */
  table?: () => Promise<ProcessTable>;
  /** readSessionChat unless given (tests). */
  readChat?: typeof readSessionChat;
  /** "Share with phone" (services/mac-sessions/share.ts); absent off macOS. */
  share?: Pick<MacShare, 'plan' | 'start' | 'job'>;
}

/** Terminal sizes a phone may ask for. */
const MAX_SIZE = 1000;
const UNTETHER_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function sendError(res: Response, code: MacSessionsErrorCode, details?: string): void {
  const error = new MacSessionsError(code, details);
  res.status(error.status).json({ error: code, ...(details ? { details } : {}) });
}

function sendFailure(res: Response, error: unknown, fallback: MacSessionsErrorCode): void {
  if (error instanceof MacSessionsError) {
    sendError(res, error.code, error.details);
    return;
  }
  sendError(res, fallback, error instanceof Error ? error.message : String(error));
}

function sendShareError(res: Response, code: MacShareErrorCode): void {
  res.status(new MacShareError(code).status).json({ error: code });
}

/** A share call's failure: its own code, else a 500 that names nothing from the Mac. */
function sendShareFailure(res: Response, error: unknown, what: string): void {
  if (error instanceof MacShareError) {
    res
      .status(error.status)
      .json({ error: error.code, ...(error.shell ? { shell: error.shell } : {}) });
    return;
  }
  logger.warn(`Share with phone: ${what} failed: ${errorName(error)}`);
  res.status(500).json({ error: 'Failed to share' });
}

const errorName = (error: unknown) =>
  error instanceof Error
    ? `${error.name}${'code' in error ? ` ${String(error.code)}` : ''}`
    : 'error';

const isMode = (value: unknown): value is MacOpenMode => value === 'control' || value === 'watch';
const isSizing = (value: unknown): value is MacSizing => value === 'others' || value === 'here';
const isSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SIZE;

/** The body of a request, as an object (express gives undefined without a JSON body). */
function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body as unknown;
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export function createMacSessionsRoutes(options: MacSessionsRouteOptions): Router {
  const router = Router();
  const table = options.table ?? processTable;
  const readChat = options.readChat ?? readSessionChat;

  router.use('/mac-sessions', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /** GET /api/mac-sessions[?force=1]: the list (enabled:false and no scan while it is off). */
  router.get('/mac-sessions', async (req, res) => {
    try {
      res.json(await options.scanner.scan({ force: req.query.force === '1' }));
    } catch (error) {
      logger.warn('Failed to list the sessions on this computer:', error);
      res.status(500).json({ error: 'Failed to list the sessions on this computer' });
    }
  });

  // Before the /mac-sessions/:id routes.
  /** GET /api/mac-sessions/share/:jobId → MacShareJob: where a share is (polled every 1 s). */
  router.get('/mac-sessions/share/:jobId', (req, res) => {
    const { jobId } = req.params;
    if (!options.share) return sendShareError(res, 'disabled');
    if (!isMacShareJobId(jobId)) return res.status(404).json({ error: 'not-found' });
    const job = options.share.job(jobId);
    if (!job) return res.status(404).json({ error: 'not-found' });
    res.json(job);
  });

  /**
   * POST /api/mac-sessions/:id/share/plan {allowPrompt?} → MacSharePlan: everything checked
   * and the tab probed, nothing changed; the token starts it.
   */
  router.post('/mac-sessions/:id/share/plan', async (req, res) => {
    const { id } = req.params;
    if (!options.share) return sendShareError(res, 'disabled');
    if (!isMacSessionId(id)) return sendShareError(res, 'bad-id');
    const { allowPrompt } = bodyOf(req) as MacSharePlanRequest;
    try {
      res.json(await options.share.plan(id, { allowPrompt: allowPrompt === true }));
    } catch (error) {
      sendShareFailure(res, error, 'plan');
    }
  });

  /** POST /api/mac-sessions/:id/share {token} → 202 {jobId}: closes it and reopens it there. */
  router.post('/mac-sessions/:id/share', async (req, res) => {
    const { id } = req.params;
    if (!options.share) return sendShareError(res, 'disabled');
    if (!isMacSessionId(id)) return sendShareError(res, 'bad-id');
    try {
      res.status(202).json(await options.share.start(bodyOf(req).token, id));
    } catch (error) {
      sendShareFailure(res, error, 'start');
    }
  });

  /** POST /api/mac-sessions/attached/:sessionId/mode {mode?, sizing?} → {mode, sizing} */
  router.post('/mac-sessions/attached/:sessionId/mode', async (req, res) => {
    const { sessionId } = req.params;
    if (!UNTETHER_SESSION_ID.test(sessionId)) return sendError(res, 'not-attached');
    const { mode, sizing } = bodyOf(req);
    if (mode !== undefined && !isMode(mode)) {
      return sendError(res, 'bad-request', 'mode is control or watch');
    }
    if (sizing !== undefined && !isSizing(sizing)) {
      return sendError(res, 'bad-request', 'sizing is others or here');
    }
    try {
      res.json(
        await options.attach.setMode(sessionId, {
          ...(mode !== undefined ? { mode } : {}),
          ...(sizing !== undefined ? { sizing } : {}),
        })
      );
    } catch (error) {
      if (!(error instanceof MacSessionsError)) {
        logger.warn('Mode change failed:', error);
      }
      sendFailure(res, error, 'mode-failed');
    }
  });

  /**
   * GET /api/mac-sessions/:id/chat[?have=<fingerprint>]: the conversation of an agent (`a-`) or
   * of the agent in a tmux pane (`p-`), as GET /api/sessions/:id/claude-chat answers it. Its
   * process is checked again (pid and start time) before each answer.
   */
  router.get('/mac-sessions/:id/chat', async (req, res) => {
    const { id } = req.params;
    if (!isMacSessionId(id)) return sendError(res, 'bad-id');
    if (!options.settings().enabled) return sendError(res, 'disabled');
    try {
      const target = await options.scanner.resolve(id);
      if (!target) return sendError(res, 'gone');
      if (target.kind === 'tmux') return sendError(res, 'bad-id', 'not a conversation');
      // A pane's agent, never the pane's own process: an Untether server running in a user's
      // tmux pane must not lend its sessions' conversations to that pane.
      const [pid, lstart] =
        target.kind === 'pane' ? [target.agentPid, target.agentStart] : [target.pid, target.lstart];
      const startedAt = parseUtcStart(lstart);
      if ((await table()).starts.get(pid) !== lstart || startedAt === undefined) {
        return sendError(res, 'gone');
      }
      const session: SessionInfo & { pid: number } = {
        id: `mac:${id}`,
        name: '',
        command: [],
        workingDir: target.cwd ?? '',
        status: 'running',
        startedAt: new Date(startedAt).toISOString(),
        pid,
      };
      res.json(chatAnswer(await readChat(session, pid), req.query.have));
    } catch (error) {
      // Its name only: a parse error's message can quote the transcript.
      logger.warn(`Failed to read a conversation on this computer: ${errorName(error)}`);
      res.status(500).json({ error: 'Failed to read the conversation' });
    }
  });

  /**
   * POST /api/mac-sessions/:id/open {mode?, cols?, rows?} → {sessionId, reused, mode}: a tmux
   * session of the list in an Untether session, in the user's open mode unless asked.
   */
  router.post('/mac-sessions/:id/open', async (req, res) => {
    const { id } = req.params;
    if (!isMacSessionId(id)) return sendError(res, 'bad-id');
    const { mode, cols, rows } = bodyOf(req);
    if (mode !== undefined && !isMode(mode)) {
      return sendError(res, 'bad-request', 'mode is control or watch');
    }
    if ((cols !== undefined && !isSize(cols)) || (rows !== undefined && !isSize(rows))) {
      return sendError(res, 'bad-request', `cols and rows are whole numbers from 1 to ${MAX_SIZE}`);
    }
    const settings = options.settings();
    if (!settings.enabled) return sendError(res, 'disabled');
    try {
      res.json(
        await options.attach.open(id, {
          mode: mode ?? settings.openMode,
          ...(cols !== undefined ? { cols } : {}),
          ...(rows !== undefined ? { rows } : {}),
        })
      );
    } catch (error) {
      if (!(error instanceof MacSessionsError)) {
        logger.warn('Opening a tmux session failed:', error);
      }
      sendFailure(res, error, 'open-failed');
    }
  });

  return router;
}
