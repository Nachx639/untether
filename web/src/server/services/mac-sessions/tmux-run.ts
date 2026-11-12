/**
 * The only way Mac Sessions runs tmux on the user's own tmux servers (attach-session aside: it
 * only ever runs inside a session's PTY). Every call is `tmux -u -N -S <socket> …`: -u so names
 * and titles come back exact without a UTF-8 locale, -N so a server that is gone is never
 * started again (nor its config run), and -S so it reaches the server that was found, never the
 * one in TMUX.
 *
 * On those servers Mac Sessions only reads, and changes nothing but Untether's own client.
 * Anything else throws before tmux starts, including each command after a `;`.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { type MacSessionsResponse, TMUX_MIN_OPEN_VERSION } from '../../../shared/mac-sessions.js';
import { findTmuxBinary, tmuxEnv } from '../shielded-tmux.js';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 2_000;
const MAX_BUFFER = 4 * 1024 * 1024;

/** A tmux command Mac Sessions may not run on a user's server. */
export class MacTmuxRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MacTmuxRefused';
  }
}

/** They only read: any option is fine. */
const READ_COMMANDS = new Set(['list-panes', 'list-clients', 'has-session']);

type OptionRule = 'flag' | ((value: string) => boolean);

interface ClientCommandRule {
  /** The client, by its tty, and for switch-client the session it stays on. */
  required: string[];
  options: Map<string, OptionRule>;
}

const isClientTty = (value: string) => /^\/dev\/\S+$/.test(value);
// A window or pane target would change the current window for every client.
const isSessionId = (value: string) => /^\$\d+$/.test(value);
// active-pane is gone in tmux 3.8, and refresh-client can't clear read-only (switch-client -r does).
const isSizeFlag = (value: string) => value === 'ignore-size' || value === '!ignore-size';

/**
 * Commands that change one client: Untether's own, which the caller has just identified (its
 * pid is the session's). Only these options, each its own argument: never -a or -s, which
 * detach the user's other clients, -P, which hangs up the client's parent, or detach-client's
 * -E, which runs a shell command in the client's place. Without a client tmux would pick one
 * itself, maybe the user's terminal. switch-client always passes -E: without it tmux copies
 * Untether's environment (update-environment: SSH_AUTH_SOCK, DISPLAY…) into the user's
 * session, where it outlives the client.
 */
const CLIENT_COMMANDS = new Map<string, ClientCommandRule>([
  [
    'switch-client',
    {
      required: ['-E', '-c', '-t'],
      options: new Map<string, OptionRule>([
        ['-E', 'flag'],
        ['-c', isClientTty],
        ['-t', isSessionId],
        ['-r', 'flag'],
      ]),
    },
  ],
  [
    'refresh-client',
    {
      required: ['-t'],
      options: new Map<string, OptionRule>([
        ['-t', isClientTty],
        ['-f', isSizeFlag],
      ]),
    },
  ],
  [
    'detach-client',
    { required: ['-t'], options: new Map<string, OptionRule>([['-t', isClientTty]]) },
  ],
]);

/**
 * `args` cut into commands as tmux cuts them: an argument `;`, or one that ends with an
 * unescaped `;`, ends a command (`-F 'x;' kill-server` is two commands).
 */
function splitCommands(args: readonly string[]): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  for (const arg of args) {
    if (arg.endsWith('\\;')) {
      current.push(`${arg.slice(0, -2)};`);
    } else if (arg.endsWith(';')) {
      if (arg.length > 1) current.push(arg.slice(0, -1));
      commands.push(current);
      current = [];
    } else {
      current.push(arg);
    }
  }
  commands.push(current);
  return commands;
}

function checkClientCommand(name: string, rule: ClientCommandRule, args: string[]): void {
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    const check = rule.options.get(option);
    if (!check || seen.has(option)) {
      throw new MacTmuxRefused(`tmux ${name}: ${option} is not allowed here`);
    }
    seen.add(option);
    if (check === 'flag') continue;
    i++;
    if (i >= args.length || !check(args[i])) {
      throw new MacTmuxRefused(`tmux ${name}: ${option} has a value that is not allowed here`);
    }
  }
  const missing = rule.required.find((option) => !seen.has(option));
  if (missing) throw new MacTmuxRefused(`tmux ${name} needs ${missing}`);
}

/** Throws MacTmuxRefused unless every command in `args` may run on a user's tmux server. */
export function assertMacTmuxAllowed(args: readonly string[]): void {
  for (const [name, ...rest] of splitCommands(args)) {
    // A format's #(…) runs a shell command in the tmux server.
    if (rest.some((arg) => arg.includes('#('))) {
      throw new MacTmuxRefused(`tmux ${name}: shell commands in formats are not allowed here`);
    }
    if (name !== undefined && READ_COMMANDS.has(name)) continue;
    const rule = name === undefined ? undefined : CLIENT_COMMANDS.get(name);
    if (!rule) throw new MacTmuxRefused(`tmux ${name ?? '(empty command)'} is not allowed here`);
    checkClientCommand(name, rule, rest);
  }
}

export interface MacTmuxOptions {
  /** findTmuxBinary() unless given. */
  tmuxBin?: string | null;
  /** process.env unless given; TMUX and TMUX_PANE are always left out. */
  env?: Record<string, string | undefined>;
}

/**
 * Run `args` on the tmux server at `socketPath` and answer its output. Rejects with
 * MacTmuxRefused for a command that may not run there, else with execFile's error when tmux
 * fails: its stderr tells a server that is gone apart (isNoTmuxServer in tmux-manager.ts).
 */
export async function runMacTmux(
  socketPath: string,
  args: readonly string[],
  options: MacTmuxOptions = {}
): Promise<string> {
  if (!path.isAbsolute(socketPath)) {
    throw new MacTmuxRefused('tmux sockets are given by their absolute path');
  }
  assertMacTmuxAllowed(args);
  const tmuxBin = options.tmuxBin ?? findTmuxBinary();
  if (!tmuxBin) throw new Error('tmux is not installed');
  const { stdout } = await execFileAsync(tmuxBin, ['-u', '-N', '-S', socketPath, ...args], {
    env: tmuxEnv(options.env ?? process.env),
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
  });
  return stdout;
}

export type TmuxAvailability = NonNullable<MacSessionsResponse['tmux']>;

function versionNumbers(text: string): [number, number] | null {
  const match = /(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * The version in `tmux -V`'s output ("tmux 3.7c", or just "3.7c"), and whether it can open a
 * session from the list: that needs TMUX_MIN_OPEN_VERSION. Builds from tmux's repository
 * ("master", "next-3.8") are newer than any release.
 */
export function parseTmuxVersion(output: string): { version: string; canOpen: boolean } | null {
  const version = output.trim().replace(/^tmux\b\s*/, '');
  if (!version) return null;
  if (version === 'master' || version.startsWith('next-')) return { version, canOpen: true };
  const found = versionNumbers(version);
  const [major, minor] = versionNumbers(TMUX_MIN_OPEN_VERSION) ?? [0, 0];
  const canOpen = found !== null && (found[0] > major || (found[0] === major && found[1] >= minor));
  return { version, canOpen };
}

async function readTmuxVersion(tmuxBin: string): Promise<TmuxAvailability> {
  try {
    const { stdout } = await execFileAsync(tmuxBin, ['-V'], {
      env: tmuxEnv(process.env),
      timeout: TIMEOUT_MS,
      encoding: 'utf8',
    });
    return { available: true, canOpen: false, ...parseTmuxVersion(stdout) };
  } catch {
    return { available: false, canOpen: false };
  }
}

let versionCache: { key: string; result: Promise<TmuxAvailability> } | undefined;

/**
 * Whether tmux is installed, its version, and whether it can open sessions. `tmux -V` runs once
 * per binary, and again only when the file changes (an upgrade); callers at the same time share
 * one run, and a run that failed is not remembered.
 */
export async function tmuxVersion(
  tmuxBin: string | null = findTmuxBinary()
): Promise<TmuxAvailability> {
  if (!tmuxBin) return { available: false, canOpen: false };
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(tmuxBin);
  } catch {
    return { available: false, canOpen: false };
  }
  const key = `${tmuxBin}\0${stat.ino}\0${stat.mtimeMs}`;
  if (versionCache?.key === key) return versionCache.result;
  const result = readTmuxVersion(tmuxBin);
  versionCache = { key, result };
  const answer = await result;
  if (!answer.available && versionCache?.result === result) versionCache = undefined;
  return answer;
}
