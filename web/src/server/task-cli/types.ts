/**
 * What the pieces of `ut task …` / `ut project …` share: what the CLI is given to work with,
 * and what a family of commands (one file each, registered in ../task-cli.ts) is made of.
 */

import type { TaskRecord } from '../../shared/tasks.js';
import type { BuildInfo } from '../build-info.js';
import type { TaskResponse } from '../pty/socket-protocol.js';
import type { FormatContext } from './format-task-line.js';

export interface TaskCliDeps {
  task: (
    op: string,
    args: Record<string, unknown>,
    caller: { sessionId?: string }
  ) => Promise<TaskResponse>;
  env: Record<string, string | undefined>;
  cwd: string;
  readStdin: () => Promise<string>;
  out: (text: string) => void;
  err: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Whether a folder exists (fs.existsSync). */
  exists?: (dir: string) => boolean;
  /**
   * This CLI's build and the running server's (its status), to tell when a failure comes from
   * one being older than the other (2026-10-31: the app's ut from 10-24 answered "unknown
   * command: ut project connector" to an agent while the dev server knew it).
   */
  builds?: {
    cli: () => BuildInfo;
    server: () => Promise<BuildInfo | undefined>;
  };
  /**
   * Runs the server's own CLI (`cli`, BuildInfo.cli) with these arguments, this process's stdin
   * and output and HANDED_OVER_ENV set; its exit code, or undefined when it could not be run.
   */
  handOver?: (cli: string, argv: string[]) => Promise<number | undefined>;
}

/** Set for the server's CLI a stale ut handed its command to: it never hands over again. */
export const HANDED_OVER_ENV = 'UNTETHER_CLI_HANDED_OVER';

/** `ut task wait` gives up after the server is unavailable this long in a row. */
export const WAIT_OUTAGE_MS = 300_000;

export type Flags = Record<string, string | boolean>;

/** The options one command takes: `value` ones are followed by their value, `switches` by none. */
export interface CommandOptions {
  value?: readonly string[];
  switches?: readonly string[];
}

export class UsageError extends Error {}

/** What one command line asks of the server. */
export interface Built {
  op: string;
  args: Record<string, unknown>;
  json: boolean;
  /** With --json, the exit code of a request that went through (0 when not given). */
  jsonExit?: (data: Record<string, unknown>) => number;
  /** A command that does more than one request and its answer (`wait`, `orchestrate --wait`). */
  run?: (context: RunContext) => Promise<number>;
}

export interface RunContext {
  built: Built;
  caller: { sessionId?: string };
  deps: TaskCliDeps;
  /** Shows an answer; the exit code. */
  print: (response: TaskResponse) => number;
  /** print, and what to do when the server is older than this CLI. */
  printExplained: (response: TaskResponse) => Promise<number>;
}

/** One command line, read against its command's options. */
export interface BuildInput {
  /** "task new". */
  command: string;
  /** "new". */
  sub: string;
  flags: Flags;
  positional: string[];
  json: boolean;
  /** --repo, resolved from the caller's folder. */
  repo: string | undefined;
  deps: TaskCliDeps;
  /** The words joined, or stdin for a lone `-`; `what` names it in the error when empty. */
  text: (words: string[], what: string) => Promise<string>;
  /** The first word as a task id or branch. */
  ref: (required: boolean) => string | undefined;
}

export interface CliCommand {
  /**
   * The options it takes (`--json` goes with all). 2026-11-10: an orchestrator's
   * `ut project tell untether --reply-to mhz2xp2 - <<EOF` ran on a ut that did not know
   * --reply-to; any unknown --option was a switch nobody read, so the message went out as the
   * text "mhz2xp2 -", not linked as an answer and without its body, and nothing said so. An
   * option a command does not list here is an error now, never text and never ignored; text
   * that starts with -- goes after a lone `--`.
   */
  options: CommandOptions;
  build: (input: BuildInput) => Built | Promise<Built>;
}

export interface PrintInput {
  built: Built;
  data: Record<string, unknown>;
  deps: TaskCliDeps;
  context: FormatContext;
  line: (task: TaskRecord) => string;
}

/** Shows the answer to one op; its exit code when not 0. */
export type Printer = (input: PrintInput) => number | undefined;

export interface PendingInput {
  built: Built;
  /** What the caller gets at once while the user's OK is waited for. */
  data: Record<string, unknown> | undefined;
  deps: TaskCliDeps;
}

/**
 * A family of commands: adding a command, an option or a line of help is a change to its
 * family's file only.
 */
export interface CommandFamily {
  /** Its lines of `ut task help`, as shown. */
  usage: string;
  /** By "task new" / "project set". */
  commands: Record<string, CliCommand>;
  /** How the answer to each of its ops is shown; an op nobody lists shows its task's line. */
  print?: Record<string, Printer>;
  /** What an op adds while it waits for the user's OK on the phone. */
  pending?: Record<string, (input: PendingInput) => void>;
}
