/** Session creation: spawning the PTY and handling its output and exit. Part of PtyManager (pty-manager.ts). */

import { randomUUID as uuidv4 } from 'node:crypto';
import * as fs from 'fs';

import type { IPty, IPtyForkOptions } from 'node-pty';
import * as path from 'path';

import { inheritedTitles } from '../../../shared/session-title.js';
import type { SessionCreateOptions, SessionInfo } from '../../../shared/types.js';
import { TitleMode } from '../../../shared/types.js';
import { claudeResumeTarget } from '../../services/claude-session-id.js';
import { codexResumeTarget } from '../../services/codex-process.js';
import { claudeStartSettings } from '../../services/model-observations.js';
import {
  SHIELD_RESTORE_GRACE_MS,
  shieldClientEndReason,
  tmuxEnv,
} from '../../services/shielded-tmux.js';
import { isShuttingDown } from '../../services/shutdown-state.js';
import { TASK_MARKER_VAR } from '../../services/task-processes.js';
import { TitleSequenceFilter } from '../../utils/ansi-title-filter.js';
import { claudeConfigDir } from '../../utils/claude-dir.js';
import { colors } from '../../utils/colors.js';
import { pathPrependEnv } from '../../utils/node-runtime.js';
import { terminalSessionEnv, withoutSecrets } from '../../utils/session-env.js';
import { trackDecModes } from '../../utils/terminal-modes.js';
import { WriteQueue } from '../../utils/write-queue.js';
import { VERSION } from '../../version.js';
import { AsciinemaWriter } from '../asciinema-writer.js';
import { ProcessUtils, recordedExitCode } from '../process-utils.js';
import { mergeConcurrentFields } from '../session-manager.js';
import { PtyError, type PtySession, type SessionCreationResult } from '../types.js';
import {
  logger,
  pty,
  SHIELD_REATTACH_RETRY_MS,
  spawnFailureHint,
  spawnRetrying,
} from './helpers.js';
import { PtyManagerIO } from './io.js';

export abstract class PtyManagerSpawn extends PtyManagerIO {
  /**
   * Create a new PTY session
   */
  async createSession(
    command: string[],
    options: SessionCreateOptions & {
      /** With `multiplexer`: the pane it opens on, until its tmux client is first listed. */
      attachSeed?: { panePid: number; paneId: string };
    }
  ): Promise<SessionCreationResult> {
    if (options.multiplexer && options.shielded) {
      // Shielding runs the command in the shield's tmux: a tmux client nested in tmux.
      throw new PtyError(
        'A session attached to a tmux session cannot be shielded',
        'INVALID_OPTIONS',
        options.sessionId
      );
    }
    if (options.withoutSecrets && (options.shielded || options.multiplexer)) {
      // A tmux server hands its sessions the environment it was started with (2026-10-23).
      throw new PtyError(
        'A session without credentials cannot run in tmux',
        'INVALID_OPTIONS',
        options.sessionId
      );
    }
    const sessionId = options.sessionId || uuidv4();
    const sessionName = options.name || path.basename(command[0]);
    // Correctly determine the web directory path (one level deeper: pty/pty-manager/)
    const webDir = path.resolve(__dirname, '..', '..', '..');
    const workingDir = options.workingDir || webDir;
    const term = this.defaultTerm;
    const cols = options.cols;
    const rows = options.rows;

    // Verify working directory exists
    logger.debug('Session creation parameters:', {
      sessionId,
      sessionName,
      workingDir,
      term,
      cols: cols !== undefined ? cols : 'terminal default',
      rows: rows !== undefined ? rows : 'terminal default',
    });

    try {
      // Create session directory structure
      const paths = this.sessionManager.createSessionDirectory(sessionId);

      // Resolve the command using unified resolution logic. A tmux client attaching to a user's
      // session is spawned as given (an absolute tmux): the PTY's pid must be that client.
      const resolved: ReturnType<typeof ProcessUtils.resolveCommand> = options.multiplexer
        ? { command: command[0], args: command.slice(1), useShell: false }
        : this.resolveSpawn(command);
      const { command: finalCommand, args: finalArgs } = resolved;
      const resolvedCommand = [finalCommand, ...finalArgs];

      // Log resolution details
      if (resolved.resolvedFrom === 'alias') {
        logger.log(
          colors.cyan(`Using alias: '${resolved.originalCommand}' → '${resolvedCommand.join(' ')}'`)
        );
      } else if (resolved.resolvedFrom === 'path' && resolved.originalCommand) {
        logger.log(colors.gray(`Resolved '${resolved.originalCommand}' → '${finalCommand}'`));
      } else if (resolved.useShell) {
        logger.debug(`Using shell to execute ${resolved.resolvedFrom}: ${command.join(' ')}`);
      }

      // Log the final command
      logger.debug(colors.blue(`Creating PTY session with command: ${resolvedCommand.join(' ')}`));
      logger.debug(`Working directory: ${workingDir}`);

      // Check if this session is being spawned from within Untether
      const attachedViaUT = !!process.env.UNTETHER_SESSION_ID;

      // A session continuing a Claude conversation keeps the titles of the one that ran it.
      const resumedConversation = claudeResumeTarget(command);
      // …and so does one continuing a Codex thread, known from the start: nothing else may
      // resume it meanwhile.
      const resumedThread = codexResumeTarget(resolvedCommand);
      const resumedId = resumedConversation ?? resumedThread;
      const inherited = resumedId
        ? inheritedTitles(this.sessionManager.listSessions(), resumedId, {
            excludeId: sessionId,
          })
        : {};
      const userTitle = options.userTitle?.trim() || inherited.userTitle;
      const claudeTitle = options.claudeTitle || inherited.claudeTitle;
      const groupPin = options.groupPin ?? inherited.groupPin;

      // What is really spawned: Untether's hooks added to a Claude (claude-hooks.ts).
      const spawnedCommand = options.multiplexer
        ? resolvedCommand
        : this.spawnCommand(resolvedCommand);

      // Create initial session info with resolved command
      const sessionInfo: SessionInfo = {
        id: sessionId,
        command: resolvedCommand,
        name: sessionName,
        workingDir: workingDir,
        status: 'starting',
        startedAt: new Date().toISOString(),
        initialCols: cols,
        initialRows: rows,
        lastClearOffset: 0,
        version: VERSION,
        gitRepoPath: options.gitRepoPath,
        gitBranch: options.gitBranch,
        gitAheadCount: options.gitAheadCount,
        gitBehindCount: options.gitBehindCount,
        gitHasChanges: options.gitHasChanges,
        gitIsWorktree: options.gitIsWorktree,
        gitMainRepoPath: options.gitMainRepoPath,
        attachedViaUT,
        ...(resumedConversation
          ? {
              claudeSessionId: resumedConversation,
              claudeStartSettings: {
                ...claudeStartSettings(claudeConfigDir(), undefined),
                spawned: true,
                conversations: [resumedConversation],
              },
            }
          : {}),
        ...(resumedThread ? { codexThreadId: resumedThread } : {}),
        ...(claudeTitle ? { claudeTitle } : {}),
        ...(userTitle ? { userTitle } : {}),
        ...(groupPin ? { groupPin } : {}),
        ...(options.shielded ? { shielded: true } : {}),
        ...(options.withoutSecrets ? { withoutSecrets: true } : {}),
        ...(options.taskId ? { taskId: options.taskId } : {}),
        ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
        ...(options.pathPrepend ? { pathPrepend: options.pathPrepend } : {}),
        ...(options.multiplexer ? { multiplexer: options.multiplexer } : {}),
        ...(spawnedCommand !== resolvedCommand ? { agentHooks: true } : {}),
      };

      if (options.shielded && !this.shieldTmux.isAvailable()) {
        throw new PtyError(
          'Shielded sessions need tmux, which is not installed',
          'SHIELD_UNAVAILABLE'
        );
      }

      // Save initial session info
      this.sessionManager.saveSessionInfo(sessionId, sessionInfo);

      // Create asciinema writer
      // Use actual dimensions if provided, otherwise AsciinemaWriter will use defaults (80x24)
      const asciinemaWriter = AsciinemaWriter.create(
        paths.stdoutPath,
        cols || undefined,
        rows || undefined,
        command.join(' '),
        sessionName,
        this.createEnvVars(term)
      );

      // Set up pruning detection callback for precise offset tracking
      asciinemaWriter.onPruningSequence(async ({ sequence, position }) => {
        const sessionInfo = this.sessionManager.loadSessionInfo(sessionId);
        if (sessionInfo) {
          sessionInfo.lastClearOffset = position;
          await this.sessionManager.saveSessionInfo(sessionId, sessionInfo);

          logger.debug(
            `Updated lastClearOffset for session ${sessionId} to exact position ${position} ` +
              `after detecting pruning sequence '${sequence.split('\x1b').join('\\x1b')}'`
          );
        }
      });

      // Create PTY process
      let ptyProcess: IPty;
      try {
        // Set up environment like Linux implementation
        const sessionEnv = terminalSessionEnv(process.env, {
          TERM: term,
          // Set session ID to prevent recursive ut calls and for debugging
          UNTETHER_SESSION_ID: sessionId,
          // A task's session: every process it starts carries the task (task-processes.ts).
          ...(options.taskId ? { [TASK_MARKER_VAR]: options.taskId } : {}),
          // A provider session: ANTHROPIC_BASE_URL/_AUTH_TOKEN and its model variables; the
          // key arrives here, never on argv (model-providers.ts).
          ...(options.env ?? {}),
        });
        // The user's own Anthropic credentials, removed for a provider session so it never mixes.
        for (const key of options.unsetEnv ?? []) delete sessionEnv[key];
        const ptyEnv = options.withoutSecrets ? withoutSecrets(sessionEnv) : sessionEnv;
        // This session's own Node (a task's project asking for another one): never handed to
        // the shield tmux server, whose environment every later session starts with.
        const ownEnv = options.pathPrepend ? pathPrependEnv(ptyEnv, options.pathPrepend) : {};

        // Debug log the spawn parameters
        logger.debug('PTY spawn parameters:', {
          command: finalCommand,
          args: finalArgs,
          options: {
            name: term,
            cols: cols !== undefined ? cols : 'terminal default',
            rows: rows !== undefined ? rows : 'terminal default',
            cwd: workingDir,
            hasEnv: !!ptyEnv,
            envKeys: Object.keys(ptyEnv).length,
          },
        });

        // Build spawn options - only include dimensions if provided
        const spawnOptions: IPtyForkOptions = {
          name: term,
          cwd: workingDir,
          env: { ...ptyEnv, ...ownEnv },
        };

        // Only add dimensions if they're explicitly provided
        if (cols !== undefined) {
          spawnOptions.cols = cols;
        }
        if (rows !== undefined) {
          spawnOptions.rows = rows;
        }

        if (options.shielded) {
          // The program runs in the shield tmux server; this PTY is only a client attached to it.
          await this.shieldTmux.create({
            sessionId,
            command: spawnedCommand,
            cwd: workingDir,
            cols,
            rows,
            env: ptyEnv,
            ownEnv,
            // A provider session's own variables and the credentials it drops reach the program
            // itself, not the shared tmux server (2026-11-08).
            ...(options.env ? { overrideEnv: options.env } : {}),
            ...(options.unsetEnv?.length ? { unsetEnv: options.unsetEnv } : {}),
          });
          const programPid = await this.shieldTmux.panePid(sessionId);
          if (programPid) this.shieldProgramPids.set(sessionId, programPid);
          const attach = this.shieldTmux.attachCommand(sessionId);
          // A server started from inside tmux must not hand its $TMUX to the client.
          ptyProcess = await spawnRetrying(() =>
            pty.spawn(attach.command, attach.args, { ...spawnOptions, env: tmuxEnv(ptyEnv) })
          );
        } else if (options.multiplexer) {
          // Never inside the tmux this server may have been started from.
          ptyProcess = await spawnRetrying(() =>
            pty.spawn(finalCommand, finalArgs, { ...spawnOptions, env: tmuxEnv(ptyEnv) })
          );
        } else {
          const [spawnFile, ...spawnArgs] = spawnedCommand;
          ptyProcess = await spawnRetrying(() => pty.spawn(spawnFile, spawnArgs, spawnOptions));
        }

        // Add immediate exit handler to catch CI issues
        const exitHandler = (event: { exitCode: number; signal?: number }) => {
          const timeSinceStart = Date.now() - Date.parse(sessionInfo.startedAt);
          if (timeSinceStart < 1000) {
            logger.error(
              `PTY process exited quickly after spawn! Exit code: ${event.exitCode}, signal: ${event.signal}, time: ${timeSinceStart}ms`
            );
            logger.error(
              'This often happens in CI when PTY allocation fails or shell is misconfigured'
            );
            logger.error('Debug info:', {
              SHELL: process.env.SHELL,
              TERM: process.env.TERM,
              CI: process.env.CI,
              NODE_ENV: process.env.NODE_ENV,
              command: finalCommand,
              args: finalArgs,
              cwd: workingDir,
              cwdExists: fs.existsSync(workingDir),
              commandExists: fs.existsSync(finalCommand),
            });
          }
        };
        ptyProcess.onExit(exitHandler);
      } catch (spawnError) {
        // Debug log the raw error first
        logger.debug('Raw spawn error:', {
          type: typeof spawnError,
          isError: spawnError instanceof Error,
          errorString: String(spawnError),
          errorKeys: spawnError && typeof spawnError === 'object' ? Object.keys(spawnError) : [],
        });

        // Provide better error messages for common issues
        let errorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);

        const errorCode =
          spawnError instanceof Error && 'code' in spawnError
            ? (spawnError as NodeJS.ErrnoException).code
            : undefined;
        if (errorCode === 'ENOENT' || errorMessage.includes('ENOENT')) {
          errorMessage = `Command not found: '${command[0]}'. Please ensure the command exists and is in your PATH.`;
        } else if (errorCode === 'EACCES' || errorMessage.includes('EACCES')) {
          errorMessage = `Permission denied: '${command[0]}'. The command exists but is not executable.`;
        } else if (errorCode === 'ENXIO' || errorMessage.includes('ENXIO')) {
          errorMessage = `Failed to allocate terminal for '${command[0]}'. This may occur if the command doesn't exist or the system cannot create a pseudo-terminal.`;
        } else if (errorMessage.includes('cwd') || errorMessage.includes('working directory')) {
          errorMessage = `Working directory does not exist: '${workingDir}'`;
        }

        // Log the error with better serialization
        const errorDetails =
          spawnError instanceof Error
            ? {
                ...spawnError,
                message: spawnError.message,
                stack: spawnError.stack,
                code: (spawnError as NodeJS.ErrnoException).code,
              }
            : spawnError;
        logger.error(`Failed to spawn PTY for command '${command.join(' ')}':`, errorDetails);
        throw new PtyError(errorMessage, 'SPAWN_FAILED');
      }

      // Create session object
      const titleMode = options.titleMode;

      // Detect if this is a tmux attachment session
      const isTmuxAttachment =
        !!options.multiplexer ||
        (resolvedCommand.includes('tmux') &&
          (resolvedCommand.includes('attach-session') ||
            resolvedCommand.includes('attach') ||
            resolvedCommand.includes('a'))) ||
        sessionName.startsWith('tmux:');

      const session: PtySession = {
        id: sessionId,
        sessionInfo,
        ptyProcess,
        asciinemaWriter,
        controlDir: paths.controlDir,
        stdoutPath: paths.stdoutPath,
        sessionJsonPath: paths.sessionJsonPath,
        startTime: new Date(),
        titleMode: titleMode || TitleMode.NONE,
        titleFilter: new TitleSequenceFilter(),
        isTmuxAttachment,
      };

      this.sessions.set(sessionId, session);
      if (options.multiplexer) {
        this.attachTracker.track(sessionId, {
          socketPath: options.multiplexer.socketPath,
          clientPid: ptyProcess.pid,
          seed: options.attachSeed,
        });
      }

      // Update session info with PID and running status (keeping what was set meanwhile)
      mergeConcurrentFields(sessionInfo, this.loadSessionInfoSafe(sessionId));
      sessionInfo.pid = ptyProcess.pid;
      sessionInfo.status = 'running';
      // Which process this pid is (pid reuse) and that it is this server's PTY.
      const pidStartTime = ProcessUtils.processStartTime(ptyProcess.pid);
      if (pidStartTime) sessionInfo.pidStartTime = pidStartTime;
      this.sessionManager.saveSessionInfo(sessionId, sessionInfo);

      logger.debug(
        colors.green(`Session ${sessionId} created successfully (PID: ${ptyProcess.pid})`)
      );
      logger.log(colors.gray(`Running: ${resolvedCommand.join(' ')} in ${workingDir}`));

      // Setup PTY event handlers
      this.setupPtyHandlers(session);

      // Start foreground process tracking
      this.startForegroundProcessTracking(session);

      // Emit session started event
      this.emit('sessionStarted', sessionId, sessionInfo.name || sessionInfo.command.join(' '));

      return {
        sessionId,
        sessionInfo,
      };
    } catch (error) {
      // Cleanup on failure
      if (options.shielded) await this.shieldTmux.kill(sessionId);
      this.attachTracker.untrack(sessionId);
      try {
        this.sessionManager.cleanupSession(sessionId);
      } catch (cleanupError) {
        logger.warn(`Failed to cleanup session ${sessionId} after creation failure:`, cleanupError);
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new PtyError(
        `Failed to create session: ${message}${spawnFailureHint(message)}`,
        'SESSION_CREATE_FAILED'
      );
    }
  }

  public getPtyForSession(sessionId: string): IPty | null {
    const session = this.sessions.get(sessionId);
    return session?.ptyProcess || null;
  }

  public getInternalSession(sessionId: string): PtySession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Setup event handlers for a PTY process
   */
  protected setupPtyHandlers(session: PtySession): void {
    const { ptyProcess, asciinemaWriter } = session;

    if (!ptyProcess) {
      logger.error(`No PTY process found for session ${session.id}`);
      return;
    }

    // Create write queue for input to prevent race conditions
    const inputQueue = new WriteQueue();
    session.inputQueue = inputQueue;

    // Handle PTY data output
    let outputPaused = false;
    ptyProcess.onData((data: string) => {
      let processedData = data;

      // Track PTY output in SessionMonitor for bell detection
      if (this.sessionMonitor) {
        this.sessionMonitor.trackPtyOutput(session.id, data);
      }
      this.outputObserver?.(session.id, data);

      // Track output activity for active/idle detection
      session.lastOutputTimestamp = Date.now();
      if (session.sessionInfo.shielded) {
        session.shieldOutputTail = ((session.shieldOutputTail ?? '') + data).slice(-256);
      }

      // Remember mode changes (mouse reporting, bracketed paste…) for replays.
      // Re-scan the end of the previous chunk too: a sequence can straddle two writes.
      session.sessionInfo.terminalModes ??= {};
      const modeText = (session.modeScanTail ?? '') + data;
      // 32: a combined set such as ESC[?1000;1002;1006h is 19 characters.
      session.modeScanTail = data.slice(-32);
      if (trackDecModes(session.sessionInfo.terminalModes, modeText)) {
        this.scheduleTerminalModesSave(session);
      }

      // If title mode is not NONE, filter out any title sequences the process might
      // have written to the stream.
      if (session.titleMode !== undefined && session.titleMode !== TitleMode.NONE) {
        processedData = session.titleFilter ? session.titleFilter.filter(data) : data;
      }

      // Write to asciinema file (it has its own internal queue)
      // The AsciinemaWriter now handles pruning detection internally with precise byte tracking
      asciinemaWriter?.writeOutput(Buffer.from(processedData, 'utf8'));
      if (asciinemaWriter?.isBackedUp() && !outputPaused) {
        // Let the kernel PTY buffer block the program instead of buffering in memory.
        outputPaused = true;
        ptyProcess.pause();
        asciinemaWriter.onceDrained(() => {
          outputPaused = false;
          ptyProcess.resume();
        });
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(async ({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      try {
        if (session.sessionInfo.shielded && !session.shieldKilling) {
          // Only the tmux client ended. While the server shuts down the program keeps running
          // and the next start attaches again: record nothing.
          if (isShuttingDown()) return;
          // Input typed from here until the next client attaches waits for it (queueShieldInput);
          // every branch below that brings no client clears this (or it expires).
          this.markShieldReattachPending(session.id);
          const tmuxAlive = await this.shieldTmux.has(session.id);
          const current = this.sessions.get(session.id) === session;
          // Another client of this session was attached meanwhile: its exit is not ours.
          if (!current && this.sessions.has(session.id)) return;
          if (tmuxAlive && current) {
            this.cleanupSessionResources(session);
            this.sessions.delete(session.id);
            if (asciinemaWriter?.isOpen()) await asciinemaWriter.close().catch(() => {});
            const now = Date.now();
            const recent = (session.shieldReattachTimes ?? []).filter((t) => now - t < 60_000);
            if (recent.length < 5) {
              logger.warn(`tmux client of shielded session ${session.id} ended; attaching again`);
              await this.reattachShieldedSession(session.id, [...recent, now]);
              return;
            }
            logger.error(`shielded session ${session.id}: tmux client keeps exiting, giving up`);
            // 2026-10-20: giving up recorded the session as exited while its program kept
            // running in tmux: "Resume Claude" then started a second writer of the conversation
            // and the next server start attached the first one again. End the program; if tmux
            // can't be reached to do that, the session stays running without a client and
            // attaching is tried again later.
            session.shieldKilling = true;
            await this.shieldTmux.kill(session.id);
            if ((await this.shieldTmux.probe(session.id)) !== 'gone') {
              const programPid = this.shieldProgramPids.get(session.id);
              this.patchSessionInfo(session.id, {
                status: 'running',
                ...(programPid
                  ? {
                      pid: programPid,
                      pidStartTime: ProcessUtils.processStartTime(programPid) ?? undefined,
                    }
                  : {}),
              });
              logger.error(
                `shielded session ${session.id}: its tmux can't be reached; left running, attaching again in ${SHIELD_REATTACH_RETRY_MS / 1000}s`
              );
              const retry = setTimeout(() => {
                if (this.sessions.has(session.id) || isShuttingDown()) return;
                this.reattachShieldedSession(session.id, []).catch((error) =>
                  logger.warn(`shielded session ${session.id}: attaching again failed: ${error}`)
                );
              }, SHIELD_REATTACH_RETRY_MS);
              retry.unref?.();
              // No client for minutes: input is refused meanwhile, never queued to be lost.
              this.dropShieldInput(session.id, 'tmux unreachable');
              return;
            }
            this.dropShieldInput(session.id, 'gave up attaching');
            this.patchSessionInfo(session.id, { shieldEnd: 'restore-failed' });
          } else if (
            !tmuxAlive &&
            current &&
            shieldClientEndReason(session.shieldOutputTail ?? '') === 'server-lost'
          ) {
            // The tmux server went away under a running program (Mac shutting down, tmux
            // killed). If this server is going down too, record nothing: the next start
            // recreates the session. Otherwise recreate it now.
            await new Promise((resolve) => setTimeout(resolve, 2000));
            if (isShuttingDown()) return;
            this.cleanupSessionResources(session);
            this.sessions.delete(session.id);
            if (asciinemaWriter?.isOpen()) await asciinemaWriter.close().catch(() => {});
            this.patchSessionInfo(session.id, { shieldEnd: 'tmux-lost' });
            logger.warn(`tmux server of shielded session ${session.id} went away; restoring it`);
            await this.restoreOrFinishShieldedSession(session.id, 'tmux-lost');
            return;
          } else if (!tmuxAlive) {
            this.dropShieldInput(session.id, 'program ended');
            // The program ended by itself: never revived. A restored program that dies right
            // away counts as a failed restore.
            const restoredAt = Date.parse(session.sessionInfo.restoredAt ?? '');
            this.patchSessionInfo(session.id, {
              shieldEnd:
                Number.isFinite(restoredAt) && Date.now() - restoredAt < SHIELD_RESTORE_GRACE_MS
                  ? 'restore-failed'
                  : 'program-exit',
            });
          }
        }
        // The code this exit is recorded and announced with, the same everywhere below. The
        // PTY of a shielded session is its tmux client, whose code says nothing about the
        // program: its own comes from the exit file (no file, no code).
        const recordedCode = recordedExitCode(
          session.sessionInfo.shielded
            ? (this.shieldTmux.takeExit(session.id) ?? {})
            : { exitCode, signal }
        );
        // Mark session as exiting to prevent false bell notifications
        this.sessionExitTimes.set(session.id, Date.now());
        // The app is gone: replaying an exited session must not turn its mouse
        // reporting back on (the wheel would talk to a dead process).
        session.sessionInfo.terminalModes = {};
        this.scheduleTerminalModesSave(session);
        // Write exit event to asciinema
        if (asciinemaWriter?.isOpen()) {
          asciinemaWriter.writeRawJson(['exit', recordedCode, session.id]);
          asciinemaWriter
            .close()
            .catch((error) =>
              logger.error(`Failed to close asciinema writer for session ${session.id}:`, error)
            );
        }

        // Update session status. Its files may be gone already ("cleanup" of a running
        // session removes them before the process dies): that threw here and skipped
        // everything below, so its timers ran (and logged) forever and no client heard
        // that it exited (2026-10-02).
        try {
          this.sessionManager.updateSessionStatus(session.id, 'exited', undefined, recordedCode);
        } catch (error) {
          logger.debug(`Could not record the exit of session ${session.id}: ${error}`);
        }

        // Clean up session resources
        this.cleanupSessionResources(session);

        // Remove from active sessions
        this.sessions.delete(session.id);

        // A suspended session did not end for anyone (session-suspender.ts): no exit event,
        // no notification. A wake that ended right away stays suspended, with the error.
        const suspension = this.loadSessionInfoSafe(session.id)?.suspended;
        if (suspension) {
          if (suspension.wakingAt) {
            this.patchSessionInfo(session.id, {
              shieldEnd: 'suspended',
              suspended: {
                ...suspension,
                wakingAt: undefined,
                resumeError: 'Claude ended right after resuming',
                resumeErrorAt: new Date().toISOString(),
              },
            });
          }
          return;
        }

        // Emit session exited event
        this.emit(
          'sessionExited',
          session.id,
          session.sessionInfo.name || session.sessionInfo.command.join(' '),
          recordedCode
        );
      } catch (error) {
        logger.error(`Failed to handle exit for session ${session.id}:`, error);
      }
    });

    // Setup IPC socket for all communication
    this.setupIPCSocket(session);
  }
}
