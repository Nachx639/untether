/**
 * GET /api/copilot/status: how the voice copilot is doing (pages, brain, speech, clips, action
 * outcomes, the last turns' timings with p50/p90). Behind the /api login; no transcript text.
 */
import { type Request, type Response, Router } from 'express';
import type { CopilotService } from '../services/copilot/service.js';

export function createCopilotRoutes(service: CopilotService): Router {
  const router = Router();
  router.get('/copilot/status', (_req: Request, res: Response) => {
    res.json(service.status());
  });
  return router;
}
