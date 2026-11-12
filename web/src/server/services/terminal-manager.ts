import * as fs from 'fs';
import { CellFlags, Ghostty, type GhosttyCell, type GhosttyTerminal } from 'ghostty-web';
import { createRequire } from 'module';
import * as path from 'path';
import {
  type BufferCell,
  CELL_ATTR,
  CELL_TYPE,
  cellColorRgb,
  SNAPSHOT_VERSION,
} from '../../shared/terminal-text-formatter.js';
import type { SessionInfo } from '../../shared/types.js';
import {
  CAST_REPLAY_MAX_BYTES,
  castReplayStart,
  findLastResizeBefore,
  forEachCastLine,
  readCastHeaderLine,
} from '../utils/cast-tail.js';
import { colors } from '../utils/colors.js';
import { ErrorDeduplicator, formatErrorSummary } from '../utils/error-deduplicator.js';
import { createLogger } from '../utils/logger.js';
import { every } from '../utils/periodic-loop.js';

const logger = createLogger('terminal-manager');

const SCROLLBACK_LIMIT = 10000;

const localRequire = createRequire(__filename);

export function resolveGhosttyWasmPath(moduleDir: string = __dirname): string {
  const candidates: string[] = [
    path.resolve(moduleDir, '../public/ghostty-vt.wasm'),
    path.resolve(moduleDir, '../../../public/ghostty-vt.wasm'),
    path.resolve(moduleDir, '../../public/ghostty-vt.wasm'),
  ];

  try {
    candidates.push(localRequire.resolve('ghostty-web/ghostty-vt.wasm'));
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `ghostty-web wasm not found. Tried:\n${candidates.map((c) => `- ${c}`).join('\n')}`
  );
}

type GhosttyWasmInstance = ConstructorParameters<typeof Ghostty>[0];
/** A compiled ghostty-vt.wasm, opaque: the server's TypeScript lib has no WebAssembly types. */
type GhosttyWasmModule = object;
type WebAssemblyLike = {
  compile: (bytes: Uint8Array) => Promise<GhosttyWasmModule>;
  Instance: new (
    module: GhosttyWasmModule,
    imports: Record<string, unknown>
  ) => GhosttyWasmInstance;
};

let ghosttyModulePromise: Promise<GhosttyWasmModule> | null = null;
function compileGhosttyModule(): Promise<GhosttyWasmModule> {
  if (!ghosttyModulePromise) {
    ghosttyModulePromise = (async () => {
      const wasmPath = resolveGhosttyWasmPath();
      const wasmBytes = await fs.promises.readFile(wasmPath);
      const wasm = (globalThis as unknown as { WebAssembly: WebAssemblyLike }).WebAssembly;
      return wasm.compile(wasmBytes);
    })();
  }
  return ghosttyModulePromise;
}

/**
 * A WASM instance of its own for each terminal. On one shared instance a new terminal showed
 * another session's text (2026-10-03): ghostty gives a new terminal the pages a freed one used
 * without zeroing them (release builds take fresh pages to be zero), so every cell it had not
 * written yet still held the old text. A brand-new Claude session's /text had "línea 3626 · el
 * veloz murciélago…" from another session around its banner, bytes its own cast never had. The
 * module compiles once; an instance starts at about 1.2 MB and goes away with its terminal.
 */
function createGhostty(ghosttyModule: GhosttyWasmModule): Ghostty {
  const wasm = (globalThis as unknown as { WebAssembly: WebAssemblyLike }).WebAssembly;
  const instance = new wasm.Instance(ghosttyModule, {
    env: {
      log: (_ptr: number, _len: number) => {
        // Intentionally no-op: ghostty can be noisy with stream warnings.
      },
    },
  });
  return new Ghostty(instance);
}

/**
 * A headless terminal on a WASM instance of its own, for a one-off render outside any session
 * (session-recordings.ts draws the screen a rotated cast's snapshot restores). The caller
 * frees it with terminal.free().
 */
export async function createHeadlessTerminal(
  cols: number,
  rows: number,
  scrollbackLimit = SCROLLBACK_LIMIT
): Promise<GhosttyTerminal> {
  return createGhostty(await compileGhosttyModule()).createTerminal(cols, rows, {
    scrollbackLimit,
  });
}

// Helper function to truncate long strings for logging
function truncateForLog(str: string, maxLength: number = 50): string {
  if (str.length <= maxLength) return str;
  return `${str.substring(0, maxLength)}...(${str.length} chars total)`;
}

/**
 * Flow control, 2026-10-04. It paused a session's terminal once its scrollback passed 80% of
 * SCROLLBACK_LIMIT lines and resumed it below 50%, but ghostty never shrinks its scrollback: the
 * server-side screen (/text, snapshots, previews, the Claude menu reader, the push notifier)
 * froze until a 5-minute timeout, which then dropped the lines queued meanwhile. ghostty's
 * limit is a byte budget, so the line count got there only on narrow terminals (about 15,000
 * lines at 5 columns, 1,100 at 80), but there it froze every time.
 *
 * The scrollback was never the risk, ghostty bounds it. What a flood can grow is output read
 * from the cast and not yet on the screen, and the CPU spent on it. So the cast on disk is the
 * queue: new output is read in 256 KB chunks and written to the terminal as it is read, in
 * order, at most LIVE_WRITE_CHUNK_CHARS at a time, and the next chunk is read only once this
 * one is on the screen. Nothing piles up in memory, nothing is paused, nothing is dropped. The
 * one deliberate cap: a terminal more than castReplayMaxBytes behind (a stalled event loop, a
 * flood faster than ghostty) skips to the end the way a new terminal's replay does, and logs it.
 */
const LIVE_WRITE_CHUNK_CHARS = 256 * 1024;

interface SessionTerminal {
  terminal: GhosttyTerminal;
  /** The terminal's own WASM instance (createGhostty), dropped with this record. */
  ghostty: Ghostty;
  watcher?: fs.FSWatcher;
  /** Reads new output now and then in case the watcher missed a change (WATCH_POLL_MS). */
  poll?: NodeJS.Timeout;
  lastUpdate: number;
  /** Bumped whenever output or a resize reaches the terminal; lets readers skip re-reading. */
  changeCount?: number;
  /** Settles once the cast's replay into the new terminal is done. */
  ready?: Promise<void>;
  /** Where the next read of the cast starts: always the start of a line. */
  lastFileOffset?: number;
  /** A read of new output is running; `readAgain` asks it for one more pass. */
  reading?: boolean;
  readAgain?: boolean;
  /**
   * Its cast said the session exited: the file watcher is closed, only the poll (one stat a
   * second) looks for more. Output after it (the same session running again) opens it again.
   */
  ended?: boolean;
}

type BufferChangeListener = (sessionId: string, snapshot: BufferSnapshot) => void;

interface BufferSnapshot {
  cols: number;
  rows: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  cells: BufferCell[][];
  /** Rows the terminal soft-wrapped onto the next one (only from a live terminal). */
  wrappedRows?: boolean[];
}

/**
 * Manages terminal instances and their buffer operations for terminal sessions.
 *
 * Provides high-performance terminal emulation using ghostty-web (WASM) terminals,
 * with sophisticated flow control, buffer management, and real-time change
 * notifications. Handles asciinema stream parsing, terminal resizing, and
 * efficient binary encoding of terminal buffers.
 *
 * Key features:
 * - Headless Ghostty terminals with 10K line scrollback
 * - Asciinema v2 format stream parsing and playback
 * - Flow control: the cast on disk is the backlog, read as fast as the terminal takes it
 * - Efficient binary buffer encoding for WebSocket transmission
 * - Real-time buffer change notifications with debouncing
 * - Error deduplication to prevent log spam
 * - Automatic cleanup of stale terminals
 *
 * Flow control: see LIVE_WRITE_CHUNK_CHARS.
 *
 * @example
 * ```typescript
 * const manager = new TerminalManager('/var/run/untether');
 *
 * // Get terminal for session
 * const terminal = await manager.getTerminal(sessionId);
 *
 * // Subscribe to buffer changes
 * const unsubscribe = await manager.subscribeToBufferChanges(
 *   sessionId,
 *   (id, snapshot) => {
 *     const encoded = manager.encodeSnapshot(snapshot);
 *     ws.send(encoded);
 *   }
 * );
 * ```
 *
 * @see GhosttyTerminal - Terminal emulation engine
 * @see web/src/server/services/buffer-aggregator.ts - Aggregates buffer updates
 * @see web/src/server/pty/asciinema-writer.ts - Writes asciinema streams
 */
/** How long a terminal waits for a new session's cast file to appear (100 × 100 ms). */
const STREAM_FILE_WAIT_ATTEMPTS = 100;
const STREAM_FILE_WAIT_INTERVAL_MS = 100;

/**
 * How often a watched cast is checked for output its fs.watch did not report. On macOS a write
 * landing just after the watcher starts goes unreported (seen 2026-10-04: output appended right
 * after a terminal was built stayed off its screen until the next write, for good on an idle
 * session). A check with nothing new is one stat.
 */
const WATCH_POLL_MS = 1000;

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Asked for the terminal of a session whose output is gone (see streamGone): not an error. */
class SessionOutputGoneError extends Error {}

/**
 * Largest recording worth replaying for a one-off screen read outside a poll: a 22.7 MB one
 * took 0.27 s once (2026-10-03), and the terminal it builds then reads in about a millisecond.
 */
export const LARGE_REPLAY_MAX_BYTES = 64 * 1024 * 1024;

/** The plain-text fallback snapshot reads at most this much of the end of a cast. */
const FALLBACK_REPLAY_MAX_BYTES = 1024 * 1024;
/** Output written to a terminal at once while replaying a cast. */
const REPLAY_WRITE_CHUNK_CHARS = 1024 * 1024;

/** Output events read live, joined and written at most LIVE_WRITE_CHUNK_CHARS at a time. */
class LiveOutput {
  private parts: string[] = [];
  private chars = 0;

  constructor(private readonly write: (data: string) => void) {}

  push(data: string): void {
    this.parts.push(data);
    this.chars += data.length;
    if (this.chars >= LIVE_WRITE_CHUNK_CHARS) this.flush();
  }

  flush(): void {
    if (this.chars === 0 && this.parts.length === 0) return;
    const data = this.parts.join('');
    this.parts = [];
    this.chars = 0;
    if (data) this.write(data);
  }
}

export class TerminalManager {
  private terminals: Map<string, SessionTerminal> = new Map();
  private controlDir: string;
  private bufferListeners: Map<string, Set<BufferChangeListener>> = new Map();
  private changeTimers: Map<string, NodeJS.Timeout> = new Map();
  private errorDeduplicator = new ErrorDeduplicator({
    keyExtractor: (error, context) => {
      // Use session ID and line prefix as context for terminal parsing errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      return `${context}:${errorMessage}`;
    },
  });
  /** Most bytes of a cast replayed into a terminal at once (CAST_REPLAY_MAX_BYTES). */
  private castReplayMaxBytes: number;
  /** WATCH_POLL_MS (tests shorten it to see several polls without waiting seconds). */
  private watchPollMs: number;

  constructor(
    controlDir: string,
    options: { castReplayMaxBytes?: number; watchPollMs?: number } = {}
  ) {
    this.controlDir = controlDir;
    this.castReplayMaxBytes = options.castReplayMaxBytes ?? CAST_REPLAY_MAX_BYTES;
    this.watchPollMs = options.watchPollMs ?? WATCH_POLL_MS;
  }

  /** When the session's output file last changed (ms), undefined if it can't be read. */
  outputModifiedAt(sessionId: string): number | undefined {
    try {
      return fs.statSync(path.join(this.controlDir, sessionId, 'stdout')).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether a screen snapshot is cheap: a terminal already exists, or the part of the session's
   * output a new terminal replays (at most castReplayMaxBytes of its end) is small enough
   * (LARGE_REPLAY_MAX_BYTES for a one-off read: about 85 MB/s). Building a terminal on a long
   * session inside a 1 s list poll would stall the server.
   */
  canSnapshotCheaply(sessionId: string, maxReplayBytes = 2 * 1024 * 1024): boolean {
    if (this.terminals.has(sessionId)) return true;
    try {
      const size = fs.statSync(path.join(this.controlDir, sessionId, 'stdout')).size;
      return Math.min(size, this.castReplayMaxBytes) <= maxReplayBytes;
    } catch {
      return false;
    }
  }

  /**
   * How many times the session's screen has changed since its terminal was created, or
   * undefined when no terminal exists yet. Equal counts mean the screen is unchanged.
   */
  getChangeCount(sessionId: string): number | undefined {
    const sessionTerminal = this.terminals.get(sessionId);
    return sessionTerminal ? (sessionTerminal.changeCount ?? 0) : undefined;
  }

  /**
   * Get or create a terminal for a session
   */
  async getTerminal(sessionId: string): Promise<GhosttyTerminal> {
    // Awaited before the lookup, so nothing awaits between it and a new terminal in the map: two
    // reads of a new session at once made a terminal each, and the first, left out of the map,
    // was never freed (with an instance per terminal, a whole WASM memory; 2026-10-03).
    const ghosttyModule = await compileGhosttyModule();
    let sessionTerminal = this.terminals.get(sessionId);

    if (!sessionTerminal) {
      // Create new terminal, on a WASM instance of its own, at the PTY's size: its screen is
      // what readiness, menus and the list read with no client connected. The cast's header and
      // resizes set it again when replayed; before the cast exists it was 80x24 and logged as
      // such (2026-10-23, a 120x30 Codex task). Read synchronously: nothing awaits between the
      // lookup above and the map entry below.
      const ghostty = createGhostty(ghosttyModule);
      const size = this.sessionSizeSync(sessionId);
      const terminal = ghostty.createTerminal(size.cols, size.rows, {
        scrollbackLimit: SCROLLBACK_LIMIT,
      });

      sessionTerminal = {
        terminal,
        ghostty,
        lastUpdate: Date.now(),
      };

      this.terminals.set(sessionId, sessionTerminal);
      // Start watching the stream file
      sessionTerminal.ready = this.watchStreamFile(sessionId);
      await sessionTerminal.ready;
      // After the replay: the size its screen is read at, the cast's own.
      if (this.terminals.get(sessionId) === sessionTerminal) {
        logger.log(
          colors.green(
            `Terminal created for session ${sessionId} (${terminal.cols}x${terminal.rows})`
          )
        );
      }
    } else if (sessionTerminal.ready) {
      // The replay is asynchronous: a second reader waits for the screen it rebuilds.
      await sessionTerminal.ready.catch(() => {});
    }
    // Closed meanwhile (its session is gone, streamGone): its terminal is freed.
    if (this.terminals.get(sessionId) !== sessionTerminal) {
      throw new SessionOutputGoneError(`Session ${truncateForLog(sessionId)} has no output`);
    }

    sessionTerminal.lastUpdate = Date.now();
    return sessionTerminal.terminal;
  }

  /** The session's PTY size (session.json, as the PTY was started), 80x24 when unknown. */
  private sessionSizeSync(sessionId: string): { cols: number; rows: number } {
    try {
      const raw = fs.readFileSync(path.join(this.controlDir, sessionId, 'session.json'), 'utf8');
      const parsed = JSON.parse(raw) as Partial<SessionInfo>;
      const valid = (value: unknown): value is number =>
        typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1000;
      if (valid(parsed.initialCols) && valid(parsed.initialRows)) {
        return { cols: parsed.initialCols, rows: parsed.initialRows };
      }
    } catch {
      // No session.json yet, or unreadable: the cast's header sets the size when it comes.
    }
    return { cols: 80, rows: 24 };
  }

  private async readSessionDimensions(
    sessionId: string
  ): Promise<{ cols?: number; rows?: number }> {
    const sessionJsonPath = path.join(this.controlDir, sessionId, 'session.json');
    if (!fs.existsSync(sessionJsonPath)) {
      return {};
    }

    try {
      const raw = await fs.promises.readFile(sessionJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SessionInfo>;
      const cols =
        typeof parsed.initialCols === 'number' && Number.isFinite(parsed.initialCols)
          ? parsed.initialCols
          : undefined;
      const rows =
        typeof parsed.initialRows === 'number' && Number.isFinite(parsed.initialRows)
          ? parsed.initialRows
          : undefined;
      return { cols, rows };
    } catch (error) {
      logger.debug(`Failed to read session.json for fallback ${truncateForLog(sessionId)}:`, error);
      return {};
    }
  }

  private async buildFallbackSnapshot(sessionId: string): Promise<BufferSnapshot> {
    const streamPath = path.join(this.controlDir, sessionId, 'stdout');
    const sessionDimensions = await this.readSessionDimensions(sessionId);
    const emptySnapshot = (): BufferSnapshot => ({
      cols: 1,
      rows: 1,
      viewportY: 0,
      cursorX: 0,
      cursorY: 0,
      cells: [[{ char: ' ', width: 1 }]],
    });

    if (!fs.existsSync(streamPath)) {
      return emptySnapshot();
    }

    // The header and the last MB only: a whole 1 GB cast does not fit in a string (2026-10-04).
    const castLines: string[] = [];
    try {
      const size = (await fs.promises.stat(streamPath)).size;
      const header = await readCastHeaderLine(streamPath);
      if (header) castLines.push(header.line);
      const from = header?.end ?? 0;
      const { start } = await castReplayStart(streamPath, from, size, FALLBACK_REPLAY_MAX_BYTES);
      await forEachCastLine(streamPath, start, size, (line) => castLines.push(line));
    } catch (error) {
      logger.error(`Failed to read fallback stream for ${truncateForLog(sessionId)}:`, error);
      return emptySnapshot();
    }

    if (castLines.length === 0) {
      return emptySnapshot();
    }

    let output = '';
    let headerCols: number | undefined;
    let headerRows: number | undefined;
    let resizeCols: number | undefined;
    let resizeRows: number | undefined;
    for (const line of castLines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed) && parsed.length >= 3) {
          if (parsed[1] === 'o') {
            output += String(parsed[2]);
          } else if (parsed[1] === 'r') {
            const match = String(parsed[2]).match(/^(\d+)x(\d+)$/);
            if (match) {
              resizeCols = Number.parseInt(match[1], 10);
              resizeRows = Number.parseInt(match[2], 10);
            }
          }
        } else if (parsed && typeof parsed === 'object') {
          const width = (parsed as { width?: number }).width;
          const height = (parsed as { height?: number }).height;
          if (typeof width === 'number' && Number.isFinite(width)) headerCols = width;
          if (typeof height === 'number' && Number.isFinite(height)) headerRows = height;
        }
      } catch {
        // ignore malformed lines
      }
    }

    const fallbackCols = resizeCols ?? sessionDimensions.cols ?? headerCols;
    const fallbackRows = resizeRows ?? sessionDimensions.rows ?? headerRows;
    if (!output) {
      const cols = Math.max(1, fallbackCols ?? 1);
      const rows = Math.max(1, fallbackRows ?? 1);
      const cells: BufferCell[][] = Array.from({ length: rows }, () => [{ char: ' ', width: 1 }]);
      return {
        cols,
        rows,
        viewportY: 0,
        cursorX: 0,
        cursorY: 0,
        cells,
      };
    }

    const normalized = output.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // biome-ignore lint/complexity/useRegexLiterals: avoid control-character lint for ESC
    const ansiPattern = new RegExp('\\u001b\\[[0-9;?]*[a-zA-Z]', 'g');
    const stripped = normalized.replace(ansiPattern, '');
    const lines = stripped.split('\n');
    const rows = Math.max(1, fallbackRows ?? lines.length);
    const visibleLines = fallbackRows ? lines.slice(-rows) : lines;
    const outputCols = Math.max(1, ...visibleLines.map((line) => Array.from(line).length));
    const cols = Math.max(1, fallbackCols ?? outputCols);

    const cells: BufferCell[][] = visibleLines.map((line) => {
      const chars = Array.from(line);
      const truncated = cols ? chars.slice(0, cols) : chars;
      if (truncated.length === 0) {
        return [{ char: ' ', width: 1 }];
      }
      return truncated.map((char) => ({ char, width: 1 }));
    });

    while (cells.length < rows) {
      cells.push([{ char: ' ', width: 1 }]);
    }

    return {
      cols,
      rows,
      viewportY: 0,
      cursorX: 0,
      cursorY: 0,
      cells,
    };
  }

  /**
   * Watch stream file for changes
   */
  private async watchStreamFile(sessionId: string, attempt = 0): Promise<void> {
    const sessionTerminal = this.terminals.get(sessionId);
    if (!sessionTerminal) return;

    const streamPath = path.join(this.controlDir, sessionId, 'stdout');

    // Check if the file exists
    if (!fs.existsSync(streamPath)) {
      // A session asked for right after it was created may not have written its cast file
      // yet. Giving up here left that terminal empty for good: no screen text, no Claude
      // choices for the "needs you" push or the answer sheet (2026-10-02). Wait for it.
      if (attempt < STREAM_FILE_WAIT_ATTEMPTS) {
        const timer = setTimeout(() => {
          if (this.terminals.get(sessionId) === sessionTerminal) {
            // From a timer nobody awaits: a failure here (logged below) must not be an
            // unhandled rejection, which stops the server (2026-11-10).
            this.watchStreamFile(sessionId, attempt + 1).catch(() => {});
          }
        }, STREAM_FILE_WAIT_INTERVAL_MS);
        timer.unref?.();
        return;
      }
      // Still no session folder (a brand-new one makes it first): the session is gone.
      if (!fs.existsSync(path.dirname(streamPath))) {
        this.streamGone(sessionId, sessionTerminal);
        return;
      }
      logger.error(
        `Stream file does not exist for session ${truncateForLog(sessionId)}: ${truncateForLog(streamPath, 100)}`
      );
      return;
    }

    try {
      // First time only: a watcher set up again goes on from where it stopped. It used to read
      // the whole file again from the start, replaying every line twice.
      if (sessionTerminal.lastFileOffset === undefined) {
        sessionTerminal.lastFileOffset = await this.replayCastTail(
          sessionId,
          sessionTerminal,
          streamPath
        );
      }
      if (this.terminals.get(sessionId) !== sessionTerminal || sessionTerminal.watcher) return;

      this.watchFile(sessionId, sessionTerminal, streamPath);
      sessionTerminal.poll = every(
        'terminal poll',
        () => this.readNewOutput(sessionId, sessionTerminal, streamPath),
        this.watchPollMs
      );
      sessionTerminal.poll.unref?.();
      // Whatever was written while the replay ran.
      void this.readNewOutput(sessionId, sessionTerminal, streamPath);

      logger.log(colors.green(`Watching stream file for session ${truncateForLog(sessionId)}`));
    } catch (error) {
      if (isMissingFile(error)) {
        this.streamGone(sessionId, sessionTerminal);
        return;
      }
      logger.error(`Failed to watch stream file for session ${truncateForLog(sessionId)}:`, error);
      // Not left in the map with no watcher and no poll (frozen until the idle cleanup): the
      // next ask opens it again.
      if (this.terminals.get(sessionId) === sessionTerminal) this.closeTerminal(sessionId);
      throw error;
    }
  }

  /** The file watcher; any event, a deletion ('rename') too: the read finds the file gone. */
  private watchFile(sessionId: string, sessionTerminal: SessionTerminal, streamPath: string) {
    sessionTerminal.watcher = fs.watch(streamPath, () => {
      void this.readNewOutput(sessionId, sessionTerminal, streamPath);
    });
    sessionTerminal.watcher.on('error', () => this.streamGone(sessionId, sessionTerminal));
  }

  /**
   * Rebuild a new terminal's screen from the end of its cast: the header line, then at most
   * castReplayMaxBytes of events, from the last clear when it is in them, else from the first
   * whole line in them (with the terminal size in effect there). A full-screen app's last
   * repaints draw all of its screen; older history is not needed and a 1 GB cast does not
   * fit in a string (2026-10-04). Written straight to the terminal, in order, so the screen is
   * right when this resolves. Returns the offset after the last complete line read.
   */
  private async replayCastTail(
    sessionId: string,
    sessionTerminal: SessionTerminal,
    streamPath: string
  ): Promise<number> {
    const terminal = sessionTerminal.terminal;
    const size = (await fs.promises.stat(streamPath)).size;
    const header = await readCastHeaderLine(streamPath);
    const from = header?.end ?? 0;
    const lastClearOffset =
      size - from > this.castReplayMaxBytes ? await this.readLastClearOffset(sessionId) : undefined;
    const { start, truncated } = await castReplayStart(
      streamPath,
      from,
      size,
      this.castReplayMaxBytes,
      lastClearOffset
    );

    // A terminal closed meanwhile has freed its WASM memory: nothing more may reach it.
    const closed = () => this.terminals.get(sessionId) !== sessionTerminal;
    let output: string[] = [];
    let outputChars = 0;
    const flush = () => {
      if (outputChars === 0) return;
      const data = output.join('');
      output = [];
      outputChars = 0;
      if (closed()) return;
      try {
        terminal.write(data);
      } catch (error) {
        logger.warn(`Terminal write error replaying ${truncateForLog(sessionId)}: ${error}`);
      }
    };
    const resize = (dimensions: string) => {
      const match = dimensions.match(/^(\d+)x(\d+)$/);
      if (!match) return;
      flush();
      if (closed()) return;
      terminal.resize(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10));
    };
    let malformed = 0;
    const replayLine = (line: string) => {
      if (!line.trim()) return;
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        malformed++;
        return;
      }
      if (Array.isArray(data)) {
        if (data.length < 3 || typeof data[2] !== 'string') return;
        if (data[1] === 'o') {
          output.push(data[2]);
          outputChars += data[2].length;
          if (outputChars >= REPLAY_WRITE_CHUNK_CHARS) flush();
        } else if (data[1] === 'r') {
          resize(data[2]);
        }
        return;
      }
      const { width, height } = (data ?? {}) as { width?: unknown; height?: unknown };
      if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
        flush();
        if (!closed()) terminal.resize(width, height);
      }
    };

    if (header) replayLine(header.line);
    if (truncated) {
      const dimensions = await findLastResizeBefore(streamPath, start, from);
      if (dimensions) resize(dimensions);
    }
    const end = await forEachCastLine(streamPath, start, size, replayLine);
    flush();

    if (malformed > 0) {
      logger.debug(`Skipped ${malformed} malformed cast lines of ${truncateForLog(sessionId)}`);
    }
    if (truncated) {
      logger.log(
        `Replayed the last ${Math.round((end - start) / 1024)} KB of the ${Math.round(size / 1024 / 1024)} MB cast of ${truncateForLog(sessionId)}`
      );
    }
    sessionTerminal.changeCount = (sessionTerminal.changeCount ?? 0) + 1;
    this.scheduleBufferChangeNotification(sessionId);
    return end;
  }

  /** The session's last clear offset from session.json, if it has one. */
  private async readLastClearOffset(sessionId: string): Promise<number | undefined> {
    try {
      const raw = await fs.promises.readFile(
        path.join(this.controlDir, sessionId, 'session.json'),
        'utf8'
      );
      const offset = (JSON.parse(raw) as Partial<SessionInfo>).lastClearOffset;
      return typeof offset === 'number' && Number.isFinite(offset) ? offset : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Hand the complete lines written since the last read to the terminal. Reads end on a line
   * boundary, so a half-written line is read again whole next time. One read at a time; a
   * change during it asks for another pass. Output reaches the terminal as it is read, so the
   * next chunk of the file is read only once this one is on the screen (LIVE_WRITE_CHUNK_CHARS).
   * A terminal more than castReplayMaxBytes behind skips to the end the way a new terminal's
   * replay does, and logs it.
   */
  private async readNewOutput(
    sessionId: string,
    sessionTerminal: SessionTerminal,
    streamPath: string
  ): Promise<void> {
    if (sessionTerminal.reading) {
      sessionTerminal.readAgain = true;
      return;
    }
    sessionTerminal.reading = true;
    try {
      do {
        sessionTerminal.readAgain = false;
        if (this.terminals.get(sessionId) !== sessionTerminal || !sessionTerminal.watcher) return;
        const size = (await fs.promises.stat(streamPath)).size;
        let from = sessionTerminal.lastFileOffset ?? 0;
        if (size <= from) continue;
        if (sessionTerminal.ended) {
          // 2026-10-31: the session runs again under the same id (a suspended session woken,
          // session-suspender.ts): its terminal stayed on "[exited]" for good, its screen
          // (the menus, the draft the suspender checks) and its viewers frozen. It reads on.
          sessionTerminal.ended = false;
          logger.log(colors.green(`Session ${truncateForLog(sessionId)} has output again`));
          try {
            this.watchFile(sessionId, sessionTerminal, streamPath);
          } catch {
            // The poll still reads it.
          }
        }
        if (size - from > this.castReplayMaxBytes) {
          from = (await castReplayStart(streamPath, from, size, this.castReplayMaxBytes)).start;
          logger.warn(
            `Skipped ${Math.round((from - (sessionTerminal.lastFileOffset ?? 0)) / 1024)} KB of output of ${truncateForLog(sessionId)}: its terminal fell more than ${Math.round(this.castReplayMaxBytes / 1024)} KB behind`
          );
        }
        const output = new LiveOutput((data) => this.writeOutput(sessionId, sessionTerminal, data));
        try {
          sessionTerminal.lastFileOffset = await forEachCastLine(streamPath, from, size, (line) => {
            if (line.trim()) this.processStreamLine(sessionId, sessionTerminal, line, output);
          });
        } finally {
          output.flush();
        }
      } while (sessionTerminal.readAgain);
    } catch (error) {
      if (isMissingFile(error)) {
        this.streamGone(sessionId, sessionTerminal);
      } else {
        logger.error(`Error reading stream file for session ${truncateForLog(sessionId)}:`, error);
      }
    } finally {
      sessionTerminal.reading = false;
    }
  }

  /**
   * The session's cast (or its whole control folder) is gone: it was closed or deleted (DELETE
   * /api/sessions/:id, a finished task). 2026-10-24: its terminal went on watching and polling
   * the missing file, logging "Error reading stream file ... ENOENT" every second until the
   * stale-terminal cleanup, ~2000 errors in 10 min in the doctor's log-errors check. A normal
   * end, not an error: the terminal is closed (watcher, poll and pending notification stopped,
   * out of the map). Its clients hear the end from the cast output hub; one asking again later
   * gets a new terminal, built again if the session is still there.
   */
  private streamGone(sessionId: string, sessionTerminal: SessionTerminal): void {
    if (this.terminals.get(sessionId) !== sessionTerminal) return;
    logger.log(colors.yellow(`Output of session ${truncateForLog(sessionId)} is gone`));
    this.closeTerminal(sessionId);
    const timer = this.changeTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.changeTimers.delete(sessionId);
    }
  }

  /**
   * Hand one cast line read live to the terminal: output is batched in `output`, which is
   * flushed before anything else reaches the terminal so everything stays in order.
   */
  private processStreamLine(
    sessionId: string,
    sessionTerminal: SessionTerminal,
    line: string,
    output: LiveOutput
  ) {
    try {
      const data = JSON.parse(line);
      // Output first: the line may change the terminal, or close it.
      const isOutput = Array.isArray(data) && data.length >= 3 && data[1] === 'o';
      if (!isOutput) output.flush();
      if (this.terminals.get(sessionId) !== sessionTerminal) return;

      // Handle asciinema header
      if (data.version && data.width && data.height) {
        sessionTerminal.terminal.resize(data.width, data.height);
        sessionTerminal.changeCount = (sessionTerminal.changeCount ?? 0) + 1;
        this.notifyBufferChange(sessionId);
        return;
      }

      // Handle asciinema events [timestamp, type, data]
      if (Array.isArray(data) && data.length >= 3) {
        const [timestamp, type, eventData] = data;

        if (timestamp === 'exit') {
          // Session exited
          logger.log(
            colors.yellow(`Session ${truncateForLog(sessionId)} exited with code ${data[1]}`)
          );
          // The watcher stops; the poll stays (one stat a second, until the stale-terminal
          // cleanup): the same session can run again and write on (a suspended session woken).
          sessionTerminal.watcher?.close();
          sessionTerminal.ended = true;
          return;
        }

        if (type === 'o') {
          if (typeof eventData === 'string') output.push(eventData);
        } else if (type === 'r') {
          // Resize event
          const match = eventData.match(/^(\d+)x(\d+)$/);
          if (match) {
            const cols = Number.parseInt(match[1], 10);
            const rows = Number.parseInt(match[2], 10);
            sessionTerminal.terminal.resize(cols, rows);
            sessionTerminal.changeCount = (sessionTerminal.changeCount ?? 0) + 1;
            this.notifyBufferChange(sessionId);
          }
        }
        // Ignore 'i' (input) events
      }
    } catch (error) {
      // Use deduplicator to check if we should log this error
      // Use a more generic context key to group similar parsing errors together
      const contextKey = `${sessionId}:parse-stream-line`;

      if (this.errorDeduplicator.shouldLog(error, contextKey)) {
        const stats = this.errorDeduplicator.getErrorStats(error, contextKey);

        if (stats && stats.count > 1) {
          // Log summary for repeated errors
          logger.warn(formatErrorSummary(error, stats, `session ${truncateForLog(sessionId)}`));
        } else {
          // First occurrence - log the error with details
          const truncatedLine = line.length > 100 ? `${line.substring(0, 100)}...` : line;
          logger.error(
            `Failed to parse stream line for session ${truncateForLog(sessionId)}: ${truncatedLine}`
          );
          if (error instanceof Error && error.stack) {
            logger.debug(`Parse error details: ${error.message}`);
          }
        }
      }
    }
  }

  /**
   * Get buffer stats for a session
   */
  async getBufferStats(sessionId: string) {
    const terminal = await this.getTerminal(sessionId);
    terminal.update();
    const cursor = terminal.getCursor();
    const scrollbackLength = terminal.getScrollbackLength();
    const totalRows = scrollbackLength + terminal.rows;
    logger.debug(
      `Getting buffer stats for session ${truncateForLog(sessionId)}: ${totalRows} total rows`
    );

    const maxLines = SCROLLBACK_LIMIT;
    const bufferUtilization = totalRows / maxLines;

    return {
      totalRows,
      cols: terminal.cols,
      rows: terminal.rows,
      viewportY: cursor.viewportY,
      cursorX: cursor.x,
      cursorY: cursor.y,
      scrollback: scrollbackLength,
      bufferUtilization: Math.round(bufferUtilization * 100),
      maxBufferLines: maxLines,
    };
  }

  /**
   * The last `maxLines` lines, scrollback included, one character per cell (its first code
   * point; an empty cell is a space), the way the phone reads its own copy (terminal.ts
   * getScreenText). A menu's key read here and on the phone then covers the same lines: the
   * snapshot below has only the visible rows and whole character clusters (review of
   * 2026-10-03). With the layout that reads its menus right: the width, which lines go on
   * from the one above (soft-wrapped; never known in the scrollback) and the visible rows.
   */
  async getRecentText(
    sessionId: string,
    maxLines = 60
  ): Promise<{ text: string; rows: number; cols: number; wrappedRows: boolean[] }> {
    const terminal = await this.getTerminal(sessionId);
    terminal.update();
    const { rows, cols } = terminal;
    const text = (cells: GhosttyCell[] | null | undefined) => {
      let line = '';
      for (const cell of cells ?? []) {
        if (!cell || cell.width === 0) continue;
        line += cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' ';
      }
      return line.trimEnd();
    };
    const lines: string[] = [];
    const wrappedRows: boolean[] = [];
    const fromScreen = Math.min(rows, maxLines);
    const scrollback = terminal.getScrollbackLength();
    for (let i = Math.max(0, scrollback - (maxLines - fromScreen)); i < scrollback; i++) {
      lines.push(text(terminal.getScrollbackLine(i)));
      wrappedRows.push(false);
    }
    const viewport = terminal.getViewport();
    for (let row = rows - fromScreen; row < rows; row++) {
      lines.push(text(viewport.slice(row * cols, (row + 1) * cols)));
      wrappedRows.push(terminal.isRowWrapped(row));
    }
    return { text: lines.join('\n'), rows, cols, wrappedRows };
  }

  /**
   * Get buffer snapshot for a session - always returns full terminal buffer (cols x rows)
   */
  async getBufferSnapshot(sessionId: string): Promise<BufferSnapshot> {
    const startTime = Date.now();
    let terminal: GhosttyTerminal;
    try {
      terminal = await this.getTerminal(sessionId);
    } catch (error) {
      if (!(error instanceof SessionOutputGoneError)) {
        logger.error(`Failed to init terminal for snapshot ${truncateForLog(sessionId)}:`, error);
      }
      return this.buildFallbackSnapshot(sessionId);
    }

    try {
      terminal.update();
    } catch (error) {
      logger.error(`Failed to update terminal for snapshot ${truncateForLog(sessionId)}:`, error);
      return this.buildFallbackSnapshot(sessionId);
    }
    const cols = terminal.cols;
    const rows = terminal.rows;
    const viewport = terminal.getViewport();
    const cursor = terminal.getCursor();
    const colors = terminal.getColors() as
      | {
          foreground: { r: number; g: number; b: number };
          background: { r: number; g: number; b: number };
        }
      | undefined;
    if (!colors?.foreground || !colors?.background) {
      return this.buildFallbackSnapshot(sessionId);
    }

    const defaultFg =
      (colors.foreground.r << 16) | (colors.foreground.g << 8) | colors.foreground.b;
    const defaultBg =
      (colors.background.r << 16) | (colors.background.g << 8) | colors.background.b;

    const cells: BufferCell[][] = [];
    const wrappedRows: boolean[] = [];

    for (let row = 0; row < rows; row++) {
      const rowCells: BufferCell[] = [];
      try {
        wrappedRows.push(terminal.isRowWrapped(row));
      } catch {
        wrappedRows.push(false);
      }

      for (let col = 0; col < cols; col++) {
        const cell = viewport[row * cols + col];
        if (!cell) continue;

        const width = cell.width;
        if (width === 0) continue;

        let char = ' ';
        if (cell.codepoint !== 0) {
          if (cell.grapheme_len && cell.grapheme_len > 1) {
            char = terminal.getGraphemeString(row, col) || ' ';
          } else {
            char = String.fromCodePoint(cell.codepoint);
          }
        }

        let attributes = 0;
        if (cell.flags & CellFlags.BOLD) attributes |= CELL_ATTR.BOLD;
        if (cell.flags & CellFlags.ITALIC) attributes |= CELL_ATTR.ITALIC;
        if (cell.flags & CellFlags.UNDERLINE) attributes |= CELL_ATTR.UNDERLINE;
        if (cell.flags & CellFlags.FAINT) attributes |= CELL_ATTR.DIM;
        if (cell.flags & CellFlags.INVERSE) attributes |= CELL_ATTR.INVERSE;
        if (cell.flags & CellFlags.INVISIBLE) attributes |= CELL_ATTR.INVISIBLE;
        if (cell.flags & CellFlags.STRIKETHROUGH) attributes |= CELL_ATTR.STRIKETHROUGH;

        const bufferCell: BufferCell = { char, width };

        const fg = (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b;
        const bg = (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b;

        if (fg !== defaultFg) bufferCell.fg = fg;
        if (bg !== defaultBg) bufferCell.bg = bg;
        if (attributes !== 0) bufferCell.attributes = attributes;

        rowCells.push(bufferCell);
      }

      // Trim trailing blanks but keep at least one cell for height
      let lastNonBlankCell = rowCells.length - 1;
      while (lastNonBlankCell >= 0) {
        const cell = rowCells[lastNonBlankCell];
        if (
          cell.char !== ' ' ||
          cell.fg !== undefined ||
          cell.bg !== undefined ||
          cell.attributes !== undefined
        ) {
          break;
        }
        lastNonBlankCell--;
      }

      if (lastNonBlankCell < rowCells.length - 1) {
        rowCells.splice(Math.max(1, lastNonBlankCell + 1));
      }

      if (rowCells.length === 0) rowCells.push({ char: ' ', width: 1 });
      cells.push(rowCells);
    }

    // Trim blank lines from the bottom
    let lastNonBlankRow = cells.length - 1;
    while (lastNonBlankRow >= 0) {
      const row = cells[lastNonBlankRow];
      const hasContent = row.some(
        (cell) =>
          cell.char !== ' ' ||
          cell.fg !== undefined ||
          cell.bg !== undefined ||
          cell.attributes !== undefined
      );
      if (hasContent) break;
      lastNonBlankRow--;
    }

    // Keep at least one row
    const trimmedCells = cells.slice(0, Math.max(1, lastNonBlankRow + 1));

    const duration = Date.now() - startTime;
    if (duration > 10) {
      logger.debug(
        `Buffer snapshot for session ${sessionId} took ${duration}ms (${trimmedCells.length} rows)`
      );
    }

    return {
      cols,
      rows: trimmedCells.length,
      viewportY: cursor.viewportY,
      cursorX: cursor.x,
      cursorY: cursor.y,
      cells: trimmedCells,
      wrappedRows: wrappedRows.slice(0, trimmedCells.length),
    };
  }

  /**
   * Encode buffer snapshot to binary format
   *
   * Converts a buffer snapshot into an optimized binary format for
   * efficient transmission over WebSocket. The encoding uses various
   * compression techniques:
   *
   * - Empty rows are marked with 2-byte markers
   * - Spaces with default styling use 1 byte
   * - ASCII characters with colors use 3-9 bytes (a color is always three RGB bytes)
   * - Unicode characters use variable length encoding
   *
   * The binary format is designed for fast decoding on the client
   * while minimizing bandwidth usage.
   *
   * @param snapshot - Terminal buffer snapshot to encode
   * @returns Binary buffer ready for transmission
   *
   * @example
   * ```typescript
   * const snapshot = await manager.getBufferSnapshot('session-123');
   * const binary = manager.encodeSnapshot(snapshot);
   *
   * // Send over WebSocket with session ID
   * const packet = Buffer.concat([
   *   Buffer.from([0xBF]), // Magic byte
   *   Buffer.from(sessionId.length.toString(16), 'hex'),
   *   Buffer.from(sessionId),
   *   binary
   * ]);
   * ws.send(packet);
   * ```
   */
  encodeSnapshot(snapshot: BufferSnapshot): Buffer {
    const startTime = Date.now();
    const { cols, rows, viewportY, cursorX, cursorY, cells } = snapshot;

    // Pre-calculate actual data size for efficiency
    let dataSize = 32; // Header size

    // First pass: calculate exact size needed
    for (let row = 0; row < cells.length; row++) {
      const rowCells = cells[row];
      if (rowCells.length === 0 || (rowCells.length === 1 && this.isPlainSpace(rowCells[0]))) {
        // Empty row marker: 2 bytes
        dataSize += 2;
      } else {
        // Row header: 3 bytes (marker + length)
        dataSize += 3;

        for (const cell of rowCells) {
          dataSize += this.calculateCellSize(cell);
        }
      }
    }

    const buffer = Buffer.allocUnsafe(dataSize);
    let offset = 0;

    // Write header (32 bytes)
    buffer.writeUInt16LE(0x5654, offset);
    offset += 2; // Magic "VT"
    buffer.writeUInt8(SNAPSHOT_VERSION, offset);
    offset += 1; // Version
    buffer.writeUInt8(0x00, offset);
    offset += 1; // Flags
    buffer.writeUInt32LE(cols, offset);
    offset += 4; // Cols (32-bit)
    buffer.writeUInt32LE(rows, offset);
    offset += 4; // Rows (32-bit)
    buffer.writeInt32LE(viewportY, offset); // Signed for large buffers
    offset += 4; // ViewportY (32-bit signed)
    buffer.writeInt32LE(cursorX, offset); // Signed for consistency
    offset += 4; // CursorX (32-bit signed)
    buffer.writeInt32LE(cursorY, offset); // Signed for relative positions
    offset += 4; // CursorY (32-bit signed)
    buffer.writeUInt32LE(0, offset);
    offset += 4; // Reserved

    // Write cells with new optimized format
    for (let row = 0; row < cells.length; row++) {
      const rowCells = cells[row];

      // Check if this is an empty row
      if (rowCells.length === 0 || (rowCells.length === 1 && this.isPlainSpace(rowCells[0]))) {
        // Empty row marker
        buffer.writeUInt8(0xfe, offset++); // Empty row marker
        buffer.writeUInt8(1, offset++); // Count of empty rows (for now just 1)
      } else {
        // Row with content
        buffer.writeUInt8(0xfd, offset++); // Row marker
        buffer.writeUInt16LE(rowCells.length, offset); // Number of cells in row
        offset += 2;

        // Write each cell
        for (const cell of rowCells) {
          offset = this.encodeCell(buffer, offset, cell);
        }
      }
    }

    // Return exact size buffer
    const result = buffer.subarray(0, offset);

    const duration = Date.now() - startTime;
    if (duration > 5) {
      logger.debug(`Encoded snapshot: ${result.length} bytes in ${duration}ms (${rows} rows)`);
    }

    return result;
  }

  /** A space with the default colours and no attributes: one byte, or a whole empty row. */
  private isPlainSpace(cell: BufferCell): boolean {
    // `undefined`, never falsy: 0 is a colour (black) and must travel.
    return cell.char === ' ' && cell.fg === undefined && cell.bg === undefined && !cell.attributes;
  }

  /**
   * Calculate the size needed to encode a cell
   */
  private calculateCellSize(cell: BufferCell): number {
    if (this.isPlainSpace(cell)) return 1;

    const isAscii = cell.char.charCodeAt(0) <= 127;
    let size = 1; // Type byte
    if (!isAscii) {
      size += 1 + Buffer.byteLength(cell.char, 'utf8'); // Length byte + UTF-8 bytes
    } else if (cell.char !== ' ') {
      size += 1; // ASCII character
    }

    const hasFg = cell.fg !== undefined;
    const hasBg = cell.bg !== undefined;
    if (cell.attributes || hasFg || hasBg) {
      size += 1; // Attributes byte
      if (hasFg) size += 3;
      if (hasBg) size += 3;
    }
    return size;
  }

  /**
   * Encode a single cell into the buffer: the type byte (CELL_TYPE), the character and,
   * when the cell has attributes or colours, the attributes byte (CELL_ATTR) and three RGB
   * bytes per colour. A colour is always RGB, whatever its value (BufferCell).
   */
  private encodeCell(buffer: Buffer, offset: number, cell: BufferCell): number {
    if (this.isPlainSpace(cell)) {
      buffer.writeUInt8(CELL_TYPE.CHAR_SPACE, offset++);
      return offset;
    }

    const isSpace = cell.char === ' ';
    const isAscii = cell.char.charCodeAt(0) <= 127;
    const { fg, bg } = cell;
    const attributes = cell.attributes ?? 0;

    let typeByte = 0;
    if (attributes !== 0 || fg !== undefined || bg !== undefined) typeByte |= CELL_TYPE.EXTENDED;
    if (!isAscii) {
      typeByte |= CELL_TYPE.UNICODE | CELL_TYPE.CHAR_UNICODE;
    } else if (!isSpace) {
      typeByte |= CELL_TYPE.CHAR_ASCII;
    }
    if (fg !== undefined) typeByte |= CELL_TYPE.HAS_FG;
    if (bg !== undefined) typeByte |= CELL_TYPE.HAS_BG;

    buffer.writeUInt8(typeByte, offset++);

    if (!isAscii) {
      const charBytes = Buffer.from(cell.char, 'utf8');
      buffer.writeUInt8(charBytes.length, offset++);
      charBytes.copy(buffer, offset);
      offset += charBytes.length;
    } else if (!isSpace) {
      buffer.writeUInt8(cell.char.charCodeAt(0), offset++);
    }

    if (typeByte & CELL_TYPE.EXTENDED) {
      buffer.writeUInt8(attributes, offset++);
      for (const color of [fg, bg]) {
        if (color === undefined) continue;
        for (const channel of cellColorRgb(color)) buffer.writeUInt8(channel, offset++);
      }
    }

    return offset;
  }

  /**
   * Close a terminal session
   */
  closeTerminal(sessionId: string): void {
    const sessionTerminal = this.terminals.get(sessionId);
    if (sessionTerminal) {
      if (sessionTerminal.watcher) {
        sessionTerminal.watcher.close();
      }
      clearInterval(sessionTerminal.poll);
      // The record holds the terminal's own WASM instance: once dropped, all its memory can go.
      sessionTerminal.terminal.free();
      this.terminals.delete(sessionId);

      logger.log(colors.yellow(`Terminal closed for session ${truncateForLog(sessionId)}`));
    }
  }

  /**
   * Clean up old terminals
   */
  cleanup(maxAge: number = 30 * 60 * 1000): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [sessionId, sessionTerminal] of this.terminals) {
      if (now - sessionTerminal.lastUpdate > maxAge) {
        toRemove.push(sessionId);
      }
    }

    for (const sessionId of toRemove) {
      logger.log(
        colors.yellow(`Cleaning up stale terminal for session ${truncateForLog(sessionId)}`)
      );
      this.closeTerminal(sessionId);
    }

    if (toRemove.length > 0) {
      logger.log(colors.gray(`Cleaned up ${toRemove.length} stale terminals`));
    }
  }

  /** Write live output to the terminal, then let listeners know (debounced). */
  private writeOutput(sessionId: string, sessionTerminal: SessionTerminal, data: string) {
    if (this.terminals.get(sessionId) !== sessionTerminal) return;
    try {
      sessionTerminal.changeCount = (sessionTerminal.changeCount ?? 0) + 1;
      sessionTerminal.terminal.write(data);
    } catch (error) {
      // Use error deduplicator to prevent log spam
      const contextKey = `${sessionId}:terminal-write`;

      if (this.errorDeduplicator.shouldLog(error, contextKey)) {
        const stats = this.errorDeduplicator.getErrorStats(error, contextKey);

        if (stats && stats.count > 1) {
          // Log summary for repeated errors
          logger.warn(
            formatErrorSummary(
              error,
              stats,
              `terminal write for session ${truncateForLog(sessionId)}`
            )
          );
        } else {
          // First occurrence - log with more detail
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.warn(
            `Terminal write error for session ${truncateForLog(sessionId)}: ${errorMessage}`
          );
          if (error instanceof Error && error.stack) {
            logger.debug(`Write error stack: ${error.stack}`);
          }
        }
      }
    }

    this.scheduleBufferChangeNotification(sessionId);
  }

  /**
   * Get all active terminals
   */
  getActiveTerminals(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Subscribe to buffer changes for a session
   */
  async subscribeToBufferChanges(
    sessionId: string,
    listener: BufferChangeListener
  ): Promise<() => void> {
    // Ensure terminal exists and is watching
    try {
      await this.getTerminal(sessionId);
    } catch (error) {
      if (!(error instanceof SessionOutputGoneError)) {
        logger.error(
          `Failed to init terminal for subscription ${truncateForLog(sessionId)}:`,
          error
        );
      }
    }

    if (!this.bufferListeners.has(sessionId)) {
      this.bufferListeners.set(sessionId, new Set());
    }

    const listeners = this.bufferListeners.get(sessionId);
    if (listeners) {
      listeners.add(listener);
      logger.log(
        colors.blue(`Buffer listener subscribed for session ${sessionId} (${listeners.size} total)`)
      );
    }

    // Send an immediate snapshot so new subscribers see a preview without waiting for output
    try {
      const snapshot = await this.getBufferSnapshot(sessionId);
      listener(sessionId, snapshot);
    } catch (error) {
      logger.error(
        `Error getting initial buffer snapshot for ${truncateForLog(sessionId)}:`,
        error
      );
    }

    // Return unsubscribe function
    return () => {
      const listeners = this.bufferListeners.get(sessionId);
      if (listeners) {
        listeners.delete(listener);
        logger.log(
          colors.yellow(
            `Buffer listener unsubscribed for session ${sessionId} (${listeners.size} remaining)`
          )
        );
        if (listeners.size === 0) {
          this.bufferListeners.delete(sessionId);
        }
      }
    };
  }

  /**
   * Schedule buffer change notification (debounced)
   */
  private scheduleBufferChangeNotification(sessionId: string) {
    // Cancel existing timer
    const existingTimer = this.changeTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new notification in 50ms
    const timer = setTimeout(() => {
      this.changeTimers.delete(sessionId);
      this.notifyBufferChange(sessionId);
    }, 50);

    this.changeTimers.set(sessionId, timer);
  }

  /**
   * Notify listeners of buffer change
   */
  private async notifyBufferChange(sessionId: string) {
    const listeners = this.bufferListeners.get(sessionId);
    if (!listeners || listeners.size === 0) return;

    // logger.debug(
    //   `Notifying ${listeners.size} buffer change listeners for session ${truncateForLog(sessionId)}`
    // );

    try {
      // Get full buffer snapshot
      const snapshot = await this.getBufferSnapshot(sessionId);

      // Notify all listeners
      listeners.forEach((listener) => {
        try {
          listener(sessionId, snapshot);
        } catch (error) {
          logger.error(
            `Error notifying buffer change listener for ${truncateForLog(sessionId)}:`,
            error
          );
        }
      });
    } catch (error) {
      logger.error(
        `Error getting buffer snapshot for notification ${truncateForLog(sessionId)}:`,
        error
      );
    }
  }

  /**
   * Destroy the terminal manager and restore console overrides
   */
  destroy(): void {
    // Close all terminals
    for (const sessionId of this.terminals.keys()) {
      this.closeTerminal(sessionId);
    }

    // Clear all timers
    for (const timer of this.changeTimers.values()) {
      clearTimeout(timer);
    }
    this.changeTimers.clear();
  }
}
