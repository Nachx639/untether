/**
 * What is done with a task once it has work: verify, fix, retry, merge, discard, keep,
 * revert, hold, priority, budget, move.
 */

import { z } from 'zod';
import { TASK_BUDGET_SPEC_MAX } from '../../shared/task-budget.js';
import { reviewIssueLine, type TaskRecord } from '../../shared/tasks.js';
import type { TaskCommandsCore } from './task-commands-core.js';
import { fail, fromAction, isFinal, issues, ok, refField } from './task-commands-shared.js';
import type { Context, TaskOpFamily } from './task-commands-types.js';
import type { TaskScheduler } from './task-scheduler.js';

/** A runner: claude, codex or the name of one in the installation's taskFallbacks. */
const runnerField = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][\w.-]{0,63}$/, 'not an agent name');

const RefSchema = z.object({ ref: refField.optional() });

const PrioritySchema = z.object({
  ref: refField.optional(),
  level: z.enum(['urgent', 'normal']),
});

const BudgetSchema = z.object({
  ref: refField.optional(),
  /** "+1h", "+50%", "rounds=+2"…; empty: +50% of the limits it reached. */
  change: z.string().trim().max(TASK_BUDGET_SPEC_MAX).default(''),
});

const MoveSchema = z.object({
  ref: refField,
  /** Its place in its project's line, 1 = next. */
  position: z.coerce.number().int().min(1).max(10_000),
});

const RetrySchema = z.object({
  ref: refField.optional(),
  /**
   * A task held for its agent's usage limit starts now on this one; a paused one goes on with
   * it in its worktree (claude, codex or a configured runner).
   */
  agent: runnerField.optional(),
  /**
   * Past its project's limit (maxActiveTasks) and the Mac's room: a queued task starts now, a
   * paused or failed one goes back to work with no slot free. Without it they wait for one.
   */
  force: z.boolean().optional(),
});

const MergeSchema = z.object({
  ref: refField,
  acceptRisk: z.boolean().optional(),
  acceptReview: z.boolean().optional(),
  reviewAgain: z.boolean().optional(),
});

const ConfirmSchema = z.object({ ref: refField, confirm: z.boolean().optional() });

/** keep: the user may merge the kept attempt past its review or its risky changes. */
const KeepSchema = ConfirmSchema.extend({
  acceptReview: z.boolean().optional(),
  acceptRisk: z.boolean().optional(),
});

function mergeDetail(task: TaskRecord): string[] {
  const lines: string[] = [];
  if (task.branch) lines.push(`${task.branch} → ${task.baseBranch ?? 'its base branch'}`);
  if (task.stats) {
    lines.push(
      `${task.stats.commits} commit(s), ${task.stats.files} file(s), +${task.stats.insertions} −${task.stats.deletions}`
    );
  }
  if (task.summary) lines.push(task.summary);
  return lines;
}

/**
 * «Parar» (2026-10-23): a security or risky task counting down to merging on its own waits
 * for the user instead. Stopping a merge is never risky: anyone but the task itself may.
 */
function hold(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = RefSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  if (self.roleOn(ctx, found.task) === 'task') {
    return fail('forbidden', 'A task cannot stop its own merge');
  }
  return fromAction(scheduler.holdAutoMerge(found.task.id));
}

/**
 * `ut task priority <id> urgent|normal` (2026-11-01, fast lane): the user or an orchestrator
 * puts a task ahead in the merge queue and the line for checks. Never the task itself: every
 * task would mark itself urgent.
 */
function priority(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = PrioritySchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  if (self.roleOn(ctx, found.task) === 'task') {
    return fail('forbidden', 'A task cannot change its own priority');
  }
  return fromAction(scheduler.setPriority(found.task.id, parsed.data.level === 'urgent'));
}

/**
 * `ut task budget <id> +…` (2026-11-01): more budget for a task; one stopped by its budget
 * goes on. The user or its orchestrator, never the task itself (it would lift its own cap).
 */
export async function budget(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = BudgetSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  if (self.roleOn(ctx, found.task) === 'task') {
    return fail(
      'forbidden',
      'A task cannot raise its own budget: its orchestrator or the user can'
    );
  }
  const result = fromAction(await scheduler.extendBudget(found.task.id, parsed.data.change));
  if (result.ok) self.tellWorkingAgain(ctx, found.task, 'the user gave it more budget');
  return result;
}

/**
 * A queued task's place in its project's line (maxActiveTasks, 2026-11-01). It changes only
 * the order in which waiting tasks start, never how many run: anyone but a task may.
 */
function move(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = MoveSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  if (self.roleOn(ctx, found.task) === 'task') {
    return fail('forbidden', 'A task cannot reorder the line');
  }
  return fromAction(scheduler.moveQueued(found.task.id, parsed.data.position));
}

function verify(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = RefSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  if (self.roleOn(ctx, found.task) === 'task') {
    return fail('forbidden', 'A task cannot run checks; the engine checks it when it is done');
  }
  return fromAction(scheduler.verify(found.task.id));
}

async function fix(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = RefSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  const { task } = found;
  const role = self.roleOn(ctx, task);
  if (role === 'task') return fail('forbidden', 'A task cannot ask for fixes');
  if (role === 'session') {
    if (!task.blocker) return fail('not-fixable', 'Nothing the agent can fix');
    return self.confirm('fix', task, ctx, { ref: task.id }, [task.blocker.message]);
  }
  const result = await scheduler.fix(task.id);
  if (result.ok) {
    self.tellWorkingAgain(ctx, task, `the user had its agent fix: ${task.blocker?.message ?? ''}`);
  }
  return fromAction(result);
}

async function retry(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = RetrySchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  const { task } = found;
  const role = self.roleOn(ctx, task);
  if (role === 'task') return fail('forbidden', 'A task cannot retry tasks');
  if (role === 'session') {
    return self.confirm(
      'retry',
      task,
      ctx,
      {
        ref: task.id,
        ...(parsed.data.agent ? { agent: parsed.data.agent } : {}),
        ...(parsed.data.force ? { force: true } : {}),
      },
      [
        task.blocker?.message ?? '',
        ...(parsed.data.force ? ["Past its project's task limit (--force)"] : []),
      ]
    );
  }
  const result = await scheduler.retry(task.id, {
    agent: parsed.data.agent,
    force: parsed.data.force,
  });
  if (result.ok) self.tellWorkingAgain(ctx, task, 'the user had it tried again');
  return fromAction(result);
}

/** "Deshacer": undo a merged task with a revert task (the user's call; others ask). */
async function revert(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = RefSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  const { task } = found;
  const role = self.roleOn(ctx, task);
  if (role === 'task') return fail('forbidden', 'A task cannot undo tasks');
  if (task.state !== 'merged') return fail('not-open', 'Only a merged task can be undone');
  if (role !== 'user') {
    return self.confirm('revert', task, ctx, { ref: task.id }, mergeDetail(task));
  }
  return fromAction(await scheduler.revert(task.id));
}

function merge(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = MergeSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  const { task } = found;
  const acceptRisk = !!parsed.data.acceptRisk;
  const acceptReview = !!parsed.data.acceptReview;
  const freshReview = !!parsed.data.reviewAgain;
  const role = self.roleOn(ctx, task);
  if (role === 'task') return fail('forbidden', 'A task cannot merge; the engine merges it');
  if (isFinal(task)) return fail('not-open', `The task is ${task.state}`);
  // 2026-10-24: a task without a worktree has nothing to merge, and this answered "The task
  // has no branch of its own", so «Descartar» was the only way to close finished work. It
  // closes as done; nothing changes in its folder, so nobody's OK is needed.
  if (task.isolation === 'none') return fromAction(scheduler.complete(task.id));
  // The AI review is the user's second pair of eyes: an orchestrator never overrides it
  // (it hands the issues to the task's agent with `ut task fix`), nor asks for a new one.
  if ((acceptReview || freshReview) && role === 'orchestrator') {
    return fail(
      'forbidden',
      acceptReview
        ? 'Only the user can merge past the AI review; use `ut task fix` or tell the user'
        : 'Only the user can ask for a new AI review'
    );
  }
  if (freshReview && role === 'session') {
    return fail('forbidden', 'Only the user can ask for a new AI review');
  }
  // 2026-10-20: an orchestrator merged the user's own tasks and tasks set to "ask" with no OK.
  // On its own it merges only what it started, and only where the policy merges by itself.
  const orchestratorMayMerge = role === 'orchestrator' && self.orchestratorMerges(ctx, task);
  if (role === 'session' || (role === 'orchestrator' && (acceptRisk || !orchestratorMayMerge))) {
    const kind = acceptReview ? 'merge-review' : acceptRisk ? 'merge-risk' : 'merge';
    const detail = acceptReview
      ? [
          ...(task.review?.summary ? [task.review.summary] : []),
          ...(task.review?.issues ?? []).map(reviewIssueLine),
          ...(acceptRisk ? (task.risk ?? []).map((risk) => `${risk.rule}: ${risk.file}`) : []),
        ]
      : acceptRisk
        ? (task.risk ?? []).map((risk) => `${risk.rule}: ${risk.file}`)
        : mergeDetail(task);
    return self.confirm(
      kind,
      task,
      ctx,
      { ref: task.id, acceptRisk, ...(acceptReview ? { acceptReview } : {}) },
      detail
    );
  }
  return fromAction(
    scheduler.merge(task.id, {
      acceptRisk,
      acceptReview,
      freshReview,
      ...(role === 'orchestrator' ? { byAgent: true } : {}),
    })
  );
}

async function discard(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = ConfirmSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  const { task } = found;
  const role = self.roleOn(ctx, task);
  if (role === 'task') return fail('forbidden', 'A task cannot discard tasks');
  if (isFinal(task)) return fail('not-open', `The task is ${task.state}`);
  if (role === 'session') {
    return self.confirm('discard', task, ctx, { ref: task.id, confirm: true }, mergeDetail(task));
  }
  // The user's own "are you sure" is theirs (the app's dialog, --yes in a terminal); the
  // orchestrator's is the user's OK.
  const confirm = ctx.confirmed || (role === 'user' && !!parsed.data.confirm);
  const result = await scheduler.discard(task.id, { confirm });
  if (!result.ok && result.code === 'needs-confirmation' && role === 'orchestrator') {
    return self.confirm('discard', task, ctx, { ref: task.id, confirm: true }, [
      `${result.commits ?? 0} commit(s) not merged anywhere`,
      ...mergeDetail(task),
    ]);
  }
  // The rule (2026-10-20): a discard that loses nothing (no commits or changes that exist
  // nowhere else) runs at once for the orchestrator too; one that would lose work waits for
  // the user. `lostNothing` says which it was, so the caller can tell the user.
  if (result.ok) {
    // 2026-10-20: its orchestrator only noticed a discard in its minute watch, and never
    // one of a task made and discarded within that minute. The user's discard is told at
    // once (an approved request of its own is told as the answer to it).
    if (role === 'user' && !ctx.confirmed && task.origin === 'orchestrator') {
      self.deps.orchestrator?.()?.taskEvent(task.id, 'discarded', 'the user discarded it');
    }
    return ok({ task: result.task, ...(confirm ? {} : { lostNothing: true }) });
  }
  return fromAction(result);
}

/**
 * "Quedarme con este": the chosen task of a parallel group is merged (checked first) and,
 * once it is merged, the others are discarded, their work with them. 2026-10-20: they went at
 * once, so a kept task whose check then failed left nothing to fall back on.
 */
async function keep(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = KeepSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  const { task } = found;
  const role = self.roleOn(ctx, task);
  if (role === 'task') return fail('forbidden', 'A task cannot keep tasks');
  if (!task.groupId) return fail('bad-request', 'The task is not one of a parallel group');
  if (isFinal(task)) return fail('not-open', `The task is ${task.state}`);
  const siblings = scheduler
    .list()
    .filter((entry) => entry.groupId === task.groupId && entry.id !== task.id && !isFinal(entry));
  const userSaidYes = ctx.confirmed || ctx.caller.kind === 'ui' || !!parsed.data.confirm;
  const acceptReview = !!parsed.data.acceptReview;
  const acceptRisk = !!parsed.data.acceptRisk;
  // Merging past the AI review is the user's alone (2026-10-20: "Fusionar igualmente" on a
  // parallel attempt); an orchestrator never gets it, not even through a confirmation.
  if (acceptReview && role === 'orchestrator') {
    return fail(
      'forbidden',
      'Only the user can merge past the AI review; use `ut task fix` or tell the user'
    );
  }
  if (role !== 'user' || !userSaidYes) {
    if (role === 'user') {
      return fail('needs-confirmation', 'Keeping it discards the other attempts: pass --yes');
    }
    return self.confirm(
      'keep',
      task,
      ctx,
      { ref: task.id, confirm: true },
      siblings.map((entry) => `discard ${entry.branch ?? entry.name}`)
    );
  }
  const merged = scheduler.merge(task.id, {
    keep: true,
    ...(acceptReview ? { acceptReview } : {}),
    ...(acceptRisk ? { acceptRisk } : {}),
  });
  if (!merged.ok) return fromAction(merged);
  return ok({
    task: merged.task,
    discarded: [],
    notDiscarded: [],
    discardOnMerge: siblings.map((entry) => entry.id),
  });
}

export const pipelineOps: TaskOpFamily = {
  taskOps: { verify, fix, retry, merge, discard, keep, revert, hold, priority, budget, move },
};
