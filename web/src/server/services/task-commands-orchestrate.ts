/**
 * A project's orchestrator and the project itself: orchestrate, forget, new.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { NEW_PROJECT_NAME_MAX } from '../../shared/new-project.js';
import { TASK_PROMPT_MAX } from '../../shared/tasks.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';
import { createProjectCreator, NewProjectError, type ProjectCreator } from './project-create.js';
import { normalizeRepoPath } from './project-settings.js';
import type { TaskCommandsCore } from './task-commands-core.js';
import { fail, isFinal, issues, ok, ProjectSchema, pathField } from './task-commands-shared.js';
import type { Context, TaskOpFamily } from './task-commands-types.js';

const ProjectOrchestrateSchema = ProjectSchema.extend({
  goal: z.string().trim().min(1).max(TASK_PROMPT_MAX),
});

const ProjectNewSchema = z.object({
  name: z.string().trim().min(1).max(NEW_PROJECT_NAME_MAX),
  /** The parent folder: always given (the sheet's «Dónde», the CLI's --dir), never a default. */
  dir: pathField,
  goal: z.string().trim().max(TASK_PROMPT_MAX).optional(),
});

/**
 * `ut project orchestrate` / POST /projects/orchestrator (2026-10-23: only the signed-in app
 * could start one, so an outside assistant could not when it made a project). The user starts the
 * project's
 * orchestrator, or gives the running one the goal, at once; anyone else (an agent, a script,
 * a request without a login, another project's orchestrator, a task) asks the user's OK on
 * the phone, showing the project and the goal: an orchestrator gets rights over the
 * project's tasks.
 */
async function projectOrchestrate(
  self: TaskCommandsCore,
  args: Record<string, unknown>,
  ctx: Context
) {
  const service = self.deps.orchestrator?.();
  if (!service) return fail('unavailable', 'Orchestrators are not available here');
  const parsed = ProjectOrchestrateSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', 'repoPath and goal are required');
  const dir = parsed.data.repo ?? parsed.data.cwd;
  if (!dir) return fail('bad-request', 'repoPath and goal are required');
  const { goal } = parsed.data;
  if (ctx.caller.kind !== 'ui' && !ctx.confirmed) {
    const repoPath = await self.resolveRepo(dir);
    if (!repoPath) return fail('bad-request', 'Not inside a git repository');
    const name = path.basename(repoPath);
    const running = !!self.deps.settings.get(repoPath).orchestratorSessionId;
    return self.request(
      'project-orchestrate',
      {
        where: name,
        repoPath,
        summary: running
          ? `Give the orchestrator of ${name} a new goal`
          : `Start the orchestrator of ${name}`,
        detail: [
          `Project: ${repoPath}`,
          // Starting it trusts the folder: its Claude's trust dialog is answered (2026-10-23).
          ...(running ? [] : ['Untether will trust this folder for Claude Code.']),
          'Goal:',
          ...goal.split('\n'),
        ],
      },
      ctx,
      { op: 'project-orchestrate', args: { repo: repoPath, goal } }
    );
  }
  const result = await service.start(dir, goal);
  if (!result.ok) return fail(result.code === 'conflict' ? 'busy' : result.code, result.message);
  return ok({
    repoPath: result.repoPath,
    sessionId: result.sessionId,
    reused: result.reused,
    // Its brief is still waiting to be typed (Claude starting or busy): it goes in later.
    ...(result.pending ? { pending: true } : {}),
  });
}

/**
 * `ut project forget` / DELETE /projects (2026-10-24: only the signed-in app could, so an
 * orchestrator asked to remove test projects whose folders were gone left the user tapping
 * «Olvidar» by hand). Its projects.json record goes (settings, pin, orchestrator mapping; a
 * running orchestrator is stopped first); the folder is never touched and may be gone.
 * Refused while it has open tasks. The user forgets at once; anyone else asks their OK.
 */
async function projectForget(self: TaskCommandsCore, args: Record<string, unknown>, ctx: Context) {
  const parsed = ProjectSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const dir = parsed.data.repo ?? parsed.data.cwd;
  if (!dir) return fail('bad-request', 'repo is required');
  // The folder may be gone (that is why it is forgotten): then the key as given, normalized.
  const given = normalizeRepoPath(resolveAbsolutePath(dir));
  const repoPath = fs.existsSync(given) ? ((await self.resolveRepo(given)) ?? given) : given;
  const open = (self.deps.scheduler()?.list() ?? []).filter(
    (task) => self.taskRepo(task) === repoPath && !isFinal(task)
  );
  if (open.length) {
    return fail('busy', `It still has ${open.length} open task(s): merge or discard them first`, {
      data: { error: 'open-tasks', openTasks: open.length },
    });
  }
  const events = self.deps.orchestrator?.();
  const recorded = self.deps.settings
    .list()
    .some((entry) => normalizeRepoPath(entry.repoPath) === repoPath);
  const known = recorded || !!events?.sessionFor?.(repoPath);
  if (ctx.caller.kind !== 'ui' && !ctx.confirmed) {
    if (!known) return fail('not-found', `Untether has no record of ${repoPath}`);
    const name = path.basename(repoPath);
    return self.request(
      'project-forget',
      {
        where: name,
        repoPath,
        summary: `Forget the project ${name}`,
        detail: [
          `Project: ${repoPath}`,
          'Its settings, pin and orchestrator go; the folder is not touched.',
        ],
      },
      ctx,
      { op: 'project-forget', args: { repo: repoPath } }
    );
  }
  if (events?.sessionFor?.(repoPath) || self.deps.settings.get(repoPath).orchestratorSessionId) {
    await events?.stop?.(repoPath).catch(() => undefined);
  }
  // Who asked for it may have been that orchestrator: its rights here end too.
  self.orchestrators.delete(repoPath);
  // Stopping it may already have emptied the record (only its orchestrator was kept).
  const forgotten = self.deps.settings.remove(repoPath) || recorded;
  return ok({ repoPath, forgotten });
}

/**
 * `ut project new` / POST /projects/new («Nuevo proyecto», 2026-10-24): a folder named after
 * the project in the parent folder given (never a default one), git and a first commit with a
 * README (project-create.ts), its record pinned on top of the home so the board shows it at
 * once, and with a goal its orchestrator started through `project-orchestrate`. The user
 * makes it at once; anyone else asks their OK (autoApprove applies), showing the folder and
 * the goal. The orchestrator then starts as the user: the OK covered it.
 */
async function projectNew(self: TaskCommandsCore, args: Record<string, unknown>, ctx: Context) {
  const parsed = ProjectNewSchema.safeParse(args);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path[0]);
    if (missing.includes('dir')) {
      return fail('bad-request', 'Where to create it (the parent folder) is required', {
        data: { error: 'bad-parent' },
      });
    }
    return fail('bad-request', 'A project name is required', { data: { error: 'bad-name' } });
  }
  const { name, dir } = parsed.data;
  const goal = parsed.data.goal || undefined;
  const creator = self.deps.createProject ?? createProjectCreator();
  const refused = (error: unknown) =>
    error instanceof NewProjectError
      ? fail(
          error.code === 'exists' || error.code === 'inside-repo'
            ? 'busy'
            : error.code === 'failed' || error.code === 'git-missing'
              ? 'error'
              : error.code === 'no-permission'
                ? 'forbidden'
                : 'bad-request',
          error.message,
          { data: { error: error.code } }
        )
      : fail('error', error instanceof Error ? error.message : String(error));
  if (ctx.caller.kind !== 'ui' && !ctx.confirmed) {
    // Checked before anyone is asked: no OK for a folder that exists or a bad name.
    let planned: Awaited<ReturnType<ProjectCreator['plan']>>;
    try {
      planned = await creator.plan(name, dir);
    } catch (error) {
      return refused(error);
    }
    const folder = path.basename(planned.repoPath);
    return self.request(
      'project-new',
      {
        where: folder,
        repoPath: planned.repoPath,
        summary: `Create the project ${planned.name}`,
        detail: [
          `Folder: ${planned.repoPath}`,
          'With git and a first commit holding a README.',
          ...(goal
            ? [
                'Its orchestrator starts with this goal (Untether will trust the folder for Claude Code):',
                ...goal.split('\n'),
              ]
            : []),
        ],
      },
      ctx,
      {
        op: 'project-new',
        args: { name: planned.name, dir: planned.parent, ...(goal ? { goal } : {}) },
      }
    );
  }
  let created: Awaited<ReturnType<ProjectCreator['create']>>;
  try {
    created = await creator.create(name, dir, goal);
  } catch (error) {
    return refused(error);
  }
  const repoPath = normalizeRepoPath(created.repoPath);
  // A pinned record is what the board shows for a project with no session or task yet.
  self.deps.settings.update(repoPath, {
    pinnedAt: new Date(self.deps.now?.() ?? Date.now()).toISOString(),
  });
  const data: Record<string, unknown> = {
    repoPath,
    name: created.name,
    branch: created.branch,
    commit: created.commit,
  };
  if (goal) {
    // As the user (the app, or the OK just given): it starts at once.
    const started = await projectOrchestrate(
      self,
      { repo: repoPath, goal },
      { ...ctx, confirmed: true }
    );
    data.orchestrator =
      started.ok && started.status === 'done'
        ? {
            ok: true,
            sessionId: started.data.sessionId,
            ...(started.data.pending ? { pending: true } : {}),
          }
        : { ok: false, message: started.ok ? 'not started' : started.message };
  }
  return ok(data);
}

export const orchestrateOps: TaskOpFamily = {
  ops: {
    'project-orchestrate': projectOrchestrate,
    'project-forget': projectForget,
    'project-new': projectNew,
  },
};
