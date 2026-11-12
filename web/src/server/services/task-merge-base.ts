/**
 * Moving the base branch to a task's work, and closing a task whose work is already there.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_PROJECT_SETTINGS } from '../../shared/projects.js';
import { pendingEffect } from '../../shared/task-effects.js';
import { isSafeRefName } from '../utils/exec-file.js';
import { parseWorktreePorcelain } from '../utils/worktree-git.js';
import { isAncestor, lastLines, MERGE_REFLOG_ACTION, MergeLog, output } from './task-merge-log.js';
import {
  COMMIT_TIMEOUT_MS,
  type MoveResult,
  type PipelineOptions,
  type PipelineResult,
  type PipelineTask,
} from './task-merge-types.js';
import {
  checkoutInTheWay,
  leftoverExcludes,
  removeTaskWorktree,
  unsavedChanges,
} from './task-worktree.js';

/**
 * The branch's tip `tip` is work of its own that is in the base already (merged before a
 * restart cut the cleanup short). 2026-10-20: a task that changed nothing had its baseSha
 * moved to the base of that day; once the base moved on, its untouched tip (the commit it was
 * made from) read as "merged" and its session, folder (uncommitted work and all) and branch
 * went. A tip the task's own base already holds is no work of its own.
 */
export async function ownWorkMerged(
  log: MergeLog,
  cwd: string,
  task: PipelineTask,
  tip: string,
  baseNow: string
): Promise<boolean> {
  if (tip === task.baseSha) return false;
  if (task.baseSha && (await isAncestor(log, cwd, tip, task.baseSha))) return false;
  return isAncestor(log, cwd, tip, baseNow);
}

/**
 * The commit of the task's own work its base holds, if any: its branch's tip while the branch
 * is there, else (the cleanup deleted it) what the task last knew of its head: the merge's
 * recorded base move, the merged or the checked commit. Null when its work is not in the base.
 */
async function workInBase(
  task: PipelineTask,
  log: MergeLog,
  baseNow: string
): Promise<string | null> {
  const { repoPath, branch } = task;
  if (!repoPath) return null;
  const known = [pendingEffect(task, 'base')?.sha, task.mergedSha, task.headSha].filter(
    (sha): sha is string => !!sha && /^[0-9a-f]{7,64}$/.test(sha)
  );
  const tip =
    branch && isSafeRefName(branch)
      ? await log.gitOut(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
      : null;
  // A branch still there speaks for itself: commits the base lacks are a real merge to do.
  if (tip) return (await ownWorkMerged(log, repoPath, task, tip, baseNow)) ? tip : null;
  for (const sha of new Set(known)) {
    if (await ownWorkMerged(log, repoPath, task, sha, baseNow)) return sha;
  }
  return null;
}

/** Finish the task as merged when its work is in its base: null when it is not. */
export async function finishIfInBase(
  task: PipelineTask,
  options: PipelineOptions,
  log: MergeLog
): Promise<PipelineResult | null> {
  const { repoPath, baseBranch: base } = task;
  if (!repoPath || !base || !isSafeRefName(base)) return null;
  const baseNow = await log.gitOut(repoPath, [
    'rev-parse',
    '--verify',
    `refs/heads/${base}^{commit}`,
  ]);
  if (!baseNow) return null;
  const sha = await workInBase(task, log, baseNow);
  if (!sha) return null;
  const done = await finishMerged(task, options, log, sha, baseNow);
  const onto = await mergedOntoOf(task, log, repoPath, sha);
  return onto && done.mergedSha === sha ? { ...done, mergedOnto: onto } : done;
}

/**
 * Where the merge of `sha` moved its base from: the recorded move's, else the base the task last
 * merged in (its run's baseSha, which the merge fast-forwarded from), when it is under `sha`.
 */
async function mergedOntoOf(
  task: PipelineTask,
  log: MergeLog,
  repoPath: string,
  sha: string
): Promise<string | undefined> {
  const moving = pendingEffect(task, 'base');
  if (moving?.sha === sha) return moving.onto;
  if (task.mergedOnto && task.mergedSha === sha) return task.mergedOnto;
  if (
    task.baseSha &&
    task.baseSha !== sha &&
    (await isAncestor(log, repoPath, task.baseSha, sha))
  ) {
    return task.baseSha;
  }
  return undefined;
}

/**
 * Finish a merge already in the base, nothing else (a restart found the task's base move
 * recorded, its TaskEffect of kind base): its session, folder and branch go unless they hold
 * work of their own. Null when the task's work is not in its base: nothing was done, and the
 * move is the pipeline's to make.
 */
export async function finishMergedTask(
  task: PipelineTask,
  options: PipelineOptions
): Promise<PipelineResult | null> {
  const log = new MergeLog(path.join(options.logDir, 'merge.log'));
  const now = options.now ?? Date.now;
  log.write(`
# ${new Date(now()).toISOString()} finish ${task.branch ?? ''}`);
  try {
    const done = await finishIfInBase(task, options, log);
    if (!done) log.write('# not in the base: nothing to finish');
    return done;
  } catch (error) {
    log.write(`# could not finish: ${error}`);
    return null;
  }
}

export async function moveBase(
  log: MergeLog,
  repoPath: string,
  base: string,
  baseRef: string,
  expected: string,
  head: string
): Promise<MoveResult> {
  const blocked = (kind: 'dirty-base' | 'merge-error', message: string, detail?: string[]) => ({
    kind: 'blocked' as const,
    result: {
      state: 'needs_you' as const,
      blocker: { kind, message, ...(detail?.length ? { detail } : {}) },
    },
  });
  const current = await log.gitOut(repoPath, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  if (current !== expected) return { kind: 'moved' };
  if (!(await isAncestor(log, repoPath, expected, head))) {
    return blocked('merge-error', `The task does not contain ${base}`);
  }

  const list = await log.gitOut(repoPath, ['worktree', 'list', '--porcelain']);
  const checkedOut = parseWorktreePorcelain(`${list ?? ''}\n`).find(
    (entry) => entry.branch === baseRef && !entry.prunable
  );
  if (checkedOut) {
    // The user's own checkout: only a fast-forward, and only when none of its uncommitted work
    // is in a file the merge changes or adds (2026-11-04: before, any edit held it). Their
    // changes are never stashed, committed or discarded: git updates the other files around them.
    const inTheWay = await checkoutInTheWay(checkedOut.path, [expected, head]);
    if (!inTheWay) return blocked('merge-error', `Could not read ${checkedOut.path}`);
    if (inTheWay.overlap.length) {
      const shown = inTheWay.overlap.slice(0, 20);
      return blocked(
        'dirty-base',
        `${checkedOut.path} has uncommitted work in files this merge changes on ${base}: ${shown.slice(0, 5).join(', ')}${inTheWay.overlap.length > 5 ? ` and ${inTheWay.overlap.length - 5} more` : ''}`,
        shown
      );
    }
    if (inTheWay.local) {
      log.write(
        `# ${checkedOut.path} has ${inTheWay.local} uncommitted file(s), none changed by the merge: fast-forward around them`
      );
    }
    // Its reflog entry says the files changed by Untether's merge: the dev server batches the
    // restarts those cause (scripts/server-watch.js mergeSignal, 2026-11-02).
    const ff = await log.git(checkedOut.path, ['merge', '--ff-only', head], COMMIT_TIMEOUT_MS, {
      GIT_REFLOG_ACTION: MERGE_REFLOG_ACTION,
    });
    if (ff.code !== 0) {
      const now = await log.gitOut(repoPath, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
      if (now !== expected) return { kind: 'moved' };
      const text = output(ff);
      return /would be overwritten|untracked working tree/i.test(text)
        ? blocked('dirty-base', `Files in ${checkedOut.path} are in the way`, lastLines(text))
        : blocked('merge-error', `Could not fast-forward ${base}`, lastLines(text));
    }
  } else {
    const updated = await log.git(repoPath, [
      'update-ref',
      '-m',
      `untether: merge task into ${base}`,
      baseRef,
      head,
      expected,
    ]);
    if (updated.code !== 0) {
      const now = await log.gitOut(repoPath, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
      if (now !== expected) return { kind: 'moved' };
      return blocked('merge-error', `Could not move ${base}`, lastLines(output(updated)));
    }
  }

  // 8. The base must hold the task's commit now.
  const after = await log.gitOut(repoPath, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  if (after !== head || !(await isAncestor(log, repoPath, head, baseRef))) {
    return blocked('merge-error', `${base} did not end at the task's commit`);
  }
  return { kind: 'merged' };
}

/**
 * What keeps a task's folder and branch from going after the base got `mergedSha`: commits
 * on its branch that are not in the base, or work in its folder that is in no commit (new
 * files the check left, `artifacts`, aside). Null when nothing does.
 */
async function leftBehind(
  task: PipelineTask,
  options: PipelineOptions,
  log: MergeLog,
  artifacts: ReadonlySet<string>
): Promise<string[] | null> {
  const { repoPath, branch, baseBranch, worktreePath } = task;
  if (!repoPath || !branch || !baseBranch) return null;
  const detail: string[] = [];
  const tip = await log.gitOut(repoPath, [
    'rev-parse',
    '--verify',
    `refs/heads/${branch}^{commit}`,
  ]);
  if (tip && !(await isAncestor(log, repoPath, tip, `refs/heads/${baseBranch}`))) {
    const count = await log.gitOut(repoPath, [
      'rev-list',
      '--count',
      `refs/heads/${baseBranch}..refs/heads/${branch}`,
    ]);
    detail.push(`${count ?? 'some'} commit(s) on ${branch} that are not in ${baseBranch}`);
  }
  if (worktreePath && fs.existsSync(worktreePath)) {
    const exclude = leftoverExcludes((options.settings ?? DEFAULT_PROJECT_SETTINGS).cloneDirs);
    const unsaved = await unsavedChanges(worktreePath, exclude);
    // Gone while it was read (a cut-short cleanup's remove still going): nothing kept in it.
    if (!unsaved && !fs.existsSync(worktreePath)) return detail.length ? detail : null;
    if (!unsaved) detail.push(`Could not read ${worktreePath}`);
    else {
      const files = [
        ...unsaved.tracked,
        ...unsaved.untracked.filter((file) => !artifacts.has(file)),
      ];
      if (files.length) {
        detail.push(`${files.length} file(s) changed in its folder and not committed`);
        detail.push(...files.slice(0, 20));
      }
    }
  }
  return detail.length ? detail : null;
}

/**
 * The base has `mergedSha`: the session ends, worktree and branch go. 2026-10-20: never with
 * work of its own left in them (new commits, uncommitted files): that stops at needs_you,
 * folder and branch kept, before the session is ended and again right after.
 */
export async function finishMerged(
  task: PipelineTask,
  options: PipelineOptions,
  log: MergeLog,
  mergedSha: string,
  baseNow: string,
  artifacts: ReadonlySet<string> = new Set()
): Promise<PipelineResult> {
  log.write(`# merged ${mergedSha} into ${task.baseBranch}`);
  const kept = (detail: string[]): PipelineResult => {
    log.write(`# kept: ${detail.join('; ')}`);
    return {
      state: 'needs_you',
      blocker: {
        kind: 'merge-error',
        message: `${task.baseBranch} has the task's commit ${mergedSha.slice(0, 8)}, but the task has work that is not in it: its folder and branch were kept. Merge it again to take the rest`,
        detail,
      },
      mergedSha,
    };
  };
  const before = await leftBehind(task, options, log, artifacts);
  if (before) return kept(before);
  await options.beforeCleanup?.().catch((error) => log.write(`# before cleanup: ${error}`));
  // The agent may have written something until its session ended.
  const after = await leftBehind(task, options, log, artifacts);
  if (after) return kept(after);
  const cleanupError = await cleanup(task, log);
  return {
    state: 'merged',
    mergedSha,
    baseSha: baseNow,
    ...(cleanupError ? { cleanupError } : {}),
  };
}

/** Remove the worktree and the branch (leftBehind found nothing of the task's own in them). */
async function cleanup(task: PipelineTask, log: MergeLog): Promise<string | undefined> {
  const { repoPath, branch, baseBranch } = task;
  if (!repoPath || !branch || !baseBranch) return undefined;
  const removed = await removeTaskWorktree({
    repoPath,
    worktreePath: task.worktreePath,
    branch,
    // leftBehind checked it: everything on it is in the base (-d would compare with HEAD).
    deleteUnmerged: true,
  });
  log.write(`# cleanup: worktree ${removed.worktreeRemoved}, branch ${removed.branchDeleted}`);
  if (!removed.worktreeRemoved) return `Could not remove ${task.worktreePath}`;
  if (!removed.branchDeleted) return removed.error ?? `Could not delete ${branch}`;
  return undefined;
}
