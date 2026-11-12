/**
 * Share with phone on a locked Mac: the agent is reopened in a new terminal window through
 * LaunchServices (`/usr/bin/open -a Terminal <file>.command`), with no AppleScript at all.
 * Every Apple Event hangs while the screen is locked (V19); `open` doesn't send one the
 * script has to wait for, and Terminal runs a `.command` file it is handed while locked.
 *
 * The file, in a private directory of its own (`mkdtemp` under the per-user temp dir, mode
 * 0700, the file 0700 too):
 *
 *   #!/bin/sh
 *   rm -f -- "$0"
 *   cd '<cwd>' && exec '<shell>' -lic '<relaunch line>'
 *
 * It deletes itself as its first act, so nothing stays behind even if this server dies right
 * after `open`; the server also removes the file and its directory after COMMAND_FILE_TTL_MS.
 * Only fixed text and values quoted by shell-quote.ts are written, never anything a client
 * sent. The relaunch line is the one the same-tab path types (relaunch-command.ts), so the
 * `shell` launcher's function (which wraps the agent with ut) runs the same way.
 *
 * QA (2026-10-04, macOS 27.0, screen locked, from `env -i HOME USER PATH`):
 * - Terminal (running): ran the file within 4 s; it deleted itself.
 * - iTerm2 3.5.4 (not running): `open -a iTerm` exited 0 and launched iTerm2, which declares
 *   `.command` files, but it never ran the file (50 s, no child process; ran again with iTerm2
 *   up: same). So an iTerm2 agent reopens in a Terminal window (NEW_WINDOW_APP), and the
 *   phone names Terminal.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MacShareApp, MacShareShell } from '../../../shared/mac-share.js';
import { quotePosix, unsafeReason } from './shell-quote.js';

/** Where an agent of each app reopens when the Mac is locked (see the QA above). */
export const NEW_WINDOW_APP: Record<MacShareApp, MacShareApp> = {
  Terminal: 'Terminal',
  iTerm: 'Terminal',
};

/** The app names given to `open -a`. */
const OPEN_APP_NAME: Record<MacShareApp, string> = { Terminal: 'Terminal', iTerm: 'iTerm' };

/** The file and its directory are removed after this, whether or not it ran. */
export const COMMAND_FILE_TTL_MS = 5 * 60_000;
/** `open` returns once LaunchServices took the file; a cold app launch is the slow case. */
export const OPEN_TIMEOUT_MS = 30_000;
const OPEN_BIN = '/usr/bin/open';
const DIR_PREFIX = 'ut-share-';
const FILE_NAME = 'reopen.command';

/** A word that needs no quoting for /bin/sh. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/-]+$/;

/** The shell binaries tried for a tab whose args[0] has no path (`-zsh`). */
const SHELL_CANDIDATES: Record<MacShareShell, string[]> = {
  zsh: ['/bin/zsh'],
  bash: ['/bin/bash'],
  fish: ['/opt/homebrew/bin/fish', '/usr/local/bin/fish'],
};

/**
 * The tab's shell as an executable path: its own args[0] when that is absolute, else the
 * user's login shell when it is the same shell, else the usual place of that shell. Null when
 * none exists (a new window can't be offered then).
 */
export function shellPathFor(
  shell: MacShareShell,
  arg0: string,
  isExecutableFile: (file: string) => boolean,
  loginShell: string | undefined = safeLoginShell()
): string | null {
  const own = (arg0.trim().split(' ')[0] ?? '').replace(/^-/, '');
  const candidates = [
    ...(own.startsWith('/') ? [own] : []),
    ...(loginShell && path.basename(loginShell) === shell ? [loginShell] : []),
    ...SHELL_CANDIDATES[shell],
  ];
  for (const candidate of candidates) {
    if (path.basename(candidate) !== shell || unsafeReason(candidate)) continue;
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function safeLoginShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

/** The line the `.command` file runs (also what the confirm sheet shows). */
export function newWindowCommand(cwd: string, shellPath: string, relaunchLine: string): string {
  const shellWord = PLAIN_PATH.test(shellPath) ? shellPath : quotePosix(shellPath);
  return `cd ${quotePosix(cwd)} && exec ${shellWord} -lic ${quotePosix(relaunchLine)}`;
}

/** The whole `.command` file: it deletes itself before doing anything else. */
export function commandFileText(command: string): string {
  if (command.includes('\n')) throw new Error('one line only');
  return `#!/bin/sh\nrm -f -- "$0"\n${command}\n`;
}

/** What the writer needs from the file system (fs.promises in production). */
export interface CommandFileFs {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(file: string, text: string, options: { mode: number; flag: string }): Promise<void>;
  chmod(file: string, mode: number): Promise<void>;
  unlink(file: string): Promise<void>;
  rmdir(dir: string): Promise<void>;
}

export const realCommandFileFs: CommandFileFs = {
  mkdtemp: (prefix) => fs.promises.mkdtemp(prefix),
  writeFile: (file, text, options) => fs.promises.writeFile(file, text, options),
  chmod: (file, mode) => fs.promises.chmod(file, mode),
  unlink: (file) => fs.promises.unlink(file),
  rmdir: (dir) => fs.promises.rmdir(dir),
};

export interface CommandFile {
  dir: string;
  file: string;
}

/** Writes `text` as a new 0700 file in a new 0700 directory under `tmpdir`. */
export async function writeCommandFile(
  text: string,
  fsx: CommandFileFs = realCommandFileFs,
  tmpdir: string = os.tmpdir()
): Promise<CommandFile> {
  const dir = await fsx.mkdtemp(path.join(tmpdir, DIR_PREFIX));
  // mkdtemp makes it 0700 already; said again so a umask or a fake can't loosen it.
  await fsx.chmod(dir, 0o700);
  const file = path.join(dir, FILE_NAME);
  try {
    await fsx.writeFile(file, text, { mode: 0o700, flag: 'wx' });
    await fsx.chmod(file, 0o700);
  } catch (error) {
    await removeCommandFile({ dir, file }, fsx);
    throw error;
  }
  return { dir, file };
}

/**
 * Removes the file (gone already once it ran) and then its directory, only when empty: never
 * a recursive delete.
 */
export async function removeCommandFile(
  { dir, file }: CommandFile,
  fsx: CommandFileFs = realCommandFileFs
): Promise<void> {
  await fsx.unlink(file).catch(() => {});
  await fsx.rmdir(dir).catch(() => {});
}

/** Runs `open`: resolves to its exit code (-1 when it couldn't run or timed out). */
export type OpenRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

export const realOpenRunner: OpenRunner = (args, env) =>
  new Promise((resolve) => {
    execFile(OPEN_BIN, args, { env, timeout: OPEN_TIMEOUT_MS }, (error) => {
      if (!error) return resolve(0);
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
      resolve(typeof code === 'number' ? code : -1);
    });
  });

/**
 * The environment `open` runs with. When it has to launch the app, the app may inherit it:
 * only what a login needs, never this server's own variables.
 */
export function openEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR']) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

export interface NewWindowDeps {
  fs?: CommandFileFs;
  tmpdir?: string;
  run?: OpenRunner;
  env?: NodeJS.ProcessEnv;
  /** Schedules the late cleanup (setTimeout, unref'd, in production). */
  later?: (fn: () => void, ms: number) => void;
}

const realLater = (fn: () => void, ms: number) => {
  setTimeout(fn, ms).unref?.();
};

/**
 * Writes the `.command` file for `command` and hands it to `app` through LaunchServices.
 * True when `open` accepted it (it runs within seconds; the job then looks for the agent).
 */
export async function openInNewWindow(
  app: MacShareApp,
  command: string,
  deps: NewWindowDeps = {}
): Promise<boolean> {
  const fsx = deps.fs ?? realCommandFileFs;
  const written = await writeCommandFile(commandFileText(command), fsx, deps.tmpdir);
  (deps.later ?? realLater)(() => void removeCommandFile(written, fsx), COMMAND_FILE_TTL_MS);
  const code = await (deps.run ?? realOpenRunner)(
    ['-a', OPEN_APP_NAME[app], written.file],
    deps.env ?? openEnv()
  );
  if (code !== 0) {
    // Not taken: nothing will run it, so it goes now.
    await removeCommandFile(written, fsx);
    return false;
  }
  return true;
}
