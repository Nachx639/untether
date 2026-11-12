/**
 * Sessions: preparing a task's worktree and starting, reopening, resuming and stopping its agent's
 * session.
 * One layer of TaskScheduler (task-scheduler.ts).
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TASK_REPORT_MAX } from '../../shared/orchestrator-prompt.js';
import { beginEffect, endEffect, pendingEffect } from '../../shared/task-effects.js';
import { buildTaskPrompt } from '../../shared/task-prompt.js';
import { fillTaskPlaceholders, type TaskRecord } from '../../shared/tasks.js';
import { BACKGROUND } from './claude-status-notifier.js';
import { resumeText } from './task-launcher.js';
import { TaskSchedulerOverlap } from './task-scheduler-overlap.js';
import {
  FINISHED_SESSION_BUSY_MS,
  FINISHED_SESSION_GRACE_MS,
  isFinal,
  limitKeyOf,
  MAX_TASK_RESUMES,
  RESTART_WINDOW_MS,
  SETUP_RETRY_MS,
  STARTABLE_STATES,
  TASK_START_CUTS_MAX,
} from './task-scheduler-rules.js';
import type { LaunchedSession, TaskWorktreeSetup } from './task-scheduler-types.js';
import { TaskWorktreeError } from './task-worktree.js';

export abstract class TaskSchedulerSessions extends TaskSchedulerOverlap {
  /**
   * A task the server stopped while it was starting (preparing, or working with no session):
   * nothing of its agent ran yet, so it starts over by itself, not told as a failure (2026-11-02,
   * ecc6e416). A worktree it made whole is recorded as its worktree step (task journal), so
   * dropPendingWorktree removes it as it does a half-made one, and a restart during that removal
   * finds it again; the new start makes a fresh one after it (both wait on `preparing`). Its
   * cuts in a row are kept on it (startCuts): past TASK_START_CUTS_MAX, or with its budget
   * spent, it fails with the reason and is told. True when it is to start over.
   */
  protected cutWhileStarting(task: TaskRecord): boolean {
    const cuts = (task.startCuts ?? 0) + 1;
    task.startCuts = cuts;
    const why = 'The server stopped while the task was starting';
    const give = (message: string) => {
      this.fail(task, 'setup', message);
      this.deps.onError?.(`Task ${task.id}: ${message}`);
      this.notifyState(task, message);
      return false;
    };
    if (cuts > TASK_START_CUTS_MAX) return give(`${why}, ${cuts} times in a row`);
    if (this.budgetSpent(task)) return give(`${why}, and its budget is spent`);
    if (
      task.isolation === 'worktree' &&
      task.worktreePath &&
      task.branch &&
      !pendingEffect(task, 'worktree')
    ) {
      beginEffect(task, {
        kind: 'worktree',
        key: task.branch,
        at: new Date(this.now()).toISOString(),
        repoPath: task.repoPath ?? task.workingDir,
        branch: task.branch,
        worktreePath: task.worktreePath,
      });
    }
    for (const key of ['worktreePath', 'branch', 'baseSha', 'sessionId'] as const) {
      delete task[key];
    }
    delete task.error;
    delete task.heldFor;
    this.setState(task, 'scheduled');
    this.deps.onError?.(
      `Task ${task.id}: ${why}; it starts over (${cuts} of ${TASK_START_CUTS_MAX})`
    );
    return true;
  }

  /**
   * The worktree a task was getting when the server stopped (its worktree step, task
   * journal): it goes, unless another task uses that folder or branch by now. Nothing ran in
   * it yet.
   */
  protected dropPendingWorktree(task: TaskRecord): void {
    const pending = pendingEffect(task, 'worktree');
    if (!pending) return;
    const taken = this.tasks.some(
      (other) =>
        other.id !== task.id &&
        (other.branch === pending.branch ||
          other.worktreePath === pending.worktreePath ||
          pendingEffect(other, 'worktree')?.branch === pending.branch)
    );
    // 2026-11-01 review: the step was dropped before the removal, so a restart during it lost
    // the half-made folder. It stays recorded until the removal says it went.
    const done = () => {
      if (pendingEffect(task, 'worktree') !== pending) return;
      endEffect(task, 'worktree');
      this.save();
    };
    if (taken) {
      done();
      return;
    }
    const { repoPath, branch, worktreePath } = pending;
    const remove = this.preparing
      .then(() =>
        this.worktrees.remove({ ...task, repoPath, branch, worktreePath }, { deleteUnmerged: true })
      )
      .then((removed) => {
        if (removed.worktreeRemoved) done();
        else throw new Error(removed.error ?? `${worktreePath} is still there`);
      });
    this.preparing = remove.catch(() => undefined);
    this.track(
      remove.catch((error) =>
        this.deps.onError?.(`task ${task.id}: could not remove its half-made worktree`, error)
      )
    );
  }

  /**
   * Its Claude conversation, when the task can be reopened (in its worktree or folder). Only restarts
   * (`afterRestart`) count against MAX_TASK_RESUMES: the user reopening it is no crash loop.
   */
  protected resumableConversation(task: TaskRecord, afterRestart: boolean): string | undefined {
    if (task.agent !== 'claude') return;
    if (task.isolation === 'worktree' && !task.worktreePath) return;
    if (afterRestart && (task.resumes ?? 0) >= MAX_TASK_RESUMES) return;
    if (!task.sessionId || !this.deps.resume) return;
    return this.deps.claudeConversation?.(task.sessionId);
  }

  /**
   * Reopen the conversation of a task whose session ended, typing `text` into it: back to
   * work at once, its new session linked when it is up. False when it can't be reopened.
   */
  protected reopenWith(task: TaskRecord, text: string): boolean {
    const conversation = this.resumableConversation(task, false);
    const oldSessionId = task.sessionId;
    const resume = this.deps.resume;
    if (!conversation || !oldSessionId || !resume) return false;
    // Until the new session is linked, the old one's end is not the task's.
    this.replacing.add(oldSessionId);
    task.reopens = (task.reopens ?? 0) + 1;
    this.setState(task, 'working');
    this.seenBusy.delete(task.id);
    this.track(
      this.openSession(task, { text: resumeText(text) }, (sessionId) =>
        resume(task, conversation, sessionId, text)
      )
        .then((launched) => {
          const { sessionId } = launched;
          this.watchTyped(task, launched);
          this.launchedHere.add(sessionId);
          if (task.sessionId === oldSessionId) task.sessionId = sessionId;
          this.save();
        })
        .catch((error) => {
          this.deps.onError?.(`Task ${task.id} could not be reopened`, error);
          // 2026-10-20 review: only logged, so the task later failed as "the session ended"
          // with the real cause and the lost message never told.
          if (task.state !== 'working' || task.sessionId !== oldSessionId) return;
          this.fail(task, 'setup', 'Its conversation could not be reopened', [
            error instanceof Error ? error.message : String(error),
          ]);
          this.save();
          this.notifyState(task, `${text.slice(0, 200)} — was not delivered`);
        })
        .finally(() => this.replacing.delete(oldSessionId))
    );
    return true;
  }

  /**
   * A worktree task with no session to type into and no conversation to reopen (a revert
   * done by git alone, a Codex task): a new agent starts in its worktree, on its branch, with
   * the task and `text` (what to do now). Back to work at once. False when it has no worktree.
   */
  protected startInWorktree(task: TaskRecord, text: string): boolean {
    if (task.isolation !== 'worktree' || !task.worktreePath || !task.branch) return false;
    if (!fs.existsSync(task.worktreePath)) return false;
    if (task.sessionId && this.deps.sessionStatus(task.sessionId) === 'running') return false;
    const original = fillTaskPlaceholders(task.prompt, {
      folder: task.workingDir,
      now: new Date(this.now()),
    });
    const prompt = buildTaskPrompt(
      [
        `[untether] You take over the task "${task.name}" in its worktree; its earlier work is committed on this branch.`,
        'The task was:',
        original,
        '',
        'What is needed now:',
        text,
      ].join('\n'),
      { branch: task.branch, baseBranch: task.baseBranch ?? 'its base branch' }
    );
    const oldSessionId = task.sessionId;
    if (oldSessionId) this.replacing.add(oldSessionId);
    task.reopens = (task.reopens ?? 0) + 1;
    this.setState(task, 'working');
    this.seenBusy.delete(task.id);
    delete task.error;
    this.track(
      this.openSession(task, { text: prompt }, (sessionId) =>
        this.deps.launch({ ...task }, prompt, sessionId)
      )
        .then((launched) => {
          const { sessionId } = launched;
          this.launchedHere.add(sessionId);
          if (isFinal(task)) return this.dropSession(task, sessionId);
          this.watchTyped(task, launched);
          if (task.sessionId === oldSessionId) task.sessionId = sessionId;
          task.startedAt = new Date(this.now()).toISOString();
          this.save();
        })
        .catch((error) => {
          this.deps.onError?.(`Task ${task.id}: no agent could start in its worktree`, error);
          if (!isFinal(task) && task.state === 'working' && task.sessionId === oldSessionId) {
            this.fail(task, 'setup', 'No agent could start in its worktree');
            this.save();
            this.notifyState(task, task.error ?? '');
          }
        })
        .finally(() => {
          if (oldSessionId) this.replacing.delete(oldSessionId);
        })
    );
    return true;
  }

  /**
   * A task whose session ended before its brief was typed: its agent never started on it, so
   * a new session starts with the task as at first (at most MAX_TASK_RESUMES times). Back to
   * work at once. False when it can't be.
   */
  protected startAgain(task: TaskRecord): boolean {
    if ((task.reopens ?? 0) >= MAX_TASK_RESUMES) return false;
    if (
      task.isolation === 'worktree' &&
      (!task.worktreePath || !fs.existsSync(task.worktreePath))
    ) {
      return false;
    }
    if (task.sessionId && this.deps.sessionStatus(task.sessionId) === 'running') return false;
    const oldSessionId = task.sessionId;
    if (oldSessionId) this.replacing.add(oldSessionId);
    task.reopens = (task.reopens ?? 0) + 1;
    this.setState(task, 'working');
    this.seenBusy.delete(task.id);
    this.deps.onError?.(
      `Task ${task.id}: its session ended before its brief went in, starting it again`
    );
    this.track(
      this.openSession(task, this.briefOf(task), (sessionId) =>
        this.deps.launch({ ...task }, this.launchPrompt(task), sessionId)
      )
        .then((launched) => {
          const { sessionId } = launched;
          if (isFinal(task)) return this.dropSession(task, sessionId);
          if (task.sessionId === oldSessionId) task.sessionId = sessionId;
          this.watchTyped(task, { ...launched, brief: true });
          this.launchedHere.add(sessionId);
          task.startedAt = new Date(this.now()).toISOString();
          this.save();
        })
        .catch((error) => {
          this.deps.onError?.(`Task ${task.id} could not be started again`, error);
          if (!isFinal(task) && task.state === 'working' && task.sessionId === oldSessionId) {
            this.fail(
              task,
              'setup',
              'Its session ended before its brief went in, and it could not be started again'
            );
            this.save();
            this.notifyState(task, task.error ?? '');
          }
        })
        .finally(() => {
          if (oldSessionId) this.replacing.delete(oldSessionId);
        })
    );
    return true;
  }

  /**
   * A Claude worktree task whose session died with the server (2026-10-18: a dev server
   * restart cut two atlas tasks mid-work and their half-done work was checked and offered
   * for merging): reopen its conversation and let it carry on. True when it was resumed.
   */
  protected async resumeInterrupted(task: TaskRecord): Promise<boolean> {
    if (this.now() - this.startedAt > RESTART_WINDOW_MS) return false;
    if (task.state !== 'working' || !task.sessionId) return false;
    if (this.launchedHere.has(task.sessionId) || this.resuming.has(task.id)) return false;
    this.resuming.add(task.id);
    try {
      const conversation = this.resumableConversation(task, true);
      if (!conversation || !this.deps.resume) return await this.relaunchUntouched(task);
      // Counted before the await: a resume that hangs and is tried again still adds up.
      task.resumes = (task.resumes ?? 0) + 1;
      this.save();
      const resume = this.deps.resume;
      const launched = await this.openSession(task, { text: resumeText() }, (sessionId) =>
        resume(task, conversation, sessionId)
      );
      const { sessionId } = launched;
      this.launchedHere.add(sessionId);
      if (isFinal(task)) {
        await this.dropSession(task, sessionId);
        return true;
      }
      this.watchTyped(task, launched);
      task.sessionId = sessionId;
      this.seenBusy.delete(task.id);
      this.save();
      this.deps.onError?.(`Task ${task.id} resumed after a server restart in ${sessionId}`);
      return true;
    } catch (error) {
      this.deps.onError?.(`Task ${task.id} could not be resumed`, error);
      return false;
    } finally {
      this.resuming.delete(task.id);
    }
  }

  /**
   * A worktree task cut off by a restart before it changed anything, with no Claude
   * conversation to reopen (a Codex task, or Claude killed before its conversation was seen):
   * started again in its worktree with its prompt. 2026-10-18: atlas task 23ce1e85 ended
   * "The session ended before the agent changed anything" after a dev server reload.
   */
  protected async relaunchUntouched(task: TaskRecord): Promise<boolean> {
    if (task.isolation !== 'worktree' || !task.worktreePath || !task.branch) return false;
    if ((task.resumes ?? 0) >= MAX_TASK_RESUMES) return false;
    if (await this.worktrees.hasUnmergedWork(task).catch(() => true)) return false;
    try {
      task.resumes = (task.resumes ?? 0) + 1;
      const launched = await this.openSession(task, this.briefOf(task), (sessionId) =>
        this.deps.launch({ ...task }, this.launchPrompt(task), sessionId)
      );
      const { sessionId } = launched;
      this.launchedHere.add(sessionId);
      if (isFinal(task)) {
        await this.dropSession(task, sessionId);
        return true;
      }
      this.watchTyped(task, { ...launched, brief: true });
      task.sessionId = sessionId;
      task.startedAt = new Date(this.now()).toISOString();
      this.seenBusy.delete(task.id);
      this.save();
      this.deps.onError?.(`Task ${task.id} started again after a server restart in ${sessionId}`);
      return true;
    } catch (error) {
      this.deps.onError?.(`Task ${task.id} could not be started again`, error);
      return false;
    }
  }

  /** What a task's agent is told when its session starts (its branch, in a worktree). */
  protected launchPrompt(task: TaskRecord): string {
    const prompt = fillTaskPlaceholders(task.prompt, {
      folder: task.workingDir,
      now: new Date(this.now()),
    });
    // A security sweep's prompt says all it may do (it commits nothing, asks nobody).
    if (task.isolation !== 'worktree' || task.security?.kind === 'sweep') return prompt;
    return buildTaskPrompt(prompt, {
      branch: task.branch as string,
      baseBranch: task.baseBranch as string,
    });
  }

  /**
   * Make a session for a task (task journal): its id is chosen and recorded first, so a restart
   * that finds the step knows which session to look for (recoverSessions) instead of starting
   * a second agent. The step stays recorded, with the first message, until that message is
   * typed (watchTyped) or the session is dropped.
   */
  protected async openSession(
    task: TaskRecord,
    /** The first message typed into it: recorded with the id, before the session exists. */
    first: { text: string; brief?: boolean },
    open: (sessionId: string) => Promise<LaunchedSession>
  ): Promise<LaunchedSession> {
    const planned = randomUUID();
    const at = new Date(this.now()).toISOString();
    beginEffect(task, {
      kind: 'session',
      key: planned,
      at,
      sessionId: planned,
      text: first.text,
      ...(first.brief ? { brief: true } : {}),
    });
    // 2026-11-01 review: the step must be on disk before the session exists, or a restart
    // could not know it (disk full, an unreadable tasks.json): it is not started.
    if (!this.save()) {
      endEffect(task, 'session', planned);
      throw new Error('Could not save tasks.json, so the session was not started');
    }
    let launched: LaunchedSession;
    try {
      launched = await open(planned);
    } catch (error) {
      endEffect(task, 'session', planned);
      throw error;
    }
    endEffect(task, 'session', planned);
    beginEffect(task, {
      kind: 'session',
      key: launched.sessionId,
      at,
      sessionId: launched.sessionId,
      // Typed by the launcher: kept until it is (watchTyped). Nothing to type: nothing kept.
      ...(launched.typed ? { text: launched.text ?? first.text } : {}),
      ...(launched.typed && (launched.brief || first.brief) ? { brief: true } : {}),
    });
    return launched;
  }

  /** A session made for a task that ended meanwhile: stopped, its step over. */
  protected async dropSession(task: TaskRecord, sessionId: string): Promise<void> {
    endEffect(task, 'session', sessionId);
    this.save();
    await this.deps.stopSession?.(sessionId).catch(() => undefined);
  }

  /**
   * Sessions a restart cut off while they were being made (task journal, openSession): one
   * that runs is the task's (adopted, never a second one; its first message, not confirmed
   * typed, waits in pendingInput to be typed), or stopped when the task no longer wants it.
   * One that does not run was never made: the task goes on as if it had not been started.
   */
  protected recoverSessions(): void {
    for (const task of this.tasks) {
      const effect = pendingEffect(task, 'session');
      if (!effect) continue;
      endEffect(task, 'session');
      const { sessionId } = effect;
      if (this.deps.sessionStatus(sessionId) !== 'running') continue;
      const current = task.sessionId;
      const otherRunning =
        !!current && current !== sessionId && this.deps.sessionStatus(current) === 'running';
      if (isFinal(task) || otherRunning) {
        if (current === sessionId) continue;
        this.deps.onError?.(`Task ${task.id}: stopping ${sessionId}, made for it before a restart`);
        this.track(this.deps.stopSession?.(sessionId).catch(() => undefined) ?? Promise.resolve());
        continue;
      }
      this.deps.onError?.(`Task ${task.id}: ${sessionId}, made before a restart, is its session`);
      task.sessionId = sessionId;
      delete task.startCuts;
      task.startedAt ??= effect.at;
      if (task.state !== 'working') this.setState(task, 'working');
      if (effect.text) {
        task.pendingInput = [
          ...(task.pendingInput ?? []),
          { text: effect.text, at: effect.at, ...(effect.brief ? { brief: true } : {}) },
        ];
      }
    }
  }

  /**
   * A finished task's session that should be stopped: running, not one the user reopened by
   * hand (for this task or any other naming it), not an orchestrator's nor a session a task
   * still open uses.
   */
  protected finishedSessionToStop(task: TaskRecord): string | undefined {
    const sessionId = task.sessionId;
    if (!sessionId || !isFinal(task)) return undefined;
    if (this.deps.sessionStatus(sessionId) !== 'running') return undefined;
    if (this.replacing.has(sessionId) || this.deps.isOrchestratorSession?.(sessionId)) {
      return undefined;
    }
    const inUse = this.tasks.some(
      (other) =>
        other.orchestratorSessionId === sessionId ||
        other.keepSessionId === sessionId ||
        (other.id !== task.id &&
          !isFinal(other) &&
          (other.sessionId === sessionId || other.createdBySessionId === sessionId))
    );
    return inUse ? undefined : sessionId;
  }

  protected armFinishedStop(task: TaskRecord, since = this.now()): void {
    this.cancelFinishedStop(task.id);
    if (!task.sessionId) {
      this.track(this.dropDoneWorktree(task));
      return;
    }
    const timer = setTimeout(() => {
      this.finishedTimers.delete(task.id);
      // Its agent still at work (its last words after `ut task done`): later, up to a limit.
      const status = task.sessionId ? this.lastStatus.get(task.sessionId) : undefined;
      const busy = status === 'busy' || status === BACKGROUND;
      if (busy && this.now() - since < FINISHED_SESSION_BUSY_MS) {
        this.armFinishedStop(task, since);
        return;
      }
      this.track(
        this.stopFinishedSession(task).then((result) =>
          result === 'failed' ? undefined : this.dropDoneWorktree(task, result === 'stopped')
        )
      );
    }, this.deps.finishedSessionGraceMs ?? FINISHED_SESSION_GRACE_MS);
    timer.unref?.();
    this.finishedTimers.set(task.id, timer);
  }

  protected cancelFinishedStop(taskId: string): void {
    const timer = this.finishedTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.finishedTimers.delete(taskId);
  }

  /**
   * Stops a finished task's session, its report kept first. 'not-needed' when it should not be
   * stopped (any more): it ended, the user reopened it, a task took it.
   */
  protected async stopFinishedSession(
    task: TaskRecord
  ): Promise<'stopped' | 'not-needed' | 'failed'> {
    const sessionId = this.finishedSessionToStop(task);
    if (!sessionId) return 'not-needed';
    if (!this.deps.stopSession) return 'failed';
    if (!task.summary) {
      const report = await this.reportOf(sessionId, task);
      if (report) {
        task.summary = report.slice(0, TASK_REPORT_MAX);
        this.save();
      }
    }
    // Checked again: the user may have reopened it, or it moved on, while the report was read.
    if (this.finishedSessionToStop(task) !== sessionId) return 'not-needed';
    try {
      await this.deps.stopSession(sessionId);
      return 'stopped';
    } catch (error) {
      this.deps.onError?.(`could not stop the session of finished task ${task.id}`, error);
      return 'failed';
    }
  }

  /**
   * Finished tasks whose session still runs more than `olderThanMs` after they finished (the
   * doctor stops them: a restart or a failed stop let them slip through).
   */
  lingeringSessions(olderThanMs: number): TaskRecord[] {
    const now = this.now();
    return this.tasks
      .filter((task) => {
        if (!this.finishedSessionToStop(task)) return false;
        const since = Date.parse(task.finishedAt ?? task.stateSince);
        return Number.isFinite(since) && now - since > olderThanMs;
      })
      .map((task) => this.copy(task));
  }

  /** Stops a lingering finished task's session by id (the doctor's heal). */
  async stopLingeringSession(id: string): Promise<'stopped' | 'not-needed' | 'failed'> {
    const task = this.tasks.find((entry) => entry.id === id);
    return task ? this.stopFinishedSession(task) : 'not-needed';
  }

  /**
   * Start a task: its worktree (in the background), then its session. `anyway`: past its
   * agent's usage limit and its project's limit (the user asked with --force). `admitted`:
   * its project's limit was already looked at (a slot freed up, «Empezar ya»).
   * `pastAgentLimit`: past its agent's usage limit only; its project's line still counts.
   */
  protected async run(
    task: TaskRecord,
    options: { anyway?: boolean; admitted?: boolean; pastAgentLimit?: boolean } = {}
  ): Promise<void> {
    // Started already by another way in (its group's first task, a double call).
    if (!STARTABLE_STATES.includes(task.state)) return;
    // Its agent is at its usage limit (another task hit it): it waits until then.
    const limit =
      options.anyway || options.pastAgentLimit ? undefined : this.agentLimit(limitKeyOf(task));
    if (limit) {
      this.holdForAgent(task, limit);
      return;
    }
    // Its project runs as many tasks as it allows (maxActiveTasks): it waits in line.
    if (!options.anyway && !options.admitted && (await this.waitsForSlot(task))) return;
    delete task.heldFor;
    // Marked before anything awaits so an overlapping timer can't start it twice.
    this.setState(task, task.isolation === 'worktree' ? 'preparing' : 'working');
    this.save();
    // Its model level, while its worktree is made (a few seconds at most).
    const choosing = this.chooseModel(task)?.catch((error) =>
      this.deps.onError?.(`task ${task.id}: could not choose its model`, error)
    );
    if (task.isolation === 'worktree') {
      const logPath = this.deps.logDir
        ? path.join(this.deps.logDir, task.id, 'setup.log')
        : undefined;
      try {
        const settings = await this.projectSettings(task);
        const setup: TaskWorktreeSetup = {
          logPath,
          // Recorded before `git worktree add` (task journal): a restart removes what it names.
          onPlanned: (plan) => {
            beginEffect(task, {
              kind: 'worktree',
              key: plan.branch,
              at: new Date(this.now()).toISOString(),
              ...plan,
            });
            this.save();
          },
          ...(settings?.worktreeRoot ? { worktreeRoot: settings.worktreeRoot } : {}),
          ...(settings?.cloneDirs ? { cloneDirs: settings.cloneDirs } : {}),
          ...(settings?.setupCommand ? { setupCommand: settings.setupCommand } : {}),
        };
        const baseBranch = task.baseBranch ?? settings?.baseBranch;
        const make = this.preparing.then(() =>
          this.worktrees.create({ ...task, ...(baseBranch ? { baseBranch } : {}) }, setup)
        );
        this.preparing = make.catch(() => undefined);
        const worktree = await make;
        endEffect(task, 'worktree');
        if (task.state !== 'preparing') {
          // Discarded while its worktree was being made: nothing was done in it.
          this.save();
          await this.worktrees
            .remove({ ...task, ...worktree }, { deleteUnmerged: true })
            .catch(() => undefined);
          return;
        }
        task.repoPath = worktree.repoPath;
        task.baseBranch = worktree.baseBranch;
        task.baseSha = worktree.baseSha;
        task.branch = worktree.branch;
        task.worktreePath = worktree.worktreePath;
        this.deps.worktreeMade?.(worktree.worktreePath);
      } catch (error) {
        // createTaskWorktree removes what it made before it throws.
        endEffect(task, 'worktree');
        if (isFinal(task)) {
          this.save();
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.fail(task, 'setup', message, error instanceof TaskWorktreeError ? error.detail : []);
        this.deps.onError?.(`task ${task.id} could not get its worktree`, error);
        this.afterSetupFailure(task);
        this.save();
        return;
      }
      if (task.revertOf && !(await this.runRevert(task))) return;
    }
    // Taken while its session starts (git answers in milliseconds, an agent takes seconds). A
    // retry keeps what was there before its first start: the first try's work is its own.
    const snapshot =
      task.isolation === 'none' && !task.startDirty ? this.noteStartDirty(task) : undefined;
    if (choosing) {
      await choosing;
      if (isFinal(task)) return;
    }
    try {
      const launched = await this.openSession(task, this.briefOf(task), (sessionId) =>
        this.deps.launch({ ...task }, this.launchPrompt(task), sessionId)
      );
      const { sessionId } = launched;
      this.launchedHere.add(sessionId);
      // 2026-10-20: discarded while its session was starting: it came back as working.
      if (isFinal(task)) {
        await this.dropSession(task, sessionId);
        return;
      }
      this.watchTyped(task, { ...launched, brief: true });
      task.sessionId = sessionId;
      // It got its session: the cuts in a row while starting are over (cutWhileStarting).
      delete task.startCuts;
      task.startedAt = new Date(this.now()).toISOString();
      this.setState(task, 'working');
    } catch (error) {
      if (isFinal(task)) return;
      this.fail(task, 'setup', error instanceof Error ? error.message : String(error));
      this.deps.onError?.(`task ${task.id} failed to start`, error);
      // Nothing was done in it: the worktree and branch go again.
      if (task.isolation === 'worktree' && task.worktreePath && !task.revertOf) {
        await this.worktrees.remove(task, { deleteUnmerged: true }).catch(() => undefined);
        delete task.worktreePath;
      }
      this.afterSetupFailure(task);
    }
    await snapshot;
    this.save();
  }

  /**
   * A setup that failed is tried again once by itself after SETUP_RETRY_MS (a lock, a slow
   * install, a session that would not start); the second failure is the user's to hear.
   * 2026-10-20: a failed setup told nobody and waited for "Reintentar" forever.
   */
  protected afterSetupFailure(task: TaskRecord): void {
    if ((task.setupRetries ?? 0) >= 1) {
      this.notifyState(task, task.error ?? '');
      return;
    }
    task.setupRetries = (task.setupRetries ?? 0) + 1;
    task.setupRetryAt = new Date(
      this.now() + (this.deps.setupRetryMs ?? SETUP_RETRY_MS)
    ).toISOString();
    this.armSetupRetry(task);
  }

  /** The timer of a waiting setup retry (TaskRecord.setupRetryAt), also after a restart. */
  protected armSetupRetry(task: TaskRecord): void {
    if (!task.setupRetryAt) return;
    const old = this.setupTimers.get(task.id);
    if (old) clearTimeout(old);
    const delay = Math.max(0, Date.parse(task.setupRetryAt) - this.now());
    const timer = setTimeout(
      () => {
        this.setupTimers.delete(task.id);
        delete task.setupRetryAt;
        if (task.state !== 'failed' || task.blocker?.kind !== 'setup') {
          this.save();
          return;
        }
        this.deps.onError?.(`Task ${task.id}: trying its setup again`);
        void this.retry(task.id).then((result) => {
          if (result.ok) return;
          // No slot of its project for it now (2026-11-10: the retry started it past the
          // limit): the same one try, later.
          if (result.code === 'limit' && task.state === 'failed') {
            task.setupRetryAt = new Date(
              this.now() + (this.deps.setupRetryMs ?? SETUP_RETRY_MS)
            ).toISOString();
            this.save();
            this.armSetupRetry(task);
            return;
          }
          this.notifyState(task, task.error ?? result.message);
        });
      },
      Number.isFinite(delay) ? delay : 0
    );
    timer.unref?.();
    this.setupTimers.set(task.id, timer);
  }
}
