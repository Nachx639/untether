/**
 * Tasks of one project that change the same files (2026-11-11, shared/task-overlap.ts).
 *
 * A. The overlap is seen while they work. Each working task's folder is looked at with two git
 *    commands (worktreeTouched: committed, uncommitted and new files against its base) at most
 *    every OVERLAP_LOOK_MS, and only when its agent made progress since the last look; a task
 *    that is not working is known by the files its last finish recorded (TaskRecord.files). No
 *    git runs in the tick itself. Two unfinished worktree tasks of a project that share a file
 *    get an entry on each other (TaskRecord.overlaps: `ut task status`, `ut task list`), the
 *    project's orchestrator hears of the pair once, and both tasks' metrics keep it.
 *
 * B. A working task is brought up to date when another one merges (ProjectSettings.baseSync,
 *    default on). A task whose files a task merged since its branch last had the base changed
 *    too has a merge pending (TaskRecord.baseSync). At a gap of its agent (its own events say
 *    it is in a turn with no tool call open, nothing waits to be typed into it) Untether
 *    merges the base into its branch (task-worktree.ts syncWithBase): only a clean merge, and
 *    only with nothing uncommitted in tracked files; else it waits for a later gap. A merge
 *    that would conflict touches nothing: the agent is typed the files once per base commit, to
 *    resolve it then, with its context fresh. A task that touches nothing of what merged is
 *    left alone. The merge pipeline is not involved: a finished task is its business.
 *
 * One layer of TaskScheduler (task-scheduler.ts).
 */
import * as fs from 'fs';
import { conflictMetrics } from '../../shared/task-metrics.js';
import {
  baseSyncConflictText,
  baseSyncMergedText,
  overlapNoticeText,
  sharedFiles,
  TASK_OVERLAP_FILES_KEPT,
} from '../../shared/task-overlap.js';
import { filesNamed, namedPaths, type TaskTouch } from '../../shared/task-serial.js';
import type { TaskOverlap, TaskRecord } from '../../shared/tasks.js';
import { normalizeRepoPath } from './project-settings.js';
import { TaskSchedulerInput } from './task-scheduler-input.js';
import { isFinal } from './task-scheduler-rules.js';
import { syncWithBase, worktreeTouched } from './task-worktree.js';

/** A working task's folder is looked at for the files it touches at most this often. */
export const OVERLAP_LOOK_MS = 2 * 60_000;
/** A pending merge of the base is tried again (a gap, a clean folder) at most this often. */
export const BASE_SYNC_RETRY_MS = 30_000;
/** One whose conflict the agent was told of: looked at again (did it merge the base?) this often. */
export const BASE_SYNC_CONFLICT_RETRY_MS = 2 * 60_000;

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export abstract class TaskSchedulerOverlap extends TaskSchedulerInput {
  /** Per working task: the files its folder touched at the last look. */
  private touched = new Map<string, { files: string[]; lookedAt: number }>();
  private touchLooking = new Set<string>();
  /** Per task: bumped when its branch got the base, so a look begun before is dropped. */
  private touchEpoch = new Map<string, number>();
  private syncTriedAt = new Map<string, number>();
  private syncing = new Set<string>();
  private syncErrors = new Map<string, string>();

  protected override forget(taskId: string): void {
    this.touched.delete(taskId);
    this.touchEpoch.delete(taskId);
    this.syncTriedAt.delete(taskId);
    this.syncErrors.delete(taskId);
    super.forget(taskId);
  }

  /** The project's baseSync (default on). */
  protected baseSyncOn(task: TaskRecord): boolean {
    const settings = task.repoPath ? this.deps.settings?.get(task.repoPath) : undefined;
    return settings?.baseSync !== false;
  }

  /** Every file the task is known to change: its last finish's and its folder's last look. */
  private filesOf(task: TaskRecord): Set<string> {
    return new Set([...(task.files ?? []), ...(this.touched.get(task.id)?.files ?? [])]);
  }

  private followed(task: TaskRecord): boolean {
    return (
      !isFinal(task) &&
      task.isolation === 'worktree' &&
      !!task.repoPath &&
      !!task.worktreePath &&
      !!task.baseBranch
    );
  }

  /**
   * `ut task new` (2026-11-11, shared/task-serial.ts): the open worktree tasks of the new
   * task's project whose known files (their last finish's, their folder's last look) its
   * prompt names, by file or by folder. Tasks it already starts after (--after, a shared zone)
   * and the others of its parallel group are left out. Nothing is held back for it.
   */
  async touchedByOthers(id: string): Promise<TaskTouch[]> {
    const task = this.tasks.find((entry) => entry.id === id);
    const named = task ? namedPaths(task.prompt) : [];
    if (!task || !named.length) return [];
    const others = this.tasks.filter(
      (other) =>
        other !== task &&
        this.followed(other) &&
        !(task.groupId && other.groupId === task.groupId) &&
        !task.after?.includes(other.id) &&
        !task.zones?.some((zone) => other.zones?.includes(zone))
    );
    if (!others.length) return [];
    const repo = await this.projectOf(task);
    const touches: TaskTouch[] = [];
    for (const other of others) {
      if (!repo || normalizeRepoPath(other.repoPath as string) !== repo) continue;
      const files = filesNamed(named, this.filesOf(other));
      if (!files.length) continue;
      touches.push({
        taskId: other.id,
        name: other.name,
        files: files.slice(0, TASK_OVERLAP_FILES_KEPT),
        count: files.length,
      });
    }
    return touches;
  }

  /**
   * Every few seconds (checkExited): the working tasks' folders are looked at when due (in the
   * background), the overlaps between open tasks are brought up to date and the working tasks
   * whose base moved in their files are merged at a gap.
   */
  protected watchOverlap(): void {
    const open = new Set<string>();
    for (const task of this.tasks) {
      if (!this.followed(task)) continue;
      open.add(task.id);
      this.lookAtTouched(task);
    }
    for (const map of [this.touched, this.touchEpoch, this.syncTriedAt, this.syncErrors]) {
      for (const id of map.keys()) if (!open.has(id)) map.delete(id);
    }
    this.settleOverlap();
  }

  /** What follows from the files known now; no git. */
  private settleOverlap(): void {
    const overlaps = this.matchOverlaps();
    const syncs = this.watchBaseSync();
    if (overlaps || syncs) this.save();
  }

  /** Looks at a working task's folder in the background, when it is due. */
  private lookAtTouched(task: TaskRecord, force = false): void {
    const { worktreePath, baseBranch, sessionId } = task;
    if (!worktreePath || !baseBranch || this.touchLooking.has(task.id)) return;
    if (task.state !== 'working' || !sessionId) return;
    if (this.deps.sessionStatus(sessionId) !== 'running') return;
    const last = this.touched.get(task.id);
    if (last && !force) {
      if (this.now() - last.lookedAt < OVERLAP_LOOK_MS) return;
      // Nothing its agent did since the last look: its files are the same.
      const progress = this.events(task)?.lastProgressAt;
      if (progress !== undefined && progress <= last.lookedAt) return;
    }
    this.touchLooking.add(task.id);
    const lookedAt = this.now();
    const epoch = this.touchEpoch.get(task.id) ?? 0;
    // Git itself by default, and only on a folder that is there (a task whose folder is gone
    // is somebody else's to notice).
    const look =
      this.deps.touchedFiles ??
      (async (dir: string, ref: string) => (fs.existsSync(dir) ? worktreeTouched(dir, ref) : null));
    this.track(
      Promise.resolve()
        .then(() => look(worktreePath, `refs/heads/${baseBranch}`))
        .catch(() => null)
        .then((files) => {
          this.touchLooking.delete(task.id);
          if (!this.tasks.includes(task) || isFinal(task)) return;
          // Begun before its branch got the base, or in another session: not its files now.
          if ((this.touchEpoch.get(task.id) ?? 0) !== epoch || task.sessionId !== sessionId) return;
          // Git could not answer: what was known stays, and it is asked again when due.
          this.touched.set(task.id, { files: files ?? last?.files ?? [], lookedAt });
          if (files && !sameList(files, last?.files ?? [])) this.settleOverlap();
        })
    );
  }

  /**
   * The overlaps between the open worktree tasks of each project, from the files known now.
   * A pair once seen stays on both while both are open (its files follow what they share now);
   * tasks of one parallel group (alternatives, one is kept) and a task stacked on another's
   * branch are no pair. True when a task changed.
   */
  private matchOverlaps(): boolean {
    let changed = false;
    const byProject = new Map<string, TaskRecord[]>();
    for (const task of this.tasks) {
      if (!this.followed(task)) {
        if (task.overlaps) {
          delete task.overlaps;
          changed = true;
        }
        continue;
      }
      const list = byProject.get(task.repoPath as string) ?? [];
      list.push(task);
      byProject.set(task.repoPath as string, list);
    }
    const now = new Date(this.now()).toISOString();
    for (const [repoPath, tasks] of byProject) {
      const files = new Map(tasks.map((task) => [task.id, this.filesOf(task)]));
      const next = new Map<string, TaskOverlap[]>(
        tasks.map((task) => [
          task.id,
          // Copies: what changes below is compared with the task's own list at the end.
          (task.overlaps ?? [])
            .filter((entry) => files.has(entry.taskId))
            .map((entry) => ({ ...entry })),
        ])
      );
      const pair = (task: TaskRecord, other: TaskRecord, shared: string[]) => {
        const list = next.get(task.id) as TaskOverlap[];
        const entry = list.find((item) => item.taskId === other.id);
        const kept = shared.slice(0, TASK_OVERLAP_FILES_KEPT);
        if (entry) {
          entry.name = other.name;
          entry.files = kept;
          entry.count = shared.length;
          return entry;
        }
        const made: TaskOverlap = {
          taskId: other.id,
          name: other.name,
          files: kept,
          count: shared.length,
          since: now,
        };
        list.push(made);
        const seen = conflictMetrics(this.metricsOf(task)).overlaps;
        if (!seen.some((item) => item.taskId === other.id)) {
          seen.push({ taskId: other.id, files: shared.length, at: now });
        }
        return made;
      };
      for (let i = 0; i < tasks.length; i++) {
        for (let j = i + 1; j < tasks.length; j++) {
          const a = tasks[i];
          const b = tasks[j];
          if (a.groupId && a.groupId === b.groupId) continue;
          if (a.baseBranch === b.branch || b.baseBranch === a.branch) continue;
          const shared = sharedFiles(
            files.get(a.id) as Set<string>,
            files.get(b.id) as Set<string>
          );
          if (!shared.length) continue;
          const mine = pair(a, b, shared);
          const theirs = pair(b, a, shared);
          // Its orchestrator hears of the pair once; with none running yet, when there is one.
          if (mine.toldAt || theirs.toldAt) {
            mine.toldAt ??= theirs.toldAt;
            theirs.toldAt ??= mine.toldAt;
            continue;
          }
          const text = overlapNoticeText(a, b, mine.files, mine.count);
          let told = false;
          try {
            told = this.deps.projectNotice?.(repoPath, text) ?? false;
          } catch (error) {
            this.deps.onError?.(`tasks ${a.id} and ${b.id}: telling their overlap`, error);
          }
          if (!told) continue;
          mine.toldAt = now;
          theirs.toldAt = now;
          this.deps.onError?.(
            `Tasks ${a.id} and ${b.id} change the same files (${shared.length}): orchestrator told`
          );
        }
      }
      for (const task of tasks) {
        const list = next.get(task.id) as TaskOverlap[];
        if (JSON.stringify(list) === JSON.stringify(task.overlaps ?? [])) continue;
        if (list.length) task.overlaps = list;
        else delete task.overlaps;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * A gap of the task's agent: it works, in a turn of its own with no tool call open, with
   * nothing still to be typed into it, and nobody else (a finish, the pipeline, a discard, a
   * session being replaced) has the task. Only its agent's own events say so: without them
   * (a Claude without hooks, a Codex without a rollout) there is never a gap.
   */
  private syncGap(task: TaskRecord): boolean {
    const sessionId = task.sessionId;
    if (task.state !== 'working' || !sessionId) return false;
    if (this.deps.sessionStatus(sessionId) !== 'running') return false;
    if (this.piping.has(task.id) || this.finishing.has(task.id)) return false;
    if (this.discarding.has(task.id) || this.resuming.has(task.id)) return false;
    if (this.replacing.has(sessionId)) return false;
    if (this.inputOutstanding(task)) return false;
    // A conflict the merge handed back: its agent is merging the base itself right now.
    if (task.autoFix?.reason === 'conflict') return false;
    const events = this.events(task);
    return !!events && events.state === 'working' && events.toolsOpen === 0;
  }

  /**
   * The working tasks whose base moved in files they touch: marked (TaskRecord.baseSync
   * pending) and, at a gap, merged in the background. True when a task changed.
   */
  private watchBaseSync(): boolean {
    let changed = false;
    const now = this.now();
    for (const task of this.tasks) {
      const sync = task.baseSync;
      const eligible = this.followed(task) && task.state === 'working' && this.baseSyncOn(task);
      const from = eligible ? this.mergedInto(task) : undefined;
      if (!from?.tasks.length) {
        if (sync?.pending || sync?.waiting || sync?.conflict) {
          delete sync.pending;
          delete sync.waiting;
          delete sync.conflict;
          changed = true;
        }
        continue;
      }
      const pending = {
        since: sync?.pending?.since ?? new Date(now).toISOString(),
        from: from.tasks.map((merged) => merged.id),
        files: from.files.slice(0, TASK_OVERLAP_FILES_KEPT),
      };
      if (JSON.stringify(pending) !== JSON.stringify(sync?.pending)) {
        task.baseSync = { ...(sync ?? {}), pending };
        changed = true;
      }
      if (this.syncing.has(task.id) || !this.syncGap(task)) continue;
      const every = task.baseSync?.conflict ? BASE_SYNC_CONFLICT_RETRY_MS : BASE_SYNC_RETRY_MS;
      const tried = this.syncTriedAt.get(task.id);
      if (tried !== undefined && now - tried < every) continue;
      this.track(this.syncBase(task, from.tasks));
    }
    return changed;
  }

  /**
   * The tasks merged into this one's base since its branch last had it (when it was made, or
   * its last merge of the base) that changed files it touches, and those files.
   */
  private mergedInto(task: TaskRecord): { tasks: TaskRecord[]; files: string[] } {
    const mine = this.filesOf(task);
    if (!mine.size) return { tasks: [], files: [] };
    const since = Date.parse(task.baseSync?.at ?? task.createdAt);
    const tasks: TaskRecord[] = [];
    const files = new Set<string>();
    for (const other of this.tasks) {
      if (other === task || other.state !== 'merged') continue;
      if (other.repoPath !== task.repoPath || other.baseBranch !== task.baseBranch) continue;
      const mergedAt = Date.parse(other.finishedAt ?? other.stateSince);
      if (!(mergedAt > since)) continue;
      const shared = sharedFiles(other.files ?? [], mine);
      if (!shared.length) continue;
      tasks.push(other);
      for (const file of shared) files.add(file);
    }
    return { tasks, files: [...files].sort() };
  }

  /** One try at merging the base into a working task's branch, and what is told of it. */
  private async syncBase(task: TaskRecord, from: TaskRecord[]): Promise<void> {
    const { worktreePath, baseBranch, sessionId } = task;
    if (!worktreePath || !baseBranch) return;
    const started = this.now();
    this.syncTriedAt.set(task.id, started);
    if (!this.deps.syncBase && !fs.existsSync(worktreePath)) return;
    this.syncing.add(task.id);
    const sync = this.deps.syncBase ?? syncWithBase;
    const result = await sync(worktreePath, baseBranch, {
      stillFree: () => this.syncGap(task),
      hold: () => this.deps.toolHold?.(task.id) ?? null,
    })
      .catch((error) => ({ kind: 'error' as const, message: String(error) }))
      .finally(() => this.syncing.delete(task.id));
    if (!this.tasks.includes(task)) return;
    const record = { ...(task.baseSync ?? {}) };
    const shared = record.pending?.files ?? [];
    const stillWorking = task.state === 'working' && task.sessionId === sessionId;
    let text: string | undefined;
    if (result.kind === 'current' || result.kind === 'merged') {
      // As of when this try began, before the base's tip was read. A task counts as merged
      // (finishedAt) only after it moved the base, so one with finishedAt before `started` was
      // in the tip this try read, and one that moved the base during the try has a later
      // finishedAt and is looked at next time (then 'current' if this merge already took it).
      record.at = new Date(started).toISOString();
      record.through = result.base;
      delete record.pending;
      delete record.waiting;
      delete record.conflict;
      this.syncErrors.delete(task.id);
      if (result.kind === 'merged') {
        record.merges = (record.merges ?? 0) + 1;
        conflictMetrics(this.metricsOf(task)).baseSyncs += 1;
        this.deps.onError?.(
          `Task ${task.id}: ${baseBranch} merged into its branch while it works (${result.files.length} file(s) changed; ${from.map((merged) => merged.id.slice(0, 8)).join(', ')} merged)`
        );
        // Its files as they are now, for the next look at who overlaps whom.
        this.touched.delete(task.id);
        this.touchEpoch.set(task.id, (this.touchEpoch.get(task.id) ?? 0) + 1);
        text = baseSyncMergedText(baseBranch, from, shared, result.files);
      }
    } else if (result.kind === 'conflict') {
      delete record.waiting;
      const known = record.conflict;
      if (!known || known.base !== result.base || !sameList(known.files, result.files)) {
        record.conflict = {
          base: result.base,
          files: result.files,
          toldAt: new Date(this.now()).toISOString(),
        };
        conflictMetrics(this.metricsOf(task)).earlyConflicts += 1;
        this.deps.onError?.(
          `Task ${task.id}: ${baseBranch} conflicts with its branch in ${result.files.length} file(s) while it works: its agent is told`
        );
        text = baseSyncConflictText(baseBranch, from, result.files);
      }
    } else if (result.kind === 'dirty' || result.kind === 'busy') {
      record.waiting = result.kind;
    } else if (this.syncErrors.get(task.id) !== result.message) {
      this.syncErrors.set(task.id, result.message);
      this.deps.onError?.(
        `Task ${task.id}: could not bring it up to date with ${baseBranch}: ${result.message}`
      );
    }
    if (isFinal(task)) return;
    task.baseSync = record;
    this.save();
    if (!text || !stillWorking) return;
    await this.deliverText(task, text, 'auto', false).catch((error) =>
      this.deps.onError?.(`Task ${task.id}: could not tell its agent of ${baseBranch}`, error)
    );
  }

  /**
   * A task just merged: the working tasks on the same base are looked at now, not at their
   * next look, so the ones that touch its files get it soon.
   */
  protected baseMovedBy(merged: TaskRecord): void {
    for (const task of this.tasks) {
      if (task === merged || !this.followed(task) || task.state !== 'working') continue;
      if (task.repoPath !== merged.repoPath || task.baseBranch !== merged.baseBranch) continue;
      this.syncTriedAt.delete(task.id);
      this.lookAtTouched(task, true);
    }
    this.settleOverlap();
  }
}
