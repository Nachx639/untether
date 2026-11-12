/**
 * What the families of task commands share: answers, common fields, the caller of a request.
 */

import { z } from 'zod';
import { MESSAGE_ID } from '../../shared/agent-messages.js';
import { parseCommand } from '../../shared/command-line.js';
import {
  TASK_FINAL_STATES,
  TASK_PROMPT_MAX,
  type TaskAgent,
  type TaskRecord,
} from '../../shared/tasks.js';
import { resolveAbsolutePath } from '../utils/path-utils.js';
import { normalizeRepoPath } from './project-settings.js';
import type { TaskCaller, TaskCommandErrorCode, TaskCommandResult } from './task-commands-types.js';
import type { TaskActionResult } from './task-scheduler.js';
import { resolveMainRepo } from './task-worktree.js';

/** The HTTP status a result is answered with. */
export function httpStatus(result: TaskCommandResult): number {
  if (result.ok) return result.status === 'pending-confirmation' ? 202 : 200;
  switch (result.code) {
    case 'bad-request':
    case 'bad-budget':
    case 'bad-result':
      return 400;
    case 'forbidden':
      return 403;
    case 'not-found':
      return 404;
    case 'unavailable':
      return 503;
    case 'error':
      return 500;
    default:
      return 409;
  }
}

/** Auth methods that mean a signed-in user (or a server with auth switched off). */
const USER_AUTH_METHODS = new Set(['ssh-key', 'password', 'tailscale', 'hq-bearer', 'no-auth']);

/**
 * The caller of an HTTP request: the app when signed in; a localhost request let in without a
 * login (local bypass) may be an agent with curl, so it gets no user rights.
 */
export function callerFromAuth(authMethod: string | undefined): TaskCaller {
  return authMethod && USER_AUTH_METHODS.has(authMethod) ? { kind: 'ui' } : { kind: 'cli' };
}

/** Where a prompt typed on the home screen goes (`route`, `submit`). */
export interface RouteOutcome {
  kind: 'match' | 'new' | 'ask';
  /** match: the task it goes to. */
  taskId?: string;
  /** ask: the tasks to offer, best first. */
  candidates?: string[];
  reason: string;
  /** The rules decided, or Claude Haiku settled an unsure case. */
  by: 'rules' | 'llm';
}

export const pathField = z.string().trim().min(1).max(4096);

export const refField = z.string().trim().min(1).max(300);

export const messageIdField = z
  .string()
  .trim()
  .regex(MESSAGE_ID, 'a message id (m + 6 characters)');

export const ProjectSchema = z.object({ repo: pathField.optional(), cwd: pathField.optional() });

export const RouteSchema = z.object({
  repo: pathField.optional(),
  repoPath: pathField.optional(),
  cwd: pathField.optional(),
  text: z.string().trim().min(1).max(TASK_PROMPT_MAX),
});

export function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`)
    .join(', ');
}

export const ok = (data: Record<string, unknown>): TaskCommandResult => ({
  ok: true,
  status: 'done',
  data,
});

export const fail = (
  code: TaskCommandErrorCode,
  message: string,
  extra: { commits?: number; data?: Record<string, unknown> } = {}
): TaskCommandResult => ({ ok: false, code, message, ...extra });

export function fromAction(result: TaskActionResult): TaskCommandResult {
  if (result.ok) return ok({ task: result.task });
  return fail(
    result.code,
    result.message,
    result.commits !== undefined ? { commits: result.commits } : {}
  );
}

export const isFinal = (task: TaskRecord) => TASK_FINAL_STATES.includes(task.state);

/** The main checkout (normalized) of the repository `dir` is in; null outside one. */
export async function resolveProjectRepo(dir: string): Promise<string | null> {
  const repo = await resolveMainRepo(resolveAbsolutePath(dir)).catch(() => null);
  return repo ? normalizeRepoPath(repo) : null;
}

/** The command line of a quick start ("claude --flag") as argv. */
export function quickStartArgv(command: string | undefined, agent: TaskAgent): string[] {
  const argv = command ? parseCommand(command.trim()) : [];
  return argv.length ? argv : [agent];
}
