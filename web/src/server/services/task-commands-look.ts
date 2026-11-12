/**
 * Looking at tasks: list, status, logs.
 */

import * as fs from 'fs';
import { z } from 'zod';
import type { TaskRecord } from '../../shared/tasks.js';
import type { TaskCommandsCore } from './task-commands-core.js';
import { fail, isFinal, issues, ok, pathField, refField } from './task-commands-shared.js';
import type { Context, TaskOpFamily } from './task-commands-types.js';
import type { TaskScheduler } from './task-scheduler.js';

/** At most this much of a log's end is read. */
const LOG_READ_BYTES = 512 * 1024;

const ListSchema = z.object({
  repo: pathField.optional(),
  all: z.boolean().optional(),
});

const StatusSchema = z.object({
  ref: refField.optional(),
  refs: z.array(refField).max(50).optional(),
});

const LogsSchema = z.object({
  ref: refField.optional(),
  kind: z.enum(['setup', 'verify', 'merge']).default('verify'),
  lines: z.coerce.number().int().min(1).max(5000).default(400),
});

/** The last `lines` lines of a log (reading at most LOG_READ_BYTES of its end). */
export function readLogTail(file: string, lines: number): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, LOG_READ_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export async function list(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>
) {
  const parsed = ListSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  let tasks = scheduler.list();
  if (!parsed.data.all) tasks = tasks.filter((task) => !isFinal(task));
  if (parsed.data.repo) {
    const repo = await self.resolveRepo(parsed.data.repo);
    if (!repo) return fail('bad-request', 'Not inside a git repository');
    tasks = tasks.filter((task) => self.taskRepo(task) === repo);
  }
  // How full the Mac is against the admission target, and how many more tasks fit (or why not).
  const room = self.deps.room?.();
  return ok({ tasks, ...(room ? { room } : {}) });
}

export function status(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = StatusSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  if (parsed.data.refs) {
    const tasks: TaskRecord[] = [];
    for (const ref of parsed.data.refs) {
      const found = self.find(scheduler, ref, ctx);
      if (!('task' in found)) return found.error;
      tasks.push(found.task);
    }
    return ok({ tasks });
  }
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  const { task } = found;
  const live = scheduler.liveState(task.id);
  const confirmations = self.confirmations.list().filter((entry) => entry.taskId === task.id);
  const tools = self.deps.tools?.taskTools(task);
  return ok({
    task,
    ...(live ? { live } : {}),
    ...(tools ? { tools } : {}),
    ...(confirmations.length ? { confirmations } : {}),
  });
}

function logs(
  self: TaskCommandsCore,
  scheduler: TaskScheduler,
  args: Record<string, unknown>,
  ctx: Context
) {
  const parsed = LogsSchema.safeParse(args);
  if (!parsed.success) return fail('bad-request', issues(parsed.error));
  const found = self.find(scheduler, parsed.data.ref, ctx);
  if (!('task' in found)) return found.error;
  const { kind, lines } = parsed.data;
  const file = scheduler.logPath(found.task.id, kind);
  const text = file ? readLogTail(file, lines) : null;
  return ok({ kind, text: text ?? '', exists: text !== null, taskId: found.task.id });
}

export const lookOps: TaskOpFamily = {
  taskOps: {
    list: (self, scheduler, args) => list(self, scheduler, args),
    status,
    logs,
  },
};
