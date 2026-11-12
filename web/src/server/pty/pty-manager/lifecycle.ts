/** Session metadata, kill, listing and cleanup. Part of PtyManager (pty-manager.ts). */

import * as fs from 'fs';

import * as path from 'path';

import { isForwardedSession } from '../../../shared/forwarded-session.js';
import { type InheritedTitles, inheritedTitles } from '../../../shared/session-title.js';
import type {
  ProviderSessionMarker,
  Session,
  SessionGroupPin,
  SessionInfo,
  TerminalClaude,
} from '../../../shared/types.js';
import { missingClaudeSessionId } from '../../services/claude-session-id.js';
import { claudeStartSettings } from '../../services/model-observations.js';
import { claudeConfigDir } from '../../utils/claude-dir.js';
import { colors } from '../../utils/colors.js';
import { sameModes } from '../../utils/terminal-modes.js';
import { computeActivityStatus } from '../activity-status.js';
import {
  confirmExternalKill,
  FORWARDER_CLOSE_GRACE_MS,
  forwarderPidOf,
  waitForProgramExit,
} from '../forwarder-kill.js';
import { ProcessUtils } from '../process-utils.js';
import { type KillControlMessage, PtyError, type PtySession } from '../types.js';
import { type ExitedKeepReason, exitedCleanupKeepReason, logger } from './helpers.js';
import { PtyManagerSpawn } from './spawn.js';

export abstract class PtyManagerLifecycle extends PtyManagerSpawn {
  /** Persist a session's terminal modes shortly after they change (they change in bursts). */
  protected scheduleTerminalModesSave(session: PtySession): void {
    if (this.terminalModesSaveTimers.has(session.id)) return;
    const timer = setTimeout(() => {
      this.terminalModesSaveTimers.delete(session.id);
      // 2026-11-02: Claude Code hides and shows the cursor (mode 25) around every frame, so
      // each busy session rewrote session.json 4 times a second (1.2 % of the server's CPU).
      // Only a state that differs from the one on disk is written.
      const modes = { ...session.sessionInfo.terminalModes };
      if (sameModes(modes, session.savedTerminalModes)) return;
      const info = this.sessionManager.loadSessionInfo(session.id);
      if (!info) return;
      session.savedTerminalModes = modes;
      if (sameModes(modes, info.terminalModes)) return;
      info.terminalModes = modes;
      this.sessionManager.saveSessionInfo(session.id, info);
    }, 250);
    timer.unref?.();
    this.terminalModesSaveTimers.set(session.id, timer);
  }

  /** What a launch on this provider sets and removes; null when it cannot be rebuilt. */
  async rebuildProviderEnv(
    marker: ProviderSessionMarker
  ): Promise<{ env: Record<string, string>; unset: string[] } | null> {
    return (await this.providerEnvResolver?.(marker)) ?? null;
  }

  /** What Claude runs in this terminal now, or that none does (services/terminal-claude.ts). */
  setTerminalClaude(sessionId: string, record: TerminalClaude | undefined): void {
    this.patchSessionInfo(sessionId, { terminalClaude: record });
  }

  /**
   * Remember the Claude Code conversation running in a session, so it can be resumed. A session
   * now running a conversation earlier sessions ran (a Mac window reopened with
   * `ut claude --resume`, `/resume` inside Claude) takes their titles when it has none: the
   * user's title follows the conversation. Returns the titles it took.
   */
  setClaudeSessionId(sessionId: string, claudeSessionId: string): InheritedTitles {
    const info = this.sessionManager.loadSessionInfo(sessionId);
    if (!info || info.claudeSessionId === claudeSessionId) return {};
    info.claudeSessionId = claudeSessionId;
    info.claudeStartSettings = claudeStartSettings(
      claudeConfigDir(),
      claudeSessionId,
      info.claudeStartSettings
    );
    const taken: InheritedTitles = {};
    if (!info.userTitle || !info.claudeTitle || !info.groupPin) {
      const inherited = inheritedTitles(this.sessionManager.listSessions(), claudeSessionId, {
        excludeId: sessionId,
        before: info.startedAt,
      });
      if (!info.userTitle && inherited.userTitle) taken.userTitle = inherited.userTitle;
      if (!info.claudeTitle && inherited.claudeTitle) taken.claudeTitle = inherited.claudeTitle;
      if (!info.groupPin && inherited.groupPin) taken.groupPin = inherited.groupPin;
    }
    Object.assign(info, taken);
    this.sessionManager.saveSessionInfo(sessionId, info);
    const memorySession = this.sessions.get(sessionId);
    if (memorySession?.sessionInfo) {
      Object.assign(memorySession.sessionInfo, {
        claudeSessionId,
        claudeStartSettings: info.claudeStartSettings,
        ...taken,
      });
    }
    if (taken.userTitle) {
      logger.log(
        `session ${sessionId} keeps the title the user gave conversation ${claudeSessionId}`
      );
    }
    return taken;
  }

  /**
   * Remember the Codex thread running in a session (services/codex-thread.ts), so it can be
   * resumed. As with a Claude conversation, a session now on a thread earlier sessions ran
   * takes the user's title and group of the newest of them when it has none. `undefined`
   * takes a thread back.
   */
  setCodexThreadId(sessionId: string, codexThreadId: string | undefined): InheritedTitles {
    const info = this.sessionManager.loadSessionInfo(sessionId);
    if (!info || info.codexThreadId === codexThreadId) return {};
    if (!codexThreadId) {
      // Recorded by mistake (another session's Codex said the thread was its own).
      this.patchSessionInfo(sessionId, { codexThreadId: undefined });
      return {};
    }
    const taken: InheritedTitles = {};
    if (!info.userTitle || !info.groupPin) {
      const inherited = inheritedTitles(this.sessionManager.listSessions(), codexThreadId, {
        excludeId: sessionId,
        before: info.startedAt,
      });
      if (!info.userTitle && inherited.userTitle) taken.userTitle = inherited.userTitle;
      if (!info.groupPin && inherited.groupPin) taken.groupPin = inherited.groupPin;
    }
    this.patchSessionInfo(sessionId, { codexThreadId, ...taken });
    logger.log(`session ${sessionId} runs Codex thread ${codexThreadId}`);
    return taken;
  }

  /** Remember Claude's conversation title so a finished session is still recognizable. */
  setClaudeTitle(sessionId: string, claudeTitle: string): void {
    const info = this.sessionManager.loadSessionInfo(sessionId);
    if (!info || info.claudeTitle === claudeTitle) return;
    info.claudeTitle = claudeTitle;
    this.sessionManager.saveSessionInfo(sessionId, info);
    const memorySession = this.sessions.get(sessionId);
    if (memorySession?.sessionInfo) memorySession.sessionInfo.claudeTitle = claudeTitle;
  }

  /**
   * Set the title the user gave a session, or clear it (null) to go back to the agent's
   * conversation title. Returns false if the session is unknown.
   */
  setUserTitle(sessionId: string, userTitle: string | null): boolean {
    const info = this.sessionManager.loadSessionInfo(sessionId);
    if (!info) return false;
    if (userTitle) info.userTitle = userTitle;
    else delete info.userTitle;
    this.sessionManager.saveSessionInfo(sessionId, info);
    const memorySession = this.sessions.get(sessionId);
    if (memorySession?.sessionInfo) {
      if (userTitle) memorySession.sessionInfo.userTitle = userTitle;
      else delete memorySession.sessionInfo.userTitle;
    }
    return true;
  }

  /**
   * Anchor a session to a group of the home (null: back to the automatic grouping). Only
   * session.json changes: the running program is never touched. False if the session is unknown.
   */
  setGroupPin(sessionId: string, groupPin: SessionGroupPin | null): boolean {
    const info = this.sessionManager.loadSessionInfo(sessionId);
    if (!info) return false;
    if (groupPin) info.groupPin = groupPin;
    else delete info.groupPin;
    this.sessionManager.saveSessionInfo(sessionId, info);
    const memorySession = this.sessions.get(sessionId);
    if (memorySession?.sessionInfo) {
      if (groupPin) memorySession.sessionInfo.groupPin = groupPin;
      else delete memorySession.sessionInfo.groupPin;
    }
    return true;
  }

  /** Mute or unmute notifications for a session. Returns false if the session is unknown. */
  setSessionMuted(sessionId: string, muted: boolean): boolean {
    const info = this.sessionManager.loadSessionInfo(sessionId);
    if (!info) return false;
    if (muted) info.muted = true;
    else delete info.muted;
    this.sessionManager.saveSessionInfo(sessionId, info);
    const memorySession = this.sessions.get(sessionId);
    if (memorySession?.sessionInfo) {
      if (muted) memorySession.sessionInfo.muted = true;
      else delete memorySession.sessionInfo.muted;
    }
    return true;
  }

  /** The session's Claude was restarted on a new version (claude-update-restart.ts). */
  setClaudeUpdatedTo(
    sessionId: string,
    update: NonNullable<SessionInfo['claudeUpdatedTo']>
  ): boolean {
    const info = this.sessionManager.loadSessionInfo(sessionId);
    if (!info) return false;
    info.claudeUpdatedTo = update;
    this.sessionManager.saveSessionInfo(sessionId, info);
    const memorySession = this.sessions.get(sessionId);
    if (memorySession?.sessionInfo) memorySession.sessionInfo.claudeUpdatedTo = update;
    return true;
  }

  isSessionMuted(sessionId: string): boolean {
    return this.sessionManager.loadSessionInfo(sessionId)?.muted === true;
  }

  /**
   * Update session name
   */
  updateSessionName(sessionId: string, name: string): string {
    logger.debug(
      `[PtyManager] updateSessionName called for session ${sessionId} with name: ${name}`
    );

    // Update in session manager (persisted storage) - get the unique name back
    logger.debug(`[PtyManager] Calling sessionManager.updateSessionName`);
    const uniqueName = this.sessionManager.updateSessionName(sessionId, name);

    // Update in-memory session if it exists
    const memorySession = this.sessions.get(sessionId);
    if (memorySession?.sessionInfo) {
      logger.debug(`[PtyManager] Found in-memory session, updating...`);
      const oldName = memorySession.sessionInfo.name;
      memorySession.sessionInfo.name = uniqueName;

      logger.log(
        `[PtyManager] Updated session ${sessionId} name from "${oldName}" to "${uniqueName}"`
      );
    } else {
      logger.debug(`[PtyManager] No in-memory session found for ${sessionId}`, {
        sessionsMapSize: this.sessions.size,
        sessionIds: Array.from(this.sessions.keys()),
      });
    }

    // Emit event for clients to refresh their session data
    this.trackAndEmit('sessionNameChanged', sessionId, uniqueName);

    logger.debug(`[PtyManager] Updated session ${sessionId} name to: ${uniqueName}`);

    return uniqueName;
  }

  /**
   * Detach from a tmux session gracefully
   * @param sessionId The session ID of the tmux attachment
   * @returns Promise that resolves when detached
   */
  protected async detachFromTmux(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session?.isTmuxAttachment || !session.ptyProcess) {
      return false;
    }

    try {
      logger.log(colors.cyan(`Detaching from tmux session (${sessionId})`));

      if (session.sessionInfo.multiplexer) {
        // On the user's server, by its socket: our client, found again by its pid.
        await this.attachTracker.detach(sessionId);
      } else {
        const clientTty = await this.findTmuxClientTty(session.ptyProcess.pid);
        if (!clientTty) {
          logger.debug(`Could not find tmux client for PTY process ${session.ptyProcess.pid}`);
          return false;
        }

        // Target the Untether client only. Using `-s` would detach every client
        // attached to the same tmux session.
        await this.execFileAsync('tmux', ['detach-client', '-t', clientTty]);
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!ProcessUtils.isProcessRunning(session.ptyProcess.pid)) {
        logger.log(colors.green(`Successfully detached from tmux (${sessionId})`));
        return true;
      }

      logger.debug(`tmux client of ${sessionId} remained attached after detach-client`);
      return false;
    } catch (error) {
      logger.error(`Error detaching from tmux: ${error}`);
      return false;
    }
  }

  protected async findTmuxClientTty(pid: number): Promise<string | undefined> {
    const { stdout } = await this.execFileAsync('tmux', [
      'list-clients',
      '-F',
      '#{client_pid}\t#{client_tty}',
    ]);

    for (const line of String(stdout).split(/\r?\n/)) {
      const [clientPid, clientTty] = line.split('\t');
      if (Number(clientPid) === pid && clientTty) {
        return clientTty;
      }
    }

    return undefined;
  }

  /**
   * Kill a session with proper SIGTERM -> SIGKILL escalation
   * Returns a promise that resolves when the process is actually terminated
   */
  async killSession(
    sessionId: string,
    signal: string | number = 'SIGTERM',
    /** `windowNotice`: written into a `ut` window by its forwarder once its program ended. */
    options: { windowNotice?: string } = {}
  ): Promise<void> {
    const memorySession = this.sessions.get(sessionId);

    try {
      // A shielded session's program lives in tmux: end it there (the attach client then exits
      // and the normal exit path records the session as exited).
      const info = memorySession?.sessionInfo ?? this.sessionManager.loadSessionInfo(sessionId);
      // Killed while suspended (the user's Kill, a finished task): an ordinary ended session.
      if (info?.suspended && info.status === 'exited' && !memorySession) {
        this.patchSessionInfo(sessionId, { suspended: undefined, shieldEnd: 'killed' });
        this.emit('sessionExited', sessionId, info.name || info.command.join(' '), 0);
        return;
      }
      if (info?.shielded) {
        if (memorySession) memorySession.shieldKilling = true;
        // Killed on purpose: never brought back after a reboot.
        this.patchSessionInfo(sessionId, { shieldEnd: 'killed' });
        await this.shieldTmux.kill(sessionId);
        if (!memorySession?.ptyProcess) {
          this.sessionManager.updateSessionStatus(sessionId, 'exited', undefined, 0);
          this.emit('sessionExited', sessionId, info.name || info.command.join(' '), 0);
          return;
        }
        for (let i = 0; i < 20 && this.sessions.get(sessionId) === memorySession; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (this.sessions.get(sessionId) !== memorySession) return;
      }

      // Special handling for tmux attachment sessions
      if (memorySession?.isTmuxAttachment) {
        const detached = await this.detachFromTmux(sessionId);
        if (detached) {
          // The PTY process should exit cleanly after detaching
          // Let the normal exit handler clean up the session
          return;
        }

        logger.warn(`Failed to detach from tmux, falling back to normal kill`);
        // Fall through to normal kill logic
      }

      // If we have an in-memory session with active PTY, kill it directly
      if (memorySession?.ptyProcess) {
        // If signal is already SIGKILL, send it immediately and wait briefly
        if (signal === 'SIGKILL' || signal === 9) {
          memorySession.ptyProcess.kill('SIGKILL');

          // Note: We no longer kill the process group to avoid affecting other sessions
          // that might share the same process group (e.g., multiple forwarder instances)

          this.sessions.delete(sessionId);
          // Wait a bit for SIGKILL to take effect
          await new Promise((resolve) => setTimeout(resolve, 100));
          return;
        }

        // Start with SIGTERM and escalate if needed
        await this.killSessionWithEscalation(sessionId, memorySession);
      } else {
        // For external sessions, try control pipe first, then fall back to PID
        const killMessage: KillControlMessage = {
          cmd: 'kill',
          signal,
          ...(options.windowNotice ? { notice: options.windowNotice } : {}),
        };

        const sentControl = this.sendControlMessage(sessionId, killMessage);
        if (sentControl) {
          // A session opened with ut ends its program itself and restores its Mac window: let
          // it (FORWARDER_CLOSE_GRACE_MS); any other one gets a moment to take the message.
          const sentTo = this.sessionManager.loadSessionInfo(sessionId);
          const programPid = sentTo?.pid;
          if (forwarderPidOf(sessionId, sentTo) && programPid) {
            await waitForProgramExit(
              () => ProcessUtils.isProcessRunning(programPid),
              FORWARDER_CLOSE_GRACE_MS
            );
          } else {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }

        // Check if process is still running, if so, use direct PID kill
        const diskSession = this.sessionManager.loadSessionInfo(sessionId);
        if (!diskSession) {
          throw new PtyError(`Session ${sessionId} not found`, 'SESSION_NOT_FOUND', sessionId);
        }

        // A pid the kernel gave to another program is never signalled (2026-10-20).
        const pidIsTheSession =
          !!diskSession.pid &&
          ProcessUtils.isSameProcess(diskSession.pid, diskSession.pidStartTime);
        if (diskSession.pid && !pidIsTheSession && ProcessUtils.isProcessRunning(diskSession.pid)) {
          logger.warn(
            `session ${sessionId}: pid ${diskSession.pid} now belongs to another process; not signalled`
          );
          if (diskSession.status !== 'exited') {
            this.sessionManager.updateSessionStatus(sessionId, 'exited', undefined, 0);
            this.emit(
              'sessionExited',
              sessionId,
              diskSession.name || diskSession.command.join(' '),
              0
            );
          }
          return;
        }
        if (diskSession.pid && pidIsTheSession) {
          logger.log(
            colors.yellow(`Killing external session ${sessionId} (PID: ${diskSession.pid})`)
          );

          if (signal === 'SIGKILL' || signal === 9) {
            process.kill(diskSession.pid, 'SIGKILL');

            // Note: We no longer kill the process group to avoid affecting other sessions
            // that might share the same process group (e.g., multiple forwarder instances)

            await new Promise((resolve) => setTimeout(resolve, 100));
          } else {
            let terminated = false;
            // Send SIGTERM first
            process.kill(diskSession.pid, 'SIGTERM');

            // Note: We no longer kill the process group to avoid affecting other sessions
            // that might share the same process group (e.g., multiple forwarder instances)

            // Wait up to 3 seconds for graceful termination
            const maxWaitTime = 3000;
            const checkInterval = 500;
            const maxChecks = maxWaitTime / checkInterval;

            for (let i = 0; i < maxChecks; i++) {
              await new Promise((resolve) => setTimeout(resolve, checkInterval));

              if (!ProcessUtils.isProcessRunning(diskSession.pid)) {
                logger.debug(colors.green(`External session ${sessionId} terminated gracefully`));
                terminated = true;
                break;
              }
            }

            // Process didn't terminate gracefully, force kill
            if (!terminated) {
              logger.debug(colors.yellow(`External session ${sessionId} requires SIGKILL`));
              process.kill(diskSession.pid, 'SIGKILL');

              // Note: We no longer kill the process group to avoid affecting other sessions
              // that might share the same process group (e.g., multiple forwarder instances)

              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
        }

        // kill(pid, 0) above also succeeds for a zombie or an exiting program, and the forwarder
        // of a session opened with ut can still hold it in its window: the session has ended only
        // once `ps` shows nothing of it runs, its forwarder signalled if needed (2026-10-04, see
        // forwarder-kill.ts). A kill that didn't happen is never reported as done.
        const outcome = await confirmExternalKill(sessionId, diskSession.pid, diskSession);
        if (!outcome.ended) {
          logger.warn(`session ${sessionId} still runs after kill: ${outcome.left}`);
          throw new Error(`still running: ${outcome.left}`);
        }
        // Not when it had already ended (its forwarder records that): no second exit.
        if (diskSession.status !== 'exited') {
          this.sessionManager.updateSessionStatus(sessionId, 'exited', undefined, 0);
          this.emit(
            'sessionExited',
            sessionId,
            diskSession.name || diskSession.command.join(' '),
            0
          );
        }
      }
    } catch (error) {
      throw new PtyError(
        `Failed to kill session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        'KILL_FAILED',
        sessionId
      );
    }
  }

  /**
   * Kill session with SIGTERM -> SIGKILL escalation (3 seconds, check every 500ms)
   */
  protected async killSessionWithEscalation(sessionId: string, session: PtySession): Promise<void> {
    if (!session.ptyProcess) {
      this.sessions.delete(sessionId);
      return;
    }

    const pid = session.ptyProcess.pid;
    logger.debug(colors.yellow(`Terminating session ${sessionId} (PID: ${pid})`));

    try {
      // Send SIGTERM first
      session.ptyProcess.kill('SIGTERM');

      // Note: We no longer kill the process group to avoid affecting other sessions
      // that might share the same process group (e.g., multiple forwarder instances)

      // Wait up to 3 seconds for graceful termination (check every 500ms)
      const maxWaitTime = 3000;
      const checkInterval = 500;
      const maxChecks = maxWaitTime / checkInterval;

      for (let i = 0; i < maxChecks; i++) {
        // Wait for check interval
        await new Promise((resolve) => setTimeout(resolve, checkInterval));

        // Check if process is still alive
        if (!ProcessUtils.isProcessRunning(pid)) {
          // Process no longer exists - it terminated gracefully
          logger.debug(colors.green(`Session ${sessionId} terminated gracefully`));
          this.sessions.delete(sessionId);
          return;
        }

        // Process still exists, continue waiting
        logger.debug(`Session ${sessionId} still running after ${(i + 1) * checkInterval}ms`);
      }

      // Process didn't terminate gracefully within 3 seconds, force kill
      logger.debug(colors.yellow(`Session ${sessionId} requires SIGKILL`));
      try {
        session.ptyProcess.kill('SIGKILL');

        // Also force kill the entire process group if on Unix
        // Note: We no longer kill the process group to avoid affecting other sessions
        // that might share the same process group (e.g., multiple forwarder instances)

        // Wait a bit more for SIGKILL to take effect
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (_killError) {
        // Process might have died between our check and SIGKILL
        logger.debug(`SIGKILL failed for session ${sessionId} (process already terminated)`);
      }

      // Remove from sessions regardless
      this.sessions.delete(sessionId);
      logger.debug(colors.yellow(`Session ${sessionId} forcefully terminated`));
    } catch (error) {
      // Remove from sessions even if kill failed
      this.sessions.delete(sessionId);
      throw new PtyError(
        `Failed to terminate session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        'KILL_FAILED',
        sessionId
      );
    }
  }

  /**
   * List all sessions (both active and persisted)
   */
  listSessions() {
    // One scan: it also marks sessions whose process died as exited; drop their sockets.
    const { sessions, zombies } = this.sessionManager.listSessionsAndZombies();
    for (const sessionId of zombies) {
      const socket = this.inputSocketClients.get(sessionId);
      if (socket) {
        socket.destroy();
        this.inputSocketClients.delete(sessionId);
      }
    }

    const now = Date.now();
    return sessions.map((session) => {
      const activeSession = this.sessions.get(session.id);
      const activityStatus = computeActivityStatus({
        status: session.status,
        lastOutputTimestamp: activeSession?.lastOutputTimestamp,
        lastInputTimestamp:
          activeSession?.lastInputTimestamp ?? this.lastInputTimestamps.get(session.id),
        lastModified: session.lastModified,
        startedAt: session.startedAt,
        now,
      });

      return {
        ...this.withClaudeSessionId(session),
        activityStatus,
      };
    });
  }

  /**
   * A session whose command resumes a conversation (`claude --resume <id>`) but never had it
   * recorded (user report: a forwarded Terminal-window Claude showed no "Resume Claude" once
   * exited): take it from the command and keep it, so later reads and restarts have it.
   */
  protected withClaudeSessionId<T extends Pick<Session, 'id' | 'command' | 'claudeSessionId'>>(
    session: T
  ): T {
    const derived = missingClaudeSessionId(session);
    if (!derived) return session;
    let taken: InheritedTitles = {};
    try {
      taken = this.setClaudeSessionId(session.id, derived);
    } catch (error) {
      logger.debug(`[PtyManager] Could not save Claude session id of ${session.id}: ${error}`);
    }
    return { ...session, claudeSessionId: derived, ...taken };
  }

  /**
   * Get a specific session
   */
  getSession(sessionId: string): Session | null {
    // Called by every per-session request (chat polls every 1.5 s): no per-call log lines.
    const paths = this.sessionManager.getSessionPaths(sessionId, true);
    if (!paths) {
      logger.debug(`[PtyManager] No session paths found for ${sessionId}`);
      return null;
    }

    const sessionInfo = this.sessionManager.loadSessionInfo(sessionId);
    if (!sessionInfo) {
      logger.debug(`[PtyManager] No session info found for ${sessionId}`);
      return null;
    }

    const activeSession = this.sessions.get(sessionId);

    // Create Session object with the id field
    const session: Session = this.withClaudeSessionId({
      ...sessionInfo,
      id: sessionId, // Ensure the id field is set
      lastModified: sessionInfo.startedAt,
    });

    if (fs.existsSync(paths.stdoutPath)) {
      const lastModified = fs.statSync(paths.stdoutPath).mtime.toISOString();
      session.lastModified = lastModified;
    }

    session.activityStatus = computeActivityStatus({
      status: session.status,
      lastOutputTimestamp: activeSession?.lastOutputTimestamp,
      lastInputTimestamp:
        activeSession?.lastInputTimestamp ?? this.lastInputTimestamps.get(sessionId),
      lastModified: session.lastModified,
      startedAt: session.startedAt,
    });

    return session;
  }

  getSessionPaths(sessionId: string) {
    return this.sessionManager.getSessionPaths(sessionId);
  }

  /**
   * Cleanup a specific session
   */
  cleanupSession(sessionId: string): void {
    // An id that is no session id ("..", from the URL) is refused before anything reads it.
    if (!/^[\w-]+$/.test(sessionId)) {
      this.sessionManager.cleanupSession(sessionId);
      return;
    }
    const info = this.sessions.get(sessionId)?.sessionInfo ?? this.loadSessionInfoSafe(sessionId);
    // 2026-10-20: removing a running session that isn't this server's PTY (a forwarded ut
    // window, a shielded one without a client) left its program running: the files went first,
    // and the forwarder's exit write recreated the folder. Its program is ended first (the
    // normal kill path), then its files go.
    const runsElsewhere =
      !!info &&
      info.status !== 'exited' &&
      (info.shielded ||
        isForwardedSession({ ...info, id: sessionId }) ||
        (!!info.pid && ProcessUtils.isProcessRunning(info.pid)));
    if (this.sessions.has(sessionId)) {
      // This server's PTY: it ends with the kill whatever happens to its files.
      this.killSession(sessionId).catch((error) => {
        logger.error(`Failed to kill session ${sessionId} during cleanup:`, error);
      });
    } else if (runsElsewhere) {
      this.killSession(sessionId)
        .catch((error) => {
          logger.error(`Failed to kill session ${sessionId} during cleanup:`, error);
        })
        .finally(() => {
          try {
            this.removeSessionFiles(sessionId);
          } catch (error) {
            logger.warn(`could not remove the files of session ${sessionId}: ${error}`);
          }
        });
      return;
    }
    // An ended shielded session's tmux session is ended too (it may outlive what was recorded).
    if (info?.shielded) void this.shieldTmux.kill(sessionId);
    this.removeSessionFiles(sessionId);
  }

  protected loadSessionInfoSafe(sessionId: string): SessionInfo | null {
    try {
      return this.sessionManager.loadSessionInfo(sessionId);
    } catch {
      return null;
    }
  }

  /** Remove a session's files and what this server holds for it. */
  protected removeSessionFiles(sessionId: string): void {
    // Remove from storage
    this.sessionManager.cleanupSession(sessionId);

    // Clean up socket connection if any
    const socket = this.inputSocketClients.get(sessionId);
    if (socket) {
      socket.destroy();
      this.inputSocketClients.delete(sessionId);
    }

    this.lastInputTimestamps.delete(sessionId);
    this.userInputTimestamps.delete(sessionId);
  }

  /**
   * Cleanup all exited sessions
   */
  cleanupExitedSessions(
    options: {
      keep?: (session: Session) => boolean;
      all?: boolean;
      /** Told of each exited session kept, and why (the API says how many were kept). */
      onKept?: (session: Session, reason: ExitedKeepReason) => void;
    } = {}
  ) {
    // 2026-10-20: ?all=1 went straight to the session files: an open task's or orchestrator's
    // session was deleted under it, and a shielded session's tmux (or a forwarder) was never
    // ended. `all` only lifts the resumable/shielded keep; the task keep and the kill path stay.
    const cleaned: string[] = [];
    for (const session of this.listSessions()) {
      // A suspended session is paused, not finished: no cleanup ever takes it (?all included).
      if (session.status !== 'exited' || session.suspended) continue;
      const reason: ExitedKeepReason | null = options.keep?.(session)
        ? 'task'
        : options.all
          ? null
          : exitedCleanupKeepReason(session);
      if (reason) {
        options.onKept?.(session, reason);
        continue;
      }
      try {
        this.cleanupSession(session.id);
        cleaned.push(session.id);
      } catch (error) {
        logger.warn(`could not clean up exited session ${session.id}: ${error}`);
      }
    }
    return cleaned;
  }

  /**
   * Get active session count
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Check if a session is active (has running PTY)
   */
  isSessionActive(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Shutdown all active sessions and clean up resources
   */
  async shutdown(): Promise<void> {
    if (this.sizeSweepTimer) clearInterval(this.sizeSweepTimer);
    this.sizeSweepTimer = null;
    for (const [sessionId, session] of Array.from(this.sessions.entries())) {
      try {
        if (session.ptyProcess) {
          session.ptyProcess.kill();

          // Note: We no longer kill the process group to avoid affecting other sessions
          // that might share the same process group (e.g., multiple forwarder instances)
          // The shutdown() method is only called during server shutdown where we DO want
          // to clean up all sessions, but we still avoid process group kills to be safe
        }
        if (session.asciinemaWriter?.isOpen()) {
          await session.asciinemaWriter.close();
        }
        // Clean up all session resources
        this.cleanupSessionResources(session);
      } catch (error) {
        logger.error(`Failed to cleanup session ${sessionId} during shutdown:`, error);
      }
    }

    this.sessions.clear();

    // Clean up all socket clients
    for (const [_sessionId, socket] of this.inputSocketClients.entries()) {
      try {
        socket.destroy();
      } catch (_e) {
        // Socket already destroyed
      }
    }
    this.inputSocketClients.clear();
  }

  /**
   * Clean up all resources associated with a session
   */
  protected cleanupSessionResources(session: PtySession): void {
    this.attachTracker.untrack(session.id);

    // Clean up resize tracking
    this.sessionResizeSources.delete(session.id);
    this.sizeOwners.forget(session.id);
    this.lastInputTimestamps.delete(session.id);
    this.userInputTimestamps.delete(session.id);

    // Clean up title filter
    if (session.titleFilter) {
      // No need to reset, just remove reference
      session.titleFilter = undefined;
    }

    // Clean up connected socket clients
    if (session.connectedClients) {
      for (const client of session.connectedClients) {
        try {
          client.destroy();
        } catch (_e) {
          // Client already destroyed
        }
      }
      session.connectedClients.clear();
    }

    // Clean up input socket server
    if (session.inputSocketServer) {
      // Close the server and wait for it to close
      session.inputSocketServer.close();
      // Unref the server so it doesn't keep the process alive
      session.inputSocketServer.unref();
      try {
        fs.unlinkSync(path.join(session.controlDir, 'ipc.sock'));
      } catch (_e) {
        // Socket already removed
      }
    }

    // Remove all event listeners for this session
    const listeners = this.sessionEventListeners.get(session.id);
    if (listeners) {
      listeners.forEach((listener) => {
        this.removeListener('sessionNameChanged', listener);
        this.removeListener('bell', listener);
      });
      this.sessionEventListeners.delete(session.id);
    }

    this.stopForegroundProcessTracking(session);
  }
}
