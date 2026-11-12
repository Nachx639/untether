/** Shielded (tmux) sessions: reattach, restore, suspend and resume. Part of PtyManager (pty-manager.ts). */

import * as fs from 'fs';

import type { IPty } from 'node-pty';
import * as os from 'os';

import { isForwardedSession } from '../../../shared/forwarded-session.js';
import type { SessionInfo, SessionInput, SessionSuspension } from '../../../shared/types.js';
import { TitleMode } from '../../../shared/types.js';
import { defaultCodexDir, findCodexRollout } from '../../services/codex-chat.js';
import { codexIdFromRollout, startsCodex } from '../../services/codex-thread.js';
import {
  keepShellAfterClaude,
  lastCastSize,
  recentShieldRestores,
  SHIELD_RESTORED_BANNER,
  SHIELD_RESUMED_BANNER,
  shieldRestorePlan,
  shieldStartupAction,
  shieldUsesLaunchd,
  terminalClaudeNoticePlan,
  tmuxEnv,
} from '../../services/shielded-tmux.js';
import { TASK_MARKER_VAR } from '../../services/task-processes.js';
import {
  type AttachedMode,
  clientMode,
  type TmuxClient,
} from '../../services/tmux-attach-tracker.js';
import { TitleSequenceFilter } from '../../utils/ansi-title-filter.js';
import { colors } from '../../utils/colors.js';
import { pathPrependEnv } from '../../utils/node-runtime.js';
import { terminalSessionEnv, withoutSecrets } from '../../utils/session-env.js';
import { AsciinemaWriter } from '../asciinema-writer.js';
import { secureUntetherState } from '../private-perms.js';
import { ProcessUtils, recordedExitCode } from '../process-utils.js';
import { PtyError, type PtySession } from '../types.js';
import { logger, pty } from './helpers.js';
import { PtyManagerLifecycle } from './lifecycle.js';

export abstract class PtyManagerShield extends PtyManagerLifecycle {
  /**
   * Server start: attach again to every shielded session whose tmux session survived, under
   * the same id (phones reconnect on their own). Shielded sessions whose tmux session is gone
   * while they were still running (the Mac rebooted, tmux was killed) are recreated under the
   * same id; ones the user killed or whose program ended stay exited. Runs before any cleanup
   * so none of them is discarded. Also the server's other start-up repairs (once per start):
   * sessions the previous server left behind (sweepSessionsOfPreviousServer) and private
   * permissions of the state folder (secureUntetherState).
   */
  async reattachShieldedSessions(): Promise<{
    reattached: string[];
    restored: string[];
    finished: string[];
  }> {
    const reattached: string[] = [];
    const restored: string[] = [];
    const finished: string[] = [];
    // Server start: first what the previous server left 'starting' or as its own PTYs.
    this.sessionManager.sweepSessionsOfPreviousServer((info) => isForwardedSession(info));
    // …and, once, the state written before it was private (private-perms.ts).
    secureUntetherState(this.sessionManager.getControlPath());
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.sessionManager.getControlPath(), { withFileTypes: true });
    } catch {
      return { reattached, restored, finished };
    }
    // Input typed to them while this runs waits for their client (sendInput's queue).
    for (const entry of entries) {
      if (entry.isDirectory() && !this.sessions.has(entry.name)) {
        this.markShieldReattachPending(entry.name);
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || this.sessions.has(entry.name)) continue;
      const info = this.sessionManager.loadSessionInfo(entry.name);
      if (!info?.shielded) {
        this.clearShieldReattachPending(entry.name);
        continue;
      }
      const action = shieldStartupAction(info, await this.shieldTmux.has(entry.name));
      if (action === 'reattach') {
        if (await this.reattachShieldedSession(entry.name)) reattached.push(entry.name);
      } else if (action === 'restore' || action === 'give-up') {
        if (await this.restoreOrFinishShieldedSession(entry.name, 'reboot')) {
          restored.push(entry.name);
        } else {
          finished.push(entry.name);
        }
      } else if (action === 'mark-exited') {
        // Its program ended while no server ran: its own code when it left one, else none.
        this.sessionManager.updateSessionStatus(
          entry.name,
          'exited',
          undefined,
          recordedExitCode(this.shieldTmux.takeExit(entry.name) ?? {})
        );
        finished.push(entry.name);
      }
      if (!this.sessions.has(entry.name)) this.dropShieldInput(entry.name, 'not attached');
    }
    if (reattached.length || restored.length || finished.length) {
      logger.log(
        colors.green(
          `shielded sessions: ${reattached.length} re-attached, ${restored.length} restored, ${finished.length} finished`
        )
      );
    }
    return { reattached, restored, finished };
  }

  /** Finish a lost shielded session for good (restore loop or restore error). */
  protected finishLostShieldedSession(sessionId: string, reason: string): void {
    logger.error(`shielded session ${sessionId} not restored: ${reason}`);
    this.patchSessionInfo(sessionId, { shieldEnd: 'restore-failed' });
    try {
      this.sessionManager.updateSessionStatus(sessionId, 'exited', undefined, 1);
    } catch {
      // session.json is gone.
    }
  }

  /**
   * Recreate a shielded session whose tmux session is gone, under the same id, name, folder
   * and size: Claude resumes its conversation, Codex its thread, anything else starts again.
   * The old output stays in the cast, followed by a "restored" line. Returns false (and marks
   * the session exited) when the loop guard refuses or the restore fails.
   */
  async restoreOrFinishShieldedSession(
    sessionId: string,
    from: 'reboot' | 'tmux-lost'
  ): Promise<boolean> {
    const info = this.sessionManager.loadSessionInfo(sessionId);
    const paths = this.sessionManager.getSessionPaths(sessionId);
    if (!info || !paths) return false;
    const now = Date.now();
    const action = shieldStartupAction({ ...info, shieldEnd: 'tmux-lost' }, false, now);
    if (action === 'give-up') {
      this.finishLostShieldedSession(sessionId, 'restored too many times in the last hour');
      return false;
    }
    if (!this.shieldTmux.isAvailable()) {
      this.finishLostShieldedSession(sessionId, 'tmux is not installed');
      return false;
    }

    // 2026-10-20: the newest rollout in the folder was taken, so two Codex sessions in one
    // folder were both restored on the same (wrong) thread. The thread recorded while it ran
    // comes first; else a rollout no other session recorded.
    let codexThreadId: string | null = info.codexThreadId ?? null;
    if (!codexThreadId) {
      try {
        codexThreadId = this.findUnclaimedCodexThread(sessionId, info);
      } catch {
        codexThreadId = null;
      }
    }
    let plan = shieldRestorePlan(info, codexThreadId);
    const cwd =
      [plan.cwd, info.workingDir].find((dir) => dir && fs.existsSync(dir)) ?? os.homedir();
    const size = lastCastSize(paths.stdoutPath) ?? {
      cols: info.initialCols ?? 120,
      rows: info.initialRows ?? 30,
    };
    const restores = [...recentShieldRestores(info, now), now];
    try {
      const sessionEnv = terminalSessionEnv(process.env, {
        TERM: this.defaultTerm,
        UNTETHER_SESSION_ID: sessionId,
        ...(info.taskId ? { [TASK_MARKER_VAR]: info.taskId } : {}),
      });
      // A sweep's agent comes back without the user's credentials too.
      const env = info.withoutSecrets ? withoutSecrets(sessionEnv) : sessionEnv;
      // A provider session comes back against its provider (key re-read), not the user's login.
      // If it cannot (provider gone, key unreadable), never restore it on the user's own
      // Anthropic account: leave it stopped with the reason.
      let providerLaunch: { env: Record<string, string>; unset: string[] } | null = null;
      const provider = info.modelProvider ?? plan.modelProvider;
      if (provider) {
        providerLaunch = await this.applyProviderEnv(env, provider);
        if (!providerLaunch && info.terminalClaude && !info.modelProvider) {
          // A terminal is still worth having back; its Claude waits for the user instead.
          plan = terminalClaudeNoticePlan(info.command, info.terminalClaude);
        } else if (!providerLaunch) {
          this.patchSessionInfo(sessionId, { shieldRestores: restores });
          this.finishLostShieldedSession(
            sessionId,
            `cannot restore against model provider "${provider.id}" (missing provider or key)`
          );
          return false;
        }
      }
      const resolved = this.resolveSpawn(plan.command);
      const spawned = this.spawnCommand([resolved.command, ...resolved.args], sessionId);
      await this.shieldTmux.create({
        sessionId,
        command: plan.thenShell ? keepShellAfterClaude(spawned, plan.thenShell) : spawned,
        cwd,
        cols: size.cols,
        rows: size.rows,
        env,
        // Its own Node comes back with it.
        ...(info.pathPrepend ? { ownEnv: pathPrependEnv(env, info.pathPrepend) } : {}),
        // The provider's variables reach the program itself, not the shared tmux server.
        ...(providerLaunch
          ? { overrideEnv: providerLaunch.env, unsetEnv: providerLaunch.unset }
          : {}),
      });
    } catch (error) {
      this.patchSessionInfo(sessionId, { shieldRestores: restores });
      this.finishLostShieldedSession(
        sessionId,
        `cannot start ${plan.command.join(' ')}: ${error instanceof Error ? error.message : error}`
      );
      return false;
    }
    this.patchSessionInfo(sessionId, {
      status: 'running',
      exitCode: undefined,
      shieldEnd: undefined,
      restoredAt: new Date(now).toISOString(),
      restoredFrom: from,
      shieldRestores: restores,
    });
    logger.log(
      colors.green(
        `restored shielded session ${sessionId} (${plan.kind}): ${plan.command.join(' ')} in ${cwd}`
      )
    );
    if (plan.kind === 'terminal-claude-notice') {
      logger.warn(`session ${sessionId}: its Claude needs an environment that cannot be rebuilt`);
    }
    if (
      await this.reattachShieldedSession(
        sessionId,
        [],
        `${SHIELD_RESTORED_BANNER}${plan.banner ?? ''}`
      )
    ) {
      return true;
    }
    await this.shieldTmux.kill(sessionId);
    this.finishLostShieldedSession(sessionId, 'cannot attach to the recreated tmux session');
    return false;
  }

  /**
   * Suspend a shielded Claude session (2026-10-31, services/session-suspender.ts): the record
   * goes into session.json first (a restart midway finds it), then its tmux session ends the
   * way a Kill ends it (Blindar's and the user's stop), then whatever of `tree` (Claude and the
   * processes under it, read before) still runs is ended too, checked by start time so a pid
   * the kernel gave to another program is never signalled. The session stays, exited and
   * marked suspended; no "session ended" event goes out (nobody is told it ended).
   */
  async suspendShieldedSession(
    sessionId: string,
    record: SessionSuspension,
    tree: number[],
    /** The input time the suspender's last look saw: anything newer cancels the suspension. */
    lastInputSeen?: number
  ): Promise<{ heldInput: SessionInput[] }> {
    const memorySession = this.sessions.get(sessionId);
    const info = memorySession?.sessionInfo ?? this.sessionManager.loadSessionInfo(sessionId);
    if (!info?.shielded || info.status !== 'running') {
      throw new PtyError(
        'Only a running shielded session is suspended',
        'INVALID_STATE',
        sessionId
      );
    }
    // From here on input is held instead of typed (sendInput), so none reaches a Claude that
    // is about to end; input since the last look cancels it (2026-10-31 review).
    //
    // Two ends only, and the held input goes somewhere in both (2026-10-31, second review):
    // - cancelled while Claude still runs (input since the last look, or tmux did not end):
    //   the record is undone and the held input is typed into it right away;
    // - its tmux ended: it is suspended, and the held input is returned (the suspender wakes
    //   it and types it). Nothing after that point throws.
    const heldInput: SessionInput[] = [];
    this.inputDuringSuspend.set(sessionId, heldInput);
    const cancel = (reason: string, code: string): never => {
      if (memorySession) memorySession.shieldKilling = false;
      this.patchSessionInfo(sessionId, { suspended: undefined, shieldEnd: undefined });
      this.inputDuringSuspend.delete(sessionId);
      for (const input of heldInput) this.sendInput(sessionId, input);
      throw new PtyError(reason, code, sessionId);
    };
    let starts: Map<number, string | null>;
    try {
      if (this.lastInputAt(sessionId) !== lastInputSeen) {
        cancel('Input arrived since the last look', 'INVALID_STATE');
      }
      starts = new Map(tree.map((pid) => [pid, ProcessUtils.processStartTime(pid)]));
      if (memorySession) memorySession.shieldKilling = true;
      this.patchSessionInfo(sessionId, { suspended: record, shieldEnd: 'suspended' });
      await this.shieldTmux.kill(sessionId).catch(() => {});
    } catch (error) {
      if (error instanceof PtyError) throw error;
      cancel(`Suspending failed: ${error}`, 'KILL_FAILED');
      throw error; // unreachable: cancel throws
    }
    // tmux could not end it (or it can't be told): it still runs, so it is not suspended.
    if (await this.shieldTmux.has(sessionId).catch(() => true)) {
      cancel('Its tmux session could not be ended', 'KILL_FAILED');
    }
    try {
      await this.finishSuspension(sessionId, memorySession, tree, starts);
    } catch (error) {
      logger.warn(`suspending session ${sessionId}: cleanup after the stop failed: ${error}`);
    }
    this.inputDuringSuspend.delete(sessionId);
    if (heldInput.length > 0) {
      // On disk with the suspension: the next successful wake types it.
      const current = this.loadSessionInfoSafe(sessionId)?.suspended ?? record;
      this.patchSessionInfo(sessionId, {
        suspended: { ...current, pendingInput: [...(current.pendingInput ?? []), ...heldInput] },
      });
    }
    return { heldInput: [...heldInput] };
  }

  protected async finishSuspension(
    sessionId: string,
    memorySession: PtySession | undefined,
    tree: number[],
    starts: Map<number, string | null>
  ): Promise<void> {
    if (memorySession?.ptyProcess) {
      for (let i = 0; i < 50 && this.sessions.get(sessionId) === memorySession; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (this.loadSessionInfoSafe(sessionId)?.status !== 'exited') {
      this.sessionManager.updateSessionStatus(sessionId, 'exited', undefined, 0);
    }
    // MCP servers normally end with Claude; those that do not are ended here.
    const alive = () =>
      tree.filter((pid) => {
        const start = starts.get(pid);
        return !!start && ProcessUtils.isSameProcess(pid, start);
      });
    for (let i = 0; i < 30 && alive().length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const left = alive();
      if (left.length === 0) break;
      logger.warn(
        `suspending session ${sessionId}: ${left.length} process(es) still ran (${left.join(', ')}); ${signal}`
      );
      for (const pid of left) {
        try {
          process.kill(pid, signal);
        } catch {
          // Gone meanwhile.
        }
      }
      for (let i = 0; i < 30 && alive().length > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const left = alive();
    if (left.length > 0) {
      logger.error(`suspended session ${sessionId}: processes still run: ${left.join(', ')}`);
    }
  }

  /**
   * Wake a suspended session under the same id: its tmux session is created again running
   * `claude --resume <conversation>` with the flags it had, in its folder, and a client
   * attaches (shieldRestorePlan, as after a reboot). The record stays (with `wakingAt`) until
   * the suspender sees Claude back on its conversation; a failure leaves it suspended.
   */
  async resumeSuspendedSession(
    sessionId: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const info = this.sessionManager.loadSessionInfo(sessionId);
    const record = info?.suspended;
    if (!info || !record) return { ok: false, error: 'Session is not suspended' };
    if (this.sessions.has(sessionId) || info.status === 'running') {
      return { ok: false, error: 'Session is already running' };
    }
    if (!this.shieldTmux.isAvailable()) return { ok: false, error: 'tmux is not installed' };
    if (await this.shieldTmux.has(sessionId)) {
      return { ok: false, error: 'Its tmux session still exists' };
    }
    const plan = shieldRestorePlan({
      command: record.command,
      claudeSessionId: record.claudeSessionId,
    });
    if (plan.kind !== 'claude-resume') return { ok: false, error: 'Not a Claude conversation' };
    if (!fs.existsSync(record.workingDir)) {
      return { ok: false, error: `Folder ${record.workingDir} no longer exists` };
    }
    const paths = this.sessionManager.getSessionPaths(sessionId);
    const size = (paths && lastCastSize(paths.stdoutPath)) || {
      cols: info.initialCols ?? 120,
      rows: info.initialRows ?? 30,
    };
    const wakingAt = new Date().toISOString();
    this.patchSessionInfo(sessionId, {
      suspended: { ...record, wakingAt, resumeError: undefined },
    });
    try {
      const resolved = this.resolveSpawn(plan.command);
      const built = terminalSessionEnv(process.env, {
        TERM: this.defaultTerm,
        UNTETHER_SESSION_ID: sessionId,
        ...(info.taskId ? { [TASK_MARKER_VAR]: info.taskId } : {}),
      });
      const env = info.withoutSecrets ? withoutSecrets(built) : built;
      // Woken against its provider (key re-read), not the user's own Anthropic login. If it
      // cannot, never wake it on the user's own account: the catch records the reason.
      let providerLaunch: { env: Record<string, string>; unset: string[] } | null = null;
      if (info.modelProvider) {
        providerLaunch = await this.applyProviderEnv(env, info.modelProvider);
        if (!providerLaunch) {
          throw new Error(
            `cannot wake against model provider "${info.modelProvider.id}" (missing provider or key)`
          );
        }
      }
      await this.shieldTmux.create({
        sessionId,
        command: this.spawnCommand([resolved.command, ...resolved.args], sessionId),
        cwd: record.workingDir,
        cols: size.cols,
        rows: size.rows,
        env,
        ...(info.pathPrepend ? { ownEnv: pathPrependEnv(env, info.pathPrepend) } : {}),
        // The provider's variables reach the program itself, not the shared tmux server.
        ...(providerLaunch
          ? { overrideEnv: providerLaunch.env, unsetEnv: providerLaunch.unset }
          : {}),
      });
    } catch (error) {
      const message = `cannot start ${plan.command.join(' ')}: ${error}`;
      // The error stays on the session (its row shows it with a retry), not only returned.
      this.patchSessionInfo(sessionId, {
        suspended: {
          ...record,
          wakingAt: undefined,
          resumeError: message,
          resumeErrorAt: new Date().toISOString(),
        },
      });
      return { ok: false, error: message };
    }
    this.patchSessionInfo(sessionId, {
      status: 'running',
      exitCode: undefined,
      shieldEnd: undefined,
    });
    logger.log(colors.green(`waking suspended session ${sessionId}: ${plan.command.join(' ')}`));
    if (await this.reattachShieldedSession(sessionId, [], SHIELD_RESUMED_BANNER)) {
      return { ok: true };
    }
    await this.shieldTmux.kill(sessionId);
    this.patchSessionInfo(sessionId, {
      status: 'exited',
      shieldEnd: 'suspended',
      suspended: {
        ...record,
        wakingAt: undefined,
        resumeError: 'cannot attach to its new tmux session',
        resumeErrorAt: new Date().toISOString(),
      },
    });
    return { ok: false, error: 'cannot attach to its new tmux session' };
  }

  /** When a client last typed into the session since this server started (epoch ms). */
  lastInputAt(sessionId: string): number | undefined {
    return (
      this.sessions.get(sessionId)?.lastInputTimestamp ?? this.lastInputTimestamps.get(sessionId)
    );
  }

  /**
   * The user pressed keys in the session (a client typed, not Untether): what Untether types
   * for an agent waits for it (user-input-guard.ts, 2026-11-10).
   */
  noteUserInput(sessionId: string): void {
    this.userInputTimestamps.set(sessionId, Date.now());
  }

  /** When the user last pressed keys in the session since this server started (epoch ms). */
  lastUserInputAt(sessionId: string): number | undefined {
    return this.userInputTimestamps.get(sessionId);
  }

  /** Set or clear a session's suspension record (the suspender's bookkeeping). */
  setSessionSuspension(sessionId: string, record: SessionSuspension | undefined): void {
    this.patchSessionInfo(sessionId, { suspended: record });
  }

  /** The user's "keep awake" for one session (never suspended). */
  setKeepAwake(sessionId: string, keepAwake: boolean): boolean {
    if (!this.loadSessionInfoSafe(sessionId)) return false;
    this.patchSessionInfo(sessionId, { keepAwake: keepAwake || undefined });
    return true;
  }

  /** Attach a new tmux client PTY to a live shielded session, keeping its id and cast file. */
  async reattachShieldedSession(
    sessionId: string,
    reattachTimes: number[] = [],
    banner?: string
  ): Promise<boolean> {
    const info = this.sessionManager.loadSessionInfo(sessionId);
    const paths = this.sessionManager.getSessionPaths(sessionId);
    if (!info || !paths) {
      this.dropShieldInput(sessionId, 'session gone');
      return false;
    }
    this.markShieldReattachPending(sessionId);
    const size = (await this.shieldTmux.windowSize(sessionId)) ?? {
      cols: info.initialCols ?? 120,
      rows: info.initialRows ?? 30,
    };
    const programPid = await this.shieldTmux.panePid(sessionId);
    if (programPid) this.shieldProgramPids.set(sessionId, programPid);
    const asciinemaWriter = AsciinemaWriter.resume(paths.stdoutPath, size.cols, size.rows);
    if (banner) {
      // Recreated session: say so in the history, after the output from before the reboot.
      asciinemaWriter.writeOutput(Buffer.from(banner));
      asciinemaWriter.writeMarker('Untether: session restored');
    }
    // tmux repaints the screen when a client attaches: that clear must not hide the output
    // from before the restart when clients replay the cast.
    const attachedAt = Date.now();
    asciinemaWriter.onPruningSequence(({ position }) => {
      if (Date.now() - attachedAt < 3000) return;
      const current = this.sessionManager.loadSessionInfo(sessionId);
      if (!current) return;
      current.lastClearOffset = position;
      this.sessionManager.saveSessionInfo(sessionId, current);
    });

    let ptyProcess: IPty;
    try {
      const attach = this.shieldTmux.attachCommand(sessionId);
      const env = terminalSessionEnv(process.env, {
        TERM: this.defaultTerm,
        UNTETHER_SESSION_ID: sessionId,
      });
      ptyProcess = pty.spawn(attach.command, attach.args, {
        name: this.defaultTerm,
        cwd: fs.existsSync(info.workingDir) ? info.workingDir : process.cwd(),
        env: tmuxEnv(env),
        cols: size.cols,
        rows: size.rows,
      });
    } catch (error) {
      logger.error(`cannot attach to shielded session ${sessionId}:`, error);
      await asciinemaWriter.close().catch(() => {});
      this.dropShieldInput(sessionId, 'attach failed');
      return false;
    }

    // session.json as it is now: renames, titles or mute set during the awaits above stay.
    const sessionInfo: SessionInfo = {
      ...(this.loadSessionInfoSafe(sessionId) ?? info),
      status: 'running',
      pid: ptyProcess.pid,
      // The new client's own start time (the old one named the previous client).
      pidStartTime: ProcessUtils.processStartTime(ptyProcess.pid) ?? undefined,
      exitCode: undefined,
    };
    const session: PtySession = {
      id: sessionId,
      sessionInfo,
      ptyProcess,
      asciinemaWriter,
      controlDir: paths.controlDir,
      stdoutPath: paths.stdoutPath,
      sessionJsonPath: paths.sessionJsonPath,
      startTime: new Date(),
      titleMode: TitleMode.NONE,
      titleFilter: new TitleSequenceFilter(),
      isTmuxAttachment: false,
      shieldReattachTimes: reattachTimes,
    };
    this.sessions.set(sessionId, session);
    this.sessionManager.saveSessionInfo(sessionId, sessionInfo);
    this.setupPtyHandlers(session);
    this.flushShieldInput(session);
    this.startForegroundProcessTracking(session);
    logger.log(
      colors.green(`re-attached shielded session ${sessionId} (client PID: ${ptyProcess.pid})`)
    );
    return true;
  }

  /**
   * Re-read the program pid of running shielded sessions whose stored one died (a respawned
   * pane), and of all of them now and then. Cheap: no tmux call while the stored pids live.
   * The Claude status notifier awaits it before each look.
   */
  async refreshProgramPids(): Promise<void> {
    const shielded = [...this.sessions.values()]
      .filter((session) => session.sessionInfo.shielded && session.sessionInfo.status === 'running')
      .map((session) => session.id);
    for (const { sessionId, from, to } of await this.shieldProgramPids.refresh(shielded)) {
      logger.log(`shielded session ${sessionId}: program pid ${from ?? 'unknown'} → ${to}`);
    }
  }

  /**
   * The rollout of a Codex session's thread that no other session recorded as its own, for a
   * restore of a session whose thread was never recorded (it ran for a moment only).
   */
  protected findUnclaimedCodexThread(sessionId: string, info: SessionInfo): string | null {
    const since = Date.parse(info.startedAt);
    if (Number.isNaN(since) || !startsCodex(info.command)) return null;
    const claimedIds = new Set<string>();
    for (const other of this.sessionManager.listSessions()) {
      if (other.id !== sessionId && other.codexThreadId) claimedIds.add(other.codexThreadId);
    }
    const claimed = new Set<string>();
    // findCodexRollout skips claimed paths: try again without each one claimed by id.
    for (let attempt = 0; attempt < 20; attempt++) {
      const rollout = findCodexRollout(defaultCodexDir(), info.workingDir, since, claimed);
      const threadId = codexIdFromRollout(rollout);
      if (!rollout || !threadId) return null;
      if (!claimedIds.has(threadId)) return threadId;
      claimed.add(rollout);
    }
    return null;
  }

  /**
   * Root of a session's process tree for detecting what runs in it (Claude, Codex): the program
   * inside tmux for a shielded session, the pane its client shows for one attached to a user's
   * tmux session, else the session's own pid.
   */
  programRootPid(session: Pick<SessionInfo, 'id' | 'pid' | 'shielded'>): number | undefined {
    return (
      (session.shielded && this.shieldProgramPids.get(session.id)) ||
      this.attachTracker.programPid(session.id) ||
      session.pid
    );
  }

  /**
   * Switches a session attached to a user's tmux session between control and watch, or how its
   * client sizes the window (`sizing` applies to control). Fields left out stay as they are.
   * Answers what tmux reports afterwards, which its `multiplexer` then records too. Throws
   * TmuxAttachError (client-not-found, mode-failed) when tmux can't be asked or didn't take it.
   */
  async setAttachedMode(sessionId: string, change: Partial<AttachedMode>): Promise<AttachedMode> {
    const multiplexer = this.sessions.get(sessionId)?.sessionInfo.multiplexer;
    if (!multiplexer) {
      throw new PtyError(
        `Session ${sessionId} is not attached to a tmux session`,
        'NOT_ATTACHED',
        sessionId
      );
    }
    const target: AttachedMode = {
      mode: change.mode ?? multiplexer.mode,
      sizing: change.sizing ?? multiplexer.sizing,
    };
    return clientMode(await this.attachTracker.setMode(sessionId, target));
  }

  /** tmux lists an attached session's client differently: keep its mode and folder in step. */
  protected reconcileAttached(sessionId: string, client: TmuxClient): void {
    const info = this.sessions.get(sessionId)?.sessionInfo;
    const multiplexer = info?.multiplexer;
    if (!info || !multiplexer) return;
    // A key bound to switch-client -r, or a `cd` or another window in the pane.
    const { mode, sizing } = clientMode(client);
    const patch: Partial<SessionInfo> = {};
    if (mode !== multiplexer.mode || sizing !== multiplexer.sizing) {
      patch.multiplexer = { ...multiplexer, mode, sizing };
    }
    if (client.cwd && client.cwd !== info.workingDir) patch.workingDir = client.cwd;
    if (Object.keys(patch).length > 0) this.patchSessionInfo(sessionId, patch);
  }

  /** pid of the program inside a shielded session (diagnostics and tests). */
  async shieldedProgramPid(sessionId: string): Promise<number | null> {
    return this.shieldTmux.panePid(sessionId);
  }

  isShieldAvailable(): boolean {
    return this.shieldTmux.isAvailable();
  }

  /** Whether the running shield tmux server answers a client of `bin` (null: none runs). */
  shieldAnswersWith(bin: string): Promise<boolean | null> {
    return this.shieldTmux.answersWith(bin);
  }

  /** Executables of every tmux server on the shield socket, old ones too (null: unreadable). */
  shieldServerBinaries(): Promise<string[] | null> {
    return this.shieldTmux.serverBinaries();
  }

  /**
   * Full Disk Access of the running shield tmux server. Only told when launchd started it
   * (its own responsible process); otherwise macOS asks Untether's, so 'unknown'.
   */
  async shieldFullDiskAccess(): Promise<'granted' | 'denied' | 'no-server' | 'unknown'> {
    if (!shieldUsesLaunchd()) return 'unknown';
    return this.shieldTmux.fullDiskAccess();
  }

  /** Remove the server's runtime variables from the shield tmux server (the names removed). */
  cleanShieldEnvironment(): Promise<string[]> {
    return this.shieldTmux.cleanGlobalEnvironment();
  }
}
