/** `ut project show` and `stats`: a project's settings and what its token-saving features did. */

import { formatSavingsReport, type SavingsReport } from '../../shared/saving-features.js';
import { formatSettings } from './project-settings.js';
import { type CommandFamily, UsageError } from './types.js';

const USAGE = `  ut project show [--repo DIR] [--json]
  ut project stats [--repo DIR] [--last N] [--json]
                 (the token-saving features over the project's last N finished tasks, 100 by
                  default: median weighted cost, first-try check pass rate, first-review
                  approval rate and auto-fix rounds with each feature and without it; small
                  samples are labelled. A feature whose tasks are clearly worse is turned off
                  for the project by itself, and its orchestrator told)`;

export const projectLook: CommandFamily = {
  usage: USAGE,
  commands: {
    'project show': {
      options: { value: ['repo'] },
      build: ({ json, repo, deps }) => ({
        op: 'project-show',
        args: { repo, cwd: deps.cwd },
        json,
      }),
    },
    'project stats': {
      options: { value: ['repo', 'last'] },
      build: ({ flags, json, repo, deps }) => {
        const last = flags.last === undefined ? undefined : Number(flags.last);
        if (last !== undefined && !(Number.isInteger(last) && last >= 1 && last <= 500)) {
          throw new UsageError('--last needs a number of tasks from 1 to 500');
        }
        return {
          op: 'project-stats',
          args: { repo, cwd: deps.cwd, ...(last !== undefined ? { last } : {}) },
          json,
        };
      },
    },
  },
  print: {
    'project-show': ({ data, deps }) => {
      deps.out(formatSettings(data));
      return undefined;
    },
    'project-stats': ({ data, deps }) => {
      deps.out(formatSavingsReport(data.report as SavingsReport));
      return undefined;
    },
  },
};
