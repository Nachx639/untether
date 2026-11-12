/**
 * Mac Sessions: opening one of the user's tmux sessions from the phone, and switching how
 * Untether's client of it behaves.
 *
 * Open: the id names a tmux session the latest scan listed; a client never sends a socket, pid
 * or target. Its server is listed again right then and must still be the same process (pid and
 * start time) with that `$N`. An Untether session already attached to it is answered as it is,
 * mode included. Otherwise a new session runs a tmux client of it:
 *
 *   tmux -u -N -S <socket> attach-session -E -f ignore-size[,read-only] -t $N
 *
 * Always ignore-size: while the user's terminal is attached the window keeps its size, and
 * alone the client gives it the phone's. Always -E: otherwise tmux copies Untether's
 * environment into the session (update-environment: SSH_AUTH_SOCK, DISPLAY…), and windows the
 * user opens there later get Untether's ssh agent. Never -d or -x, which detach the user's
 * clients, and never a window or pane target, which would switch the current window for every
 * client. Opens of one tmux session wait for each other, so a double tap or a second phone gets
 * the first one's session.
 *
 * Mode: control or watch (a read-only client), and in control whether the window follows this
 * screen too. Only Untether's own client changes (PtyManager.setAttachedMode).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  MacModeResponse,
  MacOpenMode,
  MacOpenResponse,
  MacSessionsErrorCode,
} from '../../../shared/mac-sessions.js';
import { type SessionCreateOptions, type SessionInfo, TitleMode } from '../../../shared/types.js';
import type { PtyManager } from '../../pty/pty-manager.js';
import { PtyError } from '../../pty/types.js';
import { type ProcessTable, processTable } from '../claude-chat.js';
import { parseUtcStart } from '../codex-process.js';
import { findTmuxBinary } from '../shielded-tmux.js';
import { type AttachedMode, TmuxAttachError } from '../tmux-attach-tracker.js';
import { isNoTmuxServer } from '../tmux-manager.js';
import { ancestors } from './process-tree.js';
import type { MacSessionsScanner, MacSessionTarget } from './scanner.js';
import { MacTmuxRefused, runMacTmux, type TmuxAvailability, tmuxVersion } from './tmux-run.js';
import { parseServerListing, SERVER_LISTING_ARGS, type ServerListing } from './tmux-servers.js';

/** The size a session opens at when the phone didn't say; it resizes once it connects. */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
/**
 * A session opened here whose client isn't listed yet is still attaching: one open that waited
 * for it gets it. Past this, a client that never showed up is not answered.
 */
export const ATTACHING_MS = 10_000;

const HTTP_STATUS: Record<MacSessionsErrorCode, number> = {
  'bad-id': 400,
  'bad-request': 400,
  'not-attached': 400,
  gone: 404,
  'tmux-too-old': 409,
  'client-not-found': 409,
  'not-openable': 422,
  'open-failed': 500,
  'mode-failed': 500,
  disabled: 503,
};

/** A Mac Sessions request that can't be done: its error code and the HTTP status it answers. */
export class MacSessionsError extends Error {
  readonly status: number;

  constructor(
    readonly code: MacSessionsErrorCode,
    readonly details?: string
  ) {
    super(details ? `${code}: ${details}` : code);
    this.name = 'MacSessionsError';
    this.status = HTTP_STATUS[code];
  }
}

const TMUX_SESSION_ID = /^\$\d+$/;

/** The tmux client a session runs to open tmux session `$N` of the server at `socketPath`. */
export function attachCommand(
  tmuxBin: string,
  socketPath: string,
  tmuxSessionId: string,
  mode: MacOpenMode
): string[] {
  if (!path.isAbsolute(tmuxBin) || !path.isAbsolute(socketPath)) {
    throw new Error('tmux and its socket are given by their absolute paths');
  }
  // A window or pane target would switch the current window of every client.
  if (!TMUX_SESSION_ID.test(tmuxSessionId)) throw new Error('only a tmux session id is opened');
  const flags = mode === 'watch' ? 'ignore-size,read-only' : 'ignore-size';
  return [
    tmuxBin,
    '-u',
    '-N',
    '-S',
    socketPath,
    'attach-session',
    '-E',
    '-f',
    flags,
    '-t',
    tmuxSessionId,
  ];
}

type TmuxTarget = Extract<MacSessionTarget, { kind: 'tmux' }>;

/** The Untether sessions open answers from; listSessions() gives them. */
export type AttachableSession = Pick<
  SessionInfo,
  'id' | 'pid' | 'status' | 'startedAt' | 'multiplexer'
>;

export interface MacOpenOptions {
  mode: MacOpenMode;
  cols?: number;
  rows?: number;
}

export interface MacAttachDeps {
  /** What an id names, scanning again once when needed; invalidate() after a change. */
  scanner: Pick<MacSessionsScanner, 'resolve' | 'invalidate'>;
  /** Untether's sessions: listed, opened and switched through it. */
  ptyManager: Pick<PtyManager, 'listSessions' | 'getSession' | 'createSession' | 'setAttachedMode'>;
  /** What follows defaults to this machine; tests give their own. */
  tmuxVersion?: () => Promise<TmuxAvailability>;
  tmuxBin?: () => string | null;
  /** runMacTmux: the allowlisted runner. */
  runTmux?: (socketPath: string, args: string[]) => Promise<string>;
  /** The shared process table. */
  table?: () => Promise<ProcessTable>;
  homeDir?: () => string;
  /** Whether a session can start in this folder. */
  canStartIn?: (dir: string) => boolean;
  now?: () => number;
}

function isUsableDir(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.X_OK);
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function firstLine(error: unknown): string {
  const text = String((error as { stderr?: string })?.stderr || (error as Error)?.message || error);
  return text.trim().split('\n')[0] ?? '';
}

/** What a failed mode change answers. */
function modeError(error: unknown): MacSessionsError {
  if (error instanceof MacSessionsError) return error;
  if (error instanceof TmuxAttachError) {
    if (error.code === 'not-tracked') return new MacSessionsError('not-attached', error.message);
    return new MacSessionsError(error.code, error.message);
  }
  if (error instanceof PtyError && error.code === 'NOT_ATTACHED') {
    return new MacSessionsError('not-attached', error.message);
  }
  return new MacSessionsError('mode-failed', firstLine(error));
}

/** Opens tmux sessions of the list, and switches the mode of the sessions it opened. */
export class MacAttach {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly deps: MacAttachDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * An Untether session running a tmux client of the tmux session `id` names: the one already
   * attached (`reused`, in its own mode), or a new one in `options.mode`. Throws a
   * MacSessionsError: gone, not-openable, tmux-too-old or open-failed.
   */
  async open(id: string, options: MacOpenOptions): Promise<MacOpenResponse> {
    const target = await this.deps.scanner.resolve(id);
    if (!target) throw new MacSessionsError('gone');
    if (target.kind !== 'tmux') throw new MacSessionsError('not-openable');
    const tmux = await (this.deps.tmuxVersion ?? tmuxVersion)();
    if (!tmux.available) throw new MacSessionsError('open-failed', 'tmux is not installed');
    if (!tmux.canOpen) throw new MacSessionsError('tmux-too-old', tmux.version);
    const tmuxBin = (this.deps.tmuxBin ?? findTmuxBinary)();
    if (!tmuxBin) throw new MacSessionsError('open-failed', 'tmux is not installed');
    const key = `${target.serverPid}:${target.serverStartedAt}:${target.tmuxSessionId}`;
    return this.withLock(key, () => this.openNow(target, path.resolve(tmuxBin), options));
  }

  /**
   * Switches a session opened on a tmux session between control and watch, or how it sizes the
   * window, and answers what tmux reports afterwards. Throws a MacSessionsError: not-attached,
   * client-not-found or mode-failed.
   */
  async setMode(sessionId: string, change: Partial<AttachedMode>): Promise<MacModeResponse> {
    const session = this.deps.ptyManager.getSession(sessionId);
    if (!session?.multiplexer || session.status !== 'running') {
      throw new MacSessionsError('not-attached');
    }
    try {
      return await this.deps.ptyManager.setAttachedMode(sessionId, change);
    } catch (error) {
      throw modeError(error);
    } finally {
      // The row's "In Untether" or "Watching" changes with it.
      this.deps.scanner.invalidate();
    }
  }

  private async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(run, run);
    const settled = result.catch(() => undefined);
    this.locks.set(key, settled);
    try {
      return await result;
    } finally {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    }
  }

  /** The server as it is now: still the process the id was made from, and `$N` still there. */
  private async listAgain(
    target: TmuxTarget
  ): Promise<{ listing: ServerListing; table: ProcessTable }> {
    let stdout: string;
    try {
      stdout = await (this.deps.runTmux ?? runMacTmux)(target.socketPath, SERVER_LISTING_ARGS);
    } catch (error) {
      if (isNoTmuxServer(error)) throw new MacSessionsError('gone');
      if (error instanceof MacTmuxRefused) throw new MacSessionsError('open-failed', error.message);
      throw new MacSessionsError('open-failed', firstLine(error));
    }
    const listing = parseServerListing(stdout);
    const table = await (this.deps.table ?? processTable)();
    const startedAt = parseUtcStart(table.starts.get(target.serverPid));
    const sameServer =
      listing.panes[0]?.serverPid === target.serverPid &&
      startedAt !== undefined &&
      Math.floor(startedAt / 1000) === target.serverStartedAt;
    if (!sameServer || !listing.panes.some((pane) => pane.sessionId === target.tmuxSessionId)) {
      throw new MacSessionsError('gone');
    }
    return { listing, table };
  }

  /**
   * A running Untether session attached to the tmux session: one whose pid is, or is an
   * ancestor of, one of its clients (also `tmux attach` typed in an Untether shell), else one
   * opened from here whose client isn't listed yet.
   */
  private attachedSession(
    target: TmuxTarget,
    listing: ServerListing,
    table: ProcessTable
  ): { id: string; mode: MacOpenMode } | undefined {
    const running: AttachableSession[] = this.deps.ptyManager
      .listSessions()
      .filter((session) => session.status === 'running');
    const byPid = new Map<number, AttachableSession>();
    for (const session of running) {
      if (typeof session.pid === 'number') byPid.set(session.pid, session);
    }
    for (const client of listing.clients) {
      if (client.sessionId !== target.tmuxSessionId) continue;
      for (const pid of [client.pid, ...ancestors(table, client.pid)]) {
        const session = byPid.get(pid);
        if (session) return { id: session.id, mode: client.readOnly ? 'watch' : 'control' };
      }
    }
    const listedClients = new Set(listing.clients.map((client) => client.pid));
    const attaching = running.find(
      (session) =>
        session.multiplexer?.serverPid === target.serverPid &&
        session.multiplexer.serverStartedAt === target.serverStartedAt &&
        session.multiplexer.sessionId === target.tmuxSessionId &&
        // Listed, its client shows another tmux session now.
        !(typeof session.pid === 'number' && listedClients.has(session.pid)) &&
        this.now() - Date.parse(session.startedAt) < ATTACHING_MS
    );
    return attaching?.multiplexer
      ? { id: attaching.id, mode: attaching.multiplexer.mode }
      : undefined;
  }

  private async openNow(
    target: TmuxTarget,
    tmuxBin: string,
    options: MacOpenOptions
  ): Promise<MacOpenResponse> {
    const { listing, table } = await this.listAgain(target);
    const attached = this.attachedSession(target, listing, table);
    // Never switched silently: it opens as it already is.
    if (attached) return { sessionId: attached.id, reused: true, mode: attached.mode };

    const panes = listing.panes.filter((pane) => pane.sessionId === target.tmuxSessionId);
    const current =
      panes.find((pane) => pane.windowActive && pane.paneActive) ??
      panes.find((pane) => pane.windowActive) ??
      panes[0];
    const home = (this.deps.homeDir ?? os.homedir)();
    const canStartIn = this.deps.canStartIn ?? isUsableDir;
    const workingDir = current.path && canStartIn(current.path) ? current.path : home;
    const create: SessionCreateOptions & { attachSeed: { panePid: number; paneId: string } } = {
      name: `tmux: ${current.sessionName}`,
      workingDir,
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
      titleMode: TitleMode.STATIC,
      shielded: false,
      multiplexer: {
        type: 'tmux',
        socketPath: target.socketPath,
        serverPid: target.serverPid,
        serverStartedAt: target.serverStartedAt,
        sessionId: target.tmuxSessionId,
        sessionName: current.sessionName,
        mode: options.mode,
        sizing: 'others',
        source: 'mac-sessions',
      },
      // The pane on screen now, so the first list poll already shows what runs there.
      attachSeed: { panePid: current.panePid, paneId: current.paneId },
    };
    let sessionId: string;
    try {
      ({ sessionId } = await this.deps.ptyManager.createSession(
        attachCommand(tmuxBin, target.socketPath, target.tmuxSessionId, options.mode),
        create
      ));
    } catch (error) {
      throw new MacSessionsError('open-failed', firstLine(error));
    }
    this.deps.scanner.invalidate();
    return { sessionId, reused: false, mode: options.mode };
  }
}
