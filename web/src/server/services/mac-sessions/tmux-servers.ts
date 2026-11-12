/**
 * Mac Sessions: the user's own tmux servers, found again on every scan and listed with one
 * tmux call each (its panes, then its clients). Untether's shield servers, of this instance
 * or any other, are never listed.
 *
 * Where servers are found:
 * - the socket files in <realpath of TMUX_TMPDIR or /tmp>/tmux-<uid>: the default one and every
 *   `-L name`;
 * - the `-S`/`-L` arguments of each tmux server process (the user's, without a terminal);
 * - for a server process none of those reached: its socket exactly, from lsof on macOS or
 *   /proc on Linux. Deleted while its server kept running (/tmp cleaned), it gives
 *   `tmux-socket-missing`; present but not answering (a protocol mismatch after a tmux
 *   upgrade), `tmux-unreachable`.
 * A socket whose server is gone ("no server running", "Connection refused") is skipped for
 * 30 s, as long as it is the same file: a server started at that path since made a new one.
 * Each listing carries the server's pid (#{pid}), which ties it to the process table.
 * Each server also says whether an agent's tool started it (agent-made.ts): read once per server.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { MacSessionsWarning } from '../../../shared/mac-sessions.js';
import type { ProcessTable } from '../claude-chat.js';
import { parseUtcStart } from '../codex-process.js';
import { type ProcessEnv, readProcessEnvs } from '../terminal-claude.js';
import { isNoTmuxServer, TMUX_FIELD_SEPARATOR } from '../tmux-manager.js';
import { hasAgentToolMark } from './agent-made.js';
import {
  assertRealScanAllowed,
  isShieldSocket,
  isTmuxServerProcess,
  shieldSocketPath,
  tmuxSocketFromArgs,
} from './process-tree.js';
import { runMacTmux } from './tmux-run.js';

/** A socket whose server is gone is not asked again before this. */
export const STALE_SOCKET_MS = 30_000;

const PANE_FIELDS = [
  '#{pid}',
  '#{session_id}',
  '#{session_name}',
  '#{session_attached}',
  '#{session_created}',
  '#{session_activity}',
  '#{session_windows}',
  '#{window_id}',
  '#{window_index}',
  '#{window_active}',
  '#{window_width}',
  '#{window_height}',
  '#{window_name}',
  '#{pane_id}',
  '#{pane_index}',
  '#{pane_active}',
  '#{pane_pid}',
  '#{pane_dead}',
  '#{pane_current_command}',
  '#{pane_current_path}',
  '#{pane_title}',
];

const CLIENT_FIELDS = [
  '#{client_pid}',
  '#{client_tty}',
  '#{session_id}',
  '#{window_id}',
  '#{pane_id}',
  '#{pane_pid}',
  '#{pane_current_path}',
  '#{client_readonly}',
  '#{client_flags}',
  '#{client_width}',
  '#{client_height}',
  '#{client_activity}',
];

export const PANE_FORMAT = ['P', ...PANE_FIELDS].join(TMUX_FIELD_SEPARATOR);
export const CLIENT_FORMAT = ['C', ...CLIENT_FIELDS].join(TMUX_FIELD_SEPARATOR);

/** Every pane and every client of a server, in one tmux call. */
export const SERVER_LISTING_ARGS = [
  'list-panes',
  '-a',
  '-F',
  PANE_FORMAT,
  ';',
  'list-clients',
  '-F',
  CLIENT_FORMAT,
];

export interface TmuxPaneRow {
  /** The tmux server's pid (#{pid}). */
  serverPid: number;
  /** "$3" */
  sessionId: string;
  sessionName: string;
  /** Clients attached to the session. */
  sessionAttached: number;
  /** Epoch seconds. */
  sessionCreated: number;
  sessionActivity: number;
  sessionWindows: number;
  /** "@4" */
  windowId: string;
  windowIndex: number;
  /** The session's current window. */
  windowActive: boolean;
  windowWidth: number;
  windowHeight: number;
  windowName: string;
  /** "%7" */
  paneId: string;
  paneIndex: number;
  /** The active pane of its window. */
  paneActive: boolean;
  panePid: number;
  paneDead: boolean;
  command: string;
  path: string;
  title: string;
}

export interface TmuxClientRow {
  pid: number;
  /** "/dev/ttys004" */
  tty: string;
  /** The session, window and pane the client shows. */
  sessionId: string;
  windowId: string;
  paneId: string;
  panePid: number;
  path: string;
  readOnly: boolean;
  /** tmux's client flags: "attached", "focused", "ignore-size", "read-only"… */
  flags: string[];
  width: number;
  height: number;
  /** Epoch seconds. */
  activity: number;
}

export interface ServerListing {
  panes: TmuxPaneRow[];
  clients: TmuxClientRow[];
  /** Lines without the expected fields (a name or title holding the separator). */
  dropped: number;
}

const SESSION_ID = /^\$\d+$/;
const WINDOW_ID = /^@\d+$/;
const PANE_ID = /^%\d+$/;
// How shielded sessions are named: never shown, even on a server that isn't a shield's.
const SHIELD_SESSION_NAME = /^ut-[0-9a-f-]{36}$/;

const whole = (value: string) => (/^-?\d+$/.test(value) ? Number(value) : Number.NaN);
const flag = (value: string) => (value === '1' ? true : value === '0' ? false : undefined);

function paneRow(fields: string[]): TmuxPaneRow | null {
  const [pid, sessionId, sessionName, attached, created, activity, windows, windowId] = fields;
  const [windowIndex, windowActive, width, height, windowName, paneId, paneIndex] = fields.slice(8);
  const [paneActive, panePid, paneDead, command, panePath, title] = fields.slice(15);
  const row = {
    serverPid: whole(pid),
    sessionId,
    sessionName,
    sessionAttached: whole(attached),
    sessionCreated: whole(created),
    sessionActivity: whole(activity),
    sessionWindows: whole(windows),
    windowId,
    windowIndex: whole(windowIndex),
    windowActive: flag(windowActive),
    windowWidth: whole(width),
    windowHeight: whole(height),
    windowName,
    paneId,
    paneIndex: whole(paneIndex),
    paneActive: flag(paneActive),
    panePid: whole(panePid),
    paneDead: flag(paneDead),
    command,
    path: panePath,
    title,
  };
  const numbersOk = Object.values(row).every((value) => !Number.isNaN(value));
  if (
    !numbersOk ||
    row.windowActive === undefined ||
    row.paneActive === undefined ||
    row.paneDead === undefined ||
    !SESSION_ID.test(sessionId) ||
    !WINDOW_ID.test(windowId) ||
    !PANE_ID.test(paneId)
  ) {
    return null;
  }
  return row as TmuxPaneRow;
}

function clientRow(fields: string[]): TmuxClientRow | null {
  const [pid, tty, sessionId, windowId, paneId, panePid, clientPath, readOnly, flags] = fields;
  const [width, height, activity] = fields.slice(9);
  const row = {
    pid: whole(pid),
    tty,
    sessionId,
    windowId,
    paneId,
    panePid: whole(panePid),
    path: clientPath,
    readOnly: flag(readOnly),
    flags: flags ? flags.split(',') : [],
    width: whole(width),
    height: whole(height),
    activity: whole(activity),
  };
  if (
    [row.pid, row.panePid, row.width, row.height, row.activity].some(Number.isNaN) ||
    row.readOnly === undefined ||
    !SESSION_ID.test(sessionId) ||
    !WINDOW_ID.test(windowId) ||
    !PANE_ID.test(paneId)
  ) {
    return null;
  }
  return row as TmuxClientRow;
}

/**
 * The output of SERVER_LISTING_ARGS. A line with the wrong number of fields is dropped and
 * counted; sessions named like shielded ones (ut-<uuid>) are left out with their clients.
 */
export function parseServerListing(stdout: string): ServerListing {
  const panes: TmuxPaneRow[] = [];
  const clients: TmuxClientRow[] = [];
  const shieldSessions = new Set<string>();
  let dropped = 0;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [kind, ...fields] = line.split(TMUX_FIELD_SEPARATOR);
    if (kind === 'P' && fields.length === PANE_FIELDS.length) {
      const pane = paneRow(fields);
      if (!pane) dropped++;
      else if (SHIELD_SESSION_NAME.test(pane.sessionName)) shieldSessions.add(pane.sessionId);
      else panes.push(pane);
    } else if (kind === 'C' && fields.length === CLIENT_FIELDS.length) {
      const client = clientRow(fields);
      if (client) clients.push(client);
      else dropped++;
    } else {
      dropped++;
    }
  }
  return {
    panes,
    clients: clients.filter((client) => !shieldSessions.has(client.sessionId)),
    dropped,
  };
}

export interface TmuxServer {
  pid: number;
  /** Its start (ps lstart) in epoch seconds: a restarted server, or a reused pid, differs. */
  startSec: number;
  /** The socket it answered on (real path). */
  socketPath: string;
  /** Empty for the default socket, else the socket's name (`-L name`, or the file of `-S`). */
  label: string;
  isDefault: boolean;
  /** Its starting environment carries an agent tool's mark (agent-made.ts). */
  agentMarked: boolean;
  panes: TmuxPaneRow[];
  clients: TmuxClientRow[];
}

/** A user tmux server that runs but can't be listed: its agents are shown on their own. */
export interface UnlistedTmuxServer {
  pid: number;
  startSec: number;
  /** Where it listened, from lsof or /proc (maybe deleted since). */
  socketPath: string;
  label: string;
  isDefault: boolean;
  agentMarked: boolean;
  problem: 'tmux-socket-missing' | 'tmux-unreachable';
}

export interface TmuxDiscovery {
  servers: TmuxServer[];
  unlisted: UnlistedTmuxServer[];
  /** The socket of every tmux server process found (shields too), by pid: classifyProcess. */
  sockets: Map<number, string>;
  warnings: MacSessionsWarning[];
}

export interface TmuxDiscoveryDeps {
  uid: number;
  /** <realpath of TMUX_TMPDIR or /tmp>/tmux-<uid> (tmuxSocketDir). */
  socketDir: string;
  /** This server's own shield socket (shieldSocketPath). */
  ownShieldSocket?: string | null;
  /** The socket files in a directory (full paths); none when it can't be read. */
  listSockets(dir: string): Promise<string[]>;
  /** A path with its links resolved; null when it doesn't exist. */
  realpath(file: string): Promise<string | null>;
  /** Which file a socket path is now (socketFileId); null when that can't be told. */
  socketId(file: string): Promise<string | null>;
  /** runMacTmux. */
  runTmux(socketPath: string, args: string[]): Promise<string>;
  /** The unix socket paths each process has open (lsof, /proc). */
  socketsOf(pids: number[]): Promise<Map<number, string[]>>;
  /** The environment each process started with; missing: it could not be read. */
  startingEnvs(pids: number[], table: ProcessTable): Promise<Map<number, ProcessEnv>>;
  now(): number;
}

type ListingResult =
  | { socket: string; listing: ServerListing }
  | { socket: string; stale: boolean; detail: string; id: string | null };

function firstLine(error: unknown): string {
  const text = String((error as { stderr?: string })?.stderr || (error as Error)?.message || '');
  return text.trim().split('\n')[0] ?? '';
}

/** Finds and lists the user's tmux servers; it remembers sockets whose server is gone. */
export class TmuxServerFinder {
  /** Sockets whose server was gone: which file each was, and until when it is skipped. */
  private readonly stale = new Map<string, { id: string; until: number }>();
  /** `${pid}:${start}` of each server → its mark: a process's starting environment is fixed. */
  private marks = new Map<string, boolean>();

  constructor(private readonly deps: TmuxDiscoveryDeps) {}

  private isUserServer(table: ProcessTable, pid: number): boolean {
    const info = table.procs.get(pid);
    return (
      !!info &&
      info.uid === this.deps.uid &&
      !info.stat.startsWith('Z') &&
      isTmuxServerProcess(table, pid)
    );
  }

  private isShield(socket: string): boolean {
    return isShieldSocket(socket, this.deps.ownShieldSocket);
  }

  /**
   * A socket is skipped while it is the file whose server was gone: tmux removes a dead socket
   * before it starts a new server at that path, so a new server's socket is a new file.
   */
  private isStale(socket: string, id: string | null, now: number): boolean {
    const mark = this.stale.get(socket);
    return !!mark && mark.until > now && mark.id === id;
  }

  /** `id`: the file the socket was before listing it (a server can start right after). */
  private async list(socket: string, id: string | null): Promise<ListingResult> {
    try {
      return {
        socket,
        listing: parseServerListing(await this.deps.runTmux(socket, SERVER_LISTING_ARGS)),
      };
    } catch (error) {
      return { socket, stale: isNoTmuxServer(error), detail: firstLine(error), id };
    }
  }

  private labelOf(socketPath: string): { label: string; isDefault: boolean } {
    const name = path.basename(socketPath);
    const isDefault = path.dirname(socketPath) === this.deps.socketDir && name === 'default';
    return { label: isDefault ? '' : name, isDefault };
  }

  /** The server behind a listing, when its pid is a tmux server in the table. */
  private serverOf(table: ProcessTable, socket: string, listing: ServerListing): TmuxServer | null {
    const pid = listing.panes[0]?.serverPid;
    if (pid === undefined || !isTmuxServerProcess(table, pid)) return null;
    // Started after the table was read: it gets its stable ids on the next scan.
    const startedAt = parseUtcStart(table.starts.get(pid));
    if (startedAt === undefined) return null;
    return {
      pid,
      startSec: Math.floor(startedAt / 1000),
      socketPath: socket,
      ...this.labelOf(socket),
      agentMarked: false,
      panes: listing.panes,
      clients: listing.clients,
    };
  }

  /** Sets agentMarked on each server. Rejects when an environment could not be asked for. */
  private async readMarks(
    table: ProcessTable,
    servers: Array<Pick<TmuxServer, 'pid' | 'startSec' | 'agentMarked'>>
  ): Promise<void> {
    const keyOf = (server: { pid: number; startSec: number }) => `${server.pid}:${server.startSec}`;
    const unknown = servers.filter((server) => !this.marks.has(keyOf(server)));
    const envs = await this.deps.startingEnvs(
      unknown.map((server) => server.pid),
      table
    );
    const marks = new Map<string, boolean>();
    for (const server of servers) {
      const key = keyOf(server);
      const env = envs.get(server.pid);
      const known = this.marks.get(key) ?? (env ? hasAgentToolMark(env) : undefined);
      // Unread stays unknown: it is asked for again on the next scan, and the server is shown.
      if (known !== undefined) marks.set(key, known);
      server.agentMarked = known === true;
    }
    this.marks = marks;
  }

  async discover(table: ProcessTable): Promise<TmuxDiscovery> {
    const { deps } = this;
    const now = deps.now();
    const warnings: MacSessionsWarning[] = [];
    const sockets = new Map<number, string>();
    // Without the extended ps columns a server can't be told from its clients: only the
    // socket directory and the arguments are used then.
    const serverPids = table.extended
      ? [...table.args.keys()].filter((pid) => this.isUserServer(table, pid))
      : [...table.args.keys()].filter((pid) => isTmuxServerProcess(table, pid));

    const candidates = new Set(await deps.listSockets(deps.socketDir));
    for (const pid of serverPids) {
      const socket = tmuxSocketFromArgs(table.args.get(pid) ?? '', deps.socketDir);
      if (socket) candidates.add(socket);
    }
    /** Each socket to list (real path), and which file it is. */
    const toList = new Map<string, string | null>();
    for (const candidate of candidates) {
      if (this.isShield(candidate)) continue;
      const real = await deps.realpath(candidate);
      if (!real || this.isShield(real) || toList.has(real)) continue;
      const id = await deps.socketId(real);
      if (!this.isStale(real, id, now)) toList.set(real, id);
    }

    const servers: TmuxServer[] = [];
    /** Each socket that answered, and the server that did (null: it has no sessions). */
    const answered = new Map<string, number | null>();
    const failed = new Map<string, string>();
    let dropped = 0;
    const take = (result: ListingResult) => {
      if (!('listing' in result)) {
        if (result.stale && result.id !== null) {
          this.stale.set(result.socket, { id: result.id, until: now + STALE_SOCKET_MS });
        }
        failed.set(result.socket, result.detail);
        return;
      }
      dropped += result.listing.dropped;
      const server = this.serverOf(table, result.socket, result.listing);
      answered.set(result.socket, result.listing.panes[0]?.serverPid ?? null);
      if (!server || servers.some((known) => known.pid === server.pid)) return;
      servers.push(server);
      sockets.set(server.pid, server.socketPath);
    };
    const results = await Promise.all([...toList].map(([socket, id]) => this.list(socket, id)));
    for (const result of results) take(result);

    const unlisted: UnlistedTmuxServer[] = [];
    const details = new Map<number, string>();
    let lookupFailed = false;
    if (table.extended) {
      const listed = new Set(servers.map((server) => server.pid));
      const lookup: number[] = [];
      for (const pid of serverPids) {
        if (listed.has(pid)) continue;
        const fromArgs = tmuxSocketFromArgs(table.args.get(pid) ?? '', deps.socketDir);
        // Shields name their socket: never looked into.
        if (fromArgs && this.isShield(fromArgs)) sockets.set(pid, fromArgs);
        else lookup.push(pid);
      }
      // Unknown is not "none": a failed lookup makes the scan partial instead of silent.
      const found =
        lookup.length > 0
          ? await deps.socketsOf(lookup).catch(() => {
              lookupFailed = true;
              return null;
            })
          : null;
      for (const pid of lookup) {
        const socket = found?.get(pid)?.[0];
        // Nothing tells where it listens: there is nothing to say about it.
        if (!socket) continue;
        sockets.set(pid, socket);
        if (this.isShield(socket)) continue;
        const startedAt = parseUtcStart(table.starts.get(pid));
        if (startedAt === undefined) continue;
        const startSec = Math.floor(startedAt / 1000);
        const real = await deps.realpath(socket);
        if (real && !answered.has(real) && !toList.has(real)) {
          // A socket outside the usual places (started with another TMUX_TMPDIR).
          const id = await deps.socketId(real);
          if (!this.isStale(real, id, now)) take(await this.list(real, id));
        }
        if (servers.some((server) => server.pid === pid)) continue;
        const answeredBy = real ? answered.get(real) : undefined;
        // It answered for this server, which has no sessions.
        if (real && answered.has(real) && (answeredBy === null || answeredBy === pid)) continue;
        // Deleted, or its path now belongs to another server.
        const problem = !real || answered.has(real) ? 'tmux-socket-missing' : 'tmux-unreachable';
        const detail = problem === 'tmux-unreachable' && real ? failed.get(real) : undefined;
        unlisted.push({
          pid,
          startSec,
          socketPath: socket,
          ...this.labelOf(socket),
          agentMarked: false,
          problem,
        });
        if (detail) details.set(pid, detail);
      }
    }
    // Unknown is not "none", here too: shown, and said to be partial.
    await this.readMarks(table, [...servers, ...unlisted]).catch(() => {
      lookupFailed = true;
    });
    // An agent's test server that can't be listed is not something for the user to look at.
    for (const { pid, startSec, problem, agentMarked } of unlisted) {
      if (agentMarked) continue;
      const detail = details.get(pid);
      warnings.push({ code: problem, ref: `${pid}-${startSec}`, ...(detail ? { detail } : {}) });
    }
    if (dropped > 0 || lookupFailed) warnings.push({ code: 'scan-partial', detail: 'tmux' });
    return { servers, unlisted, sockets, warnings };
  }
}

/** <realpath of TMUX_TMPDIR or /tmp>/tmux-<uid>: where tmux keeps the default and -L sockets. */
export function tmuxSocketDir(
  uid: number,
  env: Record<string, string | undefined> = process.env
): string {
  const base = env.TMUX_TMPDIR || '/tmp';
  let real = base;
  try {
    real = fs.realpathSync(base);
  } catch {
    // tmux would fail to make its socket there too
  }
  return path.join(real, `tmux-${uid}`);
}

/** The socket files in `dir` (readdir + lstat: a link is not a socket). */
export async function listSocketFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      try {
        return (await fs.promises.lstat(file)).isSocket() ? file : null;
      } catch {
        return null;
      }
    })
  );
  return files.filter((file): file is string => file !== null);
}

async function realPathOrNull(file: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(file);
  } catch {
    return null;
  }
}

/**
 * Which file a socket path is: its device and inode, and when it last changed. A server that
 * starts at a dead server's socket path removes it and makes a new one, which differs.
 */
export async function socketFileId(file: string): Promise<string | null> {
  try {
    const stat = await fs.promises.lstat(file);
    return `${stat.dev}:${stat.ino}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

/** `lsof -U -Fpn` output → pid → the unix socket paths it has open. */
export function parseLsofUnixSockets(output: string): Map<number, string[]> {
  const sockets = new Map<number, string[]>();
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n/') && pid > 0) {
      const list = sockets.get(pid) ?? [];
      if (!list.includes(line.slice(1))) list.push(line.slice(1));
      sockets.set(pid, list);
    }
  }
  return sockets;
}

/** /proc/net/unix → pid → socket paths, for the socket inodes each pid has open. */
export function parseProcNetUnix(
  text: string,
  inodes: ReadonlyMap<string, number>
): Map<number, string[]> {
  const sockets = new Map<number, string[]>();
  for (const line of text.split('\n').slice(1)) {
    // Num RefCount Protocol Flags Type St Inode Path
    const fields = line.trim().split(/\s+/);
    const pid = inodes.get(fields[6]);
    const socketPath = fields.slice(7).join(' ');
    if (pid === undefined || !socketPath.startsWith('/')) continue;
    const list = sockets.get(pid) ?? [];
    if (!list.includes(socketPath)) list.push(socketPath);
    sockets.set(pid, list);
  }
  return sockets;
}

/**
 * lsof's output. Exit status 1 still has output: lsof also uses it for "a pid I was asked about
 * is gone". Rejects when it could not run or timed out, so a slow lsof is a partial scan, not
 * "no sockets" (2026-10-31: under load 45 the 2 s lsof timed out, its '' read as "nothing
 * listens" and the tmux-socket-missing warning vanished without a word).
 */
function runLsof(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/sbin/lsof',
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (!error || error.code === 1) resolve(String(stdout));
        else reject(error);
      }
    );
  });
}

/** A first quick try, then one with room for a loaded machine. */
const LSOF_TIMEOUTS_MS = [2000, 10_000];

/** /proc/<pid>/environ: NAME=value entries, each ended by a NUL. */
export function parseProcEnviron(text: string): ProcessEnv {
  const env: ProcessEnv = new Map();
  for (const entry of text.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return env;
}

/** The environment each process started with: `ps -E` on macOS, /proc on Linux. */
export async function startingProcessEnvs(
  pids: number[],
  table: ProcessTable,
  platform: NodeJS.Platform = process.platform
): Promise<Map<number, ProcessEnv>> {
  if (pids.length === 0) return new Map();
  if (platform === 'darwin') return readProcessEnvs(pids, table);
  const envs = new Map<number, ProcessEnv>();
  if (platform !== 'linux') return envs;
  for (const pid of pids) {
    const text = await fs.promises.readFile(`/proc/${pid}/environ`, 'utf8').catch(() => null);
    if (text === null) continue;
    envs.set(pid, parseProcEnviron(text));
  }
  return envs;
}

async function procUnixSockets(pids: number[]): Promise<Map<number, string[]>> {
  const inodes = new Map<string, number>();
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = await fs.promises.readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      const link = await fs.promises.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
      if (inode) inodes.set(inode, pid);
    }
  }
  if (inodes.size === 0) return new Map();
  const text = await fs.promises.readFile('/proc/net/unix', 'utf8').catch(() => '');
  return parseProcNetUnix(text, inodes);
}

/** The unix socket paths each process has open: one lsof on macOS, /proc on Linux. */
export async function unixSocketsOf(
  pids: number[],
  platform: NodeJS.Platform = process.platform
): Promise<Map<number, string[]>> {
  if (pids.length === 0) return new Map();
  if (platform === 'linux') return procUnixSockets(pids);
  if (platform !== 'darwin') return new Map();
  const args = ['-a', '-p', pids.join(','), '-U', '-Fpn'];
  for (let attempt = 0; ; attempt++) {
    try {
      return parseLsofUnixSockets(await runLsof(args, LSOF_TIMEOUTS_MS[attempt]));
    } catch (error) {
      if (attempt + 1 >= LSOF_TIMEOUTS_MS.length) throw error;
    }
  }
}

export interface RealDiscoveryOptions {
  /** This server's control dir: its shield socket is never listed. */
  controlPath?: string;
  tmuxBin?: string | null;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

/** What the real discovery reads: this machine. Refused under vitest (assertRealScanAllowed). */
export function realTmuxDiscoveryDeps(options: RealDiscoveryOptions = {}): TmuxDiscoveryDeps {
  assertRealScanAllowed('tmux discovery');
  const env = options.env ?? process.env;
  const uid = process.getuid?.() ?? -1;
  const socketDir = tmuxSocketDir(uid, env);
  return {
    uid,
    socketDir,
    ownShieldSocket: options.controlPath ? shieldSocketPath(options.controlPath, socketDir) : null,
    listSockets: listSocketFiles,
    realpath: realPathOrNull,
    socketId: socketFileId,
    runTmux: (socket, args) => runMacTmux(socket, args, { tmuxBin: options.tmuxBin, env }),
    socketsOf: (pids) => unixSocketsOf(pids, options.platform),
    startingEnvs: (pids, table) => startingProcessEnvs(pids, table, options.platform),
    now: Date.now,
  };
}
