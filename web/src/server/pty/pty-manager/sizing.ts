/** Session sizes: size owners and resize/reset requests. Part of PtyManager (pty-manager.ts). */

import * as fs from 'fs';

import { findLastResizeInRangeSync } from '../../utils/cast-tail.js';
import { every } from '../../utils/periodic-loop.js';
import {
  ANONYMOUS_OWNER,
  awayGiveBackDecision,
  type SizeGiveBackSkip,
  type SizeRequest,
  type SizeRequestSkip,
  sizeGiveBackDecision,
  sizeRequestDecision,
  WINDOW_OWNER,
} from '../size-owner.js';
import { PtyError, type ResetSizeControlMessage, type ResizeControlMessage } from '../types.js';
import { PtyManagerForeground } from './foreground.js';
import { logger, SIZE_SEED_LOOKBACK_BYTES, SIZE_SWEEP_INTERVAL_MS } from './helpers.js';

export abstract class PtyManagerSizing extends PtyManagerForeground {
  /** How the server learns whether a page still shows a session (ws-v3-hub isClientViewing). */
  setClientViewingCheck(check: (clientId: string, sessionId: string) => boolean): void {
    this.clientViewing = check;
  }

  /** How the server learns whether a page is still there (ws-v3-hub presence, PRESENT frames). */
  setClientPresenceChecks(checks: {
    awayMs: (clientId: string, sessionId: string) => number | null;
    viewedElsewhere: (sessionId: string, exceptClientId: string) => boolean;
  }): void {
    this.clientAway = checks.awayMs;
    this.viewedElsewhere = checks.viewedElsewhere;
  }

  /** Runs sweepSizeOwners while a page owns some Mac-window session's size. */
  protected ensureSizeSweep(): void {
    if (this.sizeSweepTimer) return;
    this.sizeSweepTimer = every(
      'pty size sweep',
      () => this.sweepSizeOwners(),
      SIZE_SWEEP_INTERVAL_MS
    );
    this.sizeSweepTimer.unref?.();
  }

  /**
   * Gives a Mac-window session's size back to its window when the page that owns it has been
   * away (hidden, locked, disconnected) for SIZE_AWAY_GIVE_BACK_MS and no other page really
   * looks at the session (size-owner.ts awayGiveBackDecision). User report (2026-10-14): a phone
   * locked for long kept the Mac window drawn at the phone's width; the phone runs no timers
   * while locked, so the server decides from when it last heard the page say it was there.
   * The page coming back does not take the size again until it is used (a tap, a key).
   */
  sweepSizeOwners(): void {
    const owned = this.sizeOwners.pageOwned().filter((o) => o.sessionId.startsWith('fwd_'));
    if (owned.length === 0) {
      if (this.sizeSweepTimer) clearInterval(this.sizeSweepTimer);
      this.sizeSweepTimer = null;
      return;
    }
    for (const { sessionId } of owned) {
      if (
        !this.sessionManager.getSessionPaths(sessionId, true) ||
        this.sessionManager.loadSessionInfo(sessionId)?.status === 'exited'
      ) {
        this.sizeOwners.forget(sessionId);
        continue;
      }
      // The window may have taken it back already (typed into).
      this.refreshSizeOwner(sessionId);
      const owner = this.sizeOwners.owner(sessionId);
      if (!owner) continue;
      const awayMs = this.clientAway(owner, sessionId);
      const viewedElsewhere = this.viewedElsewhere(sessionId, owner);
      if (!awayGiveBackDecision({ forwarded: true, owner, awayMs, viewedElsewhere })) continue;
      try {
        const result = this.resetSessionSize(sessionId, { clientId: owner, viewedElsewhere });
        if (result.reset) {
          logger.log(
            `session ${sessionId}: size given back to its window (owner away ${Math.round((awayMs ?? 0) / 1000)}s)`
          );
        }
      } catch (error) {
        // The forwarder is gone or not answering: tried again on the next sweep.
        logger.warn(
          `session ${sessionId}: could not give the size back to its window: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * The size the session's recording last says the PTY got since the server last looked: one
   * the server did not ask for means the Mac window took the size (size-owner.ts). Only for a
   * Mac-window session (its forwarder records the window's own resizes), and only the bytes
   * appended since the last look are read.
   */
  protected refreshSizeOwner(sessionId: string): void {
    if (!sessionId.startsWith('fwd_')) return;
    const paths = this.sessionManager.getSessionPaths(sessionId);
    if (!paths) return;
    let size: number;
    try {
      size = fs.statSync(paths.stdoutPath).size;
    } catch {
      return;
    }
    const from = this.sizeOwners.castOffset(sessionId);
    this.sizeOwners.setCastOffset(sessionId, size);
    if (from === null) {
      // First look: the size the PTY has now, from the recording's last resize.
      const seed = findLastResizeInRangeSync(
        paths.stdoutPath,
        Math.max(0, size - SIZE_SEED_LOOKBACK_BYTES),
        size
      )?.match(/^(\d+)x(\d+)$/);
      if (seed) this.sizeOwners.seedSize(sessionId, Number(seed[1]), Number(seed[2]));
      return;
    }
    if (from >= size) return;
    // Read on the event loop: never more than the last 16 MB, however much the session wrote
    // since the last look (a busy session left alone for hours). A window resize older than
    // that, with none after it, is missed; the next one is seen.
    const last = findLastResizeInRangeSync(
      paths.stdoutPath,
      Math.max(from, size - SIZE_SEED_LOOKBACK_BYTES),
      size
    );
    const match = last?.match(/^(\d+)x(\d+)$/);
    if (!match) return;
    if (this.sizeOwners.noteStreamSize(sessionId, Number(match[1]), Number(match[2]))) {
      logger.log(`session ${sessionId}: its Mac window took the size (${last})`);
    }
  }

  /** Who owns the session's size now: a page's id, WINDOW_OWNER, or null (none yet). */
  getSizeOwner(sessionId: string): string | null {
    this.refreshSizeOwner(sessionId);
    return this.sizeOwners.owner(sessionId);
  }

  /**
   * Resize a session's terminal for a page (size-owner.ts): applied for the size's owner or a
   * page claiming it, ignored for the others, which show the owner's size scaled.
   */
  resizeSession(
    sessionId: string,
    cols: number,
    rows: number,
    request: SizeRequest = {}
  ): { applied: true } | { applied: false; reason: SizeRequestSkip } {
    const memorySession = this.sessions.get(sessionId);
    const currentTime = Date.now();
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
      throw new PtyError(`Invalid size ${cols}x${rows}`, 'RESIZE_FAILED', sessionId);
    }

    this.refreshSizeOwner(sessionId);
    const owner = this.sizeOwners.owner(sessionId);
    const clientId = request.clientId || null;
    const decision = sizeRequestDecision({
      forwarded: sessionId.startsWith('fwd_'),
      owner,
      clientId,
      claim: request.claim === true,
      ownerViewing:
        owner !== null && owner !== WINDOW_OWNER && this.clientViewing(owner, sessionId),
      senderViewing: clientId ? this.clientViewing(clientId, sessionId) : true,
    });
    if (!decision.apply) {
      logger.debug(
        `not resizing ${sessionId} to ${cols}x${rows} for ${clientId}: ${decision.reason} (${owner})`
      );
      return { applied: false, reason: decision.reason };
    }
    if (decision.owner !== owner) {
      logger.log(
        `session ${sessionId}: size now owned by ${decision.owner}${request.claim ? ' (claim)' : ''}`
      );
    }
    this.sizeOwners.setOwner(sessionId, decision.owner);
    if (sessionId.startsWith('fwd_') && decision.owner !== ANONYMOUS_OWNER) this.ensureSizeSweep();
    // The PTY has that size already (a page opened again, a reload, a claim at the same size):
    // nothing to send. A same-size TIOCSWINSZ redraws nothing, and the Mac window's forwarder
    // still recorded it as a resize.
    const current = this.sizeOwners.currentSize(sessionId);
    if (sessionId.startsWith('fwd_') && current && current.cols === cols && current.rows === rows) {
      return { applied: true };
    }

    // Check for rapid resizes (potential feedback loop)
    const lastResize = this.sessionResizeSources.get(sessionId);
    if (lastResize) {
      const timeSinceLastResize = currentTime - lastResize.timestamp;
      if (timeSinceLastResize < 100) {
        // Less than 100ms since last resize - this might indicate a loop
        logger.warn(
          `Rapid resize detected for session ${sessionId}: ${timeSinceLastResize}ms since last resize (${lastResize.cols}x${lastResize.rows} -> ${cols}x${rows})`
        );
      }
    }

    try {
      // If we have an in-memory session with active PTY, resize it
      if (memorySession?.ptyProcess) {
        memorySession.ptyProcess.resize(cols, rows);
        memorySession.asciinemaWriter?.writeResize(cols, rows);
        logger.debug(`Resized session ${sessionId} to ${cols}x${rows}`);
      } else {
        // For external sessions, send the resize through the control socket
        const resizeMessage: ResizeControlMessage = {
          cmd: 'resize',
          cols,
          rows,
        };
        this.sendControlMessage(sessionId, resizeMessage);
      }
      this.sizeOwners.noteSent(sessionId, cols, rows);
      this.sessionResizeSources.set(sessionId, { cols, rows, timestamp: currentTime });
      return { applied: true };
    } catch (error) {
      throw new PtyError(
        `Failed to resize session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        'RESIZE_FAILED',
        sessionId
      );
    }
  }

  /**
   * Give a Mac-window session's size back to its window (its forwarder). With `giveBack` (a page that
   * left the session's view a while ago), only when that page still owns the size and no other
   * page shows the session (size-owner.ts sizeGiveBackDecision); returns whether the reset was
   * sent and, if not, why. Afterwards the Mac window owns the size.
   */
  resetSessionSize(
    sessionId: string,
    giveBack?: { clientId?: string | null; viewedElsewhere?: boolean }
  ): { reset: boolean; reason?: SizeGiveBackSkip } {
    const memorySession = this.sessions.get(sessionId);
    if (giveBack) {
      this.refreshSizeOwner(sessionId);
      const skip = sizeGiveBackDecision({
        owner: this.sizeOwners.owner(sessionId),
        clientId: giveBack.clientId ?? null,
        viewedElsewhere: giveBack.viewedElsewhere === true,
      });
      if (skip) return { reset: false, reason: skip };
    }

    try {
      // For in-memory sessions there is nothing to reset (we already control the PTY size).
      // Some clients call this endpoint unconditionally; treat it as a no-op to avoid noisy 500s.
      if (memorySession?.ptyProcess) return { reset: false, reason: 'own-pty' };

      // For external sessions, send reset-size command via control pipe
      const resetSizeMessage: ResetSizeControlMessage = {
        cmd: 'reset-size',
      };

      const sent = this.sendControlMessage(sessionId, resetSizeMessage);
      if (!sent) {
        throw new PtyError(
          `Failed to send reset-size command to session ${sessionId}`,
          'CONTROL_MESSAGE_FAILED',
          sessionId
        );
      }

      logger.debug(`Sent reset-size command to session ${sessionId}`);
      this.sizeOwners.setOwner(sessionId, WINDOW_OWNER);
      return { reset: true };
    } catch (error) {
      throw new PtyError(
        `Failed to reset session size for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        'RESET_SIZE_FAILED',
        sessionId
      );
    }
  }
}
