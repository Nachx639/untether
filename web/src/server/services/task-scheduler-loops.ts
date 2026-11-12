/**
 * Failure loops of working agents (2026-11-03). The stall watch (task-scheduler-stall.ts) sees
 * an agent waiting on one thing without progress; an agent that runs the same command into the
 * same error again and again, or edits and re-runs a test that fails identically, makes
 * "progress" with every call. Its events say it (agent-failure-loop.ts): when one failure
 * repeats FAILURE_LOOP_REPEATS times in one turn, the agent is typed a short note once per
 * turn (the error line quoted: re-read it, try another approach). Never stopped, never
 * interrupted: the note waits for its turn like any message typed to it.
 *
 * Each nudge is recorded on the task (TaskRecord.failureNudges) with what became of it, shown in
 * `ut task status` and in the result its orchestrator gets, so their effect can be measured:
 * recovered (that command worked, or failed another way) or, when the same failure came back
 * FAILURE_LOOP_REPEATS more times, escalated: whoever the task reports to is told once,
 * urgently, with the evidence. The project's failureLoopNudge=false turns it all off.
 *
 * The runs are kept with the agent's tracked state (agent-events.ts dump/restore) and each nudge
 * holds when its run began, so a server restart goes on following them. One layer of TaskScheduler (task-scheduler.ts).
 */
import { taskSavingOn } from '../../shared/saving-features.js';
import { clockOf, failureNudgeLine, TASK_FAILURE_NUDGES_KEPT } from '../../shared/task-progress.js';
import type { TaskFailureNudge, TaskRecord } from '../../shared/tasks.js';
import { FAILURE_LOOP_REPEATS, type FailureRun, loopingRun } from './agent-failure-loop.js';
import { TaskSchedulerStall } from './task-scheduler-stall.js';

/** The text typed into an agent that keeps failing the same way. */
export function failureLoopNudgeText(
  run: Pick<FailureRun, 'command' | 'errorLine' | 'turnCount'>
): string {
  return `[untether] You seem stuck repeating the same failure: \`${run.command}\` failed ${run.turnCount} times with the same error: «${run.errorLine}». Running it again will not change that. Re-read the error and the code it points to, then try a different approach (another fix, a narrower test, a different command). If you cannot get past it, say what blocks you in your report.`;
}

/** What its orchestrator (or the phone) is told when the nudge did not help. */
export function failureLoopEscalationText(
  task: Pick<TaskRecord, 'id'>,
  nudge: TaskFailureNudge,
  run: Pick<FailureRun, 'count'>
): string {
  const id = task.id.slice(0, 8);
  return `Its agent keeps failing the same way: ${nudge.tool} \`${nudge.command}\` failed ${run.count} times with «${nudge.errorLine}» (${nudge.repeats} in one turn before Untether's nudge at ${clockOf(Date.parse(nudge.at))}, ${run.count - nudge.countAtNudge} more after it). Untether does not stop it. Look at \`ut task status ${id}\` and its screen, then \`ut task send ${id}\` a different approach (what to look at, what to try), or stop it.`;
}

export abstract class TaskSchedulerLoops extends TaskSchedulerStall {
  /**
   * The project's failureLoopNudge (default on), as the task recorded it when it was made: a
   * holdout task, or one made after the quality guard turned it off, runs without it
   * (shared/saving-features.ts 'loop-nudge').
   */
  protected failureLoopsOn(task: TaskRecord): boolean {
    const settings = task.repoPath ? this.deps.settings?.get(task.repoPath) : undefined;
    return taskSavingOn(task, 'loop-nudge', settings);
  }

  /**
   * Every few seconds (checkExited): each working task's open nudges are followed (recovered,
   * or escalated once), and a failure repeating in the agent's current turn is nudged once per
   * turn.
   */
  protected watchFailureLoops(): void {
    let changed = false;
    for (const task of this.tasks) {
      if (task.state !== 'working' || !task.sessionId) continue;
      if (!this.failureLoopsOn(task)) continue;
      if (this.deps.sessionStatus(task.sessionId) !== 'running') continue;
      const snapshot = this.events(task);
      if (!snapshot) continue;
      const runs = snapshot.failures ?? [];
      if (this.followNudges(task, runs)) changed = true;
      const turn = snapshot.turnStartedAt ?? 0;
      const nudges = task.failureNudges ?? [];
      const sessionId = task.sessionId;
      // Once per turn.
      if (nudges.some((n) => n.sessionId === sessionId && n.turnStartedAt === turn)) continue;
      // A failure already nudged and not over: its orchestrator is told instead (followNudges).
      const skip = new Set(
        nudges
          .filter((n) => n.sessionId === sessionId && n.outcome !== 'recovered')
          .map((n) => n.signature)
      );
      const run = loopingRun(runs, turn, skip);
      if (!run) continue;
      const nudge: TaskFailureNudge = {
        at: new Date(this.now()).toISOString(),
        sessionId,
        turnStartedAt: turn,
        tool: run.tool,
        command: run.command,
        errorLine: run.errorLine,
        repeats: run.turnCount,
        signature: run.signature,
        countAtNudge: run.count,
        runFirstAt: run.firstAt,
        after: 0,
      };
      task.failureNudges = [...nudges, nudge].slice(-TASK_FAILURE_NUDGES_KEPT);
      changed = true;
      this.deps.onError?.(`Task ${task.id}: failure loop, nudged: ${failureNudgeLine(nudge)}`);
      this.track(
        this.deliverText(task, failureLoopNudgeText(run), 'auto', false).catch((error) =>
          this.deps.onError?.(`Task ${task.id}: could not nudge its agent`, error)
        )
      );
    }
    if (changed) this.save();
  }

  /** Brings the task's open nudges up to date; true when one changed. */
  private followNudges(task: TaskRecord, runs: readonly FailureRun[]): boolean {
    let changed = false;
    for (const nudge of task.failureNudges ?? []) {
      if (nudge.outcome || nudge.sessionId !== task.sessionId) continue;
      const run = runs.find((entry) => entry.signature === nudge.signature);
      const now = new Date(this.now()).toISOString();
      // Its command worked, or failed another way (its run ended; a new one began after).
      if (!run || run.firstAt !== nudge.runFirstAt) {
        nudge.outcome = 'recovered';
        nudge.outcomeAt = now;
        this.deps.onError?.(`Task ${task.id}: failure loop over: ${failureNudgeLine(nudge)}`);
        changed = true;
        continue;
      }
      const after = run.count - nudge.countAtNudge;
      if (after !== nudge.after) {
        nudge.after = after;
        changed = true;
      }
      if (after < FAILURE_LOOP_REPEATS) continue;
      nudge.outcome = 'escalated';
      nudge.outcomeAt = now;
      changed = true;
      this.tellLoop(task, nudge, run);
    }
    return changed;
  }

  /** Tells whoever the task reports to (its orchestrator, the phone if it asked), once. */
  private tellLoop(task: TaskRecord, nudge: TaskFailureNudge, run: FailureRun): void {
    const text = failureLoopEscalationText(task, nudge, run);
    this.deps.onError?.(`Task ${task.id}: ${text}`);
    const toOrchestrator = task.origin === 'orchestrator' && !!task.orchestratorSessionId;
    if (!task.notify && !toOrchestrator) return;
    const payload = this.taskPayload(task, 'task-looping', text);
    payload.data = {
      ...payload.data,
      escalated: true,
      failure: {
        tool: nudge.tool,
        command: nudge.command,
        errorLine: nudge.errorLine,
        count: run.count,
        nudgedAt: nudge.at,
      },
    };
    this.post(payload);
  }
}
