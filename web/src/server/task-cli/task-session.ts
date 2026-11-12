/** `ut task done`, `ask` and `handoff`: what a task's agent runs inside its own session. */

import * as fs from 'fs';
import * as path from 'path';
import { TASK_RESULT_EXAMPLE } from '../../shared/task-result.js';
import { type CommandFamily, UsageError } from './types.js';

const USAGE = `  ut task done [--summary "what changed" | -] [--verified "commands run and their result"]
               [--undo "how to undo it"] [--result JSON | -]
                                               (inside a task's own session; - reads stdin;
                                                --result: outcome, files, tests, risks,
                                                followUps, measurements; its JSON may also
                                                carry summary, verified and undo)
  ut task ask "question" | -                   (inside a task's own session)
  ut task handoff --dir DIR [--title T] "prompt" | -
                                               (a request about another folder: a new
                                                session there, without a worktree)`;

export const taskSession: CommandFamily = {
  usage: USAGE,
  commands: {
    'task done': {
      options: { value: ['summary', 'verified', 'undo', 'result'] },
      build: async ({ flags, positional, json, deps, text }) => {
        // `-` (or --summary -): the summary on stdin, so a quote or `$` in it never breaks.
        const resultFromStdin = flags.result === '-';
        const fromStdin =
          flags.summary === '-' || (flags.summary === undefined && positional.join(' ') === '-');
        if (resultFromStdin && fromStdin) {
          throw new UsageError(
            'stdin carries either the summary or the --result JSON, not both: put the summary in the JSON ("summary": "…")'
          );
        }
        // The structured result (shared/task-result.ts): JSON, as an argument or on stdin. Its
        // summary, verified and undo keys fill what the flags did not give (one heredoc for all).
        let result: Record<string, unknown> | undefined;
        const extra: { summary?: string; verified?: string; undo?: string } = {};
        if (typeof flags.result === 'string') {
          const raw = resultFromStdin ? await deps.readStdin() : flags.result;
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            throw new UsageError(
              `--result is not valid JSON (${error instanceof Error ? error.message : String(error)}). Example: ${TASK_RESULT_EXAMPLE}`
            );
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new UsageError(`--result must be a JSON object. Example: ${TASK_RESULT_EXAMPLE}`);
          }
          const { summary: s, verified: v, undo: u, ...rest } = parsed as Record<string, unknown>;
          for (const [key, value] of [
            ['summary', s],
            ['verified', v],
            ['undo', u],
          ] as const) {
            if (value === undefined) continue;
            if (typeof value !== 'string')
              throw new UsageError(`--result: "${key}" must be a string`);
            extra[key] = value;
          }
          result = rest;
        }
        const summary = fromStdin
          ? await text(['-'], 'A summary')
          : typeof flags.summary === 'string'
            ? flags.summary
            : positional.join(' ') || extra.summary || undefined;
        const verified = typeof flags.verified === 'string' ? flags.verified : extra.verified;
        const undo = typeof flags.undo === 'string' ? flags.undo : extra.undo;
        return {
          op: 'done',
          json,
          args: {
            ...(summary ? { summary } : {}),
            ...(verified !== undefined ? { verified } : {}),
            ...(undo !== undefined ? { undo } : {}),
            ...(result ? { result } : {}),
          },
        };
      },
    },
    'task ask': {
      options: {},
      build: async ({ positional, json, text }) => ({
        op: 'ask',
        json,
        args: { question: await text(positional, 'A question') },
      }),
    },
    'task handoff': {
      options: { value: ['dir', 'title', 'agent'] },
      build: async ({ flags, positional, json, deps, text }) => {
        // From a task asked about another folder: a plain session there, with the request typed.
        if (typeof flags.dir !== 'string') throw new UsageError('--dir is required');
        const home = deps.env.HOME ?? '~';
        const dir = path.resolve(deps.cwd, flags.dir.replace(/^~(?=\/|$)/, home));
        if (!(deps.exists ?? fs.existsSync)(dir)) throw new UsageError(`no such folder: ${dir}`);
        return {
          op: 'new',
          json,
          args: {
            prompt: await text(positional, 'A prompt'),
            workingDir: dir,
            isolation: 'none',
            ...(typeof flags.agent === 'string' ? { agent: flags.agent } : {}),
            ...(typeof flags.title === 'string' ? { title: flags.title } : {}),
          },
        };
      },
    },
  },
};
