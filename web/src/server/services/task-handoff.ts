/**
 * A task that goes on with another agent, account or model after its own was cut short by its
 * usage limit (2026-11-01, ProjectSettings.agentFallback): the new agent starts in the same
 * worktree and branch with a bounded handoff instead of starting over. It gets the task as it
 * was given, what was done (commits, files left uncommitted), the current diff and the last
 * rows of the old agent's screen, each clipped so the prompt stays a prompt.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { TaskAgent } from '../../shared/tasks.js';

const execFileAsync = promisify(execFile);

/** The diff the new agent sees (the rest it reads with git). */
export const HANDOFF_DIFF_MAX = 12_000;
/** Commits listed. */
export const HANDOFF_COMMITS_MAX = 30;
/** The last rows of the old agent's screen. */
export const HANDOFF_SCREEN_MAX = 3_000;
/** Follow-ups the user sent, the latest ones. */
export const HANDOFF_FOLLOW_UPS_MAX = 3;
/** What the old agent was last told and was at when it stopped, whole up to this. */
export const HANDOFF_PENDING_MAX = 8_000;

/** What a task's worktree holds now, against where it started. */
export interface TaskProgress {
  /** `git log --oneline base..HEAD`, newest first. */
  commits: string[];
  /** `git status --short`: what is left uncommitted. */
  status: string[];
  /** `git diff base`: committed and uncommitted changes together. */
  diff: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

/** The progress of the work in `worktreePath` since `baseSha` (HEAD when unknown). */
export async function gitProgress(worktreePath: string, baseSha?: string): Promise<TaskProgress> {
  const base = baseSha ?? 'HEAD';
  const [log, status, diff] = await Promise.all([
    git(worktreePath, ['log', '--oneline', `-${HANDOFF_COMMITS_MAX}`, `${base}..HEAD`]).catch(
      () => ''
    ),
    git(worktreePath, ['status', '--short']).catch(() => ''),
    git(worktreePath, ['diff', '--stat', '--patch', base]).catch(() => ''),
  ]);
  const lines = (text: string) => text.split('\n').filter((line) => line.trim());
  return { commits: lines(log), status: lines(status), diff };
}

const clipEnd = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
const clipStart = (text: string, max: number) =>
  text.length > max ? `…\n${text.slice(text.length - max)}` : text;

const agentName = (agent: TaskAgent) => (agent === 'codex' ? 'Codex' : 'Claude');

export interface HandoffInput {
  /** The task as its first agent got it (TaskScheduler.launchPrompt). */
  brief: string;
  from: { agent: TaskAgent; model?: string };
  /** Why it stopped (the halt's line). */
  reason: string;
  progress?: TaskProgress;
  /** The last rows of the old agent's screen. */
  screen?: string;
  /** What the user sent it after the brief, oldest first. */
  followUps?: string[];
  /**
   * The last thing it was told, which it was working on when it stopped (a fix round's request
   * with its findings, an answer, a follow-up): kept whole, it is what the new agent does now
   * (2026-11-09: a relief in a fix round got the review's findings cut at 600 characters).
   */
  pending?: string;
  /** What it last said (its last reply). */
  lastReply?: string;
}

/** The new agent's first message. */
export function buildHandoffPrompt(input: HandoffInput): string {
  const who = `${agentName(input.from.agent)}${input.from.model ? ` (${input.from.model})` : ''}`;
  const parts = [
    `[untether] You take over a task another agent (${who}) was working on: it stopped (${input.reason.slice(0, 300)}). Do not start over: you are in its folder and branch, with its work. Check what is there (git status, git log, the diff below), finish the rest of the task and report as the task says.`,
    '',
    '=== The task, as it was given ===',
    input.brief,
  ];
  const followUps = (input.followUps ?? []).slice(-HANDOFF_FOLLOW_UPS_MAX);
  if (followUps.length) {
    parts.push('', '=== What the user added later ===');
    for (const text of followUps) parts.push(`- ${clipEnd(text.replace(/\s+/g, ' '), 600)}`);
  }
  if (input.pending?.trim()) {
    parts.push(
      '',
      '=== What it was last told, and was working on when it stopped: carry this on now ===',
      clipEnd(input.pending.trim(), HANDOFF_PENDING_MAX)
    );
  }
  const progress = input.progress;
  parts.push('', '=== What was done ===');
  if (progress) {
    parts.push(
      progress.commits.length
        ? `Commits on the branch (newest first):\n${progress.commits.join('\n')}`
        : 'No commits yet.'
    );
    parts.push(
      progress.status.length
        ? `Uncommitted:\n${progress.status.slice(0, 50).join('\n')}`
        : 'Nothing uncommitted.'
    );
  } else {
    parts.push('Unknown: look with git status and git log.');
  }
  if (input.lastReply?.trim()) {
    parts.push(`Its last words: ${clipEnd(input.lastReply.trim(), 800)}`);
  }
  if (progress?.diff.trim()) {
    parts.push('', '=== The current diff ===', clipEnd(progress.diff.trim(), HANDOFF_DIFF_MAX));
  }
  if (input.screen?.trim()) {
    parts.push(
      '',
      "=== The last rows of the other agent's screen ===",
      clipStart(input.screen.trim(), HANDOFF_SCREEN_MAX)
    );
  }
  return parts.join('\n');
}
