import { type Request, type Response, Router } from 'express';
import { validateQuickActionsForSave } from '../../shared/quick-actions.js';
import type { SessionInfo } from '../../shared/types.js';
import { loadQuickActions, quickActionsRoot, saveQuickActions } from '../services/quick-actions.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('quick-actions');

interface QuickActionsPtyManager {
  getSession(sessionId: string): SessionInfo | null | undefined;
}

export interface QuickActionsRouteOptions {
  ptyManager: QuickActionsPtyManager;
}

/**
 * GET /sessions/:sessionId/quick-actions — the actions of the session's project (or the
 * defaults), as QuickActionsResponse. PUT with { actions } saves them to the project's file.
 * The folder is the session's, never one the client names.
 */
export function createQuickActionsRoutes(options: QuickActionsRouteOptions): Router {
  const router = Router();

  const rootOf = async (req: Request, res: Response): Promise<string | null> => {
    const session = options.ptyManager.getSession(String(req.params.sessionId));
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return null;
    }
    return quickActionsRoot(session.workingDir);
  };

  router.get('/sessions/:sessionId/quick-actions', async (req: Request, res: Response) => {
    try {
      const root = await rootOf(req, res);
      if (root) res.json(await loadQuickActions(root));
    } catch (error) {
      logger.error('error reading quick actions:', error);
      res.status(500).json({ error: 'Failed to read the quick actions' });
    }
  });

  router.put('/sessions/:sessionId/quick-actions', async (req: Request, res: Response) => {
    const checked = validateQuickActionsForSave(req.body?.actions);
    if ('error' in checked) return res.status(400).json({ error: checked.error });
    try {
      const root = await rootOf(req, res);
      if (root) res.json(await saveQuickActions(root, checked.actions));
    } catch (error) {
      logger.error('error saving quick actions:', error);
      res.status(500).json({ error: 'Failed to save the quick actions' });
    }
  });

  return router;
}
