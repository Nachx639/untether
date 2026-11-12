/**
 * Connection Manager for Session View
 *
 * Handles terminal stream connections over WebSocket v3 (single-socket transport)
 * for terminal sessions.
 */

import type { Session } from '../../../shared/types.js';
import { t } from '../../i18n/index.js';
import { terminalSocketClient } from '../../services/terminal-socket-client.js';
import { toast } from '../../utils/action-toast.js';
import { createLogger } from '../../utils/logger.js';
import type { Terminal } from '../terminal.js';
import { Osc52Scanner } from '../terminal-clipboard.js';
import { ReprintTrimmer } from './reprint-trim.js';

const logger = createLogger('connection-manager');

/** RIS: back to a blank screen and default modes; the replay restores the rest. */
const RESET_TERMINAL = '\x1bc';

/** While a replay holds the paint, output is written once this much has come in. */
const REPLAY_DRAIN_CHARS = 256 * 1024;

export class ConnectionManager {
  private unsubscribe: (() => void) | null = null;
  private terminal: Terminal | null = null;
  private session: Session | null = null;
  private isConnected = false;
  private stdoutDecoder = new TextDecoder();
  // Chunks joined on flush: thousands of `+=` between flushes (a burst of repaints)
  // build a deep rope string that crashed WebKit's JS engine when it was resolved.
  private outputBuffer: string[] = [];
  private batchTimeout: number | null = null;
  /** Stops the wait for a held repaint (reprint-trim.ts) of the stream being closed. */
  private stopTrimming: (() => void) | null = null;
  private onTerminalOutput: ((data: string) => void) | null = null;
  private ptySize: { cols: number; rows: number } | null = null;
  private onPtySize: ((size: { cols: number; rows: number }) => void) | null = null;

  constructor(
    private onSessionExit: (sessionId: string) => void,
    private onSessionUpdate: (session: Session) => void
  ) {}

  setOnTerminalOutput(callback: ((data: string) => void) | null): void {
    this.onTerminalOutput = callback;
  }

  /**
   * Called with the PTY's size whenever the stream says it (its header, then each resize, from
   * this client or another one).
   */
  setOnPtySize(callback: ((size: { cols: number; rows: number }) => void) | null): void {
    this.onPtySize = callback;
  }

  /**
   * The size the session's PTY has, which the app draws for: another client may have resized
   * it to a size this terminal does not have (2026-10-04: 53 columns drawn into the phone's 45,
   * whose copy of Claude's menu lost text). Null until the stream has said.
   */
  getPtySize(): { cols: number; rows: number } | null {
    return this.ptySize;
  }

  private notePtySize(cols: unknown, rows: unknown): void {
    if (typeof cols !== 'number' || typeof rows !== 'number') return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
    this.ptySize = { cols, rows };
    this.onPtySize?.(this.ptySize);
  }

  setTerminal(terminal: Terminal | null): void {
    this.terminal = terminal;
  }

  setSession(session: Session | null): void {
    this.session = session;
  }

  setConnected(connected: boolean): void {
    this.isConnected = connected;
  }

  connectToStream(): void {
    if (!this.terminal || !this.session) {
      logger.warn(`Cannot connect to stream - missing terminal or session`);
      return;
    }

    // Don't connect if we're already disconnected
    if (!this.isConnected) {
      logger.warn(`Component already disconnected, not connecting to stream`);
      return;
    }

    logger.log(`Connecting to v3 stream for session ${this.session.id}`);

    this.cleanupStreamConnection();
    this.ptySize = null;

    let buffered = 0;
    // The stream's error (session gone, subscribe failed …) is said once in the terminal.
    let errorShown = false;
    // A size from the replay not applied yet (see followPtySize).
    let sizePending = false;
    // Claude's repaint after a resize, its lines that would only scroll into the history
    // dropped (reprint-trim.ts): the grid it is written into has the PTY's size in a replay,
    // its own (never more rows) live.
    // Apps' clipboard writes (OSC 52: Claude Code's mouse selection, vim, tmux). Read from all
    // of the output, so one split across chunks is found, and acted on only live: a replay's
    // old copies never reach the clipboard (2026-10-31).
    const clipboardWrites = new Osc52Scanner();
    const trimmer = new ReprintTrimmer(() =>
      replaying ? this.ptySize : (this.terminal?.getGridSize?.() ?? null)
    );
    let trimTimer: number | null = null;
    const releaseHeld = () => {
      if (trimTimer !== null) clearTimeout(trimTimer);
      trimTimer = null;
      const held = trimmer.flush();
      if (held) enqueue(held);
    };
    this.stopTrimming = () => {
      if (trimTimer !== null) clearTimeout(trimTimer);
      trimTimer = null;
    };
    const flush = () => {
      if (!this.terminal) return;
      if (this.outputBuffer.length > 0) {
        const output = this.outputBuffer.join('');
        this.outputBuffer = [];
        buffered = 0;
        this.terminal.write(output, true);
      }
      this.batchTimeout = null;
    };

    const enqueue = (chunk: string) => {
      if (sizePending) applyPtySize();
      this.outputBuffer.push(chunk);
      buffered += chunk.length;
      // A replay is written as it comes, nothing is painted until its end: no reason to wait
      // for a frame between large chunks of it.
      if (buffered >= REPLAY_DRAIN_CHARS && this.terminal?.isPaintHeld?.()) {
        if (this.batchTimeout !== null) clearTimeout(this.batchTimeout);
        flush();
        return;
      }
      if (this.batchTimeout === null) {
        this.batchTimeout = window.setTimeout(flush, 16);
      }
    };

    // The server answers every SUBSCRIBE with a full replay (header first). After a
    // reconnect the terminal already shows that history, so it must start over.
    let shownOutput = false;

    // Painted once it is all written, at the bottom: painted as it came, up to 16 MB of
    // history scrolled past from the top on every open (2026-10-04). The server marks its end.
    this.terminal.holdPaint?.();
    // Between the header and replay-end the output is history (see followPtySize).
    let replaying = true;
    const endReplay = () => {
      releaseHeld();
      if (sizePending) applyPtySize();
      flush();
      if (replaying) {
        replaying = false;
        this.terminal?.ptyReplayEnded?.();
      }
      this.terminal?.releasePaint?.();
    };

    /**
     * 2026-10-12: the output that follows was drawn for this size. Everything before it is
     * written first, at the size it was drawn for; then the grid follows (terminal.ts
     * followPtySize). A Mac window's 120 columns written into the phone's 80 came apart into
     * fragments and left copies of every repaint in the history.
     */
    const applyPtySize = () => {
      sizePending = false;
      const size = this.ptySize;
      if (!size) return;
      if (this.batchTimeout !== null) clearTimeout(this.batchTimeout);
      flush();
      this.terminal?.followPtySize?.(size.cols, size.rows, replaying);
    };
    /**
     * In a replay a size takes effect when output drawn for it comes: of back-to-back sizes
     * only the last one resizes (and reflows) the grid. User report 2026-10-14: a Mac window's
     * history resized it hundreds of times while «Cargando historial» was shown.
     */
    const followPtySize = () => {
      if (replaying) sizePending = true;
      else applyPtySize();
    };

    this.unsubscribe = terminalSocketClient.subscribe(this.session.id, {
      stdout: true,
      events: true,
      onStdout: (bytes) => {
        const chunk = this.stdoutDecoder.decode(bytes, { stream: true });
        if (this.onTerminalOutput) {
          this.onTerminalOutput(chunk);
        }
        shownOutput = true;
        for (const request of clipboardWrites.push(chunk)) {
          if (!replaying) this.terminal?.copyFromApp?.(request);
        }
        const text = trimmer.push(chunk);
        if (text) enqueue(text);
        // Live, a repaint held for its end is written after a moment at the latest.
        if (trimmer.isHolding() && !replaying && trimTimer === null) {
          trimTimer = window.setTimeout(releaseHeld, 150);
        }
      },
      onEvent: (event) => {
        if (!this.session) return;

        // v3 server events: { kind: 'exit', ... } or { type: 'git-status-update', ... }
        if (typeof event === 'object' && event !== null) {
          const e = event as {
            kind?: string;
            exitCode?: number;
            type?: string;
            sessionId?: string;
          } & Record<string, unknown>;

          if (e.kind === 'header') {
            const header = e.header as { width?: unknown; height?: unknown } | undefined;
            replaying = true;
            // 2026-10-02: reconnect after the phone slept duplicated the whole scrollback.
            if (shownOutput) {
              this.outputBuffer = [];
              buffered = 0;
              this.stdoutDecoder = new TextDecoder();
              clipboardWrites.reset();
              enqueue(RESET_TERMINAL);
              // The screen keeps the old history until the new one is all in.
              this.terminal?.holdPaint?.();
            }
            this.ptySize = null;
            this.notePtySize(header?.width, header?.height);
            followPtySize();
            return;
          }

          if (e.kind === 'replay-end') {
            endReplay();
            return;
          }

          // The server dropped live output this page could not keep up with; a fresh replay
          // of the recent history follows (server/services/agent-stream-coalescer.ts).
          if (e.kind === 'output-skipped') {
            const kb = Math.max(1, Math.round(Number(e.chars) / 1024) || 0);
            logger.warn(`live output skipped for ${this.session.id}: ${kb} KB`);
            toast({ kind: 'info', text: t('terminal.outputSkipped', { kb }), timeoutMs: 6000 });
            return;
          }

          // The output after it is laid out at this size (followPtySize).
          if (e.kind === 'resize' && typeof e.dimensions === 'string') {
            const match = e.dimensions.match(/^(\d+)x(\d+)$/);
            if (match) {
              releaseHeld();
              this.notePtySize(Number(match[1]), Number(match[2]));
              followPtySize();
              trimmer.arm(Number(match[2]));
            }
            return;
          }

          if (e.kind === 'exit') {
            endReplay();
            this.onSessionExit(this.session.id);
            return;
          }

          if (e.type === 'git-status-update' && e.sessionId === this.session.id) {
            const updatedSession = {
              ...this.session,
              gitModifiedCount:
                (e.gitModifiedCount as number | undefined) ?? this.session.gitModifiedCount,
              gitAddedCount: (e.gitAddedCount as number | undefined) ?? this.session.gitAddedCount,
              gitDeletedCount:
                (e.gitDeletedCount as number | undefined) ?? this.session.gitDeletedCount,
              gitAheadCount: (e.gitAheadCount as number | undefined) ?? this.session.gitAheadCount,
              gitBehindCount:
                (e.gitBehindCount as number | undefined) ?? this.session.gitBehindCount,
              gitInsertionCount:
                (e.gitInsertionCount as number | undefined) ?? this.session.gitInsertionCount,
              gitDeletionCount:
                (e.gitDeletionCount as number | undefined) ?? this.session.gitDeletionCount,
            };
            this.session = updatedSession;
            this.onSessionUpdate(updatedSession);
          }
        }
      },
      onError: (message) => {
        logger.warn(`v3 stream error for session ${this.session?.id}: ${message}`);
        // 2026-10-20: a failed stream only logged, leaving a blank terminal with no hint of
        // why. Say it in the terminal itself, once per stream (and let a held paint go).
        if (errorShown || !this.terminal) return;
        errorShown = true;
        releaseHeld();
        if (this.batchTimeout !== null) clearTimeout(this.batchTimeout);
        flush();
        this.terminal.releasePaint?.();
        const text = t('terminal.streamError', { error: message || '?' });
        this.terminal.write(`\r\n\x1b[33m${text}\x1b[0m\r\n`, true);
      },
    });
  }

  cleanupStreamConnection(): void {
    this.stopTrimming?.();
    this.stopTrimming = null;
    if (this.batchTimeout !== null) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }
    this.outputBuffer = [];
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.terminal?.releasePaint?.();
  }
}
