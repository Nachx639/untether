/** What is done with a task once it has work: check, fix, retry, merge, discard, queue place, budget. */

import type { TaskRecord } from '../../shared/tasks.js';
import { shortId } from './format-task-line.js';
import { type CliCommand, type CommandFamily, UsageError } from './types.js';

const USAGE = `  ut task verify <id>                          (check again; nothing blocking in an auto
                                                project: goes on as if the agent had finished)
  ut task fix <id>
  ut task retry <id> [--agent NAME] [--force]  (a failed task: try it again; a paused one:
                                                send it on now, with --agent it goes on with
                                                that agent (claude, codex or a configured
                                                fallback) in the same worktree; one held for
                                                its agent's usage limit: start it now, with
                                                --agent on that one. All of them only while
                                                its project has a slot (maxActiveTasks):
                                                --force goes past the limit, and starts now a
                                                task queued for it or for the Mac's room)
  ut task merge <id> [--accept-risk] [--accept-review] [--review-again]
                                               (no worktree: closes it as done)
  ut task discard <id> [--yes]                 (a queued task too: it leaves the line)
  ut task move <id> <position>                 (a queued task: its place in its project's
                                                line, 1 = next)
  ut task keep <id> [--yes]                    (keep one of a parallel group)
  ut task revert <id>                          (undo a merged task: a new task reverts it)
  ut task hold <id>                            (stop a task about to merge on its own)
  ut task budget <id> [+1h | +50% | +2 | +50M | wall=+1h rounds=+2 tokens=5M ...]
                                               (more budget: +1h adds time and agent time, +2
                                                rounds, +50M tokens; nothing: +50% of the limits
                                                it reached. A task stopped by its budget goes on)
  ut task priority <id> urgent|normal          (urgent: ahead in the merge queue and for a
                                                check slot; same check and review)`;

/** `ut task verify <id>`: the op is the command's own word. */
const byRef: CliCommand = {
  options: {},
  build: ({ sub, json, ref }) => ({ op: sub, json, args: { ref: ref(true) } }),
};

/** discard and keep: --yes loses the commits that exist only on a branch. */
const byRefConfirmed: CliCommand = {
  options: { switches: ['yes'] },
  build: ({ sub, flags, json, ref }) => ({
    op: sub,
    json,
    args: { ref: ref(true), confirm: flags.yes === true },
  }),
};

export const taskPipeline: CommandFamily = {
  usage: USAGE,
  commands: {
    'task verify': byRef,
    'task fix': byRef,
    'task retry': {
      options: { value: ['agent'], switches: ['force'] },
      build: ({ flags, json, ref }) => {
        return {
          op: 'retry',
          json,
          args: {
            ref: ref(true),
            ...(typeof flags.agent === 'string' ? { agent: flags.agent } : {}),
            ...(flags.force === true ? { force: true } : {}),
          },
        };
      },
    },
    'task merge': {
      options: { switches: ['accept-risk', 'accept-review', 'review-again'] },
      build: ({ flags, json, ref }) => {
        return {
          op: 'merge',
          json,
          args: {
            ref: ref(true),
            acceptRisk: flags['accept-risk'] === true,
            ...(flags['accept-review'] === true ? { acceptReview: true } : {}),
            ...(flags['review-again'] === true ? { reviewAgain: true } : {}),
          },
        };
      },
    },
    'task discard': byRefConfirmed,
    'task move': {
      options: {},
      build: ({ positional, json }) => {
        const position = Number(positional[1]);
        if (!positional[0] || !Number.isInteger(position) || position < 1) {
          throw new UsageError('ut task move <id> <position> (1 = next in line)');
        }
        return { op: 'move', json, args: { ref: positional[0], position } };
      },
    },
    'task keep': byRefConfirmed,
    'task revert': byRef,
    'task hold': byRef,
    'task budget': {
      options: {},
      build: ({ positional, json }) => {
        if (!positional[0]) {
          throw new UsageError('ut task budget <id> [+1h | +50% | rounds=+2 | tokens=+50M ...]');
        }
        return {
          op: 'budget',
          json,
          args: { ref: positional[0], change: positional.slice(1).join(' ') },
        };
      },
    },
    'task priority': {
      options: {},
      build: ({ positional, json, ref }) => {
        const level = positional[1];
        if (level !== 'urgent' && level !== 'normal') {
          throw new UsageError('ut task priority <id> urgent|normal');
        }
        return { op: 'priority', json, args: { ref: ref(true), level } };
      },
    },
  },
  print: {
    keep: ({ data, deps, line }) => {
      deps.out(line(data.task as TaskRecord));
      const discarded = (data.discarded ?? []) as string[];
      if (discarded.length) deps.out(`Discarded: ${discarded.map(shortId).join(', ')}`);
      const later = (data.discardOnMerge ?? []) as string[];
      if (later.length) deps.out(`Discarded once it is merged: ${later.map(shortId).join(', ')}`);
      for (const kept of (data.notDiscarded ?? []) as Array<{ id: string; error: string }>) {
        deps.err(`Could not discard ${shortId(kept.id)}: ${kept.error}`);
      }
      return undefined;
    },
    revert: ({ data, deps, line }) => {
      deps.out(`Undoing it with a new task: ${line(data.task as TaskRecord)}`);
      return undefined;
    },
  },
};
