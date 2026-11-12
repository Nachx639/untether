/**
 * What the scheduler types into an agent: fix and auto-fix prompts, late reviews, follow-ups sent
 * late.
 */
import {
  autoFixRounds,
  issueBlocks,
  reviewBlocks,
  reviewIssueLine,
  TASK_AUTO_FIX_MAX,
  TASK_AUTO_FIX_TOTAL_MAX,
  type TaskBlocker,
  type TaskRecord,
  type TaskReview,
} from '../../shared/tasks.js';
import { LATE_INPUT_MS } from './task-scheduler-rules.js';
import { LEFTOVERS_FAILED } from './task-worktree.js';

/**
 * A pending message as it is typed: with its sending time in front once it is over
 * LATE_INPUT_MS old ("(sent at 11:19, 30 min ago) …"; the day too when it was not today).
 */
export function withSendingTime(message: { text: string; at: string }, now: number): string {
  const sent = Date.parse(message.at);
  const age = now - sent;
  if (!Number.isFinite(sent) || age <= LATE_INPUT_MS) return message.text;
  const when = new Date(sent);
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const sameDay = new Date(now).toDateString() === when.toDateString();
  const day = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const minutes = Math.round(age / 60_000);
  const ago =
    minutes < 120
      ? `${minutes} min`
      : minutes < 48 * 60
        ? `${Math.round(minutes / 60)} h`
        : `${Math.round(minutes / (24 * 60))} days`;
  return `(sent ${sameDay ? '' : `on ${day} `}at ${clock}, ${ago} ago) ${message.text}`;
}

/** A pending message as it is typed: under its header (its id and sender), when it has one. */
export function typedMessage(
  message: { text: string; at: string; header?: string },
  now: number
): string {
  const text = withSendingTime(message, now);
  return message.header ? `${message.header}\n${text}` : text;
}

/** What the agent is told to fix ("Que lo arregle"), from the task's blocker. */
export function fixPrompt(task: TaskRecord, blocker: TaskBlocker): string {
  const base = task.baseBranch ?? 'the base branch';
  const done =
    "Then commit and run `ut task done --summary '<what you changed>' --verified '<commands you ran and their result>' --undo '<how to undo it>'` again (single quotes, no ' inside them).";
  const list = (lines: string[] = []) => lines.map((line) => `- ${line}`).join('\n');
  switch (blocker.kind) {
    case 'conflict': {
      // Against a merge batch's tip the base branch is not what conflicts: it does not hold
      // the tasks merging first yet, so the commit itself is named and merged.
      const tip = blocker.batchTip && blocker.base ? blocker.base : undefined;
      return [
        tip
          ? `Merging the batch your task merges with (commit \`${tip}\`: \`${base}\` and the tasks merging before yours, not in \`${base}\` yet) into your branch conflicts in:`
          : `Merging \`${base}\` into your branch conflicts in:`,
        list(blocker.detail),
        `Run \`git merge ${tip ?? base}\`, resolve the conflicts keeping both sides' intent, and commit.`,
        done,
      ].join('\n');
    }
    case 'verify': {
      const output = task.verify?.tail || (blocker.detail ?? []).join('\n');
      // The AI review of the same commit, when it found problems too: fixed in the same round.
      const review =
        task.review && reviewBlocks(task.review) && task.review.headSha === task.verify?.headSha
          ? task.review
          : undefined;
      return [
        `The project's check failed${task.verify?.command ? `: \`${task.verify.command}\`` : ''}.`,
        '```',
        output.slice(-6000),
        '```',
        'Fix the cause (do not skip or disable tests or checks).',
        ...(review
          ? [
              'The AI review of the same commit also found problems:',
              list(review.issues.map(reviewIssueLine)),
              'Fix the real ones too. If one is wrong, leave the code and say why in the summary.',
            ]
          : []),
        done,
      ].join('\n');
    }
    case 'review':
      return [
        'An AI review of your diff found problems, so the task was not merged:',
        list(task.review?.issues.length ? task.review.issues.map(reviewIssueLine) : blocker.detail),
        'Fix the real ones. If one is wrong, leave the code and say why in the summary.',
        // Stopped when the review came back first (2026-10-31): nothing says it passes.
        ...(task.verify?.cancelled && task.verify.command
          ? [
              `The project's check (\`${task.verify.command}\`) was stopped before it finished, so it is not known to pass: run it yourself before you are done. It runs again on your next commit.`,
            ]
          : []),
        done,
      ].join('\n');
    case 'risk':
      return [
        'These changes were flagged as risky and were not merged:',
        list(blocker.detail),
        'Undo any that the task does not need. If one is needed, say why in the summary.',
        done,
      ].join('\n');
    default:
      if (blocker.message === LEFTOVERS_FAILED) {
        return [
          'Untether could not commit the changes you left uncommitted:',
          list(blocker.detail),
          "Fix the cause (a commit hook's complaint, a merge you left unfinished) and commit your work yourself; do not skip the hooks.",
          done,
        ].join('\n');
      }
      return [
        `Merging the task stopped: ${blocker.message}`,
        list(blocker.detail),
        'Look into it and fix what is on your side.',
        done,
      ].join('\n');
  }
}

/** The AI review's problems, sent while the agent fixes the same commit's check. */
export function lateReviewPrompt(review: TaskReview): string {
  return [
    '[untether] The AI review of the commit whose check failed also found problems:',
    ...review.issues.filter(issueBlocks).map((issue) => `- ${reviewIssueLine(issue)}`),
    'Fix the real ones in this same round. If one is wrong, leave the code and say why in the summary.',
  ].join('\n');
}

/**
 * What the agent is told when Untether hands a blocker back by itself (the auto-fix loop).
 * The second round asks it to step back: patching around the same failure again is what
 * kept overnight loops going (2026-10-20).
 */
export function autoFixPrompt(task: TaskRecord, blocker: TaskBlocker, attempt: number): string {
  if (task.autoFix?.baseMoved) {
    // Not a failed fix (freshConflict): no count, no "last attempt".
    return `[untether] The base moved on with other merges: a new conflict to resolve, not a failed fix.\n${fixPrompt(task, blocker)}`;
  }
  const head = `[untether] Automatic fix ${attempt} of ${TASK_AUTO_FIX_MAX}: the task did not merge.`;
  // The last round of this reason, or of all of them (TASK_AUTO_FIX_TOTAL_MAX).
  const rethink =
    attempt >= TASK_AUTO_FIX_MAX || autoFixRounds(task) >= TASK_AUTO_FIX_TOTAL_MAX
      ? '\nThis is the last automatic attempt. Step back and rethink the approach instead of patching around the problem; if the approach itself is wrong, change it. If it cannot be done right, say so with `ut task ask`.'
      : '';
  return `${head}\n${fixPrompt(task, blocker)}${rethink}`;
}

/** A conflict as compared with the last one (TaskScheduler.freshConflict). */
export function conflictOf(blocker: TaskBlocker): { base: string; files: string[] } {
  return { base: blocker.base ?? '', files: [...(blocker.detail ?? [])].sort() };
}

export function sameConflict(
  a: { base: string; files: string[] },
  b: { base: string; files: string[] }
): boolean {
  return a.base === b.base && a.files.join('\n') === b.files.join('\n');
}
