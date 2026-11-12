/**
 * Projects (git repositories) of the task engine (mounted under /api, behind auth).
 *
 *   GET /projects                  repositories with settings or tasks, with their settings
 *                                  (settings.missingSince: its folder is gone, not found)
 *   GET /projects/settings         ?repo=<any folder in it> → { repoPath, settings, stored }
 *   PUT /projects/settings         { repoPath, settings: { field: value | null } } (null clears)
 *   GET /projects/detect-check     ?repo= → { checks, suggestions } what would run as its check
 *   POST /projects/orchestrator    { repoPath, goal } → { repoPath, sessionId, reused, pending? }
 *                                  starts the project's orchestrator (or gives a running one
 *                                  the goal); pending: its brief is not typed in yet. Without
 *                                  a login: 202 pending-confirmation (`ut project orchestrate`)
 *   POST /projects/orchestrator/adopt { repoPath, sessionId, goal? } → the same, for an open
 *                                  Claude session
 *   DELETE /projects/orchestrator  ?repo= → { sessionId } stops it (its tasks go on)
 *   POST /projects/git-init/preview { folder } → what the first commit of a folder without git
 *                                  would hold (services/project-git-init.ts, rules only)
 *   POST /projects/git-init/review { folder, locale? } → the AI's verdicts on it (may be
 *                                  { status: 'unavailable' })
 *   POST /projects/git-init        { folder, exclude[] } → { repoPath, commit, files }
 *   GET /projects/new              → { parent } where the «Nuevo proyecto» sheet's «Dónde»
 *                                  browser starts: the last parent the user picked for a new
 *                                  project (config.json newProjectParent), else the home folder.
 *                                  Only a starting point: nothing is ever made there unasked
 *   POST /projects/new             { name, dir, goal? } → { repoPath, name, branch, commit,
 *                                  orchestrator? }: a folder named after the project in `dir`
 *                                  (required, never a default), git, a first commit with a
 *                                  README, the project pinned on the home; with a goal its
 *                                  orchestrator starts. Errors: { error: NewProjectErrorCode,
 *                                  message } (folder exists, no permission, git missing…).
 *                                  Without a login: 202 pending-confirmation (`ut project new`)
 *   PUT /projects/group-order      { order: string[] } → { order }: the home's group order the
 *                                  user chose (dragging a header, «Subir» / «Bajar»), the same
 *                                  on every device (services/group-order.ts). Signed-in app only
 *   PUT /projects/session-order    { order: string[] } → { order }: the order of the sessions
 *                                  inside their groups the user chose (dragging a row), session
 *                                  ids; same store and rules as group-order
 *   PUT /projects/collapsed-groups { collapsed: string[] } → { collapsed }: the groups the
 *                                  user folded in the phone list and the sidebar (group
 *                                  folders, "(others)" for "Otras"); same store and rules
 *   DELETE /projects               ?repo= → { repoPath, forgotten } forgets a project: its
 *                                  projects.json record goes (settings, pin, orchestrator
 *                                  mapping; a running orchestrator is stopped first); the
 *                                  folder is never touched. 409 with open tasks. Without a
 *                                  login: 202 pending-confirmation (`ut project forget`)
 *
 * Settings are keyed by the repository's main checkout; any folder inside it (a worktree too)
 * names the same project. Reading and changing them runs through services/task-commands.ts:
 * a change without a login (localhost bypass: maybe an agent with curl) waits for the user's
 * OK (202 pending-confirmation), so no agent sets its own check or merge policy. Starting an
 * orchestrator hands out rights over the project's tasks: the signed-in app starts it at once;
 * anyone else (an agent with curl, `ut project orchestrate` from another assistant, a script,
 * another
 * project's orchestrator, a task) gets the same 202 and it starts only once the user approves
 * it on the phone, showing the project and the goal (2026-10-23). Forgetting a project works
 * the same way (2026-10-24), and so does creating one (`ut project new`, 2026-10-24: the
 * signed-in app's «Nuevo proyecto» makes it at once and remembers its parent folder; an agent's
 * waits for the OK, and once approved its orchestrator starts too). Adopting a session and
 * stopping an orchestrator stay the signed-in app's (403 otherwise). So does turning a folder
 * into a repository (git-init): a user action from the phone, never an agent's (no `ut`
 * command for it either).
 */
import { type Response, Router } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import type { ProjectSummary } from '../../shared/projects.js';
import { TASK_FINAL_STATES, TASK_PROMPT_MAX } from '../../shared/tasks.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { GroupOrderError, type GroupOrderStore } from '../services/group-order.js';
import type { Orchestrator } from '../services/orchestrator.js';
import { createGitInit, type GitInit, GitInitError } from '../services/project-git-init.js';
import { resolveProjectIcon, sendIconFile } from '../services/project-icon.js';
import { normalizeRepoPath, type ProjectSettingsStore } from '../services/project-settings.js';
import { callerFromAuth, httpStatus, type TaskCommands } from '../services/task-commands.js';
import type { TaskScheduler } from '../services/task-scheduler.js';
import { detectProjectChecks } from '../services/task-verify.js';
import { resolveMainRepo } from '../services/task-worktree.js';
import { run } from '../utils/exec-file.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';
import { sendCommandResult } from './tasks.js';

const RepoQuerySchema = z.object({ repo: z.string().trim().min(1).max(4096) });
const AdoptSchema = z.object({
  repoPath: z.string().trim().min(1).max(4096),
  sessionId: z.string().trim().min(1).max(200),
  goal: z.string().trim().max(TASK_PROMPT_MAX).optional(),
});
const PinSchema = z.object({
  repoPath: z
    .string()
    .trim()
    .min(2)
    .max(4096)
    .refine((dir) => path.isAbsolute(dir), 'must be an absolute path'),
  pinned: z.boolean(),
});
const GitInitSchema = z.object({
  folder: z.string().trim().min(1).max(4096),
  locale: z.string().max(10).optional(),
  exclude: z.array(z.string().min(1).max(4096)).max(2000).optional(),
});
const GIT_INIT_STATUS = { 'bad-request': 400, conflict: 409, busy: 409, failed: 500 } as const;

const PutSchema = z.object({
  repoPath: z.string().trim().min(1).max(4096),
  settings: z.record(z.string(), z.unknown()),
});

/** Single-quote a word for a shell when it needs it. */
function quote(word: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

async function mainRepo(dir: string): Promise<string | null> {
  const repo = await resolveMainRepo(resolveAbsolutePath(dir)).catch(() => null);
  return repo ? normalizeRepoPath(repo) : null;
}

export function createProjectRoutes(options: {
  settings: ProjectSettingsStore;
  scheduler: () => TaskScheduler | null;
  commands: TaskCommands;
  orchestrator?: () => Orchestrator | null;
  gitInit?: GitInit;
  /** The last parent folder the user picked for a new project (config.json). */
  newProjectParent?: { get(): string | undefined; set(dir: string): void };
  /** The home folder (default os.homedir()): where «Dónde» starts the first time. */
  home?: string;
  /** The home's group order (services/group-order.ts). */
  groupOrder?: GroupOrderStore;
}): Router {
  const router = Router();
  const { settings } = options;
  const gitInit = options.gitInit ?? createGitInit();

  /** git-init's input, when the signed-in app sends it (403 / 400 otherwise). */
  const gitInitInput = (req: AuthenticatedRequest, res: Response) => {
    if (callerFromAuth(req.authMethod).kind !== 'ui') {
      res.status(403).json({ error: 'Only the signed-in app can turn a folder into a repository' });
      return null;
    }
    const parsed = GitInitSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'folder is required' });
      return null;
    }
    return parsed.data;
  };
  const gitInitFailed = (res: Response, error: unknown) => {
    if (error instanceof GitInitError) {
      return res
        .status(GIT_INIT_STATUS[error.code])
        .json({ error: error.message, code: error.code });
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  };

  router.post('/projects/git-init/preview', async (req: AuthenticatedRequest, res: Response) => {
    const input = gitInitInput(req, res);
    if (!input) return;
    try {
      res.json(await gitInit.preview(input.folder));
    } catch (error) {
      gitInitFailed(res, error);
    }
  });

  router.post('/projects/git-init/review', async (req: AuthenticatedRequest, res: Response) => {
    const input = gitInitInput(req, res);
    if (!input) return;
    try {
      res.json(await gitInit.review(input.folder, input.locale));
    } catch (error) {
      gitInitFailed(res, error);
    }
  });

  router.post('/projects/git-init', async (req: AuthenticatedRequest, res: Response) => {
    const input = gitInitInput(req, res);
    if (!input) return;
    try {
      res.json(await gitInit.init(input.folder, input.exclude ?? []));
    } catch (error) {
      gitInitFailed(res, error);
    }
  });

  /** Pin a project (a repository or a project folder) on top of the home, or unpin it. */
  router.post('/projects/pin', (req: AuthenticatedRequest, res: Response) => {
    if (callerFromAuth(req.authMethod).kind !== 'ui') {
      return res.status(403).json({ error: 'Only the signed-in app can pin projects' });
    }
    const parsed = PinSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'repoPath and pinned are required' });
    const { repoPath, pinned } = parsed.data;
    try {
      settings.update(repoPath, { pinnedAt: pinned ? new Date().toISOString() : null });
    } catch (error) {
      return res
        .status(400)
        .json({ error: error instanceof Error ? error.message : String(error) });
    }
    res.json({ repoPath, pinned });
  });

  router.put('/projects/group-order', (req: AuthenticatedRequest, res: Response) => {
    if (callerFromAuth(req.authMethod).kind !== 'ui') {
      return res.status(403).json({ error: 'Only the signed-in app can order the home' });
    }
    if (!options.groupOrder) return res.status(503).json({ error: 'Group order is not available' });
    try {
      res.json({ order: options.groupOrder.set(req.body?.order) });
    } catch (error) {
      if (!(error instanceof GroupOrderError)) throw error;
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/projects/session-order', (req: AuthenticatedRequest, res: Response) => {
    if (callerFromAuth(req.authMethod).kind !== 'ui') {
      return res.status(403).json({ error: 'Only the signed-in app can order the home' });
    }
    if (!options.groupOrder) return res.status(503).json({ error: 'Group order is not available' });
    try {
      res.json({ order: options.groupOrder.setSessions(req.body?.order) });
    } catch (error) {
      if (!(error instanceof GroupOrderError)) throw error;
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/projects/collapsed-groups', (req: AuthenticatedRequest, res: Response) => {
    if (callerFromAuth(req.authMethod).kind !== 'ui') {
      return res.status(403).json({ error: 'Only the signed-in app can fold the home' });
    }
    if (!options.groupOrder) return res.status(503).json({ error: 'Group order is not available' });
    try {
      res.json({ collapsed: options.groupOrder.setCollapsed(req.body?.collapsed) });
    } catch (error) {
      if (!(error instanceof GroupOrderError)) throw error;
      res.status(400).json({ error: error.message });
    }
  });

  /** The orchestrator service, or the answer that there is none / no right to it. */
  const orchestrator = (req: AuthenticatedRequest, res: Response): Orchestrator | null => {
    if (callerFromAuth(req.authMethod).kind !== 'ui') {
      res.status(403).json({ error: 'Only the signed-in app can adopt or stop an orchestrator' });
      return null;
    }
    const instance = options.orchestrator?.() ?? null;
    if (!instance) res.status(503).json({ error: 'Orchestrators are not available here' });
    return instance;
  };

  /** Starts it, or waits for the user's OK when the request has no login (task-commands.ts). */
  router.post('/projects/orchestrator', async (req: AuthenticatedRequest, res: Response) => {
    const body = (req.body ?? {}) as { repoPath?: unknown; goal?: unknown };
    const result = await options.commands.run(
      'project-orchestrate',
      { repo: body.repoPath, goal: body.goal },
      callerFromAuth(req.authMethod)
    );
    if (result.ok && result.status === 'pending-confirmation') {
      return sendCommandResult(res, result);
    }
    // The app reads `error` as the message (utils/task-status.ts).
    if (!result.ok) return res.status(httpStatus(result)).json({ error: result.message });
    res.json(result.data);
  });

  /** An open Claude session of the project becomes its orchestrator, keeping its conversation. */
  router.post('/projects/orchestrator/adopt', async (req: AuthenticatedRequest, res: Response) => {
    const service = orchestrator(req, res);
    if (!service) return;
    const parsed = AdoptSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'repoPath and sessionId are required' });
    }
    const { repoPath, sessionId, goal } = parsed.data;
    const result = await service.adopt(repoPath, sessionId, goal ?? '');
    if (!result.ok) {
      const status = result.code === 'bad-request' ? 400 : result.code === 'conflict' ? 409 : 500;
      return res.status(status).json({ error: result.message });
    }
    res.json({
      repoPath: result.repoPath,
      sessionId: result.sessionId,
      reused: result.reused,
      // Its brief is still waiting to be typed (Claude starting or busy): it goes in later.
      ...(result.pending ? { pending: true } : {}),
    });
  });

  router.delete('/projects/orchestrator', async (req: AuthenticatedRequest, res: Response) => {
    const service = orchestrator(req, res);
    if (!service) return;
    const parsed = RepoQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'repo is required' });
    const result = await service.stop(parsed.data.repo);
    if (!result.ok) return res.status(404).json({ error: result.message });
    res.json({ sessionId: result.sessionId, ...(result.kept ? { kept: true } : {}) });
  });

  /** Forgets it at once for the signed-in app; anyone else waits for the user's OK. */
  router.delete('/projects', async (req: AuthenticatedRequest, res: Response) => {
    const parsed = RepoQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'repo is required' });
    const result = await options.commands.run(
      'project-forget',
      { repo: parsed.data.repo },
      callerFromAuth(req.authMethod)
    );
    if (result.ok && result.status === 'pending-confirmation') {
      return sendCommandResult(res, result);
    }
    if (!result.ok) {
      // The app reads `error` ('open-tasks' with open tasks) and `message`.
      return res
        .status(httpStatus(result))
        .json({ error: result.message, ...result.data, message: result.message });
    }
    res.json(result.data);
  });

  router.get('/projects/new', (_req, res) => {
    const last = options.newProjectParent?.get();
    const usable = !!last && path.isAbsolute(last) && fs.existsSync(last);
    res.json({ parent: usable ? last : (options.home ?? os.homedir()) });
  });

  /** Makes it at once for the signed-in app; anyone else waits for the user's OK. */
  router.post('/projects/new', async (req: AuthenticatedRequest, res: Response) => {
    const body = (req.body ?? {}) as { name?: unknown; dir?: unknown; goal?: unknown };
    const caller = callerFromAuth(req.authMethod);
    const result = await options.commands.run(
      'project-new',
      { name: body.name, dir: body.dir, goal: body.goal },
      caller
    );
    if (result.ok && result.status === 'pending-confirmation') {
      return sendCommandResult(res, result);
    }
    if (!result.ok) {
      // The app words `error` (shared/new-project.ts) in the user's language.
      return res
        .status(httpStatus(result))
        .json({ error: result.data?.error ?? 'failed', message: result.message });
    }
    // Where «Dónde» starts next time: the parent the user just picked.
    if (caller.kind === 'ui' && typeof result.data.repoPath === 'string') {
      try {
        options.newProjectParent?.set(path.dirname(result.data.repoPath));
      } catch {
        // Only a starting point for the next time.
      }
    }
    res.json(result.data);
  });

  router.get('/projects', (_req, res) => {
    // Renamed or moved project folders are followed (at most every 30 s; seen next time).
    void settings.followMoves();
    const tasks = options.scheduler()?.list() ?? [];
    const repos = new Map<string, ProjectSummary>();
    const add = (repoPath: string) => {
      const key = normalizeRepoPath(repoPath);
      let entry = repos.get(key);
      if (!entry) {
        entry = {
          repoPath: key,
          name: path.basename(key),
          settings: settings.get(key),
          openTasks: 0,
        };
        repos.set(key, entry);
      }
      return entry;
    };
    for (const { repoPath } of settings.list()) add(repoPath);
    for (const task of tasks) {
      if (!task.repoPath) continue;
      const entry = add(task.repoPath);
      if (!TASK_FINAL_STATES.includes(task.state)) entry.openTasks++;
    }
    const projects = [...repos.values()].sort((a, b) => a.name.localeCompare(b.name));
    res.json({ projects });
  });

  /** The project's icon (ProjectSettings.icon), for the orchestrator's row. */
  router.get('/projects/icon', (req: AuthenticatedRequest, res: Response) => {
    const parsed = RepoQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'repo is required' });
    const repoPath = normalizeRepoPath(parsed.data.repo);
    const relative = settings.get(repoPath).icon;
    if (!relative) return res.status(404).json({ error: 'no icon' });
    const icon = resolveProjectIcon(repoPath, relative);
    if ('error' in icon) return res.status(404).json({ error: icon.error });
    sendIconFile(res, icon, 300);
  });

  router.get('/projects/settings', async (req: AuthenticatedRequest, res: Response) => {
    const parsed = RepoQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'repo is required' });
    const result = await options.commands.run(
      'project-show',
      { repo: parsed.data.repo },
      callerFromAuth(req.authMethod)
    );
    sendCommandResult(res, result);
  });

  router.put('/projects/settings', async (req: AuthenticatedRequest, res: Response) => {
    const parsed = PutSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return res.status(400).json({ error: 'repoPath and settings are required' });
    const result = await options.commands.run(
      'project-set',
      { repo: parsed.data.repoPath, settings: parsed.data.settings },
      callerFromAuth(req.authMethod)
    );
    sendCommandResult(res, result);
  });

  router.get('/projects/detect-check', async (req, res) => {
    const parsed = RepoQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'repo is required' });
    const repoPath = await mainRepo(parsed.data.repo);
    if (!repoPath) return res.status(400).json({ error: 'Not inside a git repository' });
    const checks = await detectProjectChecks(repoPath, (args) =>
      run('git', args, repoPath, 15_000)
    );
    // Xcode gets no default (slow, signing-dependent): only a suggestion to set by hand.
    const xcode = await run(
      'git',
      ['ls-files', '-z', '--', ':(glob)**/*.xcodeproj/project.pbxproj'],
      repoPath,
      15_000
    );
    const suggestions = (xcode.code === 0 ? xcode.stdout.split('\0') : [])
      .filter(Boolean)
      .slice(0, 5)
      .map((file) => {
        const project = path.dirname(file);
        const scheme = path.basename(project, '.xcodeproj');
        return {
          command: `xcodebuild test -project ${quote(project)} -scheme ${quote(scheme)} -destination 'platform=macOS'`,
          reason: `Xcode project ${project}`,
        };
      });
    res.json({
      repoPath,
      checks,
      suggestions,
      override: settings.get(repoPath).checkCommand ?? null,
    });
  });

  return router;
}
