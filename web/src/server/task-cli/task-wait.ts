/** `ut task wait`: polls `status` here until the tasks get there (a socket request answers at once). */

import type { TaskRecord, TaskState } from '../../shared/tasks.js';
import type { TaskResponse } from '../pty/socket-protocol.js';
import { type CommandFamily, type RunContext, UsageError, WAIT_OUTAGE_MS } from './types.js';

const USAGE = `  ut task wait <id>... [--until done|attention|any] [--timeout SEC] [--json]`;

const DONE_STATES: readonly TaskState[] = [
  'ready',
  'merged',
  'done',
  'failed',
  'discarded',
  'missed',
];
/**
 * States that want someone to look. 2026-10-20: ready was missing, so `--until attention` on
 * several tasks did not return when one of them became ready (only when all were done).
 */
const ATTENTION_STATES: readonly TaskState[] = ['needs_you', 'failed', 'ready'];

type Until = 'done' | 'attention' | 'any';

/** Whether `wait` is over for these tasks (`initial`: their states when it started). */
export function waitSatisfied(
  until: 'done' | 'attention' | 'any',
  tasks: TaskRecord[],
  initial: Map<string, TaskState>
): boolean {
  const done = tasks.every((task) => DONE_STATES.includes(task.state));
  if (until === 'done') return done;
  if (until === 'attention') {
    return done || tasks.some((task) => ATTENTION_STATES.includes(task.state));
  }
  return (
    done ||
    tasks.some(
      (task) =>
        task.state !== initial.get(task.id) ||
        DONE_STATES.includes(task.state) ||
        ATTENTION_STATES.includes(task.state)
    )
  );
}

async function waitForTasks(
  { until, timeoutMs, intervalMs }: { until: Until; timeoutMs: number; intervalMs: number },
  { built, caller, deps, print }: RunContext
): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let initial: Map<string, TaskState> | null = null;
  let outageSince: number | undefined;
  let toldOutage = false;
  for (;;) {
    let response: TaskResponse;
    try {
      response = await deps.task('status', built.args, caller);
      outageSince = undefined;
      toldOutage = false;
    } catch (error) {
      // 2026-10-18: a server restart ended `ut task wait` with "connect ECONNREFUSED". A
      // status look is safe to repeat: wait through an outage (the client already retried
      // the connection) until WAIT_OUTAGE_MS of it or the caller's timeout.
      outageSince ??= now();
      if (now() - outageSince >= WAIT_OUTAGE_MS || (timeoutMs && now() >= deadline)) throw error;
      if (!toldOutage) {
        toldOutage = true;
        const reason = error instanceof Error ? error.message : String(error);
        deps.err(`Untether server unavailable (${reason}); still waiting...`);
      }
      await sleep(intervalMs);
      continue;
    }
    if (!response.ok || response.status !== 'done') return print(response);
    const tasks = (response.data.tasks ?? []) as TaskRecord[];
    initial ??= new Map(tasks.map((task) => [task.id, task.state]));
    const satisfied = waitSatisfied(until, tasks, initial);
    if (satisfied) return print(response);
    if (timeoutMs && now() >= deadline) {
      print(response);
      // Not an error: nothing happened yet (2026-10-20: exit 2 sent orchestrators into loops).
      deps.out(
        `Timed out after ${Math.round(timeoutMs / 1000)}s, nothing changed; events will be typed in.`
      );
      return 0;
    }
    await sleep(intervalMs);
  }
}

export const taskWait: CommandFamily = {
  usage: USAGE,
  commands: {
    'task wait': {
      options: { value: ['until', 'timeout', 'interval'] },
      build: ({ flags, positional, json }) => {
        if (!positional.length) throw new UsageError('ut task wait needs at least one task');
        const until = (flags.until ?? 'done') as string;
        if (!['done', 'attention', 'any'].includes(until)) {
          throw new UsageError('--until is done, attention or any');
        }
        const timeoutSec = flags.timeout === undefined ? 540 : Number(flags.timeout);
        const intervalSec = flags.interval === undefined ? 3 : Number(flags.interval);
        if (!(timeoutSec >= 0) || !(intervalSec > 0))
          throw new UsageError('bad --timeout/--interval');
        const wait = {
          until: until as Until,
          timeoutMs: timeoutSec * 1000,
          intervalMs: intervalSec * 1000,
        };
        return {
          op: 'status',
          json,
          args: { refs: positional },
          run: (context) => waitForTasks(wait, context),
        };
      },
    },
  },
};
