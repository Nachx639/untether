/**
 * Words for a task's agent: send, answer.
 */

import { z } from 'zod';
import { type AgentMessageParty, partyLabel, replyReference } from '../../shared/agent-messages.js';
import type { PromptAnswer } from '../../shared/agent-prompt.js';
import { TASK_PROMPT_MAX, type TaskFollowUp } from '../../shared/tasks.js';
import type { TaskCommandsCore } from './task-commands-core.js';
import { fail, fromAction, issues, messageIdField, ok, refField } from './task-commands-shared.js';
import type { Context, TaskOpFamily } from './task-commands-types.js';
import type { TaskScheduler } from './task-scheduler.js';

/** `ut task answer <id> approve | deny | <n> | --text "…"` (shared/agent-prompt.ts). */
const AnswerSchema = z
  .object({
    ref: refField,
    choice: z.union([z.enum(['approve', 'deny']), z.number().int().min(1).max(9)]).optional(),
    text: z.string().trim().min(1).max(TASK_PROMPT_MAX).optional(),
  })
  .refine((value) => (value.choice === undefined) !== (value.text === undefined), {
    message: 'Give one answer: approve, deny, an option number, or --text "what to do instead"',
  });

const SendSchema = z.object({
  ref: refField,
  text: z.string().trim().min(1).max(TASK_PROMPT_MAX),
  /** The message this one answers or follows (agent-messages.ts). */
  replyTo: messageIdField.optional(),
});

export async function send(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context,
  via?: TaskFollowUp['via']
) {
  const parsed = SendSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  const { task } = found;
  const role = self.roleOn(ctx, task);
  if (role === 'task') return fail('forbidden', 'A task cannot send to tasks');
  if (role === 'session') {
    return self.confirm('send', task, ctx, { ref: task.id, text: parsed.data.text }, [
      parsed.data.text,
    ]);
  }
  const followUpVia = via ?? (ctx.caller.kind === 'ui' ? 'ui' : 'cli');
  // A message with an id and a sender (2026-11-10): the task reads who it is from, and its
  // next report answers it.
  const repo = self.taskRepo(task);
  // Written by a session and approved by the user: that session's, not the user's words.
  const from: AgentMessageParty =
    role === 'orchestrator' && repo
      ? { kind: 'project', repoPath: repo }
      : ctx.confirmed && ctx.onBehalfOf
        ? { kind: 'session', sessionId: ctx.onBehalfOf }
        : { kind: 'user' };
  const recorded = self.messages.record({
    from,
    to: { kind: 'task', taskId: task.id, name: task.name, ...(repo ? { repoPath: repo } : {}) },
    text: parsed.data.text,
    ...(parsed.data.replyTo ? { replyTo: parsed.data.replyTo } : {}),
  });
  if (!recorded.ok) return fail('not-found', recorded.message);
  const { message, repliedTo } = recorded;
  const header = `[untether] Message ${message.id} from ${partyLabel(from)}${repliedTo ? `, ${replyReference(repliedTo, false)}` : ''}:`;
  const result = await scheduler.send(task.id, parsed.data.text, followUpVia, {
    id: message.id,
    header,
  });
  if (!result.ok) {
    self.messages.discard(message.id);
    return fromAction(result);
  }
  self.tellWorkingAgain(ctx, task, `the user sent its agent: ${parsed.data.text}`);
  return ok({ task: result.task, message: { id: message.id } });
}

/**
 * `ut task answer` (2026-11-10): answers the prompt of its agent's own a task stopped on. The
 * user gives any answer. Its orchestrator may deny, say what to do instead, and approve what
 * deletes nothing and could be read; the rest is the user's alone (the scheduler refuses it
 * and tells their phone): never the confirmations' way, which autoApprove would wave through.
 */
export async function answer(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = AnswerSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  const { task } = found;
  const role = self.roleOn(ctx, task);
  if (role === 'task') return fail('forbidden', 'A task cannot answer prompts');
  if (role === 'session') {
    return fail(
      'forbidden',
      "Only the user or the task's orchestrator answers its prompt: tell the user"
    );
  }
  const { choice, text } = parsed.data;
  const answer: PromptAnswer =
    text !== undefined
      ? { kind: 'text', text }
      : typeof choice === 'number'
        ? { kind: 'option', option: choice }
        : { kind: choice === 'approve' ? 'approve' : 'deny' };
  const result = await scheduler.answerPrompt(task.id, answer, {
    byAgent: role === 'orchestrator',
  });
  if (result.ok) self.tellWorkingAgain(ctx, task, "the user answered its agent's prompt");
  return fromAction(result);
}

export const talkOps: TaskOpFamily = {
  taskOps: { send: (self, scheduler, args, ctx) => send(self, scheduler, args, ctx), answer },
};
