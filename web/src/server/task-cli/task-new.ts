/** `ut task new`: a new task, or with --route the open task its prompt belongs to. */

import { type TaskTouch, touchLine } from '../../shared/task-serial.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { commaList } from './flags.js';
import { queuedNote, shortId } from './format-task-line.js';
import { type CommandFamily, UsageError } from './types.js';

const USAGE = `  ut task new [--repo DIR] [--agent claude|codex] [--model fast|capable|NAME|PROVIDER:MODEL]
              [--title T] [--base BRANCH] [--parallel N] [--no-worktree] [--merge auto|ask]
              [--budget SPEC] [--after ID[,ID...]] [--zone NAME[,NAME...]] [--route] [--json]
              [--] "prompt" | -
                                               (--model: its agent's fast or capable model
                                                as this Mac configures them, or a model name;
                                                PROVIDER:MODEL runs Claude Code against a
                                                configured external provider (modelProviders),
                                                e.g. abliteration:abliterated-model-large-v2
                                                (the provider's default model when none is named);
                                                unset, a project with modelRouting=true picks
                                                the level from the prompt, capable if unsure;
                                                --budget: its limits over the project's, e.g.
                                                wall=2h,agent=90m,rounds=4,tokens=50M,usd=5,warn=75
                                                (usd only bites a priced provider task);
                                                --after: it starts by itself once those tasks
                                                are merged or closed, from a base with their
                                                work; until then it waits in line ("waits for
                                                <id>") and holds no slot. If one of them is
                                                discarded or fails it says so and waits for a
                                                decision: retry that one, start this one
                                                without it (ut task retry, forced), or discard;
                                                --zone: two tasks of a project with the same
                                                zone never work at once, the later one waits
                                                for the earlier like --after (the project's
                                                zones setting gives a zone by the paths the
                                                prompt names; no zone is ever guessed).
                                                It also says when the prompt names files an
                                                open task of the project already changes)`;

export const taskNew: CommandFamily = {
  usage: USAGE,
  commands: {
    'task new': {
      options: {
        value: [
          'repo',
          'agent',
          'model',
          'title',
          'base',
          'parallel',
          'merge',
          'budget',
          'after',
          'zone',
        ],
        switches: ['no-worktree', 'route'],
      },
      build: async ({ flags, positional, json, repo, deps, text }) => {
        const parallel = flags.parallel === undefined ? 1 : Number(flags.parallel);
        if (!Number.isInteger(parallel) || parallel < 1)
          throw new UsageError('--parallel needs a number');
        if (flags.route === true) {
          if (parallel > 1 || flags['no-worktree'] === true) {
            throw new UsageError('--route goes with neither --parallel nor --no-worktree');
          }
          return {
            // Changed nothing: it could not tell where the prompt goes.
            jsonExit: (data) => (data.action === 'ask' ? 3 : 0),
            op: 'submit',
            json,
            args: {
              text: await text(positional, 'A prompt'),
              cwd: deps.cwd,
              ...(repo ? { repoPath: repo } : {}),
              ...(typeof flags.agent === 'string' ? { agent: flags.agent } : {}),
              ...(typeof flags.title === 'string' ? { title: flags.title } : {}),
              ...(typeof flags.base === 'string' ? { baseBranch: flags.base } : {}),
              ...(typeof flags.merge === 'string' ? { mergePolicy: flags.merge } : {}),
            },
          };
        }
        return {
          op: 'new',
          json,
          args: {
            prompt: await text(positional, 'A prompt'),
            cwd: deps.cwd,
            ...(repo ? { repoPath: repo } : {}),
            isolation: flags['no-worktree'] === true ? 'none' : 'worktree',
            ...(typeof flags.agent === 'string' ? { agent: flags.agent } : {}),
            ...(typeof flags.model === 'string' ? { model: flags.model } : {}),
            ...(typeof flags.title === 'string' ? { title: flags.title } : {}),
            ...(typeof flags.base === 'string' ? { baseBranch: flags.base } : {}),
            ...(typeof flags.merge === 'string' ? { mergePolicy: flags.merge } : {}),
            ...(typeof flags.budget === 'string' ? { budget: flags.budget } : {}),
            ...(typeof flags.after === 'string' ? { after: commaList(flags.after) } : {}),
            ...(typeof flags.zone === 'string' ? { zone: commaList(flags.zone) } : {}),
            parallel,
          },
        };
      },
    },
  },
  print: {
    new: ({ data, deps, line }) => {
      const tasks = (data.tasks ?? [data.task]) as TaskRecord[];
      deps.out(tasks.map(line).join('\n'));
      const queued = tasks.find((task) => task.state === 'queued');
      if (queued) deps.out(queuedNote(queued));
      if (typeof data.warning === 'string') deps.err(data.warning);
      // Its prompt names files an open task already changes: said, the task runs anyway.
      for (const touch of (data.touches ?? []) as TaskTouch[]) {
        deps.err(touchLine(tasks[0], touch));
      }
      return undefined;
    },
    submit: ({ data, deps, line }) => {
      if (data.action === 'ask') {
        const decision = (data.decision ?? {}) as { candidates?: string[] };
        const open = (data.open ?? []) as Array<{ id: string; name: string; branch?: string }>;
        const offered = open.filter((task) => decision.candidates?.includes(task.id));
        deps.out('Not sure which task this goes with. Closest open tasks:');
        for (const task of offered) {
          deps.out(`  ${shortId(task.id)}  ${task.name}${task.branch ? `  [${task.branch}]` : ''}`);
        }
        deps.out(
          "Send it to one with 'ut task send <id> …', or start it with 'ut task new' (no --route)."
        );
        return 3;
      }
      const task = data.task as TaskRecord;
      if (data.action === 'sent') deps.out(`→ added to ${line(task)}`);
      else deps.out(((data.tasks ?? [task]) as TaskRecord[]).map(line).join('\n'));
      return undefined;
    },
  },
};
