/**
 * What a task's agent runs inside its own session: done, ask.
 */

import { z } from 'zod';
import {
  TASK_RESULT_JSON_MAX,
  type TaskResult,
  taskResultErrorMessage,
  validateTaskResult,
  verifiedFromResult,
} from '../../shared/task-result.js';
import {
  TASK_QUESTION_MAX,
  TASK_SUMMARY_MAX,
  TASK_UNDO_MAX,
  TASK_VERIFIED_MAX,
} from '../../shared/tasks.js';
import type { TaskCommandsCore } from './task-commands-core.js';
import { fail, isFinal, issues, ok } from './task-commands-shared.js';
import type { Context, TaskOpFamily } from './task-commands-types.js';
import type { TaskScheduler } from './task-scheduler.js';

const DoneSchema = z.object({
  summary: z.string().max(TASK_SUMMARY_MAX).optional(),
  /** How the agent checked its work: the commands it ran and what they printed. */
  verified: z.string().max(TASK_VERIFIED_MAX).optional(),
  /** How to undo it. */
  undo: z.string().max(TASK_UNDO_MAX).optional(),
  /** The structured result (shared/task-result.ts), checked by validateTaskResult. */
  result: z.unknown().optional(),
});

const AskSchema = z.object({ question: z.string().trim().min(1).max(TASK_QUESTION_MAX) });

async function done(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = DoneSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const sessionId = ctx.caller.kind === 'cli' ? ctx.caller.sessionId : undefined;
  // A task without a worktree that already reads ready still takes its report (2026-10-20:
  // atlas-guard's agent finished a follow-up, `ut task done` was refused and its report
  // reached nobody).
  const own =
    sessionId &&
    (self.ownTask(sessionId) ??
      self.deps
        .scheduler()
        ?.list()
        .find((task) => task.sessionId === sessionId && !isFinal(task)));
  if (!sessionId || !own) {
    return fail('forbidden', "'ut task done' only works inside a task's own session");
  }
  // 2026-10-24: a task without a worktree ended done with its changes uncommitted on the
  // project's branch, and the next task could not merge into it.
  const left = await scheduler.uncommittedWork(sessionId);
  if (left.length) {
    const shown = left.slice(0, 30).join(', ') + (left.length > 30 ? `, … (${left.length})` : '');
    return fail(
      'uncommitted',
      `Not done yet: this project merges finished tasks on its own, so your changes must be committed on the branch you work on before 'ut task done'. Uncommitted files you changed or added: ${shown}. Commit them (git add <files> && git commit -m '<what changed>'), then run 'ut task done' again. Files that were already uncommitted before you started are not counted. If one of these is not yours, ask the user with 'ut task ask'.`,
      { data: { files: left } }
    );
  }
  // The structured result: anything missing goes back to the agent, named, to complete
  // (nothing recorded, the task goes on).
  let result: TaskResult | undefined;
  if (parsed.data.result !== undefined) {
    const size = JSON.stringify(parsed.data.result)?.length ?? 0;
    if (size > TASK_RESULT_JSON_MAX) {
      return fail(
        'bad-result',
        taskResultErrorMessage([
          `result: at most ${TASK_RESULT_JSON_MAX} characters of JSON (${size})`,
        ])
      );
    }
    const checked = validateTaskResult(parsed.data.result);
    if (!checked.ok) {
      return fail('bad-result', taskResultErrorMessage(checked.errors), {
        data: { errors: checked.errors },
      });
    }
    if (!parsed.data.summary?.trim()) {
      return fail(
        'bad-result',
        taskResultErrorMessage([
          'summary: required with --result (--summary, stdin, or "summary" in the JSON): what changed, in a few lines',
        ])
      );
    }
    result = checked.result;
  }
  const verified = parsed.data.verified || (result ? verifiedFromResult(result) : undefined);
  const task = await scheduler.markDone(sessionId, parsed.data.summary, {
    ...(verified ? { verified } : {}),
    ...(parsed.data.undo ? { undo: parsed.data.undo } : {}),
    ...(result ? { result } : {}),
  });
  // Its report answers what it was sent (agent-messages.ts).
  if (task) self.messages.taskReported(task.id);
  return task ? ok({ task }) : fail('not-open', 'This session runs no open task');
}

function ask(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = AskSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const sessionId = ctx.caller.kind === 'cli' ? ctx.caller.sessionId : undefined;
  if (!sessionId || !self.ownTask(sessionId)) {
    return fail('forbidden', "'ut task ask' only works inside a task's own session");
  }
  const task = scheduler.ask(sessionId, parsed.data.question);
  if (task) self.messages.taskReported(task.id);
  return task ? ok({ task }) : fail('not-open', 'This session runs no open task');
}

export const sessionOps: TaskOpFamily = { taskOps: { done, ask } };
