/**
 * Tasks and task templates (mounted under /api, behind auth).
 *
 *   GET    /tasks                 scheduled, open and recent tasks, and the running
 *                                 orchestrators { tasks, orchestrators: [{ repoPath, sessionId }],
 *                                 pinnedProjects: [{ repoPath, git }], groupOrder: string[],
 *                                 sessionOrder: string[], collapsedGroups: string[] } (the
 *                                 home's group order, the order of the sessions in their
 *                                 groups and the groups folded, as the user chose)
 *   POST   /tasks                 run now (no runAt / runAt now) or schedule; `isolation:
 *                                 "worktree"` gives it its own branch, `parallel` 1-4 copies
 *   POST   /tasks/route           { repoPath, text } → where a prompt typed on the home screen
 *                                 goes: { repoPath, decision: { kind: match|new|ask, taskId?,
 *                                 candidates?, by: rules|llm }, open: [{ id, name, branch, state }] }
 *   POST   /tasks/submit          { repoPath, text, agent, choice? } → sends it to the task
 *                                 `choice` (or starts a new one for 'new'; routes it without
 *                                 one): { action: sent|created|ask, task?, decision?, open? }
 *   GET    /tasks/:id             one task
 *   PUT    /tasks/:id             change a task that has not run yet
 *   DELETE /tasks/:id             cancel it, or drop a settled one from the list
 *   POST   /tasks/:id/send        type a follow-up into its session { text }
 *   POST   /tasks/:id/discard     throw it away { confirm? } (409 needs-confirmation when it
 *                                 has work not merged anywhere)
 *   POST   /tasks/:id/merge       merge it now { acceptRisk? } (check first; answers verifying)
 *   POST   /tasks/:id/verify      run its check again (answers verifying)
 *   POST   /tasks/:id/fix         type its blocker into the agent's session (back to working)
 *   POST   /tasks/:id/keep        keep this one of a parallel group: merge it, discard the others
 *   POST   /tasks/:id/revert      undo a merged task ("Deshacer"): { task } the new task that
 *                                 reverts its commits, is checked, reviewed and merged
 *   GET    /tasks/:id/log         ?kind=setup|verify|merge&lines=N → { kind, text, exists }
 *   GET    /task-templates        the user's templates (built-ins live in the client)
 *   POST   /task-templates        add one
 *   PUT    /task-templates/:id    edit one
 *   DELETE /task-templates/:id    delete one
 *
 * Every task command runs through services/task-commands.ts, like `ut task …`: a request
 * without a login (localhost bypass) has no user rights, so what changes a task waits for the
 * user's OK there (202 { status: 'pending-confirmation', confirmation }). Editing or dropping
 * a task (PUT / DELETE /tasks/:id) and changing templates are the signed-in app's alone (403
 * otherwise): 2026-10-20, they skipped that guard, so an agent with curl could rewrite a
 * scheduled task's command line or prompt, or what a template sends.
 */
import { randomUUID } from 'crypto';
import { type Response, Router } from 'express';
import { z } from 'zod';
import { TASK_NAME_MAX, TASK_PROMPT_MAX } from '../../shared/tasks.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { ConfigService } from '../services/config-service.js';
import {
  callerFromAuth,
  httpStatus,
  type TaskCommandResult,
  type TaskCommands,
} from '../services/task-commands.js';
import type { TaskScheduler } from '../services/task-scheduler.js';

/** A time picked a moment ago on the phone is still "now"; older than this is a mistake. */
const PAST_TOLERANCE_MS = 60_000;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

const RunAtSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'runAt must be a date')
  .transform((value) => new Date(value));

const TaskFields = {
  name: z.string().trim().min(1).max(TASK_NAME_MAX),
  prompt: z.string().trim().min(1).max(TASK_PROMPT_MAX),
  workingDir: z.string().trim().min(1).max(4096),
  command: z.array(z.string().min(1).max(4096)).min(1).max(64),
  agent: z.enum(['claude', 'codex']),
  shielded: z.boolean(),
  notify: z.boolean(),
};

/** Error codes answered with the message alone (validation, server trouble). */
const MESSAGE_ONLY = new Set(['bad-request', 'error', 'unavailable']);

/** A task command's result as JSON: data as is, a pending confirmation, or the error. */
export function sendCommandResult(res: Response, result: TaskCommandResult): void {
  if (result.ok && result.status === 'done') {
    res.status(200).json(result.data);
    return;
  }
  if (result.ok) {
    res.status(202).json({ status: 'pending-confirmation', confirmation: result.confirmation });
    return;
  }
  res.status(httpStatus(result)).json(
    MESSAGE_ONLY.has(result.code)
      ? { error: result.message, ...(result.data ?? {}) }
      : {
          error: result.code,
          message: result.message,
          ...(result.commits !== undefined ? { commits: result.commits } : {}),
        }
  );
}

// runAt null is "run now": the scheduled task starts through the normal queue at once.
const TaskPatchSchema = z
  .object(TaskFields)
  .partial()
  .extend({ runAt: RunAtSchema.nullable().optional() });

const TemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(TASK_NAME_MAX),
  prompt: z.string().trim().min(1).max(TASK_PROMPT_MAX),
});

function checkRunAt(runAt: Date | null | undefined): string | null {
  if (!runAt) return null;
  const now = Date.now();
  if (runAt.getTime() < now - PAST_TOLERANCE_MS) return 'runAt is in the past';
  if (runAt.getTime() > now + MAX_AHEAD_MS) return 'runAt is too far ahead';
  return null;
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join(', ');
}

export function createTaskRoutes(options: {
  configService: ConfigService;
  scheduler: () => TaskScheduler | null;
  commands: TaskCommands;
  /** Projects' running orchestrators (P7): the home pins their sessions. */
  orchestrators?: () => Array<{
    repoPath: string;
    sessionId: string;
    adopted?: boolean;
    /** Its brief is not typed in yet. */
    pending?: boolean;
  }>;
  /** Projects pinned on top of the home, the first pinned first. */
  pinnedProjects?: () => Array<{ repoPath: string; git: boolean }>;
  /** The home's group order the user chose (services/group-order.ts). */
  groupOrder?: () => string[];
  /** The order of the sessions inside their groups the user chose (services/group-order.ts). */
  sessionOrder?: () => string[];
  /** The groups the user folded (services/group-order.ts). */
  collapsedGroups?: () => string[];
}): Router {
  const router = Router();
  const { configService, commands } = options;

  const scheduler = (res: { status: (code: number) => { json: (body: unknown) => void } }) => {
    const instance = options.scheduler();
    if (!instance) res.status(503).json({ error: 'Tasks are not available yet' });
    return instance;
  };

  /** Runs `op` as the request's caller and answers with its result. */
  const command =
    (op: string, args: (req: AuthenticatedRequest) => Record<string, unknown>) =>
    async (req: AuthenticatedRequest, res: Response) => {
      const result = await commands.run(op, args(req), callerFromAuth(req.authMethod));
      sendCommandResult(res, result);
    };

  /** False (answered 403) unless the request is the signed-in app's. */
  const fromUser = (req: AuthenticatedRequest, res: Response): boolean => {
    if (callerFromAuth(req.authMethod).kind === 'ui') return true;
    res.status(403).json({
      error: 'forbidden',
      message: 'Only the signed-in app can change tasks and templates this way',
    });
    return false;
  };

  const body = (req: AuthenticatedRequest) =>
    req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  const withRef = (req: AuthenticatedRequest) => ({ ...body(req), ref: req.params.id });

  router.get('/tasks', async (req: AuthenticatedRequest, res: Response) => {
    const result = await commands.run('list', { all: true }, callerFromAuth(req.authMethod));
    if (result.ok && result.status === 'done') {
      // A security sweep's search is silent (2026-10-23): the board shows only what two
      // reviewers confirmed, as a task of its own.
      const data = result.data as { tasks?: Array<{ security?: { kind?: string } }> };
      res.json({
        ...result.data,
        ...(Array.isArray(data.tasks)
          ? { tasks: data.tasks.filter((task) => task.security?.kind !== 'sweep') }
          : {}),
        orchestrators: options.orchestrators?.() ?? [],
        pinnedProjects: options.pinnedProjects?.() ?? [],
        groupOrder: options.groupOrder?.() ?? [],
        sessionOrder: options.sessionOrder?.() ?? [],
        collapsedGroups: options.collapsedGroups?.() ?? [],
        // Actions waiting for the user's OK, for the app's "Te necesita" (2026-10-18 review:
        // they were reachable only from their push). Only a signed-in app may answer them.
        ...(callerFromAuth(req.authMethod).kind === 'ui'
          ? { confirmations: commands.confirmations.list() }
          : {}),
      });
      return;
    }
    sendCommandResult(res, result);
  });
  router.post('/tasks', command('new', body));
  router.post('/tasks/route', command('route', body));
  router.post('/tasks/submit', command('submit', body));
  router.get(
    '/tasks/:id',
    command('status', (req) => ({ ref: req.params.id }))
  );
  router.post('/tasks/:id/send', command('send', withRef));
  router.post(
    '/tasks/:id/hold',
    command('hold', (req) => ({ ref: req.params.id }))
  );
  router.post('/tasks/:id/priority', command('priority', withRef));
  router.post('/tasks/:id/budget', command('budget', withRef));
  router.post('/tasks/:id/discard', command('discard', withRef));
  router.post('/tasks/:id/move', command('move', withRef));
  router.post('/tasks/:id/merge', command('merge', withRef));
  router.post(
    '/tasks/:id/verify',
    command('verify', (req) => ({ ref: req.params.id }))
  );
  router.post(
    '/tasks/:id/fix',
    command('fix', (req) => ({ ref: req.params.id }))
  );
  router.post('/tasks/:id/keep', command('keep', withRef));
  router.post(
    '/tasks/:id/revert',
    command('revert', (req) => ({ ref: req.params.id }))
  );
  router.post(
    '/tasks/:id/retry',
    // «Seguir con Codex»: a paused task goes on with the agent its pause offers.
    // The user's own tap («Reintentar», «Empezar ya»): past the project's limit, as asked.
    command('retry', (req) => ({
      ref: req.params.id,
      force: true,
      ...(typeof req.body?.agent === 'string' ? { agent: req.body.agent } : {}),
    }))
  );
  router.post(
    '/tasks/:id/answer',
    // The prompt of its agent's own a task stopped on (2026-11-10).
    command('answer', (req) => ({
      ref: req.params.id,
      ...(req.body?.choice !== undefined ? { choice: req.body.choice } : {}),
      ...(typeof req.body?.text === 'string' ? { text: req.body.text } : {}),
    }))
  );
  router.get(
    '/tasks/:id/log',
    command('logs', (req) => ({ ...(req.query as Record<string, unknown>), ref: req.params.id }))
  );

  router.put('/tasks/:id', (req, res) => {
    if (!fromUser(req as AuthenticatedRequest, res)) return;
    const tasks = scheduler(res);
    if (!tasks) return;
    const parsed = TaskPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: issues(parsed.error) });
    const runAtError = checkRunAt(parsed.data.runAt);
    if (runAtError) return res.status(400).json({ error: runAtError });
    const task = tasks.update(req.params.id, parsed.data);
    if (!task) return res.status(404).json({ error: 'No scheduled task with that id' });
    res.json({ task });
  });

  router.delete('/tasks/:id', (req, res) => {
    if (!fromUser(req as AuthenticatedRequest, res)) return;
    const tasks = scheduler(res);
    if (!tasks) return;
    const removed = tasks.remove(req.params.id);
    if (removed === 'not-found') return res.status(404).json({ error: 'Task not found' });
    if (removed === 'active') {
      return res.status(409).json({ error: 'The task still has its branch: discard it' });
    }
    res.json({ success: true });
  });

  router.get('/task-templates', (_req, res) => {
    res.json({ templates: configService.getTaskTemplates() });
  });

  const saveTemplates = (
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: ReturnType<ConfigService['getTaskTemplates']>
  ): boolean => {
    try {
      configService.updateTaskTemplates(next);
      return true;
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  router.post('/task-templates', (req, res) => {
    if (!fromUser(req as AuthenticatedRequest, res)) return;
    const parsed = TemplateInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: issues(parsed.error) });
    const template = { id: randomUUID(), ...parsed.data };
    if (!saveTemplates(res, [...configService.getTaskTemplates(), template])) return;
    res.json({ template });
  });

  router.put('/task-templates/:id', (req, res) => {
    if (!fromUser(req as AuthenticatedRequest, res)) return;
    const parsed = TemplateInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: issues(parsed.error) });
    const current = configService.getTaskTemplates();
    if (!current.some((tpl) => tpl.id === req.params.id)) {
      return res.status(404).json({ error: 'Template not found' });
    }
    const template = { id: req.params.id, ...parsed.data };
    const next = current.map((tpl) => (tpl.id === template.id ? template : tpl));
    if (!saveTemplates(res, next)) return;
    res.json({ template });
  });

  router.delete('/task-templates/:id', (req, res) => {
    if (!fromUser(req as AuthenticatedRequest, res)) return;
    const current = configService.getTaskTemplates();
    const next = current.filter((tpl) => tpl.id !== req.params.id);
    if (next.length === current.length)
      return res.status(404).json({ error: 'Template not found' });
    if (!saveTemplates(res, next)) return;
    res.json({ success: true });
  });

  return router;
}
