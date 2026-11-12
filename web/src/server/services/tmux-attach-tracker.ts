/**
 * A session opened from "On this Mac" runs a tmux client attached to a session on the user's own
 * tmux server. Its pid is that client, which has no children: the programs run in the server's
 * panes. The tracker maps each such session's client to the pane it shows right now, so status,
 * chat, pushes and quick answers look at the program there (PtyManager.programRootPid). It is
 * also how Untether changes its own client (control or watch, how it sizes the window,
 * detach), always found again by its pid in a fresh listing right before.
 *
 * While a session is tracked, the clients of each socket are listed every 2 s, one tmux call
 * per socket, through runMacTmux (reads, and changes to one client only).
 */
import type { MacOpenMode, MacSizing } from '../../shared/mac-sessions.js';
import { createLogger } from '../utils/logger.js';
import { every } from '../utils/periodic-loop.js';
import { runMacTmux } from './mac-sessions/tmux-run.js';
import { isNoTmuxServer, TMUX_FIELD_SEPARATOR } from './tmux-manager.js';

const logger = createLogger('tmux-attach');

const REFRESH_MS = 2_000;

/** One `list-clients` line per client; the pane fields are those of the pane it shows. */
export const TMUX_CLIENT_FORMAT = [
  'C',
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
].join(TMUX_FIELD_SEPARATOR);

/** Fields before the pane's path and after it: the path is the only free text. */
const HEAD_FIELDS = 7;
const TAIL_FIELDS = 5;

export interface TmuxClient {
  clientPid: number;
  tty: string;
  /** tmux ids of the session ("$3"), window ("@4") and pane ("%7") the client shows. */
  sessionId: string;
  windowId: string;
  paneId: string;
  /** The pane's program (its shell, or the agent itself); 0 when tmux gives none. */
  panePid: number;
  cwd: string;
  readOnly: boolean;
  /** client_flags: "attached", "ignore-size", "read-only"… */
  flags: string[];
  width: number;
  height: number;
  /** Last activity, epoch seconds. */
  activity: number;
}

/** A line of `list-clients -F TMUX_CLIENT_FORMAT`, or null for anything else. */
export function parseTmuxClientLine(line: string): TmuxClient | null {
  const parts = line.split(TMUX_FIELD_SEPARATOR);
  if (parts[0] !== 'C' || parts.length < HEAD_FIELDS + 1 + TAIL_FIELDS) return null;
  const [, pid, tty, sessionId, windowId, paneId, panePid] = parts;
  const [readOnly, flags, width, height, activity] = parts.slice(-TAIL_FIELDS);
  const clientPid = Number(pid);
  if (!Number.isInteger(clientPid) || clientPid <= 0 || !tty) return null;
  return {
    clientPid,
    tty,
    sessionId,
    windowId,
    paneId,
    panePid: Number(panePid) || 0,
    // A separator inside the path stays in it.
    cwd: parts.slice(HEAD_FIELDS, -TAIL_FIELDS).join(TMUX_FIELD_SEPARATOR),
    readOnly: readOnly === '1',
    flags: flags ? flags.split(',') : [],
    width: Number(width) || 0,
    height: Number(height) || 0,
    activity: Number(activity) || 0,
  };
}

export interface AttachedMode {
  mode: MacOpenMode;
  sizing: MacSizing;
}

/**
 * The mode tmux reports for a client: read-only is watch, and a client that ignores size
 * leaves the window to the other terminals.
 */
export function clientMode(client: Pick<TmuxClient, 'readOnly' | 'flags'>): AttachedMode {
  return {
    mode: client.readOnly ? 'watch' : 'control',
    sizing: client.flags.includes('ignore-size') ? 'others' : 'here',
  };
}

/** What a client ends up as for `target`: a read-only client always ignores size. */
function expectedMode(target: AttachedMode): AttachedMode {
  return target.mode === 'watch' ? { mode: 'watch', sizing: 'others' } : target;
}

/**
 * tmux commands that take a client from what `list-clients` shows to `target`. Only
 * `switch-client -r` clears read-only (`refresh-client -f '!read-only'` is ignored); it sets
 * or clears ignore-size along with read-only and keeps the client on its own session, so size
 * is set again afterwards. Its -E leaves the session's environment alone (update-environment).
 */
export function modeCommands(
  client: Pick<TmuxClient, 'tty' | 'sessionId' | 'readOnly' | 'flags'>,
  target: AttachedMode
): string[][] {
  const wanted = expectedMode(target);
  const commands: string[][] = [];
  let ignoresSize = client.flags.includes('ignore-size');
  if (client.readOnly !== (wanted.mode === 'watch')) {
    commands.push(['switch-client', '-E', '-c', client.tty, '-t', client.sessionId, '-r']);
    ignoresSize = wanted.mode === 'watch';
  }
  if (ignoresSize !== (wanted.sizing === 'others')) {
    const flag = wanted.sizing === 'others' ? 'ignore-size' : '!ignore-size';
    commands.push(['refresh-client', '-t', client.tty, '-f', flag]);
  }
  return commands;
}

export type TmuxAttachErrorCode = 'not-tracked' | 'client-not-found' | 'mode-failed';

export class TmuxAttachError extends Error {
  constructor(
    readonly code: TmuxAttachErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'TmuxAttachError';
  }
}

export interface TrackTarget {
  socketPath: string;
  /** The session's pid: its tmux client. */
  clientPid: number;
  /** The pane the session was opened on, used until the client is first listed. */
  seed?: { panePid: number; paneId: string };
}

/** Runs tmux on the server at `socketPath`, answering its output. */
export type TmuxRunner = (socketPath: string, args: string[]) => Promise<string>;

/** Told about each tracked client that tmux reports differently, its first listing included. */
export type TmuxClientListener = (
  sessionId: string,
  client: TmuxClient,
  previous: TmuxClient | undefined
) => void;

interface Tracked extends TrackTarget {
  client?: TmuxClient;
  /** Listed once at least: missing from a later listing, it detached or its server is gone. */
  seen: boolean;
}

const sameClient = (a: TmuxClient, b: TmuxClient) =>
  JSON.stringify({ ...a, activity: 0 }) === JSON.stringify({ ...b, activity: 0 });

export class TmuxAttachTracker {
  private readonly tracked = new Map<string, Tracked>();
  private readonly listeners = new Set<TmuxClientListener>();
  private readonly run: TmuxRunner;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(options: { run?: TmuxRunner; intervalMs?: number } = {}) {
    this.run = options.run ?? ((socketPath, args) => runMacTmux(socketPath, args));
    this.intervalMs = options.intervalMs ?? REFRESH_MS;
  }

  track(sessionId: string, target: TrackTarget): void {
    this.tracked.set(sessionId, { ...target, seen: false });
    if (!this.timer) {
      this.timer = every('tmux attach tracker', () => this.refresh(), this.intervalMs);
      this.timer.unref();
    }
  }

  untrack(sessionId: string): void {
    this.tracked.delete(sessionId);
    if (this.tracked.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isTracked(sessionId: string): boolean {
    return this.tracked.has(sessionId);
  }

  /** pid of the program in the pane the session's client shows, as last listed. */
  programPid(sessionId: string): number | undefined {
    const entry = this.tracked.get(sessionId);
    if (!entry) return undefined;
    if (!entry.seen) return entry.seed?.panePid;
    return entry.client?.panePid || undefined;
  }

  /** The session's client as last listed (undefined once it is gone). */
  client(sessionId: string): TmuxClient | undefined {
    return this.tracked.get(sessionId)?.client;
  }

  onChange(listener: TmuxClientListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Lists the clients of every tracked socket now; callers at the same time share one run. */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      const sockets = new Set([...this.tracked.values()].map((entry) => entry.socketPath));
      await Promise.all(
        [...sockets].map((socketPath) =>
          this.listSocket(socketPath).catch((error) => {
            // Kept as last listed: a slow or confused server is not a detached client.
            logger.debug(`cannot list the clients of a tmux server: ${error}`);
          })
        )
      );
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Switches the session's client to `target` (sizing only applies to control) and answers it
   * as tmux lists it afterwards. Throws TmuxAttachError: client-not-found when no client of
   * the socket has the session's pid, mode-failed when tmux did not take the change.
   */
  async setMode(sessionId: string, target: AttachedMode): Promise<TmuxClient> {
    const { entry, client } = await this.ownClient(sessionId);
    const commands = modeCommands(client, target);
    if (commands.length === 0) return client;
    for (const args of commands) await this.run(entry.socketPath, args);
    const after = (await this.ownClient(sessionId)).client;
    const got = clientMode(after);
    const wanted = expectedMode(target);
    if (got.mode !== wanted.mode || got.sizing !== wanted.sizing) {
      throw new TmuxAttachError(
        'mode-failed',
        `tmux reports ${got.mode} with sizing ${got.sizing}`
      );
    }
    return after;
  }

  /** Detaches the session's own client; the tmux session keeps running. */
  async detach(sessionId: string): Promise<void> {
    const { entry, client } = await this.ownClient(sessionId);
    await this.run(entry.socketPath, ['detach-client', '-t', client.tty]);
  }

  /** The session's client in a fresh listing of its socket. */
  private async ownClient(sessionId: string): Promise<{ entry: Tracked; client: TmuxClient }> {
    const entry = this.tracked.get(sessionId);
    if (!entry) {
      throw new TmuxAttachError('not-tracked', `session ${sessionId} is not attached to tmux`);
    }
    const client = (await this.listSocket(entry.socketPath)).get(entry.clientPid);
    if (!client) {
      throw new TmuxAttachError('client-not-found', `the tmux client of ${sessionId} is gone`);
    }
    return { entry, client };
  }

  /** Lists one socket's clients by pid, and updates every session attached through it. */
  private async listSocket(socketPath: string): Promise<Map<number, TmuxClient>> {
    let output = '';
    try {
      output = await this.run(socketPath, ['list-clients', '-F', TMUX_CLIENT_FORMAT]);
    } catch (error) {
      // A server that is gone took its clients with it.
      if (!isNoTmuxServer(error)) throw error;
    }
    const clients = new Map<number, TmuxClient>();
    for (const line of output.split('\n')) {
      const client = parseTmuxClientLine(line);
      if (client) clients.set(client.clientPid, client);
    }
    for (const [sessionId, entry] of this.tracked) {
      if (entry.socketPath === socketPath) {
        this.update(sessionId, entry, clients.get(entry.clientPid));
      }
    }
    return clients;
  }

  private update(sessionId: string, entry: Tracked, client: TmuxClient | undefined): void {
    if (!client) {
      // Right after opening it may not be attached yet: the seed stands until it is listed.
      if (entry.seen) entry.client = undefined;
      return;
    }
    const previous = entry.client;
    entry.client = client;
    entry.seen = true;
    if (previous && sameClient(previous, client)) return;
    for (const listener of this.listeners) {
      try {
        listener(sessionId, client, previous);
      } catch (error) {
        logger.warn(`tmux client change of ${sessionId} not applied:`, error);
      }
    }
  }
}
