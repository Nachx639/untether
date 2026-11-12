/**
 * Mac Sessions: who a process on this computer belongs to. An agent or a tmux client is
 * Untether's, runs in a pane of one of the user's own tmux servers, or is the user's own in
 * some app's terminal ("mac"). classifyProcess walks up its parents, nearest first, and the
 * first marker found decides:
 * 1. this server;
 * 2. a running Untether session's pid;
 * 3. an Untether shield tmux server, of this instance or any other;
 * 4. a forwarder (`ut <command>`: untether-fwd, or `untether fwd`);
 * 5. any other tmux server of the user's: a tmux pane;
 * 6. nothing: the user's own, in the app found above it (Terminal, iTerm, Visual Studio Code,
 *    SSH…).
 * Only the shared `ps` table is read: walking up is cheap, and nothing here runs a command.
 */
import * as path from 'path';
import { type ProcessTable, processTable } from '../claude-chat.js';
import { shieldSocketArgs } from '../shielded-tmux.js';

/** Parents looked at, at most: deeper chains are cut, and cycles end the walk. */
export const MAX_ANCESTORS = 64;

/**
 * Tests must never list the developer's own tmux servers or agents: under vitest the real scan
 * refuses to run, and a test injects its own dependencies instead.
 */
export function assertRealScanAllowed(
  what: string,
  env: Record<string, string | undefined> = process.env
): void {
  if (env.VITEST) {
    throw new Error(`Mac Sessions: no real ${what} under vitest; inject its dependencies`);
  }
}

const parentMaps = new WeakMap<ProcessTable, Map<number, number>>();

function parentOf(table: ProcessTable, pid: number): number | undefined {
  const info = table.procs.get(pid);
  if (info) return info.ppid;
  // Without the extended columns, parents come from the children lists.
  let parents = parentMaps.get(table);
  if (!parents) {
    parents = new Map();
    for (const [ppid, children] of table.children) {
      for (const child of children) parents.set(child, ppid);
    }
    parentMaps.set(table, parents);
  }
  return parents.get(pid);
}

/**
 * The parents of `pid`, nearest first, without `pid` itself. The walk stops at launchd or init
 * (pid ≤ 1), at a pid it has seen (a table read while processes came and went), and after
 * MAX_ANCESTORS steps.
 */
export function ancestors(table: ProcessTable, pid: number): number[] {
  const chain: number[] = [];
  const seen = new Set([pid]);
  let current = pid;
  while (chain.length < MAX_ANCESTORS) {
    const parent = parentOf(table, current);
    if (parent === undefined || parent <= 1 || seen.has(parent)) break;
    chain.push(parent);
    seen.add(parent);
    current = parent;
  }
  return chain;
}

/** The process's terminal ("ttys007", "pts/3"), null without one or when `ps` didn't say. */
export function ttyName(table: ProcessTable, pid: number): string | null {
  return table.procs.get(pid)?.tty ?? null;
}

const base = (word: string | undefined) => (word ?? '').split('/').pop() ?? '';

/**
 * Whether a command line is the forwarder `ut <command>` runs: the native untether-fwd, or
 * `untether fwd` (also through node or bun).
 */
export function isForwarderArgs(args: string): boolean {
  const words = args.trim().split(/\s+/);
  let index = 0;
  if (/^(node\d*|bun)$/.test(base(words[0]))) {
    index = words.findIndex((word, i) => i > 0 && !word.startsWith('-'));
    if (index < 0) return false;
  }
  const program = base(words[index]);
  return program === 'untether-fwd' || (program === 'untether' && words[index + 1] === 'fwd');
}

// A tmux server keeps the arguments of the client that started it ("tmux -L work new -s x");
// on Linux it calls itself "tmux: server". It has no terminal; its clients always have one.
const TMUX_PROCESS = /^(\S*\/)?tmux(:\s+server)?(\s|$)/;
const LINUX_SERVER_TITLE = /^(\S*\/)?tmux:\s+server(\s|$)/;

/** Whether `pid` is a tmux server (a tmux process without a terminal). */
export function isTmuxServerProcess(table: ProcessTable, pid: number): boolean {
  const args = table.args.get(pid);
  if (!args || !TMUX_PROCESS.test(args)) return false;
  // Without the extended columns this can't be told; a client never has children anyway.
  return ttyName(table, pid) === null;
}

/** tmux's own options that take a value (`tmux -f conf -L work new`). */
const TMUX_OPTIONS_WITH_VALUE = new Set(['c', 'f', 'L', 'S', 'T']);

/**
 * The socket a tmux command line names: `-S path` (or `-Spath`), else `-L name` (or `-Lname`)
 * in `socketDir`, else the default one there. Null when that can't be told from the line: a
 * relative -S path (it depends on the folder tmux was started in), or Linux's "tmux: server".
 */
export function tmuxSocketFromArgs(args: string, socketDir: string): string | null {
  if (LINUX_SERVER_TITLE.test(args)) return null;
  const words = args.trim().split(/\s+/);
  let socketPath: string | undefined;
  let label: string | undefined;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    // The options end where tmux's command starts ("new-session", "attach"…).
    if (!word.startsWith('-') || word === '-' || word === '--') break;
    for (let j = 1; j < word.length; j++) {
      const option = word[j];
      if (!TMUX_OPTIONS_WITH_VALUE.has(option)) continue;
      const value = j + 1 < word.length ? word.slice(j + 1) : words[++i];
      if (option === 'S') socketPath = value;
      if (option === 'L') label = value;
      break;
    }
  }
  if (socketPath !== undefined) return path.isAbsolute(socketPath) ? socketPath : null;
  return path.join(socketDir, label || 'default');
}

const SHIELD_SOCKET_NAME = '.shield-tmux';
const SHIELD_LABEL = /^untether-[0-9a-f]{12}$/;

/** The socket of this server's own shield tmux server (`-L` names live in `socketDir`). */
export function shieldSocketPath(controlPath: string, socketDir: string): string {
  const [option, value] = shieldSocketArgs(controlPath);
  return option === '-S' ? value : path.join(socketDir, value);
}

/** Whether a tmux socket is this server's own shield's (shieldSocketPath). */
export function isOwnShieldSocket(socketPath: string, ownShieldSocket?: string | null): boolean {
  return !!ownShieldSocket && path.resolve(socketPath) === path.resolve(ownShieldSocket);
}

/**
 * Whether a tmux socket is an Untether shield server's, from any Untether instance:
 * `<control dir>/.shield-tmux`, `-L untether-<12 hex>` (used when that path is too long for
 * a socket), or this server's own.
 */
export function isShieldSocket(socketPath: string, ownShieldSocket?: string | null): boolean {
  const name = path.basename(socketPath);
  if (name === SHIELD_SOCKET_NAME || SHIELD_LABEL.test(name)) return true;
  return isOwnShieldSocket(socketPath, ownShieldSocket);
}

// The outermost app bundle an executable is in: VS Code's terminal runs under ".../Visual
// Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/...". A folder name never ends
// in a space, so "/bin/zsh /x/My.app/Contents/run" is not taken for an app.
const APP_BUNDLE = /^(\/(?:[^/]*[^/\s]\/)*?[^/]*\.app)\/Contents\//;
// iTerm2 runs its shells under ~/Library/Application Support/iTerm2/iTermServer-<version>.
const ITERM_SERVER = /(^|\/)iTermServer-[^\s/]*(\s|$)/;
// "sshd: me@ttys003", "sshd-session: me@pts/0", "/usr/sbin/sshd -D".
const SSHD = /^(\S*\/)?sshd(-session)?(:|\s|$)/;

/** The name an ancestor gives the app around the process, if it is one. */
function appOf(
  table: ProcessTable,
  pid: number,
  below: number,
  platform: NodeJS.Platform
): string | null {
  const args = table.args.get(pid) ?? '';
  if (platform === 'darwin') {
    const bundle = APP_BUNDLE.exec(args);
    if (bundle) return path.basename(bundle[1], '.app');
  }
  if (ITERM_SERVER.test(args)) return 'iTerm';
  if (SSHD.test(args)) return 'SSH';
  // Linux: the terminal emulator is the first process without a terminal above the ones in it.
  if (platform === 'linux' && ttyName(table, pid) === null && ttyName(table, below) !== null) {
    return base(args.split(/\s+/)[0]).replace(/:$/, '') || null;
  }
  return null;
}

/**
 * The app `pid` runs in, from its ancestors (not itself), nearest first: on macOS the outermost
 * app bundle ("Terminal", "Visual Studio Code"), iTerm's server, an SSH daemon ("SSH"), and on
 * Linux the first process without a terminal above ones with it ("gnome-terminal-server").
 * Untether's forwarders are skipped: they are never the app. Null when none matches.
 */
export function hostAppOf(
  table: ProcessTable,
  pid: number,
  platform: NodeJS.Platform = process.platform
): string | null {
  let below = pid;
  for (const ancestor of ancestors(table, pid)) {
    if (!isForwarderArgs(table.args.get(ancestor) ?? '')) {
      const app = appOf(table, ancestor, below, platform);
      if (app) return app;
    }
    below = ancestor;
  }
  return null;
}

export type ProcessOwner =
  | {
      owner: 'untether';
      by: 'server' | 'session' | 'shield' | 'forwarder';
      /** The Untether session the process is, or runs under (by: 'session'). */
      sessionId?: string;
      /** The shield's socket (by: 'shield'): this server's own, or another instance's. */
      socketPath?: string;
    }
  | {
      owner: 'tmux';
      serverPid: number;
      /** The pane's process: the ancestor just below the tmux server. */
      panePid: number;
      socketPath: string | null;
    }
  | { owner: 'mac'; app: string | null };

export interface OwnershipContext {
  /** This Untether server (process.pid). */
  serverPid: number;
  /** pid → id of each running Untether session. */
  sessionPids: ReadonlyMap<number, string>;
  /** Ids of the Untether sessions run by ut-fwd in a terminal window (isForwardedSession). */
  forwardedSessionIds?: ReadonlySet<string>;
  /** The user's uid: only their own tmux servers hold Mac sessions. */
  uid: number;
  /** Where `-L` sockets live: <realpath of TMUX_TMPDIR or /tmp>/tmux-<uid>. */
  socketDir: string;
  /** This server's shield socket (shieldSocketPath). */
  ownShieldSocket?: string | null;
  /** Sockets of tmux servers found by listing them or by lsof, by server pid. */
  tmuxSockets?: ReadonlyMap<number, string>;
  platform?: NodeJS.Platform;
}

function sameUser(table: ProcessTable, pid: number, uid: number): boolean {
  const info = table.procs.get(pid);
  return !info || info.uid === uid;
}

/**
 * A tmux server's socket: the one found for it (exact), else what its arguments name. Shield
 * servers always name theirs, so a shield is told apart even before anything was found.
 */
export function tmuxServerSocket(
  table: ProcessTable,
  pid: number,
  ctx: Pick<OwnershipContext, 'socketDir' | 'tmuxSockets'>
): string | null {
  return ctx.tmuxSockets?.get(pid) ?? tmuxSocketFromArgs(table.args.get(pid) ?? '', ctx.socketDir);
}

/** Who `pid` belongs to (see the top of this file). */
export function classifyProcess(
  table: ProcessTable,
  pid: number,
  ctx: OwnershipContext
): ProcessOwner {
  let below = pid;
  for (const current of [pid, ...ancestors(table, pid)]) {
    if (current === ctx.serverPid) return { owner: 'untether', by: 'server' };
    const sessionId = ctx.sessionPids.get(current);
    if (sessionId !== undefined) return { owner: 'untether', by: 'session', sessionId };
    if (
      current !== pid &&
      isTmuxServerProcess(table, current) &&
      sameUser(table, current, ctx.uid)
    ) {
      const socketPath = tmuxServerSocket(table, current, ctx);
      if (socketPath && isShieldSocket(socketPath, ctx.ownShieldSocket)) {
        return { owner: 'untether', by: 'shield', socketPath };
      }
      return { owner: 'tmux', serverPid: current, panePid: below, socketPath };
    }
    if (isForwarderArgs(table.args.get(current) ?? '')) {
      return { owner: 'untether', by: 'forwarder' };
    }
    below = current;
  }
  return { owner: 'mac', app: hostAppOf(table, pid, ctx.platform ?? process.platform) };
}

export interface HostAppOptions {
  /** The shared process table unless given (tests). */
  table?: () => Promise<ProcessTable>;
  platform?: NodeJS.Platform;
}

const hostApps = new Map<string, string | null>();
const MAX_HOST_APPS = 500;

/**
 * The app whose terminal window runs a session started with `ut <command>` there
 * (isForwardedSession): "Terminal", "iTerm", "Visual Studio Code", "SSH"…, or null when it
 * can't be told. `pid` is the session's program or its forwarder; the app is looked for above
 * the forwarder, as for agents outside Untether. A process's ancestors don't change, so the
 * answer is kept per process (pid and start time).
 */
export async function hostAppForPid(
  pid: number,
  options: HostAppOptions = {}
): Promise<string | null> {
  const table = await (options.table ?? processTable)();
  const start = table.starts.get(pid);
  if (start === undefined) return null;
  const key = `${pid}\0${start}`;
  const known = hostApps.get(key);
  if (known !== undefined) return known;
  const forwarder = [pid, ...ancestors(table, pid)].find((candidate) =>
    isForwarderArgs(table.args.get(candidate) ?? '')
  );
  const app = hostAppOf(table, forwarder ?? pid, options.platform ?? process.platform);
  hostApps.set(key, app);
  if (hostApps.size > MAX_HOST_APPS) hostApps.delete(hostApps.keys().next().value as string);
  return app;
}
