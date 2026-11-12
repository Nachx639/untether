/** Foreground command tracking (command notifications). Part of PtyManager (pty-manager.ts). */

import { colors } from '../../utils/colors.js';
import { every } from '../../utils/periodic-loop.js';
import { readForegroundPgids } from '../foreground-pgids.js';
import type { PtySession } from '../types.js';
import {
  foregroundPollDue,
  logger,
  MIN_COMMAND_DURATION_MS,
  PROCESS_POLL_INTERVAL_MS,
  SHELL_COMMANDS,
} from './helpers.js';
import { PtyManagerState } from './state.js';

export abstract class PtyManagerForeground extends PtyManagerState {
  /**
   * Start tracking foreground process for command completion notifications
   */
  protected startForegroundProcessTracking(session: PtySession): void {
    if (!session.ptyProcess) return;
    // 2026-11-02: a shielded session's pty runs the tmux client, which stays the foreground
    // group of its terminal whatever runs in the pane (pgid == tpgid, checked on the live
    // server): polling it could never see a command start or finish, and it was most of the
    // 2 `ps` a second the server ran.
    if (session.sessionInfo.shielded) return;

    const ptyPid = session.ptyProcess.pid;

    // Get the shell's process group ID (pgid)
    this.getProcessPgid(ptyPid)
      .then((shellPgid) => {
        // The session may have exited while ps ran: never track it then.
        if (this.sessions.get(session.id) !== session || !session.ptyProcess) return;
        if (!shellPgid) {
          logger.warn(`Session ${session.id}: Could not get shell PGID`);
          return;
        }
        session.shellPgid = shellPgid;
        session.currentForegroundPgid = shellPgid;
        logger.debug(`Session ${session.id}: Shell PGID is ${shellPgid}, tracking commands`);
        this.foregroundTracked.add(session);
        this.foregroundPollTimer ??= every(
          'pty foreground poll',
          () => this.pollForegroundProcesses(),
          PROCESS_POLL_INTERVAL_MS
        );
      })
      .catch((err) => {
        logger.warn(`Failed to get shell PGID for session ${session.id}:`, err);
      });
  }

  protected stopForegroundProcessTracking(session: PtySession): void {
    this.foregroundTracked.delete(session);
    if (this.foregroundTracked.size === 0 && this.foregroundPollTimer) {
      clearInterval(this.foregroundPollTimer);
      this.foregroundPollTimer = null;
    }
  }

  /**
   * Get process group ID for a process
   */
  protected async getProcessPgid(pid: number): Promise<number | null> {
    try {
      const { stdout } = await this.execFileAsync('ps', ['-o', 'pgid=', '-p', String(pid)], {
        timeout: 1000,
      });
      const pgid = Number.parseInt(stdout.trim(), 10);
      return Number.isNaN(pgid) ? null : pgid;
    } catch (_error) {
      return null;
    }
  }

  /**
   * One `ps` for every tracked session: the foreground process group of each session's
   * terminal (tpgid of its root process).
   *
   * 2026-10-02: each session polled on its own timer with a `ps -t … | grep | head` shell
   * pipeline every 500 ms, the timer was never cleared when the session exited, and every
   * tick logged 3-4 lines. 10 running + 100 exited sessions cost ~7% CPU and 87 KB/s of log
   * while idle, forever. Exited sessions now leave the set, and the poll stops when it is empty.
   */
  protected async pollForegroundProcesses(): Promise<void> {
    if (this.foregroundPollRunning) return;
    for (const session of this.foregroundTracked) {
      if (!session.ptyProcess || this.sessions.get(session.id) !== session) {
        this.stopForegroundProcessTracking(session);
      }
    }
    if (this.foregroundTracked.size === 0) return;

    // Only sessions whose terminal moved lately (a command starts after input and ends with
    // a prompt), and every other one now and then.
    const now = Date.now();
    const tracked = [...this.foregroundTracked].filter((session) =>
      foregroundPollDue(session, now)
    );
    if (tracked.length === 0) return;

    this.foregroundPollRunning = true;
    try {
      for (const session of tracked) session.lastForegroundPollAt = now;
      const foreground = await readForegroundPgids(
        tracked.map((session) => session.ptyProcess?.pid ?? 0)
      );
      for (const session of tracked) {
        const pid = session.ptyProcess?.pid;
        const pgid = pid ? foreground.get(pid) : undefined;
        if (pgid) await this.checkForegroundProcess(session, pgid);
      }
    } catch (error) {
      logger.debug(`Foreground process poll failed: ${error}`);
    } finally {
      this.foregroundPollRunning = false;
    }
  }

  /**
   * Detect foreground process changes of one session
   */
  protected async checkForegroundProcess(session: PtySession, currentPgid: number): Promise<void> {
    if (!session.ptyProcess || !session.shellPgid) return;
    if (currentPgid === session.currentForegroundPgid) return;

    try {
      const previousPgid = session.currentForegroundPgid;
      session.currentForegroundPgid = currentPgid;
      logger.debug(
        `Session ${session.id}: Foreground PGID changed from ${previousPgid} to ${currentPgid}`
      );

      if (currentPgid === session.shellPgid && previousPgid !== session.shellPgid) {
        // A command just finished (returned to shell)
        await this.handleCommandFinished(session, previousPgid);
      } else if (currentPgid !== session.shellPgid) {
        // A new command started
        await this.handleCommandStarted(session, currentPgid);
      }
    } catch (error) {
      logger.debug(`Error checking foreground process for session ${session.id}:`, error);
    }
  }

  /**
   * Handle when a new command starts
   */
  protected async handleCommandStarted(session: PtySession, pgid: number): Promise<void> {
    try {
      // Get command info from process tree
      if (!session.ptyProcess) return;
      const processTree = await this.processTreeAnalyzer.getProcessTree(session.ptyProcess.pid);
      const commandProc = processTree.find((p) => p.pgid === pgid);

      if (commandProc) {
        session.currentCommand = commandProc.command;
        session.commandStartTime = Date.now();

        // Update SessionMonitor with new command
        if (this.sessionMonitor) {
          this.sessionMonitor.updateCommand(session.id, commandProc.command);
        }

        // Special logging for Claude commands
        const isClaudeCommand = commandProc.command.toLowerCase().includes('claude');
        if (isClaudeCommand) {
          logger.log(
            colors.cyan(
              `🤖 Session ${session.id}: Claude command started: "${commandProc.command}" (PGID: ${pgid})`
            )
          );
        } else {
          logger.debug(
            `Session ${session.id}: Command started: "${commandProc.command}" (PGID: ${pgid})`
          );
        }

        // Log process tree for debugging
        logger.debug(
          `Process tree for session ${session.id}:`,
          processTree.map((p) => `  PID: ${p.pid}, PGID: ${p.pgid}, CMD: ${p.command}`).join('\n')
        );
      } else {
        logger.warn(
          colors.yellow(`Session ${session.id}: Could not find process info for PGID ${pgid}`)
        );
      }
    } catch (error) {
      logger.debug(`Failed to get command info for session ${session.id}:`, error);
    }
  }

  /**
   * Handle when a command finishes
   */
  protected async handleCommandFinished(
    session: PtySession,
    pgid: number | undefined
  ): Promise<void> {
    if (!pgid || !session.commandStartTime || !session.currentCommand) {
      logger.debug(
        colors.red(
          `Session ${session.id}: Cannot handle command finished - missing data: pgid=${pgid}, startTime=${session.commandStartTime}, command="${session.currentCommand}"`
        )
      );
      return;
    }

    const duration = Date.now() - session.commandStartTime;
    const command = session.currentCommand;
    const isClaudeCommand = command.toLowerCase().includes('claude');

    // Reset tracking
    session.currentCommand = undefined;
    session.commandStartTime = undefined;

    // Log command completion for Claude
    if (isClaudeCommand) {
      logger.log(
        colors.cyan(
          `🤖 Session ${session.id}: Claude command completed: "${command}" (duration: ${duration}ms)`
        )
      );
    }

    // Check if we should notify - bypass duration check for Claude commands
    if (!isClaudeCommand && duration < MIN_COMMAND_DURATION_MS) {
      logger.debug(
        `Session ${session.id}: Command "${command}" too short (${duration}ms < ${MIN_COMMAND_DURATION_MS}ms), not notifying`
      );
      return;
    }

    // Log duration for Claude commands even if bypassing the check
    if (isClaudeCommand && duration < MIN_COMMAND_DURATION_MS) {
      logger.log(
        colors.yellow(
          `⚡ Session ${session.id}: Claude command completed quickly (${duration}ms) - still notifying`
        )
      );
    }

    // Check if it's a built-in shell command
    const baseCommand = command.split(/\s+/)[0];
    if (SHELL_COMMANDS.has(baseCommand)) {
      logger.debug(`Session ${session.id}: Ignoring built-in command: ${baseCommand}`);
      return;
    }

    // The exit code of a command run inside the session's shell cannot be known from outside
    // it: always 0. (Until 2026-11-11 a `sh -c "ps …"` ran here per finished command, and its
    // result was thrown away.)
    const exitCode = 0;

    // Emit the event
    const eventData = {
      sessionId: session.id,
      command,
      exitCode,
      duration,
      timestamp: new Date().toISOString(),
    };

    logger.info(
      `🔔 NOTIFICATION DEBUG: Emitting commandFinished event - sessionId: ${session.id}, command: "${command}", duration: ${duration}ms, exitCode: ${exitCode}`
    );
    this.emit('commandFinished', eventData);

    // Enhanced logging for events
    if (isClaudeCommand) {
      logger.log(
        colors.green(
          `✅ Session ${session.id}: Claude command notification event emitted: "${command}" (duration: ${duration}ms, exit: ${exitCode})`
        )
      );
    } else {
      logger.log(`Session ${session.id}: Command finished: "${command}" (duration: ${duration}ms)`);
    }

    logger.debug(`Session ${session.id}: commandFinished event data:`, eventData);
  }
}
