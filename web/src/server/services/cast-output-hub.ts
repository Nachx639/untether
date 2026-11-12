import * as fs from 'fs';
import * as path from 'path';
import type { SessionManager } from '../pty/session-manager.js';
import type { AsciinemaHeader } from '../pty/types.js';
import {
  CAST_CLIENT_REPLAY_MAX_BYTES,
  CAST_REPLAY_MAX_BYTES,
  castReplayStart,
  findLastResizeBefore,
  findLineStart,
  forEachCastLine,
  scanCastModeSequences,
} from '../utils/cast-tail.js';
import { colors } from '../utils/colors.js';
import { createLogger } from '../utils/logger.js';
import { every } from '../utils/periodic-loop.js';
import {
  calculatePruningPositionInFile,
  containsPruningSequence,
  findLastPrunePoint,
  logPruningDetection,
} from '../utils/pruning-detector.js';
import { decModesToSequence, trackDecModes } from '../utils/terminal-modes.js';

const logger = createLogger('cast-output-hub');

const HEADER_READ_BUFFER_SIZE = 4096;

/**
 * How often a followed cast is checked for output its fs.watch did not report. On macOS a write
 * landing just after the watcher starts goes unreported (2026-10-04: output appended right after
 * a phone subscribed stayed off it until the next write, for good on an idle session). A check
 * with nothing new is one stat.
 */
const WATCH_POLL_MS = 1000;

/**
 * How long a followed session's folder must stay missing before the session counts as gone: one
 * deleted and made again under the same id within it goes on being followed.
 */
const SESSION_GONE_GRACE_MS = 10_000;

type AsciinemaOutputEvent = [number, 'o', string];
type AsciinemaInputEvent = [number, 'i', string];
type AsciinemaResizeEvent = [number, 'r', string];
type AsciinemaExitEvent = ['exit', number, string];
type AsciinemaEvent =
  | AsciinemaOutputEvent
  | AsciinemaInputEvent
  | AsciinemaResizeEvent
  | AsciinemaExitEvent;

function isOutputEvent(event: AsciinemaEvent): event is AsciinemaOutputEvent {
  return (
    Array.isArray(event) && event.length === 3 && event[1] === 'o' && typeof event[0] === 'number'
  );
}

function isResizeEvent(event: AsciinemaEvent): event is AsciinemaResizeEvent {
  return (
    Array.isArray(event) && event.length === 3 && event[1] === 'r' && typeof event[0] === 'number'
  );
}

function isExitEvent(event: AsciinemaEvent): event is AsciinemaExitEvent {
  return Array.isArray(event) && event[0] === 'exit';
}

export type CastOutputHubEvent =
  | { kind: 'header'; header: AsciinemaHeader }
  | { kind: 'output'; data: string; historical: boolean }
  | { kind: 'resize'; dimensions: string; historical: boolean }
  | { kind: 'exit'; exitCode: number }
  | { kind: 'error'; message: string }
  /**
   * The history replay ends here, live events follow. A phone holds its terminal's paint
   * until it comes: painting 16 MB of replay as it arrived scrolled the whole history past
   * from the top on every open (2026-10-04).
   */
  | { kind: 'replay-end' };

export type CastOutputHubListener = (event: CastOutputHubEvent) => void;

/**
 * Stops a subscription when called. `resync` resets the subscriber's terminal and replays the
 * recent history again, then follows live: for a client that could not keep up and had live
 * output dropped (agent-stream-coalescer.ts).
 */
export type CastSubscription = (() => void) & { resync: () => void };

/** Most characters of history replay output sent as one event (and one WebSocket frame). */
const REPLAY_CHUNK_CHARS = 256 * 1024;

/** Sent before the history a reset replays: a full terminal reset (RIS). */
const RESET_EVENT: CastOutputHubEvent = { kind: 'output', data: '\x1bc', historical: true };

interface HubClient {
  /** Takes a live event; held back while this client's replay runs. */
  deliver: CastOutputHubListener;
  /** (Re)plays the history up to lastOffset, first resetting the terminal when asked. */
  replay: (reset: boolean) => void;
}

interface WatcherInfo {
  streamPath: string;
  clients: Set<HubClient>;
  watcher?: fs.FSWatcher;
  /** Reads new output now and then in case the watcher missed a change (WATCH_POLL_MS). */
  poll?: NodeJS.Timeout;
  /**
   * End of the last complete line handed to the clients: live follow reads on from here, a
   * new subscriber's replay ends here. A trailing partial line is read again once it ends, so
   * a UTF-8 character split across two writes stays whole.
   */
  lastOffset: number;
  /** A read is running; `readAgain` asks it for one more pass when it is done. */
  reading: boolean;
  readAgain: boolean;
  retryTimer?: NodeJS.Timeout;
  /** Its clients were told the session exited (its exit line, or its folder gone). */
  exited?: boolean;
  /** When its session folder was first seen missing; cleared once it is there again. */
  folderMissingSince?: number;
}

export class CastOutputHub {
  private activeWatchers: Map<string, WatcherInfo> = new Map();
  /** Most bytes a live follower may fall behind before skipping (CAST_REPLAY_MAX_BYTES). */
  private replayMaxBytes: number;
  /** Most bytes of history replayed to a new subscriber (CAST_CLIENT_REPLAY_MAX_BYTES). */
  private historyMaxBytes: number;
  /** SESSION_GONE_GRACE_MS. */
  private goneGraceMs: number;
  /** WATCH_POLL_MS (tests shorten it to see several polls without waiting seconds). */
  private pollMs: number;

  constructor(
    private sessionManager: SessionManager,
    options: {
      replayMaxBytes?: number;
      historyMaxBytes?: number;
      goneGraceMs?: number;
      pollMs?: number;
    } = {}
  ) {
    this.replayMaxBytes = options.replayMaxBytes ?? CAST_REPLAY_MAX_BYTES;
    this.historyMaxBytes =
      options.historyMaxBytes ?? Math.min(CAST_CLIENT_REPLAY_MAX_BYTES, this.replayMaxBytes);
    this.goneGraceMs = options.goneGraceMs ?? SESSION_GONE_GRACE_MS;
    this.pollMs = options.pollMs ?? WATCH_POLL_MS;
    process.on('beforeExit', () => this.cleanup());
  }

  subscribe(sessionId: string, listener: CastOutputHubListener): CastSubscription {
    const paths = this.sessionManager.getSessionPaths(sessionId, true);
    if (!paths) {
      listener({ kind: 'error', message: 'Session paths not found' });
      return Object.assign(() => {}, { resync: () => {} });
    }

    const streamPath = paths.stdoutPath;
    let watcherInfo = this.activeWatchers.get(sessionId);

    if (!watcherInfo) {
      watcherInfo = {
        streamPath,
        clients: new Set(),
        lastOffset: 0,
        reading: false,
        readAgain: false,
      };
      this.activeWatchers.set(sessionId, watcherInfo);

      // Live follow starts after the last complete line; a half-written one is read live.
      if (fs.existsSync(streamPath)) {
        watcherInfo.lastOffset = findLineStart(streamPath, fs.statSync(streamPath).size);
      }

      // Start watching (or retry until file exists).
      this.startWatchingWithRetry(sessionId, watcherInfo);
    }

    // 2026-10-02: the replay read the file to EOF asynchronously while live events were
    // already delivered to the same listener, so a session writing while a phone
    // (re)subscribed showed new output before the history and lines from both paths
    // twice. Replay stops where live follow starts and live events wait for it.
    let pending: CastOutputHubEvent[] | null = null;
    let active = true;
    let replays = 0;
    const info = watcherInfo;
    const client: HubClient = {
      deliver: (event) => {
        if (pending) pending.push(event);
        else if (active) listener(event);
      },
      replay: (reset) => {
        // A newer replay (after a reset) supersedes one still running.
        const replay = ++replays;
        const replayListener: CastOutputHubListener = (event) => {
          if (active && replay === replays) listener(event);
        };
        pending = [];
        if (reset) replayListener(RESET_EVENT);
        const done = () => {
          if (replay !== replays) return;
          const queued = pending ?? [];
          pending = null;
          replayListener({ kind: 'replay-end' });
          for (const event of queued) replayListener(event);
        };
        // After a reset the saved clear offset points into the old content: scan for one.
        this.sendExistingContent(
          sessionId,
          info.streamPath,
          info.lastOffset,
          !reset,
          replayListener,
          done
        );
      },
    };
    watcherInfo.clients.add(client);
    client.replay(false);

    const unsubscribe = () => {
      active = false;
      pending = null;
      const current = this.activeWatchers.get(sessionId);
      if (!current) return;
      current.clients.delete(client);

      if (current.clients.size === 0) {
        this.stopWatching(sessionId);
      }
    };
    return Object.assign(unsubscribe, {
      resync: () => {
        if (active && this.activeWatchers.get(sessionId) === info) client.replay(true);
      },
    });
  }

  private stopWatching(sessionId: string) {
    const watcherInfo = this.activeWatchers.get(sessionId);
    if (!watcherInfo) return;

    watcherInfo.retryTimer && clearTimeout(watcherInfo.retryTimer);
    watcherInfo.watcher?.close();
    watcherInfo.watcher = undefined;
    clearInterval(watcherInfo.poll);
    this.activeWatchers.delete(sessionId);
    logger.debug(colors.yellow(`stopped cast watcher for session ${sessionId}`));
  }

  private startWatchingWithRetry(sessionId: string, watcherInfo: WatcherInfo) {
    if (watcherInfo.watcher) return;

    if (!fs.existsSync(watcherInfo.streamPath)) {
      if (this.stopIfSessionGone(sessionId, watcherInfo)) return;
      watcherInfo.retryTimer = setTimeout(() => {
        watcherInfo.retryTimer = undefined;
        this.startWatchingWithRetry(sessionId, watcherInfo);
      }, 200);
      return;
    }

    this.startWatching(sessionId, watcherInfo);
  }

  private startWatching(sessionId: string, watcherInfo: WatcherInfo): void {
    // The poll goes first and alone if the watch cannot be made (the cast deleted since the
    // check above, no descriptors left): it reads the same output, and finds a gone session.
    // 2026-11-10: fs.watch threw here from a retry timer, an uncaught exception: server down.
    this.startPoll(sessionId, watcherInfo);
    try {
      watcherInfo.watcher = fs.watch(watcherInfo.streamPath, { persistent: true }, (eventType) => {
        if (eventType === 'change') void this.readNewOutput(sessionId, watcherInfo);
      });
    } catch (error) {
      logger.warn(`could not watch the cast of session ${sessionId} (polling it instead):`, error);
      return;
    }

    watcherInfo.watcher.on('error', (error) => {
      logger.error(`file watcher error for session ${sessionId}:`, error);
    });

    logger.debug(colors.green(`watching cast file for session ${sessionId}`));
  }

  private startPoll(sessionId: string, watcherInfo: WatcherInfo): void {
    if (watcherInfo.poll) return;
    watcherInfo.poll = every(
      'cast output poll',
      () => this.readNewOutput(sessionId, watcherInfo),
      this.pollMs
    );
    watcherInfo.poll.unref?.();
  }

  /**
   * Hand the complete lines written since lastOffset to the clients, in order and once each.
   * 2026-10-04: this read all new bytes in one buffer and decoded them in one go, so a burst
   * of hundreds of MB was held whole in memory, and one past V8's string limit threw and lost
   * every line in it. Lines now stream in 256 KB chunks (forEachCastLine), the next chunk read
   * only after this one's lines went out, so sockets drain in between (a client that falls
   * MAX_CLIENT_BUFFERED_BYTES behind is dropped by the WebSocket hub). A follower more than
   * replayMaxBytes behind skips to the end like a new subscriber's replay, and says so.
   */
  private async readNewOutput(sessionId: string, watcherInfo: WatcherInfo): Promise<void> {
    if (watcherInfo.reading) {
      watcherInfo.readAgain = true;
      return;
    }
    watcherInfo.reading = true;
    try {
      do {
        watcherInfo.readAgain = false;
        if (this.activeWatchers.get(sessionId) !== watcherInfo) return;
        const streamPath = watcherInfo.streamPath;
        const size = (await fs.promises.stat(streamPath)).size;
        if (size < watcherInfo.lastOffset) {
          // 2026-10-04: a cast that shrank (a forwarder restarted under the same id truncates
          // it) never passed the old offset again, so its clients froze. Start over: reset
          // their terminals and replay the new file's bounded tail, then follow it.
          logger.warn(
            `cast of ${sessionId} shrank to ${size} bytes (was followed up to ${watcherInfo.lastOffset}); resetting its live stream`
          );
          watcherInfo.lastOffset = findLineStart(streamPath, size);
          watcherInfo.exited = false;
          for (const client of watcherInfo.clients) client.replay(true);
          this.startPoll(sessionId, watcherInfo); // stopped if the old content ended in an exit
          watcherInfo.readAgain = true;
          continue;
        }
        const behind = size - watcherInfo.lastOffset;
        if (behind <= 0) continue;
        if (behind > this.replayMaxBytes) {
          const { start } = await castReplayStart(
            streamPath,
            watcherInfo.lastOffset,
            size,
            this.replayMaxBytes
          );
          logger.warn(
            `skipped ${Math.round((start - watcherInfo.lastOffset) / 1024)} KB of output of ${sessionId}: its live stream fell more than ${Math.round(this.replayMaxBytes / 1024)} KB behind`
          );
          watcherInfo.lastOffset = start;
        }
        await forEachCastLine(streamPath, watcherInfo.lastOffset, size, (line, lineEnd) => {
          // Moved line by line: a subscriber joining mid-read replays exactly up to here.
          watcherInfo.lastOffset = lineEnd;
          if (line.trim()) this.broadcastLine(sessionId, line, watcherInfo);
        });
      } while (watcherInfo.readAgain);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A cleaned-up session: the poll would log this every second until its clients leave.
        if (!this.stopIfSessionGone(sessionId, watcherInfo)) {
          logger.debug(`cast of ${sessionId} is gone`);
        }
      } else {
        logger.error(`failed to read file changes for session ${sessionId}:`, error);
      }
    } finally {
      watcherInfo.reading = false;
    }
  }

  /**
   * 2026-10-24: a session whose control folder was deleted (DELETE /api/sessions/:id, a finished
   * task) was followed for as long as a client stayed: a stat every second, a retry every 200 ms
   * when its cast was gone before the watch began. Its folder gone, the session is over: its
   * clients hear it exited (unless they already did) and the following stops. A cast missing
   * from a folder that is still there is only waited for (a forwarder writing it anew), and so
   * is a missing folder for goneGraceMs (made again under the same id). subscribe() follows only
   * a session whose folder exists, so a missing one was there and is now deleted.
   */
  private stopIfSessionGone(sessionId: string, watcherInfo: WatcherInfo): boolean {
    if (fs.existsSync(path.dirname(watcherInfo.streamPath))) {
      watcherInfo.folderMissingSince = undefined;
      return false;
    }
    const now = Date.now();
    watcherInfo.folderMissingSince ??= now;
    if (now - watcherInfo.folderMissingSince < this.goneGraceMs) return false;
    if (this.activeWatchers.get(sessionId) !== watcherInfo) return true;
    logger.debug(`session ${sessionId} is gone; no longer following its cast`);
    this.stopWatching(sessionId);
    if (!watcherInfo.exited) {
      watcherInfo.exited = true;
      // Its exit code went with its folder.
      for (const client of watcherInfo.clients) client.deliver({ kind: 'exit', exitCode: -1 });
    }
    return true;
  }

  private parseAsciinemaLine(line: string): AsciinemaEvent | AsciinemaHeader | null {
    if (!line.trim()) return null;
    try {
      const parsed = JSON.parse(line);
      if (parsed.version && parsed.width && parsed.height) return parsed as AsciinemaHeader;
      if (Array.isArray(parsed)) {
        if (parsed[0] === 'exit') return parsed as AsciinemaExitEvent;
        if (parsed.length >= 3 && typeof parsed[0] === 'number') return parsed as AsciinemaEvent;
      }
      return null;
    } catch {
      return null;
    }
  }

  private broadcastLine(_sessionId: string, line: string, watcherInfo: WatcherInfo): void {
    const parsed = this.parseAsciinemaLine(line);
    if (!parsed) {
      // Treat as raw output line
      for (const client of watcherInfo.clients) {
        client.deliver({ kind: 'output', data: line, historical: false });
      }
      return;
    }

    // Skip headers during live follow (clients already got one from existing content).
    if (!Array.isArray(parsed)) return;

    if (isExitEvent(parsed)) {
      // Nothing follows an exit: the watcher alone notices a restart under the same id.
      clearInterval(watcherInfo.poll);
      watcherInfo.poll = undefined;
      watcherInfo.exited = true;
      for (const client of watcherInfo.clients) {
        client.deliver({ kind: 'exit', exitCode: parsed[1] });
      }
      return;
    }

    if (isOutputEvent(parsed)) {
      for (const client of watcherInfo.clients) {
        client.deliver({ kind: 'output', data: parsed[2], historical: false });
      }
    } else if (isResizeEvent(parsed)) {
      for (const client of watcherInfo.clients) {
        client.deliver({ kind: 'resize', dimensions: parsed[2], historical: false });
      }
    }
  }

  private processClearSequence(
    event: AsciinemaOutputEvent,
    eventIndex: number,
    fileOffset: number,
    currentResize: AsciinemaResizeEvent | null,
    eventLine: string
  ): {
    lastClearIndex: number;
    lastClearOffset: number;
    lastResizeBeforeClear: AsciinemaResizeEvent | null;
  } | null {
    const prunePoint = findLastPrunePoint(event[2]);
    if (!prunePoint) return null;

    const lastClearOffset = calculatePruningPositionInFile(
      fileOffset,
      eventLine,
      prunePoint.position
    );
    logPruningDetection(prunePoint.sequence, lastClearOffset, '(retroactive scan)');

    return {
      lastClearIndex: eventIndex,
      lastClearOffset,
      lastResizeBeforeClear: currentResize,
    };
  }

  private sendExistingContent(
    sessionId: string,
    streamPath: string,
    endOffset: number,
    useSavedClear: boolean,
    listener: CastOutputHubListener,
    onDone: () => void
  ) {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onDone();
    };
    const fail = (error: unknown) => {
      logger.error(`failed to send existing cast content for ${sessionId}:`, error);
      listener({ kind: 'error', message: 'Failed to read session output' });
      finish();
    };
    this.replayExistingContent(sessionId, streamPath, endOffset, useSavedClear, listener)
      .then(finish)
      .catch(fail);
  }

  /**
   * Replay the history in [last clear, endOffset): the header, the modes the app set, then the
   * events from the last clear on. At most historyMaxBytes of it (2026-10-04): a long Claude
   * Code session's 1 GB cast had 430 MB after its last clear, all kept in memory here and
   * queued on the socket (history is exempt from the client buffer limit). A longer history
   * starts on the first whole event line in its last historyMaxBytes, at the terminal size in
   * effect there; a full-screen app's repaints in them draw the current screen. Without
   * `useSavedClear` the session's lastClearOffset is not trusted and the range is scanned.
   */
  private async replayExistingContent(
    sessionId: string,
    streamPath: string,
    endOffset: number,
    useSavedClear: boolean,
    listener: CastOutputHubListener
  ): Promise<void> {
    const sessionInfo = this.sessionManager.loadSessionInfo(sessionId);
    let clearOffset = useSavedClear ? (sessionInfo?.lastClearOffset ?? 0) : 0;
    const size = fs.existsSync(streamPath) ? fs.statSync(streamPath).size : 0;
    if (clearOffset > size) {
      // 2026-10-04: saved against a longer cast (a forwarder restarted under the same id
      // truncates it). Clamped to the size it left nothing to replay, and a reconnect showed
      // no history. It says nothing about this file: replay its bounded tail instead.
      logger.warn(
        `ignoring lastClearOffset ${clearOffset} of ${sessionId}: its cast is only ${size} bytes`
      );
      clearOffset = 0;
    }
    clearOffset = Math.min(clearOffset, endOffset);
    // lastClearOffset points inside the event that contains the clear sequence. Start at
    // that event's line so it parses; otherwise the frame drawn right after the clear in
    // the same write (Claude Code does `ESC[2J` + full redraw at once) is lost.
    clearOffset = findLineStart(streamPath, clearOffset);

    // Read header line (best-effort)
    let header: AsciinemaHeader | null = null;
    let fd: number | null = null;
    try {
      fd = fs.openSync(streamPath, 'r');
      const buf = Buffer.alloc(HEADER_READ_BUFFER_SIZE);
      let data = '';
      let filePosition = 0;
      let bytesRead = fs.readSync(fd, buf, 0, buf.length, filePosition);

      while (!data.includes('\n') && bytesRead > 0) {
        data += buf.toString('utf8', 0, bytesRead);
        filePosition += bytesRead;
        if (!data.includes('\n')) {
          bytesRead = fs.readSync(fd, buf, 0, buf.length, filePosition);
        }
      }

      const idx = data.indexOf('\n');
      if (idx !== -1) header = JSON.parse(data.slice(0, idx));
    } catch {
      // ignore
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
    }

    if (endOffset <= clearOffset) {
      // Nothing to replay yet (no file, or nothing after the last clear).
      if (header) listener({ kind: 'header', header });
      return;
    }

    const { start: startOffset, truncated } = await castReplayStart(
      streamPath,
      clearOffset,
      endOffset,
      this.historyMaxBytes
    );
    // The size the terminal had where the replay starts: past the header (a cut replay, or one
    // from the saved clear) the header's is long gone. 2026-10-14: a replay from the saved clear
    // of a Claude session resized from 120 to 84 columns before it went out with the header's
    // 120 and drew its screen torn, rows missing.
    const sizeAtStart =
      startOffset > 0 ? await findLastResizeBefore(streamPath, startOffset) : null;
    if (truncated) {
      logger.log(
        `replaying the last ${Math.round((endOffset - startOffset) / 1024)} KB of ${Math.round((endOffset - clearOffset) / 1024)} KB of history of ${sessionId}`
      );
    }

    const events: AsciinemaEvent[] = [];
    let lastClearIndex = -1;
    const resizeAtStart: AsciinemaResizeEvent | null = sizeAtStart ? [0, 'r', sizeAtStart] : null;
    let currentResize = resizeAtStart;
    let lastResizeBeforeClear: AsciinemaResizeEvent | null = null;
    let lastClearOffset = startOffset;

    const processLine = (line: string, fileOffset: number) => {
      if (!line.trim()) return;

      try {
        const parsed = JSON.parse(line);
        if (parsed.version && parsed.width && parsed.height) {
          header = parsed as AsciinemaHeader;
          return;
        }

        if (!Array.isArray(parsed)) return;

        if (parsed[0] === 'exit') {
          events.push(parsed as AsciinemaExitEvent);
          return;
        }

        if (parsed.length < 3 || typeof parsed[0] !== 'number') return;
        const event = parsed as AsciinemaEvent;

        if (isResizeEvent(event)) currentResize = event;

        if (isOutputEvent(event) && containsPruningSequence(event[2])) {
          const clearResult = this.processClearSequence(
            event as AsciinemaOutputEvent,
            events.length,
            fileOffset,
            currentResize,
            line
          );
          if (clearResult) {
            lastClearIndex = clearResult.lastClearIndex;
            lastClearOffset = clearResult.lastClearOffset;
            lastResizeBeforeClear = clearResult.lastResizeBeforeClear;
          }
        }

        events.push(event);
      } catch {
        // ignore invalid lines
      }
    };

    await forEachCastLine(streamPath, startOffset, endOffset, processLine);

    let startIndex = 0;
    let clearedPrefix = '';
    if (lastClearIndex >= 0) {
      // Whatever the clearing event wrote after its last clear sequence is the current
      // screen (Claude Code clears and redraws in one write), so replay that remainder.
      startIndex = lastClearIndex + 1;
      const clearEvent = events[lastClearIndex] as AsciinemaOutputEvent;
      const prunePoint = findLastPrunePoint(clearEvent[2]);
      const remainder = prunePoint ? clearEvent[2].slice(prunePoint.position) : '';
      if (remainder && prunePoint) {
        clearedPrefix = clearEvent[2].slice(0, prunePoint.position);
        startIndex = lastClearIndex;
        events[lastClearIndex] = [clearEvent[0], clearEvent[1], remainder];
      }
      // Reload before saving: the stream read may be long and other fields (terminal
      // modes) may have been saved meanwhile.
      const latestInfo = this.sessionManager.loadSessionInfo(sessionId);
      if (latestInfo) {
        latestInfo.lastClearOffset = lastClearOffset;
        this.sessionManager.saveSessionInfo(sessionId, latestInfo);
      }
    }

    if (header) {
      const headerToSend = { ...(header as AsciinemaHeader) };
      const sizeEvent = lastClearIndex >= 0 ? lastResizeBeforeClear : resizeAtStart;
      if (sizeEvent) {
        const [w, h] = sizeEvent[2].split('x');
        headerToSend.width = Number.parseInt(w, 10);
        headerToSend.height = Number.parseInt(h, 10);
      }
      listener({ kind: 'header', header: headerToSend });
    }

    // Restore modes the app set before the replayed range (mouse reporting etc.), only
    // while it runs: an exited session's saved modes may never have been cleared (the
    // exit clears them on a 250 ms timer, a session the zombie scan marked exited never
    // does), and mouse reporting for a dead process sends the wheel nowhere (2026-10-04).
    let terminalModes = sessionInfo?.terminalModes;
    if (sessionInfo?.status === 'running' && !terminalModes) {
      // A session this server does not run (a Mac window forwarded by ut-fwd): nobody tracked
      // its modes, so they are read from the history left out of the replay (user report
      // 2026-10-14: Claude Code's fullscreen renderer turns on mouse reporting once at start,
      // before its first clear, so a phone opening a Mac-window session never learned it and
      // scrolling moved the phone's own scrollback, taking Claude's pinned prompt with it).
      terminalModes = await this.scanCastModes(sessionId, streamPath, startOffset, header, size);
      for (let i = 0; i < startIndex; i++) {
        const event = events[i];
        if (isOutputEvent(event)) trackDecModes(terminalModes, event[2]);
      }
      // Only the remainder of the clearing event is replayed: what came before it counts.
      if (clearedPrefix) trackDecModes(terminalModes, clearedPrefix);
    }
    const modes = sessionInfo?.status === 'exited' ? '' : decModesToSequence(terminalModes);
    if (modes) listener({ kind: 'output', data: modes, historical: true });

    // Consecutive output goes out joined, up to REPLAY_CHUNK_CHARS at a time: one frame per
    // cast event made a 1 MB history of short lines 214k WebSocket messages, which a phone
    // took 2.8 s to take in where ghostty parses the whole megabyte in 18 ms (2026-10-04).
    let chunk: string[] = [];
    let chunkLength = 0;
    const sendChunk = () => {
      if (chunk.length === 0) return;
      listener({ kind: 'output', data: chunk.join(''), historical: true });
      chunk = [];
      chunkLength = 0;
    };
    for (let i = startIndex; i < events.length; i++) {
      const event = events[i];
      if (isOutputEvent(event)) {
        chunk.push(event[2]);
        chunkLength += event[2].length;
        if (chunkLength >= REPLAY_CHUNK_CHARS) sendChunk();
        continue;
      }
      sendChunk();
      if (isExitEvent(event)) {
        listener({ kind: 'exit', exitCode: event[1] });
      } else if (isResizeEvent(event)) {
        listener({ kind: 'resize', dimensions: event[2], historical: true });
      }
    }
    sendChunk();
  }

  /**
   * The DEC modes in effect at `offset` (a line start) of the cast of a session this server
   * does not run. Read once from the start of the cast (about 1 ms per MB), then only from
   * where the last read stopped, kept in session.json (castModes). Read again from the start
   * when the cast was replaced (another header) or cut.
   */
  private async scanCastModes(
    sessionId: string,
    streamPath: string,
    offset: number,
    header: unknown,
    size: number
  ): Promise<Record<string, boolean>> {
    const timestamp = (header as Partial<AsciinemaHeader> | null)?.timestamp;
    const cast = String(timestamp ?? '');
    const saved = this.sessionManager.loadSessionInfo(sessionId)?.castModes;
    const reuse = saved && saved.cast === cast && saved.offset <= offset && saved.offset <= size;
    const modes: Record<string, boolean> = reuse ? { ...saved.modes } : {};
    const from = reuse ? saved.offset : 0;
    const scannedTo = await scanCastModeSequences(streamPath, from, offset, (sequence) =>
      trackDecModes(modes, sequence)
    );
    if (!reuse || scannedTo !== saved.offset) {
      // Reload before saving, as for lastClearOffset: other fields may have changed meanwhile.
      const latest = this.sessionManager.loadSessionInfo(sessionId);
      if (latest) {
        latest.castModes = { cast, offset: scannedTo, modes: { ...modes } };
        this.sessionManager.saveSessionInfo(sessionId, latest);
      }
    }
    return modes;
  }

  private cleanup(): void {
    for (const [sessionId] of this.activeWatchers) {
      this.stopWatching(sessionId);
    }
  }
}
