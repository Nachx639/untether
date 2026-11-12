/**
 * Which quick-start programs exist on this machine (2026-10-03): gemini and crush, not
 * installed on the dev Mac, were one-tap buttons that only started a session failing with
 * "command not found". The client dims those and says why instead.
 *
 * "Exists" follows ProcessUtils.resolveCommand, how sessions start: a program `which` finds
 * in the server's PATH runs directly; anything else runs through the user's interactive
 * login shell ($SHELL -i -l -c …), where ~/.zshrc aliases, functions and PATH apply (codex
 * only exists there on that Mac). So PATH first, then ONE shell asked about everything not
 * found there: zsh `whence -w` prints "name: none" for an unknown name, bash `type -t` prints
 * nothing. Another shell, a timeout or any failure counts as available: a check that went
 * wrong must never hide a command that works. Answers are cached for a few minutes.
 */
import { execFile, spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { getUserShell } from '../pty/process-utils.js';
import { createLogger } from '../utils/logger.js';
import { terminalSessionEnv } from '../utils/session-env.js';

const logger = createLogger('quick-start-availability');

/** { "<program>": false } when it isn't on this machine; true when it is or can't be told. */
export type QuickStartAvailabilityMap = Record<string, boolean>;

/** Whether `which` finds the program in the server's PATH. */
export type PathLookup = (program: string) => Promise<boolean>;

/** Runs `shell ...args` and resolves with its stdout; it must stop the shell when aborted. */
export type ShellRunner = (shell: string, args: string[], signal: AbortSignal) => Promise<string>;

export interface QuickStartAvailabilityOptions {
  findInPath?: PathLookup;
  /** Tests pass a fake: they never start a real interactive shell. */
  runShell?: ShellRunner;
  /** The user's shell, as sessions use it. */
  getShell?: () => string;
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
}

export const QUICK_START_CHECK_TIMEOUT_MS = 5000;
export const QUICK_START_CACHE_MS = 5 * 60 * 1000;

// The names travel as arguments ("$@"), never spliced into the script. The leading newline
// keeps the answer off a line the profile may have left unfinished.
const ZSH_SCRIPT = `printf '\\n'; whence -w -- "$@"`;
const BASH_SCRIPT = `printf '\\n'; for name in "$@"; do printf '%s: %s\\n' "$name" "$(type -t -- "$name" || echo none)"; done`;

// What resolveCommand accepts as a shell fallback command name (buildShellCommandArgs).
const SHELL_SAFE_NAME = /^[A-Za-z0-9_@%+,./:-]+$/;

/** Same lookup as resolveCommand: `which` with the server's own PATH, 2 s at most. */
export const findInServerPath: PathLookup = (program) =>
  new Promise((resolve) => {
    execFile('which', [program], { encoding: 'utf8', timeout: 2000 }, (error, stdout) =>
      resolve(!error && stdout.trim().length > 0)
    );
  });

const MAX_SHELL_OUTPUT = 64 * 1024;

/**
 * Runs the shell in its own session, with a session's environment. Detached, so it has no
 * controlling terminal: an interactive zsh would otherwise open /dev/tty and take over the
 * terminal the server was started from. SHELL_SESSIONS_DISABLE keeps macOS Terminal's
 * session save/restore (/etc/zshrc_Apple_Terminal) out of it. Aborting kills its whole
 * process group.
 */
export const runShellScript: ShellRunner = (shell, args, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd: os.homedir(),
      env: terminalSessionEnv(process.env, {
        TERM: 'xterm-256color',
        SHELL_SESSIONS_DISABLE: '1',
      }),
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      signal.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      if (error) reject(error);
      else resolve(stdout);
    };
    const onAbort = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      settle(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-MAX_SHELL_OUTPUT);
    });
    child.once('error', (error) => settle(error));
    child.once('close', () => settle());
    // Something the profile started in the background can hold stdout open after the shell
    // itself exited: don't wait for it.
    child.once('exit', () => {
      if (!settled) grace = setTimeout(() => settle(), 250);
    });
  });

/** The names the shell's answer calls unknown ("gemini: none"); one it didn't mention is not. */
function unknownNames(stdout: string, asked: string[]): string[] {
  const names = new Set(asked);
  const unknown: string[] = [];
  for (const line of stdout.split('\n')) {
    const separator = line.lastIndexOf(': ');
    if (separator <= 0) continue;
    const name = line.slice(0, separator);
    if (names.has(name) && line.slice(separator + 2).trim() === 'none') unknown.push(name);
  }
  return unknown;
}

export class QuickStartAvailability {
  private readonly findInPath: PathLookup;
  private readonly runShell: ShellRunner;
  private readonly getShell: () => string;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private cached: { key: string; at: number; answer: QuickStartAvailabilityMap } | null = null;
  private pending: { key: string; answer: Promise<QuickStartAvailabilityMap> } | null = null;

  constructor(options: QuickStartAvailabilityOptions = {}) {
    this.findInPath = options.findInPath ?? findInServerPath;
    this.runShell = options.runShell ?? runShellScript;
    this.getShell = options.getShell ?? getUserShell;
    this.timeoutMs = options.timeoutMs ?? QUICK_START_CHECK_TIMEOUT_MS;
    this.cacheMs = options.cacheMs ?? QUICK_START_CACHE_MS;
    this.now = options.now ?? Date.now;
  }

  /** { program: available } for each program; never rejects. */
  check(programs: string[]): Promise<QuickStartAvailabilityMap> {
    const unique = [...new Set(programs.filter(Boolean))].sort();
    const key = unique.join('\n');
    if (this.cached?.key === key && this.now() - this.cached.at < this.cacheMs) {
      return Promise.resolve(this.cached.answer);
    }
    if (this.pending?.key === key) return this.pending.answer;
    const answer = this.lookUp(unique).then((result) => {
      this.cached = { key, at: this.now(), answer: result };
      if (this.pending?.answer === answer) this.pending = null;
      return result;
    });
    this.pending = { key, answer };
    return answer;
  }

  private async lookUp(programs: string[]): Promise<QuickStartAvailabilityMap> {
    const answer: QuickStartAvailabilityMap = Object.fromEntries(programs.map((p) => [p, true]));
    try {
      const inPath = await Promise.all(
        programs.map((program) => this.findInPath(program).catch(() => false))
      );
      // A relative path depends on the session's folder; a name resolveCommand won't hand to
      // a shell can't be asked safely. Neither is hidden.
      const toAsk = programs.filter(
        (program, index) =>
          !inPath[index] &&
          SHELL_SAFE_NAME.test(program) &&
          (!program.includes('/') || program.startsWith('/'))
      );
      for (const program of await this.unknownToShell(toAsk)) answer[program] = false;
    } catch (error) {
      logger.warn(`quick-start check failed, reporting everything as available: ${error}`);
      return Object.fromEntries(programs.map((p) => [p, true]));
    }
    logger.debug('quick-start availability:', answer);
    return answer;
  }

  /** The programs the user's login shell doesn't know either; [] when it can't be asked. */
  private async unknownToShell(programs: string[]): Promise<string[]> {
    if (!programs.length) return [];
    const shell = this.getShell();
    const shellName = path.basename(shell).toLowerCase();
    const script = shellName === 'zsh' ? ZSH_SCRIPT : shellName === 'bash' ? BASH_SCRIPT : null;
    if (!script) return [];

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${shell} gave no answer in ${this.timeoutMs} ms`));
        controller.abort();
      }, this.timeoutMs);
    });
    try {
      const stdout = await Promise.race([
        this.runShell(shell, ['-i', '-l', '-c', script, '--', ...programs], controller.signal),
        timeout,
      ]);
      return unknownNames(stdout, programs);
    } finally {
      clearTimeout(timer);
    }
  }
}
