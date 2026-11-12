import { type Request, type Response, Router } from 'express';
import type { SessionInfo } from '../../shared/types.js';
import { type AwaySummary, buildAwaySummary } from '../services/away-summary.js';
import type { ClaudeChat } from '../services/claude-chat.js';
import { readSessionChat } from '../services/session-chat.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('away-summary');

/** Summaries are cached per session and minute of `since`, for a few seconds. */
const SINCE_BUCKET_MS = 60_000;
const CACHE_TTL_MS = 3000;
const MAX_CACHED = 100;

interface AwaySummaryPtyManager {
  getSession(sessionId: string): SessionInfo | null | undefined;
  programRootPid(session: Pick<SessionInfo, 'id' | 'pid' | 'shielded'>): number | undefined;
}

export interface AwaySummaryRouteOptions {
  ptyManager: AwaySummaryPtyManager;
  /** Test seam over the transcript readers; defaults to the real chat reader. */
  readChat?: (session: SessionInfo & { pid: number }, programPid: number) => Promise<ClaudeChat>;
}

/** GET /sessions/:sessionId/away-summary?since=<iso> — what the agent did since then. */
export function createAwaySummaryRoutes(options: AwaySummaryRouteOptions): Router {
  const router = Router();
  const readChat = options.readChat ?? readSessionChat;
  const cache = new Map<string, { at: number; summary: AwaySummary }>();

  router.get('/sessions/:sessionId/away-summary', async (req: Request, res: Response) => {
    const session = options.ptyManager.getSession(String(req.params.sessionId));
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const sinceRaw = typeof req.query.since === 'string' ? req.query.since : '';
    const sinceParsed = Date.parse(sinceRaw);
    if (!sinceRaw || Number.isNaN(sinceParsed)) {
      return res.status(400).json({ error: 'since must be an ISO date' });
    }
    const since = Math.floor(sinceParsed / SINCE_BUCKET_MS) * SINCE_BUCKET_MS;
    if (!session.pid || session.status !== 'running') {
      return res.json(buildAwaySummary({ available: false, messages: [] }, since));
    }
    const key = `${session.id}\0${since}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return res.json(cached.summary);
    try {
      const programPid = options.ptyManager.programRootPid(session) ?? session.pid;
      const chat = await readChat({ ...session, pid: session.pid }, programPid);
      const summary = buildAwaySummary(chat, since);
      cache.delete(key);
      cache.set(key, { at: Date.now(), summary });
      while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
      res.json(summary);
    } catch (error) {
      logger.error('error building away summary:', error);
      res.status(500).json({ error: 'Failed to read the session activity' });
    }
  });
  return router;
}
