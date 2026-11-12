/**
 * Programs started with an argument array (`execFile`, never a shell): the safe way to run
 * git and friends with paths and names that came from a client or an agent.
 */
import { execFile } from 'child_process';
import { withoutServerRuntime } from './session-env.js';

const MAX_OUTPUT = 16 * 1024 * 1024;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started at all (ENOENT: not installed). */
  spawnError?: string;
  /** The output passed the limit (16 MB): `stdout` is its start, the program was stopped. */
  truncated?: boolean;
}

/** execFile with an argument array; resolves with the exit code instead of throwing. */
export function run(
  bin: string,
  args: string[],
  cwd: string,
  timeout: number,
  extraEnv: Record<string, string> = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd,
        timeout,
        maxBuffer: MAX_OUTPUT,
        encoding: 'utf8',
        // 2026-10-24: a task worktree's install got the dev server's npm_config_ignore_scripts
        // and NODE_ENV; what runs in a project never gets the server's own runtime.
        env: {
          ...withoutServerRuntime(process.env),
          GIT_TERMINAL_PROMPT: '0',
          GH_PROMPT_DISABLED: '1',
          GH_NO_UPDATE_NOTIFIER: '1',
          NO_COLOR: '1',
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const err = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
        if (err.code === 'ENOENT') {
          return resolve({ code: 127, stdout: '', stderr: '', spawnError: 'ENOENT' });
        }
        const code = typeof err.code === 'number' ? err.code : 1;
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '', truncated: true });
        }
        const timedOut = err.killed ? '\n(timed out)' : '';
        resolve({ code, stdout: stdout ?? '', stderr: `${stderr ?? ''}${timedOut}` });
      }
    );
  });
}

/**
 * Git ref names we accept from the client (base branch): what `git check-ref-format --branch`
 * allows, minus a leading '-' (it would read as an option) and shell syntax. 2026-10-20: only ASCII letters,
 * digits and `._/-` were let in, so `feature/añadir-login`, `fix+1` or `user@x` could not be a
 * task's base although git takes them.
 */
export function isSafeRefName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false;
  if (name.startsWith('-') || name === '@') return false;
  // Control characters, space and the characters of revision syntax.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  // Shell syntax: git takes it, but a name like `main;rm` is never a real branch, and one
  // pasted into a shell some day must not run anything.
  if (/[;|&$`'"<>(){}!]/.test(name)) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  return name
    .split('/')
    .every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}
