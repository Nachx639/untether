/**
 * Shielded sessions ("Blindar sesión"): the command runs inside a detached tmux session on a
 * Untether-only tmux server, and the session's PTY is just a `tmux attach` client.
 *
 * Why tmux and not a detached forwarder: a web session's PTY is a node-pty child of the server.
 * When the server exits (deploy, crash, update) the PTY master closes, the kernel hangs up the
 * terminal and the shell (and Claude in it) gets SIGHUP; on the next start the session list sees
 * the dead pid and marks it exited. The tmux server daemonizes (fork + setsid), so it is not in
 * the Untether process tree or process group and outlives any restart; only the attach client
 * dies, and the next server start attaches a new one under the same session id. tmux also keeps
 * the screen and scrollback itself, so nothing has to be replayed from our side.
 *
 * The tmux server is private to the control directory (its socket lives in it), so the user's
 * own tmux is never touched and two Untether servers with different control dirs (tests) don't
 * share sessions. Every tmux call is execFile with an argument array: no shell.
 *
 * After a Mac reboot the tmux server is gone: sessions that were still running are recreated
 * under the same id (see shieldStartupAction / shieldRestorePlan); the programs start fresh
 * (Claude/Codex resume their conversation, a shell is a new shell). Limits: this only happens
 * when Untether itself starts, which is normally at login (the app or a LaunchAgent); before
 * login (FileVault) nothing runs. A boot-time PATH or keychain may differ from the user's
 * shell, so a program needing them can fail; that counts towards the restore loop guard.
 *
 * macOS: the tmux server is started by launchd as its own job (see startServerWithLaunchd).
 * A process stays in the coalition of the app that started it, across fork and setsid, and
 * when an app quits macOS ends its whole coalition a few seconds later (loginwindow,
 * "quitOrKillSubordinateProcesses"). On 2026-10-03 quitting Untether.app for an update took
 * the shield tmux server with it, and every shielded session came back restarted instead of
 * re-attached. A launchd job has a coalition of its own and outlives the app.
 */
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import type {
  ProviderSessionMarker,
  Session,
  SessionInfo,
  TerminalClaude,
} from '../../shared/types.js';
import { createLogger } from '../utils/logger.js';
import { isServerRuntimeVar } from '../utils/session-env.js';
import { CODEX_INLINE_FLAG } from './codex-process.js';
import { codexResumeCommand, startsCodex } from './codex-thread.js';

const logger = createLogger('shielded-tmux');
const execFileAsync = promisify(execFile);

const TMUX_CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
/** macOS caps unix socket paths at 104 bytes. */
const MAX_SOCKET_PATH = 100;

let cachedTmux: string | null | undefined;
let stableTmux: string | null = null;

/**
 * The stable, user-signed copy of tmux Untether keeps (stable-tmux.ts), or null to use the
 * installed tmux. Set by the server when the setting is on and the copy is good.
 */
export function setStableTmuxBinary(bin: string | null): void {
  stableTmux = bin;
}

/**
 * The tmux binary every Untether tmux call runs, or null when tmux isn't installed (shielding
 * is then unavailable): UNTETHER_TMUX_BIN, else the stable signed copy when it is on, else the
 * installed tmux. Not cached as a whole: the stable copy can be turned on or off while the
 * server runs, and a running ShieldTmux asks again on every call.
 */
export function findTmuxBinary(): string | null {
  const fromEnv = process.env.UNTETHER_TMUX_BIN;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;
  if (stableTmux && isExecutable(stableTmux)) return stableTmux;
  return findInstalledTmux();
}

/** The tmux installed on this machine (Homebrew, /usr/local, /usr/bin or PATH), never the copy. */
export function findInstalledTmux(): string | null {
  if (cachedTmux !== undefined) return cachedTmux;
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [...TMUX_CANDIDATES, ...pathDirs.map((dir) => path.join(dir, 'tmux'))];
  cachedTmux =
    candidates.find(
      (candidate) =>
        isExecutable(candidate) && (!stableTmux || path.resolve(candidate) !== stableTmux)
    ) ?? null;
  return cachedTmux;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** tmux session name of an Untether session. */
export function shieldTmuxName(sessionId: string): string {
  return `ut-${sessionId}`;
}

/**
 * Socket selection args for the shield tmux server of a control dir: `-S <controlDir>/.shield-tmux`
 * (or `-L` with a name derived from it when that path is too long for a unix socket).
 */
export function shieldSocketArgs(controlPath: string): string[] {
  const socketPath = path.join(controlPath, '.shield-tmux');
  if (socketPath.length <= MAX_SOCKET_PATH) return ['-S', socketPath];
  const hash = crypto.createHash('sha1').update(controlPath).digest('hex').slice(0, 12);
  return ['-L', `untether-${hash}`];
}

/**
 * Pids of the tmux servers on a shield socket in `ps -o pid=,ppid=,args=` output: a tmux
 * process whose arguments select that socket (`-S <path>` / `-L <name>`) and whose parent is
 * launchd (servers daemonize or are launchd jobs; attached clients have Untether as parent).
 */
export function shieldServerPids(psOutput: string, socketArgs: string[]): number[] {
  const select = socketArgs.join(' ');
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || match[2] !== '1') continue;
    // The program (its path may hold spaces) is what comes before the socket selection.
    const at = `${match[3]} `.indexOf(` ${select} `);
    if (at > 0 && path.basename(match[3].slice(0, at)) === 'tmux') pids.push(Number(match[1]));
  }
  return pids;
}

/**
 * Codex inline keeps its history in the tmux pane, but none of it reaches the web terminal:
 * it draws in synchronized updates (`?2026h`), which tmux turns into repaints, and a burst
 * that did scroll would lose its lines anyway (checked with Codex 0.164 and tmux 3.8,
 * 2026-11-09). So for this session alone tmux takes the mouse: the wheel opens copy mode on
 * its own history, and terminal-app-scroll places the scrollbar like any app that scrolls.
 */
export function shieldScrollsTmuxHistory(command: readonly string[]): boolean {
  return command.includes(CODEX_INLINE_FLAG);
}

/**
 * Mouse reports (SGR or legacy) and nothing else: a wheel, a click or a drag, any of which can
 * put tmux in copy mode and none of which is typing (review of 2026-11-09).
 */
export function isMouseInput(data: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching mouse reports on purpose
  return /^(?:\u001b\[<\d+;\d+;\d+[Mm]|\u001b\[M[\s\S]{3})+$/.test(data);
}

/** A terminal saying it gained or lost focus (focus-events on): not typing either. */
export function isFocusReport(data: string): boolean {
  return data === '\u001b[I' || data === '\u001b[O';
}

/**
 * Options of the shield tmux server: tmux must be invisible. No status bar, no prefix key (every
 * key reaches the program), no mouse capture (the web terminal scrolls), no escape delay, and no
 * alternate screen on the outside so output scrolls into the web terminal's scrollback.
 */
export const SHIELD_SERVER_OPTIONS: string[][] = [
  ['set-option', '-g', 'status', 'off'],
  ['set-option', '-g', 'prefix', 'None'],
  ['set-option', '-g', 'prefix2', 'None'],
  ['set-option', '-g', 'mouse', 'off'],
  ['set-option', '-s', 'escape-time', '0'],
  ['set-option', '-g', 'history-limit', '50000'],
  ['set-option', '-g', 'default-terminal', 'tmux-256color'],
  ['set-option', '-s', 'terminal-overrides', '*:smcup@:rmcup@'],
  ['set-option', '-s', 'terminal-features', 'xterm*:RGB:clipboard:title:focus'],
  ['set-option', '-s', 'set-clipboard', 'on'],
  ['set-option', '-s', 'focus-events', 'on'],
  ['set-option', '-g', 'set-titles', 'on'],
  ['set-option', '-g', 'set-titles-string', '#{pane_title}'],
  ['set-option', '-g', 'allow-passthrough', 'on'],
  ['set-option', '-g', 'allow-rename', 'off'],
  ['set-option', '-g', 'bell-action', 'any'],
  ['set-option', '-g', 'visual-bell', 'off'],
  ['set-option', '-g', 'remain-on-exit', 'off'],
  ['set-option', '-g', 'destroy-unattached', 'off'],
  ['set-option', '-g', 'detach-on-destroy', 'on'],
  ['set-option', '-g', 'window-size', 'latest'],
];

/** Variables each session gets with `new-session -e`; never part of the server's environment. */
const PER_SESSION_ENV = ['UNTETHER_SESSION_ID', 'UNTETHER_TASK_ID', 'TERM_PROGRAM', 'COLORTERM'];

/**
 * Whether the shield tmux server is started by launchd: on macOS, unless
 * UNTETHER_SHIELD_LAUNCHD=0. Tests start and kill throwaway tmux servers, so under vitest
 * only with UNTETHER_SHIELD_LAUNCHD=1.
 */
export function shieldUsesLaunchd(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'darwin' || env.UNTETHER_SHIELD_LAUNCHD === '0') return false;
  return env.UNTETHER_SHIELD_LAUNCHD === '1' || !env.VITEST;
}

/** launchd label of a control dir's shield tmux server (one per control dir). */
export function shieldLaunchdLabel(controlPath: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(controlPath)).digest('hex');
  return `com.nachx639.untether.shield-tmux.${hash.slice(0, 12)}`;
}

const xmlText = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// biome-ignore lint/suspicious/noControlCharactersInRegex: XML 1.0 can't carry these
const XML_UNSAFE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

/**
 * The launchd job of the shield tmux server: `tmux -S <socket> -D` (in the foreground, so
 * launchd owns it), as an Interactive process (no background CPU/IO throttling for Claude)
 * that is not restarted when it ends (the next shielded session starts it again). Its
 * environment is the one sessions get (the tmux global environment), without per-session
 * variables; the plist is written 0600 next to the socket.
 */
export function shieldLaunchdPlist(options: {
  label: string;
  programArguments: string[];
  env: Record<string, string>;
  workingDirectory: string;
}): string {
  const env = Object.entries(options.env).filter(
    ([key, value]) =>
      !PER_SESSION_ENV.includes(key) &&
      key !== 'TMUX' &&
      key !== 'TMUX_PANE' &&
      !XML_UNSAFE.test(key) &&
      !XML_UNSAFE.test(value)
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xmlText(options.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...options.programArguments.map((arg) => `    <string>${xmlText(arg)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><false/>',
    '  <key>ProcessType</key><string>Interactive</string>',
    '  <key>AbandonProcessGroup</key><true/>',
    `  <key>WorkingDirectory</key><string>${xmlText(options.workingDirectory)}</string>`,
    '  <key>StandardOutPath</key><string>/dev/null</string>',
    '  <key>StandardErrorPath</key><string>/dev/null</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env.map(
      ([key, value]) => `    <key>${xmlText(key)}</key><string>${xmlText(value)}</string>`
    ),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Join tmux commands into one invocation (`a ; b ; c`, each `;` its own argument). */
export function chainTmuxCommands(commands: string[][]): string[] {
  return commands.flatMap((command, index) => (index === 0 ? command : [';', ...command]));
}

/** The environment tmux commands run with: never inside another tmux. */
export function tmuxEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && key !== 'TMUX' && key !== 'TMUX_PANE') env[key] = value;
  }
  return env;
}

/**
 * Argument list for `tmux new-session`. With more than one argument tmux execs the command
 * directly (no shell), so a one-word command goes through /usr/bin/env.
 */
export function newSessionArgs(options: {
  sessionId: string;
  command: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  sessionEnv: Record<string, string>;
}): string[] {
  const command =
    options.command.length === 1 ? ['/usr/bin/env', options.command[0]] : options.command;
  return [
    'new-session',
    '-d',
    '-s',
    shieldTmuxName(options.sessionId),
    '-c',
    options.cwd,
    '-x',
    String(options.cols ?? 120),
    '-y',
    String(options.rows ?? 30),
    ...Object.entries(options.sessionEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '--',
    ...command,
  ];
}

/**
 * How a shielded program's own exit code reaches Untether. The PTY of a shielded session is a
 * tmux client, and its exit code says nothing about the program (it is 0 whenever the tmux
 * session ended). So the pane stays for a moment when its program ends (remain-on-exit), a
 * pane-died hook writes "<status> <signal>" to the session's exit file (its path is the
 * session's @ut_exit_file option, shell-quoted by `q:`, so no path is ever parsed by tmux or
 * sh) and then ends the pane, which ends the session as before. `kill-pane` runs even when the
 * write fails. remain-on-exit-format is emptied so "Pane is dead" never reaches the terminal
 * (`-q`: a tmux older than 3.3 has no such option). 2026-11-10.
 */
export const SHIELD_EXIT_HOOK = `run-shell 'printf "%s %s\\n" "#{pane_dead_status}" "#{pane_dead_signal}" > #{q:@ut_exit_file}' ; kill-pane`;

/** Where the pane-died hook of a shielded session writes how its program ended. */
export function shieldExitFile(controlPath: string, sessionId: string): string {
  return path.join(controlPath, `${shieldTmuxName(sessionId)}.exit`);
}

/** The tmux commands, run with new-session, that make a session record its program's exit. */
export function shieldExitCommands(sessionId: string, exitFile: string): string[][] {
  const target = `=${shieldTmuxName(sessionId)}:`;
  return [
    ['set-option', '-t', target, '@ut_exit_file', exitFile],
    ['set-option', '-w', '-t', target, 'remain-on-exit', 'on'],
    ['set-option', '-wq', '-t', target, 'remain-on-exit-format', ''],
    ['set-hook', '-w', '-t', target, 'pane-died', SHIELD_EXIT_HOOK],
  ];
}

/**
 * What the exit file says: the program's exit code, or the signal that ended it (tmux writes
 * its number or, since 3.4, its name without SIG). null when it says neither.
 */
export function parseShieldExit(text: string): { exitCode?: number; signal?: number } | null {
  const match = /^(\d*) (\S*)\s*$/.exec(text.split('\n')[0]);
  if (!match) return null;
  const [, status, signal] = match;
  if (signal) {
    const number = /^\d+$/.test(signal)
      ? Number(signal)
      : os.constants.signals[`SIG${signal.toUpperCase()}` as NodeJS.Signals];
    return number ? { signal: number } : null;
  }
  return status ? { exitCode: Number(status) } : null;
}

/** A shell variable name (sourced into a POSIX shell): everything else is left out. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The variable the env file sets last; the preflight checks it carries this session's nonce. */
const SHIELD_APPLIED_VAR = '__UT_ENV_APPLIED';

/**
 * The POSIX-sh preflight a shielded session with its own environment runs. `$0` is the 0600 env
 * file (sourced and removed at once, so a secret is never on argv), `$1` the verify file, `$2`
 * this session's nonce (the value the env file's last line sets), `$3` the comma-separated names
 * that must carry no credential; the rest is the real command. It checks the EFFECTIVE
 * environment the program will run with (on macOS a process's environment cannot be read from
 * outside): the env file must have sourced cleanly and reached its last line (its nonce is in
 * place, so every assignment before it took effect), and every dropped credential must be gone.
 * On any failure — the file did not load, the nonce is missing (the environment did not take
 * effect), a credential lingers — it writes `fail:<reason>` and does NOT run the agent (it would
 * talk to the Anthropic API on the user's login); create() reads the failure and kills it. It
 * only writes `ok` and execs the command in its place (same pid) when everything checks out.
 * 2026-11-08.
 */
export const SHIELD_PREFLIGHT_SCRIPT =
  '__vf="$1"; ' +
  // `.` on a missing file makes a non-interactive shell exit before any `else`, so the file is
  // checked readable first; an unreadable env file is a loud failure, not a silent pass.
  '[ -r "$0" ] || { printf "fail:env-file\\n" > "$__vf"; exec sleep 30; }; ' +
  '. "$0"; rm -f "$0"; ' +
  '__nonce="$2"; __forb="$3"; shift 3; __bad=""; ' +
  `[ "$${SHIELD_APPLIED_VAR}" = "$__nonce" ] || __bad="env-not-applied"; ` +
  '__oifs="$IFS"; IFS=","; ' +
  'for __v in $__forb; do [ -z "$__v" ] && continue; eval "__x=\\"\\$$__v\\""; ' +
  '[ -z "$__x" ] || __bad="$__bad +$__v"; done; ' +
  'IFS="$__oifs"; ' +
  'if [ -n "$__bad" ]; then printf "fail:%s\\n" "$__bad" > "$__vf"; exec sleep 30; fi; ' +
  'printf "ok\\n" > "$__vf"; exec "$@"';

/** The env file's last line: the nonce the preflight checks (not a secret; a per-session value). */
export function shieldAppliedLine(nonce: string): string {
  return `${SHIELD_APPLIED_VAR}='${nonce}'; export ${SHIELD_APPLIED_VAR}\n`;
}

/** The argv that runs `command` behind the per-session env file and its preflight check. */
export function shieldPreflightCommand(
  envFile: string,
  verifyFile: string,
  nonce: string,
  forbid: string[],
  command: string[]
): string[] {
  const names = forbid.filter((name) => ENV_NAME.test(name)).join(',');
  return ['/bin/sh', '-c', SHIELD_PREFLIGHT_SCRIPT, envFile, verifyFile, nonce, names, ...command];
}

/**
 * What the preflight wrote to its verify file. Fails closed: only an explicit `ok` passes; a
 * failure, an empty file (not written yet) or anything unrecognised is not ok, so a session whose
 * environment was never confirmed is never run on the user's own Anthropic login.
 */
export function readShieldVerify(text: string): { ok: boolean; problem?: string } {
  const line = text.trim();
  if (line === 'ok') return { ok: true };
  if (line.startsWith('fail:')) {
    return { ok: false, problem: line.slice('fail:'.length).trim() || 'unspecified' };
  }
  return {
    ok: false,
    problem: line ? `unrecognised verdict "${line.slice(0, 40)}"` : 'no verdict',
  };
}

/**
 * Wait for the preflight's verify file and read its verdict, failing closed: an empty or missing
 * file by the deadline is a failure (the session never confirmed its environment), not a pass.
 */
export async function awaitShieldVerify(
  verifyFile: string,
  timeoutMs = 15_000
): Promise<{ ok: boolean; problem?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let text = '';
    try {
      text = fs.readFileSync(verifyFile, 'utf8');
    } catch {
      text = '';
    }
    if (text.trim()) return readShieldVerify(text);
    if (Date.now() >= deadline) {
      return { ok: false, problem: 'the session did not confirm its environment in time' };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The POSIX-sh env file a shielded session's wrapper sources: each variable of `set` assigned
 * (single-quote-escaped) and exported, each name in `unset` removed. Safe to `.`-source: values
 * never run as code. The shield tmux server's global environment is shared and long-lived
 * (whatever the first session started it with), so per-session variables — a provider's
 * ANTHROPIC_BASE_URL/_AUTH_TOKEN/_*_MODEL and the user's own credentials to drop — travel here,
 * never in the server's environment (its launchd plist on disk) nor on argv.
 */
export function shieldEnvFileContent(set: Record<string, string>, unset: string[]): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(set)) {
    if (!ENV_NAME.test(key)) continue;
    const quoted = `'${value.split("'").join("'\\''")}'`;
    lines.push(`${key}=${quoted}; export ${key}`);
  }
  for (const key of unset) {
    if (ENV_NAME.test(key)) lines.push(`unset ${key}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** Names set in `tmux show-environment` output that are the server's runtime (isServerRuntimeVar). */
export function runtimeVarsInEnvironment(showEnvironment: string): string[] {
  const names: string[] = [];
  for (const line of showEnvironment.split('\n')) {
    const eq = line.indexOf('=');
    // `-NAME` lines are variables already removed.
    if (eq <= 0 || line.startsWith('-')) continue;
    const name = line.slice(0, eq);
    if (isServerRuntimeVar(name)) names.push(name);
  }
  return names;
}

export class ShieldTmux {
  /** A launchd start in progress (two sessions created at once share it). */
  private launchdStart: Promise<boolean> | null = null;

  /** How long create() waits for the preflight's verify file before failing closed (tests lower it). */
  verifyTimeoutMs = 15_000;

  /**
   * `tmuxBin`: a fixed binary (tests), or by default findTmuxBinary() asked on every call, so
   * turning the stable signed copy on or off (stable-tmux.ts) applies without a restart.
   */
  constructor(
    private readonly controlPath: string,
    private readonly tmuxBinOption: string | null | (() => string | null) = findTmuxBinary,
    private readonly useLaunchd: boolean = shieldUsesLaunchd()
  ) {}

  private get tmuxBin(): string | null {
    return typeof this.tmuxBinOption === 'function' ? this.tmuxBinOption() : this.tmuxBinOption;
  }

  isAvailable(): boolean {
    return this.tmuxBin !== null;
  }

  private bin(): string {
    if (!this.tmuxBin) throw new Error('tmux is not installed: shielded sessions need tmux');
    return this.tmuxBin;
  }

  private async run(args: string[], env?: Record<string, string>): Promise<string> {
    const { stdout } = await execFileAsync(
      this.bin(),
      [...shieldSocketArgs(this.controlPath), ...args],
      { env: tmuxEnv(env ?? process.env), timeout: 10_000 }
    );
    return stdout;
  }

  /** Start `command` in a detached tmux session for `sessionId`. */
  async create(options: {
    sessionId: string;
    command: string[];
    cwd: string;
    cols?: number;
    rows?: number;
    /** Environment of the program (the tmux server inherits it when this call starts it). */
    env: Record<string, string>;
    /** Variables of this session only, never of the server (pathPrependEnv). */
    ownEnv?: Record<string, string>;
    /**
     * Variables set for THIS session only (a provider's ANTHROPIC_*): never the server's global
     * environment (its launchd plist on disk, the sessions started after it). A shield tmux
     * server hands every session the environment it was started with, so `-e` and the server's
     * environment are not enough; these reach the program through a 0600 file it sources, so a
     * key is never on argv (`ps`). 2026-11-08.
     */
    overrideEnv?: Record<string, string>;
    /** Variables removed for THIS session only (the user's own credentials the server carries). */
    unsetEnv?: string[];
  }): Promise<void> {
    // Per-session variables: the tmux server's global environment is whatever the first
    // session's call had, so the ones that differ per session are set on the session itself.
    const sessionEnv: Record<string, string> = {};
    for (const key of PER_SESSION_ENV) {
      if (options.env[key]) sessionEnv[key] = options.env[key];
    }
    sessionEnv.COLORTERM ??= 'truecolor';
    // tmux gives a new session the PATH of the client that made it, whatever `-e` says: this
    // session's own PATH (pathPrependEnv) goes in through env, which execs the program (2026-11-02).
    const { PATH: ownPath, ...ownRest } = options.ownEnv ?? {};
    Object.assign(sessionEnv, ownRest);
    let command = ownPath
      ? ['/usr/bin/env', `PATH=${ownPath}`, ...options.command]
      : options.command;
    // A provider session's variables (and the credentials it drops) are the session's, never the
    // server's: the server starts and the new-session runs with them stripped out, and the
    // program alone gets them through a 0600 file it sources and deletes (no key on argv).
    const override = options.overrideEnv ?? {};
    const unset = options.unsetEnv ?? [];
    const serverEnv = { ...options.env };
    for (const key of Object.keys(override)) delete serverEnv[key];
    let envFilePath: string | undefined;
    let verifyFilePath: string | undefined;
    const content = shieldEnvFileContent(override, unset);
    if (content) {
      const base = path.join(this.controlPath, shieldTmuxName(options.sessionId));
      envFilePath = `${base}.env`;
      verifyFilePath = `${base}.verify`;
      // The env file ends with this session's nonce, so the preflight can tell it sourced cleanly
      // and reached its last line (every assignment before it took effect) from a swallowed or
      // half-applied environment, whatever the variables' own values are (an empty one is valid).
      const nonce = crypto.randomBytes(12).toString('hex');
      fs.writeFileSync(envFilePath, content + shieldAppliedLine(nonce), { mode: 0o600 });
      fs.chmodSync(envFilePath, 0o600);
      // The preflight checks the effective environment the program will run with and refuses to
      // start the agent on a wrong one (the file did not apply, a dropped credential lingers): on
      // macOS a process's environment cannot be read from outside, so the check runs inside it and
      // reports through the verify file (2026-11-08).
      command = shieldPreflightCommand(envFilePath, verifyFilePath, nonce, unset, command);
    }
    const dropEnvFile = () => {
      for (const file of [envFilePath, verifyFilePath]) {
        if (!file) continue;
        try {
          fs.unlinkSync(file);
        } catch {
          // Already gone.
        }
      }
    };
    // What an earlier program of this id left (it ended while no server ran) is not this one's.
    const exitFile = shieldExitFile(this.controlPath, options.sessionId);
    fs.rmSync(exitFile, { force: true });
    try {
      if (this.useLaunchd) {
        this.launchdStart ??= this.startServerWithLaunchd(serverEnv).finally(() => {
          this.launchdStart = null;
        });
        await this.launchdStart;
      }
      // A server started before its environment was cleaned still hands it to new sessions.
      await this.cleanGlobalEnvironment();
      const args = chainTmuxCommands([
        // A no-op when the server runs (launchd started it); otherwise it starts here.
        ['start-server'],
        ...SHIELD_SERVER_OPTIONS,
        newSessionArgs({ ...options, command, sessionEnv }),
        ...shieldExitCommands(options.sessionId, exitFile),
        ...(shieldScrollsTmuxHistory(options.command)
          ? [['set-option', '-t', `=${shieldTmuxName(options.sessionId)}:`, 'mouse', 'on']]
          : []),
      ]);
      // 2026-11-03: a session that ended just before (the server's last one, so tmux exits) let
      // this client reach a server on its way out: "server exited unexpectedly", the program
      // never started and the create answered 500. Asked again, it starts a fresh server.
      await this.retryWhileServerExits(() => this.run(args, serverEnv));
    } catch (error) {
      // The program never started, so it will not read and remove the file: drop it here.
      dropEnvFile();
      throw error;
    }
    // Wait for the preflight's verdict on the effective environment and fail closed: a wrong one,
    // or none at all, fails loudly here (the task is not started and its prompt is never typed)
    // instead of running on the user's own Anthropic login.
    if (verifyFilePath) {
      const verdict = await awaitShieldVerify(verifyFilePath, this.verifyTimeoutMs);
      dropEnvFile();
      if (!verdict.ok) {
        await this.kill(options.sessionId).catch(() => {});
        throw new Error(
          `shielded session ${options.sessionId}: its environment did not take effect (${verdict.problem}); not starting the agent on the user's Anthropic login`
        );
      }
    }
    logger.log(`shielded tmux session ${shieldTmuxName(options.sessionId)} started`);
  }

  /** Leaves copy mode (shieldScrollsTmuxHistory) so what is typed next reaches the program. */
  async leaveCopyMode(sessionId: string): Promise<void> {
    const target = `=${shieldTmuxName(sessionId)}:`;
    await this.run([
      'if-shell',
      '-F',
      '-t',
      target,
      '#{pane_in_mode}',
      `send-keys -X -t ${target} cancel`,
    ]);
  }

  /**
   * Run `call` again while the shield server answers that it is exiting (isShieldServerExiting):
   * the next client finds no server (or a new one) and gets a real answer.
   */
  private async retryWhileServerExits<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (!isShieldServerExiting(error) || attempt >= SERVER_EXIT_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, SERVER_EXIT_RETRY_MS));
      }
    }
  }

  /**
   * Remove the server's runtime variables (NODE_ENV, npm_*, ...) from the shield tmux server's
   * global environment, which every new session starts with. 2026-10-24: a server started by
   * `pnpm dev` kept NODE_ENV=development there for 12 days and every task's Claude got it.
   * Sessions get a clean environment anyway (terminalSessionEnv); this heals a server that
   * runs from before, without ending its sessions. Answers the names removed (none when no
   * server runs).
   */
  async cleanGlobalEnvironment(): Promise<string[]> {
    if (!this.tmuxBin) return [];
    let leaked: string[];
    try {
      leaked = runtimeVarsInEnvironment(await this.run(['show-environment', '-g']));
    } catch {
      return [];
    }
    if (!leaked.length) return [];
    await this.run(chainTmuxCommands(leaked.map((name) => ['set-environment', '-g', '-u', name])));
    logger.warn(`shield tmux server carried ${leaked.join(', ')}; removed from its environment`);
    return leaked;
  }

  /** Whether the shield tmux server answers on its socket (it never starts one). */
  private async serverUp(): Promise<boolean> {
    try {
      await this.run(['show-options', '-s', 'escape-time']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether the running shield tmux server answers a client of `bin` (null: no server runs).
   * Before the stable tmux copy moves to a new tmux version (stable-tmux.ts) it checks the new
   * client still speaks the running server's protocol.
   */
  async answersWith(bin: string): Promise<boolean | null> {
    if (!(await this.serverUp())) return null;
    try {
      await execFileAsync(
        bin,
        [...shieldSocketArgs(this.controlPath), 'show-options', '-s', 'escape-time'],
        { env: tmuxEnv(process.env), timeout: 10_000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Executable path of the running shield tmux server (null: none runs or unreadable). */
  async serverBinary(): Promise<string | null> {
    try {
      const pid = Number.parseInt((await this.run(['display-message', '-p', '#{pid}'])).trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      const { stdout } = await execFileAsync('ps', ['-o', 'comm=', '-p', String(pid)], {
        timeout: 5_000,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Executables of every tmux server process on this control dir's shield socket (null: `ps`
   * could not be read). More than the one answering the socket (2026-10-31: after the stable
   * tmux copy was turned on, servers started with Homebrew's tmux kept running; one whose
   * socket file was replaced still holds sessions): found by the socket in their arguments,
   * parented to launchd (a server, not an attached client).
   */
  async serverBinaries(): Promise<string[] | null> {
    try {
      const { stdout: listed } = await execFileAsync('ps', ['-axww', '-o', 'pid=,ppid=,args='], {
        timeout: 5_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const pids = shieldServerPids(listed, shieldSocketArgs(this.controlPath));
      if (!pids.length) return [];
      const { stdout } = await execFileAsync('ps', ['-o', 'pid=,comm=', '-p', pids.join(',')], {
        timeout: 5_000,
      }).catch(() => ({ stdout: '' }));
      const binaries: string[] = [];
      for (const line of stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (match) binaries.push(match[2]);
      }
      return binaries;
    } catch {
      return null;
    }
  }

  /**
   * Whether the running shield tmux server has macOS Full Disk Access: a job it runs itself
   * (`run-shell`, so macOS holds the server responsible, as for every shielded session) lists
   * one of the user's protected folders (Mail, Messages, Safari), which only Full Disk Access
   * allows. Reading never asks the user anything. Only meaningful when launchd started the
   * server (its own responsible process); 'no-server' when none runs, 'unknown' when it
   * couldn't be told (none of those folders exists on this Mac).
   *
   * 2026-11-08: it used to read the TCC database, which macOS 27 no longer lets even Full Disk
   * Access read: the doctor said «denied» on a tmux that had the grant (checked: the signed
   * copy lists ~/Library/Mail, a tmux without the grant does not).
   */
  async fullDiskAccess(
    home: string = os.homedir()
  ): Promise<'granted' | 'denied' | 'no-server' | 'unknown'> {
    if (!this.tmuxBin) return 'no-server';
    if (!(await this.serverUp())) return 'no-server';
    const library = path.join(home, 'Library');
    const quoted = `'${library.replace(/'/g, `'\\''`)}'`;
    try {
      const out = await this.run([
        'run-shell',
        `seen=; for d in Mail Messages Safari; do p=${quoted}/$d; ` +
          `if /bin/ls "$p" >/dev/null 2>&1; then echo granted; exit 0; fi; ` +
          `[ -e "$p" ] && seen=1; done; if [ -n "$seen" ]; then echo denied; else echo unknown; fi`,
      ]);
      const answer = out.trim().split('\n').pop();
      return answer === 'granted' || answer === 'denied' ? answer : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * macOS: when no shield tmux server runs, start it as its own launchd job in the user's GUI
   * domain (own coalition: it outlives the app; GUI session: keychain access for Claude).
   * False when that didn't work; create() then starts it the old way. A server already
   * running (an older one started without launchd) is used as it is.
   */
  private async startServerWithLaunchd(env: Record<string, string>): Promise<boolean> {
    const tmuxBin = this.tmuxBin;
    const uid = process.getuid?.();
    if (!tmuxBin || uid === undefined) return false;
    if (await this.serverUp()) return true;
    const label = shieldLaunchdLabel(this.controlPath);
    const domain = `gui/${uid}`;
    const plistPath = path.join(this.controlPath, '.shield-tmux.plist');
    try {
      const loaded = await execFileAsync('launchctl', ['print', `${domain}/${label}`]).then(
        ({ stdout }) => stdout,
        () => null
      );
      if (loaded !== null) {
        if (/^\tstate = running$/m.test(loaded)) {
          logger.warn(`launchd job ${label} runs but its tmux socket doesn't answer`);
          return false;
        }
        // Loaded but its tmux ended: unload it so the new plist (environment) is used.
        await execFileAsync('launchctl', ['bootout', `${domain}/${label}`]).catch(() => {});
      }
      fs.writeFileSync(
        plistPath,
        shieldLaunchdPlist({
          label,
          programArguments: [tmuxBin, ...shieldSocketArgs(this.controlPath), '-D'],
          env: tmuxEnv(env),
          workingDirectory: env.HOME || os.homedir(),
        }),
        { mode: 0o600 }
      );
      fs.chmodSync(plistPath, 0o600);
      await execFileAsync('launchctl', ['bootstrap', domain, plistPath], { timeout: 10_000 });
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await this.serverUp()) {
          logger.log(`shield tmux server started by launchd (${label})`);
          return true;
        }
        // With the screen locked launchd may not run RunAtLoad on its own; an explicit
        // kickstart does (see the watchdog incident of 2026-09-09).
        if (attempt === 10) {
          await execFileAsync('launchctl', ['kickstart', `${domain}/${label}`]).catch(() => {});
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      logger.error(`launchd job ${label} started but its tmux socket never answered`);
      return false;
    } catch (error) {
      logger.warn(
        `could not start the shield tmux server with launchd (${label}): ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Whether the tmux session of `sessionId` is alive ('alive'), certainly gone ('gone': tmux
   * said there is no such session, or no server runs on the socket), or could not be told
   * ('unknown': a timeout, a protocol mismatch after a tmux upgrade, any other error).
   */
  async probe(sessionId: string): Promise<ShieldProbe> {
    if (!this.tmuxBin) return 'gone';
    try {
      // 2026-11-03: asked right after the kill of the server's last session, tmux was still
      // exiting and said "server exited unexpectedly": read as unknown, the give-up path left
      // the session running with no client for 5 minutes. Asked again, it says gone.
      await this.retryWhileServerExits(() =>
        this.run(['has-session', '-t', `=${shieldTmuxName(sessionId)}`])
      );
      return 'alive';
    } catch (error) {
      return classifyHasSessionError(error);
    }
  }

  /**
   * Whether the tmux session of `sessionId` is still alive. An answer that could not be told
   * is asked again a few times and then counts as alive.
   *
   * 2026-10-20: any error (a 10 s timeout under load, "protocol version mismatch" after a tmux
   * upgrade) read as "gone": the session was recorded as ended by its program while Claude kept
   * running in tmux, and "Resume Claude" started a second writer of the same conversation.
   */
  async has(sessionId: string, options: { retries?: number; retryDelayMs?: number } = {}) {
    const retries = options.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const state = await this.probe(sessionId);
      if (state !== 'unknown') return state === 'alive';
      if (attempt >= retries) {
        logger.warn(`could not tell whether tmux session of ${sessionId} lives; treating as alive`);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 500));
    }
  }

  /** pid of the program in the session's pane (the user's shell or Claude). */
  async panePid(sessionId: string): Promise<number | null> {
    try {
      const out = await this.run([
        'display-message',
        '-p',
        '-t',
        `=${shieldTmuxName(sessionId)}:`,
        '#{pane_pid}',
      ]);
      const pid = Number.parseInt(out.trim(), 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  /**
   * Pane pid of each of `sessionIds` from one `list-panes` of the shield server (the active
   * pane of the active window, which `panePid` asks for); asked one by one if that call fails.
   */
  async panePids(sessionIds: string[]): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    let out: string;
    try {
      out = await this.run([
        'list-panes',
        '-a',
        '-F',
        '#{session_name} #{window_active}#{pane_active} #{pane_pid}',
      ]);
    } catch {
      await Promise.all(
        sessionIds.map(async (sessionId) => result.set(sessionId, await this.panePid(sessionId)))
      );
      return result;
    }
    const active = new Map<string, number>();
    for (const line of out.split('\n')) {
      const match = /^(\S+) 11 (\d+)$/.exec(line.trim());
      if (match) active.set(match[1], Number(match[2]));
    }
    for (const sessionId of sessionIds) {
      result.set(sessionId, active.get(shieldTmuxName(sessionId)) ?? null);
    }
    return result;
  }

  /** Current window size, so a re-attached client starts at the size the program has. */
  async windowSize(sessionId: string): Promise<{ cols: number; rows: number } | null> {
    try {
      const out = await this.run([
        'display-message',
        '-p',
        '-t',
        `=${shieldTmuxName(sessionId)}:`,
        '#{window_width} #{window_height}',
      ]);
      const [cols, rows] = out.trim().split(' ').map(Number);
      return cols > 0 && rows > 0 ? { cols, rows } : null;
    } catch {
      return null;
    }
  }

  /** End the session and its program (SIGHUP to the pane, like closing a terminal). */
  async kill(sessionId: string): Promise<void> {
    if (!this.tmuxBin) return;
    try {
      await this.run(['kill-session', '-t', `=${shieldTmuxName(sessionId)}`]);
    } catch {
      // Already gone.
    }
    // A killed session records no exit; what an earlier end left goes with it.
    fs.rmSync(shieldExitFile(this.controlPath, sessionId), { force: true });
  }

  /**
   * How the session's program ended, read once from its exit file (SHIELD_EXIT_HOOK): its exit
   * code or the signal that ended it. null when nothing was written: the session was killed
   * (kill-session fires no pane-died), its tmux server went away, or it was started before
   * 2026-11-10 and has no hook.
   */
  takeExit(sessionId: string): { exitCode?: number; signal?: number } | null {
    const exitFile = shieldExitFile(this.controlPath, sessionId);
    let text: string;
    try {
      text = fs.readFileSync(exitFile, 'utf8');
    } catch {
      return null;
    }
    fs.rmSync(exitFile, { force: true });
    return parseShieldExit(text);
  }

  /** Command + args for the PTY: a tmux client attached to the session. */
  attachCommand(sessionId: string): { command: string; args: string[] } {
    return {
      command: this.bin(),
      args: [
        ...shieldSocketArgs(this.controlPath),
        'attach-session',
        '-t',
        `=${shieldTmuxName(sessionId)}`,
      ],
    };
  }
}

export type ShieldProbe = 'alive' | 'gone' | 'unknown';

/** How often, and how far apart, a call is made again while the shield server exits. */
const SERVER_EXIT_RETRIES = 10;
const SERVER_EXIT_RETRY_MS = 100;

/**
 * Whether a failed tmux call reached a server that was exiting (its last session had just
 * ended): it closed the connection ("server exited unexpectedly", "lost server") or had no
 * session left to answer for ("no current target"). It says nothing about the call itself;
 * asked again, the next client finds no server, or a new one. A server that is merely slow or
 * speaks another protocol answers differently (a timeout, "protocol version mismatch").
 */
export function isShieldServerExiting(error: unknown): boolean {
  const failure = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown };
  if (failure?.killed || failure?.signal || failure?.code !== 1) return false;
  const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
  return /server exited unexpectedly|lost server|no current target/i.test(stderr);
}

/**
 * What a failed `tmux has-session` means. tmux exits 1 and says "can't find session" when the
 * session is gone, "no current target" when the server has no session left, and "no server
 * running" / "error connecting to <socket> (No such file or directory | Connection refused)"
 * when nothing listens on the socket. Anything else (killed
 * by the timeout, a protocol mismatch, EAGAIN…) says nothing about the session.
 */
export function classifyHasSessionError(error: unknown): ShieldProbe {
  const failure = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown };
  if (failure?.killed || failure?.signal) return 'unknown';
  const stderr = typeof failure?.stderr === 'string' ? failure.stderr : '';
  if (
    failure?.code === 1 &&
    /can't find session|session not found|no server running|no current target|error connecting to .*\((No such file or directory|Connection refused)\)/i.test(
      stderr
    )
  ) {
    return 'gone';
  }
  return 'unknown';
}

export type ShieldStartupAction = 'reattach' | 'restore' | 'give-up' | 'mark-exited' | 'ignore';

/** At most this many automatic restores of one session per hour (a command that dies at once). */
export const SHIELD_RESTORE_LIMIT = 3;
export const SHIELD_RESTORE_WINDOW_MS = 60 * 60 * 1000;

/** Restores of a session within the loop-guard window. */
export function recentShieldRestores(
  info: Pick<SessionInfo, 'shieldRestores'>,
  now = Date.now()
): number[] {
  return (info.shieldRestores ?? []).filter(
    (t) => typeof t === 'number' && now - t < SHIELD_RESTORE_WINDOW_MS && t <= now
  );
}

/**
 * What a server start does with a session from disk. Shielded sessions whose tmux session is
 * alive are attached again whatever their recorded status (a dying server may have recorded
 * "exited" when its attach client got SIGHUP). When the tmux session is gone, a session that
 * was still running (the Mac rebooted, tmux was killed) is recreated under the same id, unless
 * it was restored too often in the last hour ('give-up'). Sessions the user killed, whose
 * program ended by itself, or that already exited for any other recorded reason stay finished.
 * Other sessions are left to the existing cleanup.
 */
export function shieldStartupAction(
  info: Pick<SessionInfo, 'shielded' | 'status' | 'shieldEnd' | 'shieldRestores'>,
  tmuxAlive: boolean,
  now = Date.now()
): ShieldStartupAction {
  if (!info.shielded) return 'ignore';
  if (tmuxAlive) return 'reattach';
  if (info.shieldEnd && info.shieldEnd !== 'tmux-lost') {
    return info.status === 'exited' ? 'ignore' : 'mark-exited';
  }
  if (info.status === 'exited' && info.shieldEnd !== 'tmux-lost') return 'ignore';
  if (recentShieldRestores(info, now).length >= SHIELD_RESTORE_LIMIT) return 'give-up';
  return 'restore';
}

/**
 * Why a shielded session's tmux client ended, from the last thing it printed: `[exited]` when
 * the tmux session ended (program exited or kill-session), `[server exited]` /
 * `[server exited unexpectedly]` / `[lost server]` when the tmux server itself went away.
 */
export function shieldClientEndReason(
  outputTail: string
): 'session-ended' | 'server-lost' | 'unknown' {
  if (/\[(server exited|lost server)/.test(outputTail)) return 'server-lost';
  if (outputTail.includes('[exited]')) return 'session-ended';
  return 'unknown';
}

/** A restored program that ends this soon counts as a failed restore, not a normal exit. */
export const SHIELD_RESTORE_GRACE_MS = 10_000;

/** Line written into the session history when a suspended session wakes (session-suspender.ts). */
export const SHIELD_RESUMED_BANNER =
  '\r\n\x1b[2m— Untether: sesión reanudada tras la pausa —\x1b[0m\r\n';

/** Line written into the session history when a lost session is recreated. */
export const SHIELD_RESTORED_BANNER =
  '\r\n\x1b[2m— Untether: sesión restaurada tras reinicio —\x1b[0m\r\n';

/** What a lost shielded session runs when it is recreated, and how. */
export interface ShieldRestorePlan {
  command: string[];
  kind:
    | 'claude-resume'
    | 'codex-resume'
    | 'same-command'
    | 'terminal-claude-resume'
    | 'terminal-claude-notice';
  /** Where to run it, when not the session's recorded folder. */
  cwd?: string;
  /** The provider the resumed Claude runs against. */
  modelProvider?: ProviderSessionMarker;
  /** The terminal's shell, to run once `command` ends. */
  thenShell?: string[];
  /** Written into the session history (no shell to print it). */
  banner?: string;
}

/**
 * What a lost shielded session runs when it is recreated: Claude resumes its conversation
 * (`claude --resume <id>`), Codex started directly resumes its thread (`codex resume <id>`)
 * when it is known, anything else (a shell, …) runs its original command again.
 * `codexThreadId`: the thread to use when the session recorded none (a rollout found for it).
 */
export function shieldRestorePlan(
  info: Pick<SessionInfo, 'command' | 'claudeSessionId' | 'codexThreadId' | 'terminalClaude'>,
  codexThreadId: string | null = info.codexThreadId ?? null
): ShieldRestorePlan {
  const command = info.command;
  const first = command[0] ?? '';
  const reopen = shieldReopenPlan({ ...info, codexThreadId: codexThreadId ?? undefined });
  if (reopen.resumes === 'claude') {
    // Keep the executable the session was started with (a boot-time PATH may lack it).
    const executable = first.split('/').pop() === 'claude' ? first : 'claude';
    return { command: [executable, ...reopen.command.slice(1)], kind: 'claude-resume' };
  }
  if (reopen.resumes === 'codex') return { command: reopen.command, kind: 'codex-resume' };
  if (info.terminalClaude) return terminalClaudePlan(command, info.terminalClaude);
  return { command, kind: 'same-command' };
}

/** A shell with options only: `zsh -l -i`, not `zsh ./script` or `zsh -c …`. */
function isPlainShell(command: string[]): boolean {
  const name = (command[0] ?? '').split('/').pop()?.replace(/^-/, '') ?? '';
  return (
    ['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh'].includes(name) &&
    command
      .slice(1)
      .every(
        (arg) => arg.startsWith('-') && !/^-[a-z]*c/i.test(arg) && !arg.startsWith('--command')
      )
  );
}

// Constant scripts: every value arrives as an argument, none is spliced into the shell text
// (no-shell-interpolation.test.ts).
const PRINT_THEN_EXEC = `printf '%s\\n' "$1"; shift; exec "$@"`;
/**
 * $1 is how many of the following words are the first command; the rest are the second. The
 * subshell rotates the words to keep only the first command's, as sh has no arrays.
 */
const RUN_THEN_EXEC =
  'n=$1; shift; (i=0; total=$#; while [ "$i" -lt "$total" ]; do ' +
  '[ "$i" -lt "$n" ] && set -- "$@" "$1"; shift; i=$((i+1)); done; exec "$@"); ' +
  'shift "$n"; exec "$@"';

/**
 * A terminal in which Claude was running when its tmux went away: Claude resumes its
 * conversation in the folder it ran in, and the shell is there again once Claude quits.
 * Resumed only if it would talk to the same backend (services/terminal-claude.ts).
 */
function terminalClaudePlan(command: string[], claude: TerminalClaude): ShieldRestorePlan {
  if (claude.customEnv.length > 0 && !claude.modelProvider) {
    return terminalClaudeNoticePlan(command, claude);
  }
  return {
    command: ['claude', '--resume', claude.conversationId, ...claude.flags],
    kind: 'terminal-claude-resume',
    cwd: claude.cwd,
    ...(claude.modelProvider ? { modelProvider: claude.modelProvider } : {}),
    ...(isPlainShell(command) ? { thenShell: command } : {}),
  };
}

/**
 * The terminal comes back without its Claude, which needs an environment Untether cannot
 * rebuild, and says how to pick the conversation up: never resumed on the wrong backend.
 */
export function terminalClaudeNoticePlan(
  command: string[],
  claude: TerminalClaude
): ShieldRestorePlan {
  const vars = claude.customEnv.length > 0 ? ` (${claude.customEnv.join(', ')})` : '';
  const notice =
    `Untether: aquí corría Claude, conversación ${claude.conversationId}, con un entorno propio${vars} ` +
    `que no se puede volver a crear sin guardar secretos. ` +
    `Para seguirla, lanza aquí tu comando habitual con --resume ${claude.conversationId}`;
  if (isPlainShell(command)) {
    return {
      command: ['/bin/sh', '-c', PRINT_THEN_EXEC, 'sh', notice, ...command],
      kind: 'terminal-claude-notice',
      cwd: claude.cwd,
    };
  }
  return {
    command,
    kind: 'terminal-claude-notice',
    cwd: claude.cwd,
    banner: `\r\n\x1b[2m${notice}\x1b[0m\r\n`,
  };
}

/** Runs `claude` (already resolved and with its hooks), then the terminal's own shell. */
export function keepShellAfterClaude(claude: string[], shell: string[]): string[] {
  return ['/bin/sh', '-c', RUN_THEN_EXEC, 'sh', String(claude.length), ...claude, ...shell];
}

/** Last size recorded in a cast file (resize events, else the header), for a recreated pane. */
export function lastCastSize(castPath: string): { cols: number; rows: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(castPath, 'r');
    const size = fs.fstatSync(fd).size;
    const headerBuf = Buffer.alloc(Math.min(size, 4096));
    fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
    let result: { cols: number; rows: number } | null = null;
    try {
      const header = JSON.parse(headerBuf.toString('utf8').split('\n')[0]);
      if (header.width > 0 && header.height > 0) {
        result = { cols: header.width, rows: header.height };
      }
    } catch {
      // No usable header.
    }
    const tailLength = Math.min(size, 512 * 1024);
    const tailBuf = Buffer.alloc(tailLength);
    fs.readSync(fd, tailBuf, 0, tailLength, size - tailLength);
    const resizes = [...tailBuf.toString('utf8').matchAll(/,\s*"r"\s*,\s*"(\d+)x(\d+)"\s*\]/g)];
    const last = resizes[resizes.length - 1];
    if (last) result = { cols: Number(last[1]), rows: Number(last[2]) };
    return result;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Claude flags that start another conversation or a one-off run: never carried. */
const CLAUDE_DROPPED = new Set(['-c', '--continue', '--fork-session', '-p', '--print']);
/** …the same, with a value of their own. */
const CLAUDE_DROPPED_VALUE = new Set([
  '--session-id',
  '--output-format',
  '--input-format',
  '--json-schema',
  '--max-turns',
  '--max-budget-usd',
]);
/** …with a value only when one follows (`-r` alone opens the picker). */
const CLAUDE_DROPPED_OPTIONAL = new Set(['-r', '--resume']);
/** Flags taking every following word that isn't a flag (commander variadic options). */
const CLAUDE_VARIADIC = new Set([
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--add-dir',
  '--mcp-config',
  '--betas',
  '--plugin-dir',
  '--file',
]);
/** Flags taking exactly one value. */
const CLAUDE_VALUE = new Set([
  '--model',
  '--fallback-model',
  '--permission-mode',
  '--effort',
  '--agent',
  '--agents',
  '--settings',
  '--setting-sources',
  '--append-system-prompt',
  '--system-prompt',
  '--append-system-prompt-file',
  '--system-prompt-file',
  '-n',
  '--name',
  '--debug-file',
  '--autocompact',
  '--permission-prompts',
  '--plugin-url',
  '--remote-control-session-name-prefix',
  '--system-prompt-snapshot',
  '--environment',
]);
/**
 * Claude's flags without a value (`claude --help`, 2026-10-20). Any other `--flag` followed by
 * a word not starting with "-" is taken as a flag and its value.
 */
const CLAUDE_BOOLEAN = new Set([
  '--allow-dangerously-skip-permissions',
  '--ax-screen-reader',
  '--bg',
  '--background',
  '--bare',
  '--brief',
  '--chrome',
  '--no-chrome',
  '--dangerously-skip-permissions',
  '--disable-slash-commands',
  '--exclude-dynamic-system-prompt-sections',
  '--forward-subagent-text',
  '-h',
  '--help',
  '--ide',
  '--include-hook-events',
  '--include-partial-messages',
  '--no-session-persistence',
  '--replay-user-messages',
  '--restricted',
  '--safe-mode',
  '--strict-mcp-config',
  '--verbose',
  '-v',
  '--version',
]);
/**
 * Flags whose value is optional (`--debug [filter]`): the next word may just as well be the
 * prompt, so it is never taken as their value (the old behaviour for every flag).
 */
const CLAUDE_OPTIONAL_VALUE = new Set([
  '-d',
  '--debug',
  '--cloud',
  '--from-pr',
  '--prompt-suggestions',
  '--remote-control',
  '--teleport',
  '-w',
  '--worktree',
  '--tmux',
  '--desktop',
]);

/**
 * The options of a Claude command line (args after the executable) a resume keeps: all but
 * those naming another conversation or a one-off run (--resume, --continue, --session-id,
 * --print…) and the positional prompt (typed once, never again). The argv is exact here (the
 * server started it), so values with spaces are kept as they are.
 *
 * 2026-10-20: Blindar and the restore after a reboot rebuilt `claude --resume <id>` with only
 * --dangerously-skip-permissions: orchestrators and tasks lost their --allowedTools
 * (`Bash(ut task …)`) and stopped at permission prompts; --model and --permission-mode too.
 */
export function carriedClaudeArgs(args: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break; // The rest is the prompt.
    if (!arg.startsWith('-')) continue; // A positional prompt.
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const takesNext = i + 1 < args.length && !args[i + 1].startsWith('-');
    if (CLAUDE_DROPPED.has(name)) continue;
    if (CLAUDE_DROPPED_VALUE.has(name)) {
      if (eq < 0) i++;
      continue;
    }
    if (CLAUDE_DROPPED_OPTIONAL.has(name)) {
      if (eq < 0 && takesNext) i++;
      continue;
    }
    kept.push(arg);
    if (eq > 0) continue;
    if (CLAUDE_VALUE.has(name)) {
      if (i + 1 < args.length) kept.push(args[++i]);
    } else if (CLAUDE_VARIADIC.has(name)) {
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) kept.push(args[++i]);
    } else if (
      takesNext &&
      name.startsWith('--') &&
      !CLAUDE_BOOLEAN.has(name) &&
      !CLAUDE_OPTIONAL_VALUE.has(name)
    ) {
      // 2026-10-20: a flag this list does not know (`--append-system-prompt-file X`, newer
      // Claude options) lost its value, which was dropped as if it were the prompt, and the
      // resumed Claude refused the bare flag. Unknown `--flag word` is kept as a pair.
      kept.push(args[++i]);
    }
  }
  return kept;
}

/** Whether a session's own command line says Claude (`claude …`, `zsh -c "claude …"`). */
export function commandNamesClaude(command: string[]): boolean {
  return /(^|[\s/])claude(\s|$)/.test(command.join(' '));
}

/** Index of the Claude executable in a command (`claude`, `/…/claude`, after `env`…), or -1. */
function claudeIndex(command: string[]): number {
  return command.findIndex((arg) => arg.split('/').pop() === 'claude');
}

/**
 * What "Blindar" starts for a session: its Claude conversation or its Codex thread resumed
 * (replacing the old session: two agents typing into one conversation would collide) or the
 * same command again. Codex only when the command starts it directly and its thread is known
 * (2026-11-10: Blindar on a Codex session opened a new, empty Codex next to it).
 */
export function shieldReopenPlan(
  session: Pick<Session, 'command' | 'claudeSessionId' | 'codexThreadId'>
): {
  command: string[];
  replacesOld: boolean;
  /** The agent whose conversation goes on in the new session. */
  resumes?: 'claude' | 'codex';
} {
  const commandLine = session.command.join(' ');
  if (session.claudeSessionId && commandNamesClaude(session.command)) {
    const at = claudeIndex(session.command);
    // `zsh -c "claude …"` and the like: only its flags can't be told apart, skip-permissions
    // is still carried as before.
    const carried =
      at >= 0
        ? carriedClaudeArgs(session.command.slice(at + 1))
        : commandLine.includes('--dangerously-skip-permissions')
          ? ['--dangerously-skip-permissions']
          : [];
    return {
      command: ['claude', '--resume', session.claudeSessionId, ...carried],
      replacesOld: true,
      resumes: 'claude',
    };
  }
  if (session.codexThreadId && startsCodex(session.command)) {
    return {
      command: codexResumeCommand(session.command, session.codexThreadId),
      replacesOld: true,
      resumes: 'codex',
    };
  }
  return { command: session.command, replacesOld: false };
}
