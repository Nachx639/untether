/**
 * Task-engine actions waiting for the user's OK (mounted under /api, behind auth).
 *
 *   GET  /confirmations        { confirmations } the pending ones, oldest first
 *   POST /confirmations/:id    { approve: boolean } → { status: 'approved', result } |
 *                              { status: 'declined' }; 404 gone (expired, unknown, answered)
 *   PUT  /confirmations/auto-approve  { on: boolean } → { autoApprove } (the user's setting:
 *                              nothing waits for an OK; 202 with { confirmation } when a
 *                              request without a login turns it on: that waits for the user)
 *
 * Only the signed-in app answers: a request let in without a login (localhost bypass) could be
 * the very agent that asked, approving itself (403).
 */
import { type Response, Router } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { callerFromAuth, httpStatus, type TaskCommands } from '../services/task-commands.js';

const AnswerSchema = z.object({ approve: z.boolean() });
const AutoApproveSchema = z.object({ on: z.boolean() });

export function createConfirmationRoutes(options: { commands: TaskCommands }): Router {
  const router = Router();
  const { commands } = options;

  router.get('/confirmations', (req: AuthenticatedRequest, res: Response) => {
    if (callerFromAuth(req.authMethod).kind !== 'ui') {
      return res.status(403).json({ error: 'Sign in to see confirmations' });
    }
    res.json({ confirmations: commands.confirmations.list() });
  });

  router.put('/confirmations/auto-approve', async (req: AuthenticatedRequest, res: Response) => {
    const parsed = AutoApproveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'on must be true or false' });
    const result = await commands.run(
      'auto-approve',
      { on: parsed.data.on },
      callerFromAuth(req.authMethod)
    );
    if (!result.ok) {
      return res.status(httpStatus(result)).json({ error: result.code, message: result.message });
    }
    if (result.status === 'pending-confirmation') {
      return res.status(202).json({ confirmation: result.confirmation });
    }
    return res.json(result.data);
  });

  router.post('/confirmations/:id', async (req: AuthenticatedRequest, res: Response) => {
    const parsed = AnswerSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'approve must be true or false' });
    const answer = await commands.answerConfirmation(
      String(req.params.id),
      parsed.data.approve,
      callerFromAuth(req.authMethod)
    );
    switch (answer.status) {
      case 'forbidden':
        return res.status(403).json({ error: 'forbidden', message: 'Sign in to answer it' });
      case 'gone':
        return res
          .status(404)
          .json({ error: 'gone', message: 'It expired or was already answered' });
      case 'declined':
        return res.json({ status: 'declined' });
      case 'approved': {
        const { result } = answer;
        if (!result.ok) {
          return res.status(httpStatus(result)).json({
            error: result.code,
            message: result.message,
            status: 'approved',
          });
        }
        return res.json({
          status: 'approved',
          result: result.status === 'done' ? result.data : { confirmation: result.confirmation },
        });
      }
    }
  });

  return router;
}
