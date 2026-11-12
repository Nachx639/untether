/** `ut project forget` and `new`: a project leaves Untether, or a new one is made. */

import * as path from 'path';
import { shortId } from './format-task-line.js';
import { type CommandFamily, UsageError } from './types.js';

const USAGE = `  ut project forget [--repo DIR] [--json]
                 (Untether forgets the project: its settings, pin and orchestrator go, a running
                  orchestrator is stopped; the folder is never touched and may already be gone.
                  Refused while it has open tasks; from an agent or a script it asks the user's
                  OK on the phone first)
  ut project new <name> --dir PARENT [--goal "goal" | -] [--json]
                 (a new project: the folder PARENT/<name as a folder name> with git and a first
                  commit holding a README, pinned on the user's home; with a goal its
                  orchestrator starts on it. --dir is required: there is no default place.
                  Refused when the folder exists or PARENT is inside a repository; from an agent
                  or a script it asks the user's OK on the phone first)`;

function formatNewProject(data: Record<string, unknown>): string {
  const lines = [
    `Created ${String(data.repoPath)} (branch ${String(data.branch)}, first commit ${String(data.commit).slice(0, 8)}); it is pinned on the user's home`,
  ];
  const orchestrator = data.orchestrator as
    | { ok: true; sessionId: string; pending?: boolean }
    | { ok: false; message: string }
    | undefined;
  if (orchestrator?.ok) {
    lines.push(`→ started its orchestrator (session ${shortId(orchestrator.sessionId)})`);
    if (orchestrator.pending) lines.push('Its brief is typed in once its Claude is ready.');
  } else if (orchestrator) {
    lines.push(
      `Its orchestrator did not start: ${orchestrator.message} (run 'ut project orchestrate --repo ${String(data.repoPath)} -' with the goal)`
    );
  }
  return lines.join('\n');
}

export const projectLifecycle: CommandFamily = {
  usage: USAGE,
  commands: {
    'project forget': {
      options: { value: ['repo'] },
      build: ({ json, repo, deps }) => ({
        op: 'project-forget',
        args: { repo, cwd: deps.cwd },
        json,
      }),
    },
    'project new': {
      options: { value: ['dir', 'goal'] },
      build: async ({ flags, positional, json, deps, text }) => {
        const fromStdin = positional[positional.length - 1] === '-';
        const name = (fromStdin ? positional.slice(0, -1) : positional).join(' ').trim();
        if (!name) throw new UsageError('ut project new needs a project name');
        if (typeof flags.dir !== 'string' || !flags.dir.trim()) {
          throw new UsageError(
            'ut project new needs --dir: the folder to create the project in (there is no default place)'
          );
        }
        // ~ is the server's to expand (the shell usually did already).
        const dir = flags.dir.startsWith('~') ? flags.dir : path.resolve(deps.cwd, flags.dir);
        if (fromStdin && flags.goal !== undefined) {
          throw new UsageError('give the goal either with --goal or on stdin (-), not both');
        }
        const goal =
          fromStdin || flags.goal === '-'
            ? await text(['-'], 'A goal')
            : typeof flags.goal === 'string'
              ? flags.goal
              : undefined;
        if (flags.goal === true) throw new UsageError('--goal needs a value');
        return {
          op: 'project-new',
          args: { name, dir, ...(goal?.trim() ? { goal } : {}) },
          json,
        };
      },
    },
  },
  print: {
    'project-forget': ({ data, deps }) => {
      deps.out(
        data.forgotten
          ? `Forgot ${String(data.repoPath)} (its folder was not touched)`
          : `Untether had no record of ${String(data.repoPath)}`
      );
      return undefined;
    },
    'project-new': ({ data, deps }) => {
      deps.out(formatNewProject(data));
      return undefined;
    },
  },
};
