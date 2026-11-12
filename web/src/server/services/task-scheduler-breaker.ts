/**
 * The circuit breaker: a project whose merged tasks keep being reverted or given up on stops
 * merging on its own for a while.
 * One layer of TaskScheduler (task-scheduler.ts).
 */
import * as path from 'path';
import { type AutoMergePauseCode, autoMergePaused } from '../../shared/projects.js';
import { normalizeRepoPath } from './project-settings.js';
import { TaskSchedulerLoops } from './task-scheduler-loops.js';
import { BREAKER_GAVE_UP, BREAKER_REVERTS, BREAKER_WINDOW_MS } from './task-scheduler-rules.js';

export abstract class TaskSchedulerBreaker extends TaskSchedulerLoops {
  /** A pause of the project's auto-merge that is over is cleared (circuit breaker). */
  /**
   * What the circuit breaker counts for a project within its window: auto-merged tasks undone,
   * and tasks whose automatic fixes ran out and that have not merged since.
   * 2026-10-20: what happened before the user turned auto-merge back on counted again, so the
   * same old undos paused it again at the next one; only what came after counts.
   */
  protected breakerCounts(repoPath: string): { reverted: number; gaveUp: number } {
    const repo = normalizeRepoPath(repoPath);
    const current = this.deps.settings?.get(repo);
    const resumedAt = current?.autoMergeResumedAt ? Date.parse(current.autoMergeResumedAt) : 0;
    const since = Math.max(
      this.now() - BREAKER_WINDOW_MS,
      Number.isFinite(resumedAt) ? resumedAt : 0
    );
    const within = (at?: string) => !!at && Date.parse(at) >= since;
    const inRepo = this.tasks.filter(
      (task) => task.repoPath && normalizeRepoPath(task.repoPath) === repo
    );
    return {
      reverted: inRepo.filter((task) => task.autoMerged && within(task.revertedAt)).length,
      // A task that merged in the end is no failure (2026-11-02: two of the three that paused
      // bakery had merged an hour later, after a full disk and Docker going down).
      gaveUp: inRepo.filter(
        (task) => within(task.autoFixGaveUpAt) && task.state !== 'merged' && task.state !== 'done'
      ).length,
    };
  }

  protected clearExpiredPause(repoPath: string): void {
    const settings = this.deps.settings;
    if (!settings?.update) return;
    const current = settings.get(repoPath);
    if (!current.autoMergePausedUntil) return;
    // A pause for failures whose tasks merged meanwhile has no cause left: it ends now, not a
    // day later (2026-11-02: bakery stayed paused and asked the user to turn it back on
    // after two of its three failed tasks had merged).
    const stale =
      current.autoMergePausedCode === 'failures' &&
      this.breakerCounts(repoPath).gaveUp < BREAKER_GAVE_UP;
    if (autoMergePaused(current, this.now()) && !stale) return;
    try {
      settings.update(repoPath, {
        autoMergePausedUntil: null,
        autoMergePausedReason: null,
        autoMergePausedCode: null,
        autoMergePausedCount: null,
      });
    } catch (error) {
      this.deps.onError?.(`could not clear the auto-merge pause of ${repoPath}`, error);
    }
  }

  /**
   * The circuit breaker (2026-10-20): when, within BREAKER_WINDOW_MS, BREAKER_REVERTS of a
   * project's auto-merged tasks were undone or BREAKER_GAVE_UP of its tasks still failed after
   * the automatic fixes, its tasks wait for the user before merging for the next 24 hours, and
   * the user is told once. It clears by itself, or when the user turns auto-merge back on.
   */
  protected checkBreaker(repoPath: string): void {
    const settings = this.deps.settings;
    if (!settings?.update) return;
    this.clearExpiredPause(repoPath);
    const repo = normalizeRepoPath(repoPath);
    const current = settings.get(repo);
    if (autoMergePaused(current, this.now())) return;
    const { reverted, gaveUp } = this.breakerCounts(repo);
    const code: AutoMergePauseCode | undefined =
      reverted >= BREAKER_REVERTS ? 'reverts' : gaveUp >= BREAKER_GAVE_UP ? 'failures' : undefined;
    if (!code) return;
    const count = code === 'reverts' ? reverted : gaveUp;
    // English for logs and old phones; the phone says it in its language from code + count.
    const reason =
      code === 'reverts'
        ? `${count} of its tasks that merged on their own were undone in the last 24 hours`
        : `${count} of its tasks still failed after Untether's automatic fixes in the last 24 hours`;
    try {
      settings.update(repo, {
        autoMergePausedUntil: new Date(this.now() + BREAKER_WINDOW_MS).toISOString(),
        autoMergePausedReason: reason,
        autoMergePausedCode: code,
        autoMergePausedCount: count,
      });
    } catch (error) {
      this.deps.onError?.(`could not pause the auto-merge of ${repo}`, error);
      return;
    }
    const name = path.basename(repo);
    this.deps.onError?.(`auto-merge paused in ${repo}: ${reason}`);
    this.post({
      type: 'project-paused',
      title: `⏸️ Auto-merge paused: ${name}`,
      body: `${reason[0].toUpperCase()}${reason.slice(1)}. For the next 24 hours its tasks wait for you before merging; you can turn auto-merge back on in the project's settings.`.slice(
        0,
        300
      ),
      icon: '/apple-touch-icon.png',
      badge: '/favicon-32.png',
      tag: `untether-project-paused-${name}`,
      actions: [{ action: 'dismiss', title: 'Dismiss' }],
      data: {
        type: 'project-paused',
        repoPath: repo,
        where: name,
        detail: reason,
        code,
        count,
        timestamp: new Date(this.now()).toISOString(),
      },
    });
  }
}
