/** `ut task list`, `status` (also `show`) and `logs`: looking at tasks. */

import type { TaskConfirmation } from '../../shared/task-confirmations.js';
import type { TaskRecord } from '../../shared/tasks.js';
import type { TaskToolsInfo } from '../services/tool-pruning.js';
import { formatTaskDetail, type TaskStatusExtras } from './format-task-detail.js';
import type { CliCommand, CommandFamily } from './types.js';

const USAGE = `  ut task list [--repo DIR] [--all] [--json]
  ut task status [<id|branch>] [--json]        (also: show; with where its time went, per round)
  ut task logs [<id>] [--kind setup|verify|merge] [--lines N] [--json]`;

const status: CliCommand = {
  options: {},
  build: ({ json, ref }) => ({ op: 'status', json, args: { ref: ref(false) } }),
};

export const taskLook: CommandFamily = {
  usage: USAGE,
  commands: {
    'task list': {
      options: { value: ['repo'], switches: ['all'] },
      build: ({ flags, json, repo }) => ({
        op: 'list',
        json,
        args: { ...(repo ? { repo } : {}), all: flags.all === true },
      }),
    },
    'task status': status,
    'task show': status,
    'task logs': {
      options: { value: ['kind', 'lines'] },
      build: ({ flags, json, ref }) => {
        return {
          op: 'logs',
          json,
          args: {
            ref: ref(false),
            ...(typeof flags.kind === 'string' ? { kind: flags.kind } : {}),
            ...(typeof flags.lines === 'string' ? { lines: Number(flags.lines) } : {}),
          },
        };
      },
    },
  },
  print: {
    list: ({ data, deps, line }) => {
      const tasks = (data.tasks ?? []) as TaskRecord[];
      deps.out(tasks.length ? tasks.map(line).join('\n') : 'No tasks');
      if (typeof data.room === 'string') deps.out(`Admission: ${data.room}`);
      return undefined;
    },
    status: ({ data, deps, line, context }) => {
      if (Array.isArray(data.tasks)) deps.out((data.tasks as TaskRecord[]).map(line).join('\n'));
      else {
        deps.out(
          formatTaskDetail(data.task as TaskRecord, {
            ...context,
            ...(data.live ? { live: data.live as TaskStatusExtras['live'] } : {}),
            ...(data.tools ? { tools: data.tools as TaskToolsInfo } : {}),
            ...(Array.isArray(data.confirmations)
              ? { confirmations: data.confirmations as TaskConfirmation[] }
              : {}),
          })
        );
      }
      return undefined;
    },
    logs: ({ data, deps }) => {
      deps.out(data.exists ? String(data.text) : `No ${data.kind} log yet`);
      return undefined;
    },
  },
};
