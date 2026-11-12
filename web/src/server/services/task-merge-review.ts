/**
 * The merge pipeline's AI review step.
 */

import { reviewIssueLine, TASK_REVIEWER_VERSION, type TaskReview } from '../../shared/tasks.js';
import { isAncestor, type MergeLog } from './task-merge-log.js';
import type { PipelineOptions, PipelineTask } from './task-merge-types.js';
import {
  collectReviewInput,
  createTaskReviewer,
  diffFiles,
  readGuidelines,
  reviewRound,
  type TaskReviewer,
} from './task-review.js';

let defaultReviewer: TaskReviewer | undefined;

/**
 * `head` is the work reviewed at `reviewed` with only `base` merged into it since, cleanly:
 * what a clean merge of the two gives is exactly head's tree (nothing of the task's changed).
 */
export async function onlyBaseSince(
  log: MergeLog,
  cwd: string,
  base: string,
  reviewed: string,
  head: string
): Promise<boolean> {
  if (reviewed === head || !(await isAncestor(log, cwd, reviewed, head))) return false;
  const merged = await log.git(cwd, ['merge-tree', '--write-tree', base, reviewed]);
  if (merged.code !== 0) return false;
  const tree = merged.stdout.split('\n')[0]?.trim();
  return !!tree && tree === (await log.gitOut(cwd, ['rev-parse', `${head}^{tree}`]));
}

/**
 * Ask the reviewer about the task's diff (from its merge-base with the base, the files
 * `changes` names); anything that goes wrong is 'unavailable'.
 *
 * 2026-11-01 (bakery e15c0fae: three reviews read main's code merged into the branch and
 * spent both automatic fixes on it): a diff whose files are not the task's changes is not sent
 * (unavailable, retried, never an automatic fix); a re-review that finds nothing changed since
 * keeps the earlier verdict; a re-review whose reviewer says the diff does not hold the task's
 * work is asked again on the whole diff, and only that answer counts.
 */
export async function runReview(
  task: PipelineTask,
  options: PipelineOptions,
  log: MergeLog,
  baseSha: string,
  head: string,
  changes: string[],
  earlier?: TaskReview
): Promise<TaskReview> {
  const now = options.now ?? Date.now;
  let review: TaskReview;
  try {
    const cwd = task.worktreePath as string;
    let input = await collectReviewInput(cwd, baseSha, head, earlier?.headSha, changes);
    if ('unchanged' in input) {
      if (earlier) {
        log.write(`# review: ${earlier.verdict} (kept, only ${task.baseBranch} merged in since)`);
        const { round: _round, ...kept } = earlier;
        return { ...kept, headSha: head, at: new Date(now()).toISOString() };
      }
      input = await collectReviewInput(cwd, baseSha, head, undefined, changes);
      if ('unchanged' in input) throw new Error('no diff to review');
    }
    const guidelines = await readGuidelines(cwd, baseSha).catch(() => undefined);
    defaultReviewer ??= createTaskReviewer();
    const reviewer = options.reviewer ?? defaultReviewer;
    const ask = (reviewInput: Exclude<typeof input, { unchanged: true }>, previous = earlier) =>
      reviewer({
        title: task.name,
        prompt: task.prompt ?? '',
        // What the user or the orchestrator said since; Untether's own fix hand-backs are not asks.
        followUps: (task.followUps ?? [])
          .filter((message) => message.via !== 'auto')
          .map((message) => message.text),
        summary: task.summary,
        ...(task.result ? { result: task.result } : {}),
        ...(task.resultMismatch ? { resultMismatch: task.resultMismatch } : {}),
        ...(task.guardBlocks?.count ? { guardBlocks: task.guardBlocks } : {}),
        headSha: head,
        agent: task.agent ?? 'claude',
        // Cross review is on unless the project turned it off (2026-11-01).
        crossReview: options.settings?.crossReview !== false,
        ...reviewInput,
        ...(guidelines ? { guidelines } : {}),
        ...(previous?.headSha
          ? {
              previous: {
                headSha: previous.headSha,
                summary: previous.summary,
                issues: previous.issues,
              },
            }
          : {}),
      });
    review = await ask(input);
    let shown = input;
    if (review.diffMismatch && input.incremental) {
      log.write(
        "# review: the reviewer says the diff since is not the task's work; the whole diff"
      );
      const whole = await collectReviewInput(cwd, baseSha, head, undefined, changes);
      if ('unchanged' in whole) throw new Error('no diff to review');
      shown = whole;
      review = await ask(whole);
    }
    if (review.verdict !== 'unavailable') {
      // For comparing reviewers (2026-11-01): what this answer raised, and what became of the
      // previous findings (fixed if the agent touched their file since, else argued away).
      const changedSince = !earlier?.headSha
        ? null
        : shown.incremental
          ? diffFiles(shown)
          : await log
              .git(cwd, ['diff', '--name-only', earlier.headSha, head])
              .then((r) => (r.code === 0 ? r.stdout.split('\n').filter(Boolean) : null))
              .catch(() => null);
      review = { ...review, round: reviewRound(review, earlier, changedSince) };
    }
  } catch (error) {
    review = {
      verdict: 'unavailable',
      summary: '',
      issues: [],
      reason: error instanceof Error ? error.message : String(error),
      at: new Date(now()).toISOString(),
      model: 'sonnet',
      headSha: head,
    };
  }
  review = { ...review, reviewer: TASK_REVIEWER_VERSION };
  log.write(
    `# review: ${review.verdict} by ${review.model}${review.crossReview ? ' (cross)' : ''}${
      review.fallback ? ` [cross reviewer unavailable: ${review.fallback}]` : ''
    }${review.reason ? ` (${review.reason})` : ''}${
      review.summary ? ` — ${review.summary}` : ''
    }${review.issues.length ? `\n${review.issues.map(reviewIssueLine).join('\n')}` : ''}`
  );
  return review;
}
