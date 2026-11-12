/**
 * `untether task …` / `untether project …` (and `ut task …` / `ut project …`): the task engine
 * from a terminal or an agent's shell, through the API socket (services/task-commands.ts does
 * the work and decides what needs the user's OK). Human output by default, `--json` for
 * scripts.
 *
 * Exit codes: 0 done (or waiting for the user's OK on the phone, or `wait` timed out with
 * nothing changed), 1 error (also: the user declined, or let expire, what
 * `project orchestrate --wait` asked), 3 `new --route` could not tell which task the prompt
 * goes with (nothing done). `--help` / `-h` anywhere shows the usage and runs nothing.
 *
 * 2026-10-20, from orchestrators' transcripts: `ut task merge --help` merged; a timed-out
 * `wait` (exit 2) read as a failure and was retried in loops; a confirmation waiting on the
 * phone read as an error.
 *
 * The commands themselves are families (CommandFamily, one file each) handed to createTaskCli
 * by ../task-cli.ts: this file knows none of them.
 */

import * as path from 'path';
import type { TaskRecord } from '../../shared/tasks.js';
import { type BuildInfo, isOlderBuild, olderCliRefusal, olderServerAdvice } from '../build-info.js';
import type { TaskResponse } from '../pty/socket-protocol.js';
import { parseFlags } from './flags.js';
import { type FormatContext, formatTaskLine } from './format-task-line.js';
import { helpOf } from './help.js';
import { formatConfirmation, printTask } from './print.js';
import {
  type Built,
  type CliCommand,
  type CommandFamily,
  type CommandOptions,
  HANDED_OVER_ENV,
  type PendingInput,
  type Printer,
  type TaskCliDeps,
  UsageError,
} from './types.js';

/** Never in the way: no builds, no server or an unreadable status is simply no advice. */
async function serverBuild(deps: TaskCliDeps): Promise<BuildInfo | undefined> {
  try {
    return await deps.builds?.server();
  } catch {
    return undefined;
  }
}

/**
 * A ut older than the running server runs nothing for it (2026-11-10: the app's ut did not know
 * `ut project tell --reply-to`, which the development server it talked to did; the message went
 * out wrong and nobody was told). It hands the command, as typed and with its stdin, to the
 * server's own CLI; when it cannot, it refuses and says how to run it. undefined: not older (or
 * no server to compare with), go on.
 */
async function olderThanServer(
  group: 'task' | 'project',
  argv: string[],
  deps: TaskCliDeps
): Promise<number | undefined> {
  if (!deps.builds) return undefined;
  const cli = deps.builds.cli();
  const server = await serverBuild(deps);
  if (!server || !isOlderBuild(cli, server)) return undefined;
  // Handed over once already and still older: never a loop, refuse.
  if (server.cli && deps.handOver && !deps.env[HANDED_OVER_ENV]) {
    const code = await deps.handOver(server.cli, [group, ...argv]);
    if (code !== undefined) return code;
  }
  for (const line of olderCliRefusal(cli, server, [group, ...argv])) deps.err(line);
  return 1;
}

export interface TaskCli {
  /** The usage `ut task help` shows. */
  help: string;
  /** Every command ("task new") and the options it takes. */
  options: Record<string, CommandOptions>;
  /** Runs one `ut task …` / `ut project …`; returns the exit code. */
  run: (group: 'task' | 'project', argv: string[], deps: TaskCliDeps) => Promise<number>;
}

/** One table out of every family's; a name two families claim is a mistake in the code. */
function gather<T>(what: string, tables: ReadonlyArray<Record<string, T> | undefined>) {
  // Without a prototype: no inherited property of the table can match a command or an op.
  const all: Record<string, T> = Object.create(null);
  for (const table of tables) {
    for (const [name, value] of Object.entries(table ?? {})) {
      if (name in all) throw new Error(`ut: ${what} "${name}" is registered twice`);
      all[name] = value;
    }
  }
  return all;
}

export function createTaskCli(families: readonly CommandFamily[]): TaskCli {
  const help = helpOf(families);
  const commands = gather<CliCommand>(
    'command',
    families.map((family) => family.commands)
  );
  const printers = gather<Printer>(
    'printer',
    families.map((family) => family.print)
  );
  const pending = gather<(input: PendingInput) => void>(
    'pending note',
    families.map((family) => family.pending)
  );
  const options = Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [name, command.options])
  );

  async function build(group: string, argv: string[], deps: TaskCliDeps): Promise<Built> {
    const [sub, ...rest] = argv;
    const command = `${group} ${sub ?? ''}`.trim();
    const known: CliCommand | undefined = commands[command];
    if (!known) throw new UsageError(`unknown command: ut ${command}`);
    const { flags, positional } = parseFlags(rest, `ut ${command}`, known.options);
    return known.build({
      command,
      sub,
      flags,
      positional,
      json: flags.json === true,
      repo: typeof flags.repo === 'string' ? path.resolve(deps.cwd, flags.repo) : undefined,
      deps,
      text: async (words, what) => {
        const joined =
          words.length === 1 && words[0] === '-' ? await deps.readStdin() : words.join(' ');
        if (!joined.trim()) throw new UsageError(`${what} is required`);
        return joined;
      },
      ref: (required) => {
        const value = positional[0];
        if (!value && required) throw new UsageError(`ut ${command} needs a task id or branch`);
        return value;
      },
    });
  }

  function print(built: Built, response: TaskResponse, deps: TaskCliDeps): number {
    const context: FormatContext = {
      ...(deps.env.UNTETHER_SESSION_ID ? { me: deps.env.UNTETHER_SESSION_ID } : {}),
      now: (deps.now ?? Date.now)(),
    };
    const line = (task: TaskRecord) => formatTaskLine(task, context);
    if (built.json) {
      deps.out(JSON.stringify(response, null, 2));
      if (!response.ok) return 1;
      return (response.status === 'done' && built.jsonExit?.(response.data)) || 0;
    }
    if (!response.ok) {
      deps.err(`Error: ${response.message}`);
      if (response.code === 'needs-confirmation' && response.commits !== undefined) {
        deps.err(
          `${response.commits} commit(s) exist only on its branch; pass --yes to lose them.`
        );
      }
      return 1;
    }
    if (response.status === 'pending-confirmation') {
      deps.out(formatConfirmation(response.confirmation));
      pending[built.op]?.({ built, data: response.data, deps });
      return 0;
    }
    const data = response.data;
    const auto = data.autoApproved as { summary?: string } | undefined;
    if (auto) deps.out(`Done without asking (the user's autoApprove is on): ${auto.summary ?? ''}`);
    const printer: Printer = printers[built.op] ?? printTask;
    return printer({ built, data, deps, context, line }) ?? 0;
  }

  /** print(), and when the server did not know the op it was sent: it is older than this CLI. */
  async function printExplained(
    built: Built,
    response: TaskResponse,
    deps: TaskCliDeps
  ): Promise<number> {
    const code = print(built, response, deps);
    if (
      !response.ok &&
      response.code === 'bad-request' &&
      response.message.startsWith('Unknown task command') &&
      deps.builds
    ) {
      for (const line of olderServerAdvice(deps.builds.cli(), await serverBuild(deps))) {
        deps.err(line);
      }
    }
    return code;
  }

  async function run(
    group: 'task' | 'project',
    argv: string[],
    deps: TaskCliDeps
  ): Promise<number> {
    const handed = await olderThanServer(group, argv, deps);
    if (handed !== undefined) return handed;
    if (!argv.length || argv[0] === 'help') {
      deps.out(help);
      return argv.length ? 0 : 1;
    }
    // 2026-10-20: `ut task merge <id> --help` merged the task. Help anywhere (before a `--`)
    // only shows the usage.
    const end = argv.indexOf('--');
    const flagged = end < 0 ? argv : argv.slice(0, end);
    if (flagged.includes('--help') || flagged.includes('-h')) {
      deps.out(help);
      return 0;
    }
    let built: Built;
    try {
      built = await build(group, argv, deps);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      deps.err(`Error: ${error.message}`);
      deps.err(`Run 'ut ${group} help' for usage.`);
      return 1;
    }
    const caller = deps.env.UNTETHER_SESSION_ID ? { sessionId: deps.env.UNTETHER_SESSION_ID } : {};
    if (built.run) {
      return built.run({
        built,
        caller,
        deps,
        print: (response) => print(built, response, deps),
        printExplained: (response) => printExplained(built, response, deps),
      });
    }
    return printExplained(built, await deps.task(built.op, built.args, caller), deps);
  }

  return { help, options, run };
}
