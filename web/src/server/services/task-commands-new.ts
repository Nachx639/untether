/**
 * A new task (new), and the prompt sent to the open task it belongs to (route, submit).
 */

import * as path from 'path';
import { z } from 'zod';
import {
  parseBudgetSpec,
  TASK_BUDGET_SPEC_MAX,
  type TaskBudgetSpec,
} from '../../shared/task-budget.js';
import {
  isZoneName,
  TASK_AFTER_MAX,
  TASK_ZONES_MAX,
  WAIT_OVER_STATES,
} from '../../shared/task-serial.js';
import {
  TASK_PARALLEL_MAX,
  TASK_PROMPT_MAX,
  type TaskModelTier,
  type TaskRecord,
  taskTitleFromPrompt,
} from '../../shared/tasks.js';
import type { ModelProvider } from '../../types/config.js';
import { isSafeRefName } from '../utils/exec-file.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';
import {
  findProvider,
  parseProviderModel,
  providerDefaultModel,
  providerModels,
} from './model-providers.js';
import type { TaskCommandsCore } from './task-commands-core.js';
import {
  fail,
  isFinal,
  issues,
  ok,
  pathField,
  type RouteOutcome,
  RouteSchema,
  refField,
} from './task-commands-shared.js';
import { send } from './task-commands-talk.js';
import type { Context, TaskOpFamily } from './task-commands-types.js';
import { toRoutable } from './task-router.js';
import type { TaskScheduler } from './task-scheduler.js';

/** A task as a routing answer lists it (the toast, "Cambiar", the one-tap choice). */
export interface RoutedTaskSummary {
  id: string;
  name: string;
  branch?: string;
  state: TaskRecord['state'];
}

/** A time picked a moment ago on the phone is still "now"; older than this is a mistake. */
const PAST_TOLERANCE_MS = 60_000;

const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

const RunAtSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'runAt must be a date')
  .transform((value) => new Date(value));

/** A model the agent understands (`--model` / `-m`): a level or a plain model name. */
const modelField = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][\w.:/[\]-]{0,99}$/, 'not a model name');

/** `--model fast|capable|<name>` as the scheduler takes it. */
function modelInput(model: string | undefined): { model?: string; modelTier?: TaskModelTier } {
  if (!model) return {};
  return model === 'fast' || model === 'capable' ? { modelTier: model } : { model };
}

/** What `--model` resolves to, including an external provider (`<id>:<model>`). */
type ResolvedModel = { model?: string; modelTier?: TaskModelTier; modelProvider?: string };

/**
 * `--model`, resolved against the configured providers: `<id>:<model>` where `<id>` is a
 * configured provider becomes a provider task (its model, else the provider's default); a
 * colon that is not a configured provider is left as a plain model name (so Bedrock-style ids
 * still work). A typo in a provider's model, or a provider with no default, fails fast.
 */
function resolveModelInput(
  model: string | undefined,
  providers: ModelProvider[] | undefined
): { ok: true; value: ResolvedModel } | { ok: false; error: string } {
  if (!model) return { ok: true, value: {} };
  const parsed = parseProviderModel(model);
  const provider = parsed ? findProvider({ modelProviders: providers }, parsed.providerId) : null;
  if (parsed && provider) {
    const chosen = parsed.model ?? providerDefaultModel(provider);
    if (!chosen) {
      return {
        ok: false,
        error: `Provider "${provider.id}" has no default model; name one as ${provider.id}:<model>.`,
      };
    }
    const list = providerModels(provider);
    if (list.length && !list.some((m) => m.id === chosen)) {
      return {
        ok: false,
        error: `Provider "${provider.id}" has no model "${chosen}" (has: ${list
          .map((m) => m.id)
          .join(', ')}).`,
      };
    }
    return { ok: true, value: { modelProvider: provider.id, model: chosen } };
  }
  return { ok: true, value: modelInput(model) };
}

/**
 * A task title: a longer one is cut at a word with "…" (taskTitleFromPrompt), never refused.
 * 2026-11-01: titles of 81-90 characters failed `ut task new` again and again for agents.
 */
const titleField = z.string().trim().min(1).max(TASK_PROMPT_MAX).transform(taskTitleFromPrompt);

const NewSchema = z.object({
  name: titleField.optional(),
  title: titleField.optional(),
  prompt: z.string().trim().min(1).max(TASK_PROMPT_MAX),
  workingDir: pathField.optional(),
  /** The CLI's folder: the task's folder when neither workingDir nor repoPath is given. */
  cwd: pathField.optional(),
  repoPath: pathField.optional(),
  command: z.array(z.string().min(1).max(4096)).min(1).max(64).optional(),
  agent: z.enum(['claude', 'codex']).default('claude'),
  shielded: z.boolean().default(false),
  notify: z.boolean().default(true),
  runAt: RunAtSchema.nullish(),
  isolation: z.enum(['worktree', 'none']).default('none'),
  baseBranch: z.string().refine(isSafeRefName, 'invalid branch name').optional(),
  mergePolicy: z.enum(['auto', 'ask']).optional(),
  parallel: z.number().int().min(1).max(TASK_PARALLEL_MAX).default(1),
  /** `--model`: fast or capable (the installation's model for that level), or a model name. */
  model: modelField.optional(),
  /** Its own budget over the project's (shared/task-budget.ts): "wall=2h,rounds=4". */
  budget: z.string().trim().min(1).max(TASK_BUDGET_SPEC_MAX).optional(),
  /** `--after`: the tasks (id, its first characters, or branch) it starts after. */
  after: z.array(refField).max(TASK_AFTER_MAX).optional(),
  /** `--zone`: tasks of the project that share one never work at once. */
  zone: z
    .array(z.string().trim().refine(isZoneName, 'a zone is a short name (letters, digits, . _ -)'))
    .max(TASK_ZONES_MAX)
    .optional(),
});

const SubmitSchema = RouteSchema.extend({
  agent: z.enum(['claude', 'codex']).default('claude'),
  /** A task id (or branch) to send it to, or 'new'; none = route it. */
  choice: refField.optional(),
  title: titleField.optional(),
  command: z.array(z.string().min(1).max(4096)).min(1).max(64).optional(),
  shielded: z.boolean().optional(),
  baseBranch: z.string().refine(isSafeRefName, 'invalid branch name').optional(),
  mergePolicy: z.enum(['auto', 'ask']).optional(),
});

/** A task's name from its prompt (the CLI's `ut task new` without --title). */
export const titleFromPrompt = taskTitleFromPrompt;

/** Open tasks for a routing answer, the most recently active first. */
function summaries(tasks: readonly TaskRecord[]): RoutedTaskSummary[] {
  const activity = (task: TaskRecord) => Number(toRoutable(task).lastActivityAt) || 0;
  return [...tasks]
    .sort((a, b) => activity(b) - activity(a))
    .map((task) => ({
      id: task.id,
      name: task.name,
      ...(task.branch ? { branch: task.branch } : {}),
      state: task.state,
    }));
}

function checkRunAt(runAt: Date | null | undefined): string | null {
  if (!runAt) return null;
  const now = Date.now();
  if (runAt.getTime() < now - PAST_TOLERANCE_MS) return 'runAt is in the past';
  if (runAt.getTime() > now + MAX_AHEAD_MS) return 'runAt is too far ahead';
  return null;
}

/** Flags that let an agent act without asking (Claude and Codex). */
const BYPASS_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
]);

/** An agent's command line without its permission bypass (bypassPermissions mode included). */
export function withoutBypass(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i > 0 && BYPASS_FLAGS.has(arg)) continue;
    if (i > 0 && /^--permission-mode=bypassPermissions$/i.test(arg)) continue;
    if (i > 0 && arg === '--permission-mode' && /^bypassPermissions$/i.test(argv[i + 1] ?? '')) {
      i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

async function create(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = NewSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const input = parsed.data;
  const role = ctx.confirmed ? 'user' : self.roleFor(ctx.caller);
  const isolation = input.parallel > 1 ? 'worktree' : input.isolation;
  // 2026-10-18: a task asked about another project told the user to go elsewhere. It may hand
  // the request over to a plain session in that folder, which has nothing to merge.
  // 2026-10-20: checked on the isolation it gets (`--no-worktree --parallel 2` is worktrees).
  if (role === 'task' && isolation !== 'none') {
    return fail('forbidden', 'A task cannot start other tasks (ut task handoff only)');
  }
  const workingDir = input.workingDir ?? input.repoPath ?? input.cwd;
  if (!workingDir) return fail('bad-request', 'workingDir: Required');
  let name = input.title ?? input.name;
  if (!name) {
    if (ctx.caller.kind !== 'cli') return fail('bad-request', 'name: Required');
    name = titleFromPrompt(input.prompt);
  }
  const runAtError = checkRunAt(input.runAt);
  if (runAtError) return fail('bad-request', runAtError);
  let budget: TaskBudgetSpec | undefined;
  if (input.budget) {
    try {
      budget = parseBudgetSpec(input.budget);
    } catch (error) {
      return fail('bad-budget', (error as Error).message);
    }
  }
  // `--model <id>:<model>` against a configured provider (model-providers.ts); fails fast on
  // an unknown provider model. Providers speak the Anthropic Messages API, so a provider task
  // only runs Claude Code: `--agent codex` with a provider is refused (it would get Anthropic
  // variables that do not configure Codex and run the wrong agent).
  // `--after`: tasks that exist and may still merge. One already merged or done is in the
  // base: nothing to wait for; one discarded or never run would keep it waiting for good.
  const after: string[] = [];
  const notes: string[] = [];
  for (const ref of input.after ?? []) {
    const found = self.find(scheduler, ref, ctx);
    if (!('task' in found)) return found.error;
    const other = found.task;
    const id = other.id.slice(0, 8);
    if (WAIT_OVER_STATES.includes(other.state)) {
      notes.push(`Note: ${id} is already ${other.state}: nothing to wait for there.`);
    } else if (isFinal(other)) {
      return fail(
        'bad-request',
        `--after ${id}: that task is ${other.state}, its work will never merge; leave it out`
      );
    } else if (!after.includes(other.id)) after.push(other.id);
  }
  const resolvedModel = resolveModelInput(input.model, self.deps.providers?.());
  if (!resolvedModel.ok) return fail('bad-request', resolvedModel.error);
  if (resolvedModel.value.modelProvider && input.agent === 'codex') {
    return fail(
      'bad-request',
      `Model provider "${resolvedModel.value.modelProvider}" runs Claude Code; it cannot run with --agent codex.`
    );
  }
  let repo: string | null = null;
  if (ctx.caller.kind === 'cli' && isolation === 'worktree') {
    repo = await self.resolveRepo(input.repoPath ?? workingDir);
    if (!repo) {
      return fail(
        'bad-request',
        `${workingDir} is not inside a git repository (use --no-worktree)`
      );
    }
  }
  const callerSession = ctx.caller.kind === 'cli' ? ctx.caller.sessionId : undefined;
  // 2026-10-20: `ut task new --no-worktree` or `ut task handoff --dir X` from an orchestrator
  // started a session with the user's quick start (--dangerously-skip-permissions) in any
  // folder, with no check, review or merge to stop it. For a session that orchestrates any
  // project, such a session waits for the user's OK and never gets a permission bypass.
  const orchestrator = !!callerSession && self.orchestratedRepos(callerSession).length > 0;
  if (isolation === 'none' && orchestrator && !ctx.confirmed && role !== 'task') {
    const command = withoutBypass(
      input.command ?? self.deps.commandFor?.(input.agent) ?? [input.agent]
    );
    const folder = resolveAbsolutePath(workingDir);
    return self.request(
      'start',
      {
        where: name,
        summary: `Start a session without a worktree in ${path.basename(folder)}: ${name}`,
        detail: [
          `in ${folder}`,
          `runs ${command.join(' ')}`,
          ...input.prompt.split('\n').slice(0, 6),
        ],
      },
      ctx,
      {
        op: 'new',
        args: {
          name,
          prompt: input.prompt,
          workingDir: folder,
          agent: input.agent,
          command,
          isolation: 'none',
          notify: input.notify,
          ...(input.model ? { model: input.model } : {}),
          ...(input.runAt ? { runAt: input.runAt.toISOString() } : {}),
          ...(after.length ? { after } : {}),
          ...(input.zone?.length ? { zone: input.zone } : {}),
        },
      }
    );
  }
  const orchestrating =
    !ctx.confirmed &&
    !!callerSession &&
    !!repo &&
    self.roleFor(ctx.caller, repo) === 'orchestrator';
  // 2026-10-20: orchestrators started tasks in other projects (which then reported to
  // nobody). An orchestrator works only in its own project; a plain session is warned.
  let warning: string | undefined = notes.join('\n') || undefined;
  if (callerSession && !ctx.confirmed && isolation === 'worktree' && role !== 'task') {
    const own = self.orchestratedRepos(callerSession);
    const target = repo ?? (await self.resolveRepo(input.repoPath ?? workingDir));
    if (own.length && target && !own.includes(target)) {
      return fail(
        'forbidden',
        `You orchestrate only ${own.map((dir) => path.basename(dir)).join(', ')}: tasks in ${path.basename(target)} are not yours to start. Tell the user instead.`
      );
    }
    const here = input.cwd ? await self.resolveRepo(input.cwd) : null;
    if (!own.length && here && target && here !== target) {
      notes.push(`Note: this task is for ${target}, not the project this session is in (${here}).`);
      warning = notes.join('\n');
    }
  }
  let command = input.command ?? self.deps.commandFor?.(input.agent) ?? [input.agent];
  // An orchestrator's own sessions never skip permissions (worktree tasks are checked,
  // reviewed and merged by the engine; a plain one is not).
  if (orchestrator && isolation === 'none') command = withoutBypass(command);
  // 2026-10-20: a session an orchestrator asked for and the user approved ran as the user's
  // own, so its events reached nobody. Approved for an orchestrator, it is still its task.
  const owner =
    orchestrating && callerSession
      ? callerSession
      : ctx.confirmed && ctx.onBehalfOf && self.orchestratedRepos(ctx.onBehalfOf).length > 0
        ? ctx.onBehalfOf
        : undefined;
  const created = await scheduler.createGroup(
    {
      name,
      prompt: input.prompt,
      workingDir,
      command,
      agent: input.agent,
      shielded: input.shielded,
      notify: input.notify,
      runAt: input.runAt ?? undefined,
      isolation,
      ...(input.repoPath ? { repoPath: input.repoPath } : {}),
      ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
      ...(input.mergePolicy ? { mergePolicy: input.mergePolicy } : {}),
      ...resolvedModel.value,
      ...(budget ? { budget } : {}),
      ...(after.length ? { after } : {}),
      ...(input.zone?.length ? { zones: input.zone } : {}),
      ...(owner ? { origin: 'orchestrator' as const, orchestratorSessionId: owner } : {}),
      ...((callerSession ?? ctx.onBehalfOf)
        ? { createdBySessionId: callerSession ?? ctx.onBehalfOf }
        : {}),
    },
    input.parallel
  );
  const tasks = created.map((task) => scheduler.get(task.id) ?? task);
  const [task] = tasks;
  if (tasks.every((entry) => entry.state === 'failed')) {
    return fail('error', task.error ?? 'The task could not start', { data: { task, tasks } });
  }
  // Its prompt names files an open task of the project already changes: said, never held.
  const touches = await scheduler.touchedByOthers(task.id);
  return ok({
    task,
    tasks,
    ...(warning ? { warning } : {}),
    ...(touches.length ? { touches } : {}),
  });
}

/** Read only: where a prompt would go, and the open tasks to offer instead. */
async function route(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>
) {
  const parsed = RouteSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const repoPath = await self.routeRepo(parsed.data);
  if (!repoPath) return fail('bad-request', 'Not inside a git repository');
  const { decision, open } = await self.decide(scheduler, repoPath, parsed.data.text);
  return ok({ repoPath, decision, open: summaries(open) });
}

/**
 * A prompt typed on the home screen: to the task the user picked (`choice`), a new task
 * (`choice: 'new'`), or where routing sends it. An unsure route changes nothing and answers
 * `action: 'ask'` with the tasks to offer. Sending and starting keep their own rights.
 */
async function submit(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = SubmitSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const input = parsed.data;
  const repoPath = await self.routeRepo(input);
  if (!repoPath) return fail('bad-request', 'Not inside a git repository');
  let choice = input.choice;
  let decision: RouteOutcome | undefined;
  if (!choice) {
    const decided = await self.decide(scheduler, repoPath, input.text);
    decision = decided.decision;
    if (decision.kind === 'ask') {
      return ok({ action: 'ask', repoPath, decision, open: summaries(decided.open) });
    }
    choice = decision.kind === 'match' && decision.taskId ? decision.taskId : 'new';
  }
  const extra = { repoPath, ...(decision ? { decision } : {}) };
  if (choice === 'new') {
    const created = await create(
      self,
      scheduler,
      {
        prompt: input.text,
        title: input.title ?? titleFromPrompt(input.text),
        workingDir: repoPath,
        repoPath,
        isolation: 'worktree',
        agent: input.agent,
        ...(input.command ? { command: input.command } : {}),
        ...(input.shielded !== undefined ? { shielded: input.shielded } : {}),
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        ...(input.mergePolicy ? { mergePolicy: input.mergePolicy } : {}),
      },
      ctx
    );
    return created.ok && created.status === 'done'
      ? ok({ action: 'created', ...created.data, ...extra })
      : created;
  }
  const sent = await send(self, scheduler, { ref: choice, text: input.text }, ctx, 'route');
  return sent.ok && sent.status === 'done' ? ok({ action: 'sent', ...sent.data, ...extra }) : sent;
}

export const newOps: TaskOpFamily = {
  taskOps: {
    new: create,
    route: (self, scheduler, args) => route(self, scheduler, args),
    submit: (self, scheduler, args, ctx) => submit(self, scheduler, args, ctx),
  },
};
