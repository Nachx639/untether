/** `ut project orchestrate`: starts a project's orchestrator with a goal, or gives the running one the goal. */

import * as path from 'path';
import type { TaskConfirmation } from '../../shared/task-confirmations.js';
import type { TaskResponse } from '../pty/socket-protocol.js';
import { shortId } from './format-task-line.js';
import { formatConfirmation } from './print.js';
import { type CommandFamily, type RunContext, UsageError, WAIT_OUTAGE_MS } from './types.js';

const USAGE = `  ut project orchestrate [--repo DIR] [--wait [--timeout SEC]] [--json] "goal" | -
                 (start the project's orchestrator with this goal, or give the running one the
                  goal; from an agent or a script it asks the user's OK on the phone first.
                  --wait waits for the answer, 540 s by default; run it again with --wait to
                  keep waiting: it does not ask twice)`;

/** A started (or reused) orchestrator, in one or two lines. */
function formatOrchestrated(data: Record<string, unknown>): string {
  const name = path.basename(String(data.repoPath));
  const session = shortId(String(data.sessionId));
  const lines = [
    data.reused
      ? `→ gave the goal to the running orchestrator of ${name} (session ${session})`
      : `→ started the orchestrator of ${name} (session ${session})`,
  ];
  if (data.pending) lines.push('Its brief is typed in once its Claude is ready.');
  return lines.join('\n');
}

/**
 * `project orchestrate --wait`: polls what became of the confirmation it asked for, then
 * says it. Approved runs as the user (it started); declined, expired or failed started nothing.
 */
async function waitForAnswer(
  wait: { timeoutMs: number; intervalMs: number },
  confirmation: TaskConfirmation,
  { built, caller, deps, print }: RunContext
): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + wait.timeoutMs;
  if (!built.json) {
    deps.out(formatConfirmation(confirmation));
    deps.out("Waiting for the user's answer...");
  }
  let outageSince: number | undefined;
  for (;;) {
    let response: TaskResponse;
    try {
      response = await deps.task('confirmation', { id: confirmation.id }, caller);
      outageSince = undefined;
    } catch (error) {
      // A server restart keeps pending confirmations: wait through it as `task wait` does.
      outageSince ??= now();
      if (now() - outageSince >= WAIT_OUTAGE_MS || (wait.timeoutMs && now() >= deadline)) {
        throw error;
      }
      await sleep(wait.intervalMs);
      continue;
    }
    if (!response.ok || response.status !== 'done') return print(response);
    const data = response.data;
    const status = String(data.status);
    if (status === 'pending') {
      if (wait.timeoutMs && now() >= deadline) {
        if (built.json) deps.out(JSON.stringify(response, null, 2));
        else {
          deps.out(
            `Still waiting for the user's OK after ${Math.round(wait.timeoutMs / 1000)}s; run the same command with --wait again to keep waiting (it does not ask twice).`
          );
        }
        return 0;
      }
      await sleep(wait.intervalMs);
      continue;
    }
    const result = data.result as TaskResponse | undefined;
    const started = status === 'approved' && result?.ok && result.status === 'done';
    if (built.json) {
      deps.out(JSON.stringify(response, null, 2));
      return started ? 0 : 1;
    }
    if (started) {
      deps.out(formatOrchestrated(result.data));
      return 0;
    }
    if (status === 'approved' && result && !result.ok) {
      deps.err(`Approved, but it could not start: ${result.message}`);
    } else if (status === 'declined') {
      deps.err('The user declined: no orchestrator was started or given the goal.');
    } else if (status === 'expired') {
      deps.err('The request expired unanswered: nothing was started.');
    } else if (status === 'failed') {
      deps.err(`Approved, but it failed: ${String(data.message)}`);
    } else {
      deps.err(
        "The answer is unknown (the server restarted?): check 'ut project show' for its orchestratorSessionId."
      );
    }
    return 1;
  }
}

export const projectOrchestrate: CommandFamily = {
  usage: USAGE,
  commands: {
    'project orchestrate': {
      options: { value: ['repo', 'timeout', 'interval'], switches: ['wait'] },
      build: async ({ flags, positional, json, repo, deps, text }) => {
        const timeoutSec = flags.timeout === undefined ? 540 : Number(flags.timeout);
        const intervalSec = flags.interval === undefined ? 3 : Number(flags.interval);
        if (!(timeoutSec >= 0) || !(intervalSec > 0)) {
          throw new UsageError('bad --timeout/--interval');
        }
        const wait = { timeoutMs: timeoutSec * 1000, intervalMs: intervalSec * 1000 };
        return {
          op: 'project-orchestrate',
          args: { repo, cwd: deps.cwd, goal: await text(positional, 'A goal') },
          json,
          ...(flags.wait === true
            ? {
                // --wait: wait for the user's answer to what it asked.
                run: async (context: RunContext) => {
                  const response = await context.deps.task(
                    context.built.op,
                    context.built.args,
                    context.caller
                  );
                  if (response.ok && response.status === 'pending-confirmation') {
                    return waitForAnswer(wait, response.confirmation, context);
                  }
                  return context.printExplained(response);
                },
              }
            : {}),
        };
      },
    },
  },
  print: {
    'project-orchestrate': ({ data, deps }) => {
      deps.out(formatOrchestrated(data));
      return undefined;
    },
  },
  pending: {
    'project-orchestrate': ({ built, deps }) => {
      if (built.run) return;
      deps.out(
        "To wait for the answer, run the same command again with --wait (it does not ask twice); once approved, 'ut project show' lists its orchestratorSessionId."
      );
    },
  },
};
