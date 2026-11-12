/**
 * The AI reviewer (2026-10-18): a second pair of eyes on a finished task before it merges, for
 * projects with `aiReview` on (projects.json). The merge pipeline (task-merge.ts) calls it after
 * the risk scan and the check passed, with the task's title, its prompt, the agent's summary,
 * its commits and its diff against the base.
 *
 * Claude Sonnet (`claude -p` through the user's subscription, claude-oneshot.ts) answers with
 * no tools, from an empty folder, in strict JSON (2026-11-01, cross review, project setting
 * crossReview, on unless turned off: the other family than the task's agent answers instead,
 * Codex through `codex exec` for Claude's tasks, so its blind spots are not the author's; one
 * that can't answer falls back to Claude without blocking, and the review names who read it):
 *   {"verdict":"ok"|"concerns","summary":"…","issues":[{"file","line"?,"severity","what"}]}
 * Any open medium or high bug or security finding stops the merge (blocker 'review', a hard
 * gate whatever the verdict says); low ones and nits only show.
 *
 * 2026-10-20 (how Anthropic reviews agent code; overnight review loops of 50 rounds): the
 * reviewer judges only the lines the diff changed, never older code around them; it reads the
 * repository's REVIEW.md / CLAUDE.md / AGENTS.md (from the base commit, so a task can't rewrite
 * its own review rules); style never blocks and at most a few low notes are kept; a repeated
 * bug is one finding for the whole class; a security pass runs in the same review. A re-review
 * after a fix reads only what changed since the last reviewed commit, with the previous
 * findings, and says which are still open: nothing already fixed or argued comes back.
 *
 * No claude, no token, no answer within REVIEW_TIMEOUT_MS or an answer that is not that JSON
 * even when asked a second time (ai-json-reply.ts, 2026-10-25; the unreadable replies are kept
 * in ~/.untether/ai-replies) → verdict 'unavailable': the task does not merge on it
 * (task-merge.ts), Untether retries.
 *
 * A diff over REVIEW_DIFF_MAX is cut: the --stat first, then the biggest files' diffs (each at
 * most REVIEW_FILE_MAX), and the reviewer is told what was left out.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SecurityEffort } from '../../shared/security.js';
import { fitResultLines, type TaskResult, taskResultLines } from '../../shared/task-result.js';
import {
  guardLetThrough,
  issueBlocks,
  type TaskAgent,
  type TaskGuardBlocks,
  type TaskReview,
  type TaskReviewCategory,
  type TaskReviewIssue,
  type TaskReviewRound,
  type TaskReviewSeverity,
} from '../../shared/tasks.js';
import { run } from '../utils/exec-file.js';
import { askForJson, extractJsonObject } from './ai-json-reply.js';
import { askClaudeOnce, type ClaudeOnceOptions } from './claude-oneshot.js';
import { askCodexOnce, type CodexOnce } from './security-review.js';

/** Sonnet reviews code better than Haiku (the copilot's default). */
export const REVIEW_MODEL = 'sonnet';
export const REVIEW_TIMEOUT_MS = 180_000;
/** `codex exec` starts slower and thinks longer than `claude -p`. */
export const CODEX_REVIEW_TIMEOUT_MS = 300_000;
/** Codex's reasoning effort as a reviewer (CODEX_EFFORT_CONFIG). */
export const CODEX_REVIEW_EFFORT: SecurityEffort = 'medium';
/** The most diff text the reviewer is shown. */
export const REVIEW_DIFF_MAX = 150 * 1024;
/** The most of one file's diff shown when the whole diff is too big. */
export const REVIEW_FILE_MAX = 24 * 1024;
const PROMPT_MAX = 8000;
const SUMMARY_MAX = 4000;
/** The agent's structured result: whole lines, files last, so they are what a cut drops. */
const RESULT_MAX = 12000;
const COMMITS_MAX = 60;
const ISSUES_MAX = 30;
/** At most this many low-severity notes and nits are kept (they never block). */
export const LOW_NOTES_MAX = 3;
const GUIDELINES_MAX = 6000;
/** The repository's own words on what matters in a review, read from the base commit. */
export const GUIDELINE_FILES = ['REVIEW.md', 'CLAUDE.md', 'AGENTS.md'];
const GIT_TIMEOUT_MS = 60_000;

export interface ReviewRequest {
  title: string;
  /** The task's prompt (what was asked). */
  prompt: string;
  /**
   * What the user or the orchestrator told the task after its prompt, oldest first: it changes
   * or extends what was asked (2026-10-23: the review flagged as "contrary to the request" an
   * auto-merge the user had asked for in a later message it never saw).
   */
  followUps?: string[];
  /** What the agent said it did. */
  summary?: string;
  /**
   * Its structured result (`ut task done --result`): outcome, the files it says it touched and
   * why, the tests it says it ran, known risks, what is left. Compared with the diff.
   */
  result?: TaskResult;
  /** Where Untether already saw that result disagree with the branch. */
  resultMismatch?: string;
  /** Tool calls of the agent that Untether's command guard blocked (task-guard.ts). */
  guardBlocks?: TaskGuardBlocks;
  /** "abc1234 subject", oldest first. */
  commits: string[];
  /** The diff to show (already cut to size). */
  diff: string;
  /** Files the diff left out because it was too big. */
  omitted: string[];
  truncated: boolean;
  headSha: string;
  /** REVIEW.md / CLAUDE.md / AGENTS.md of the base commit, cut to size. */
  guidelines?: string;
  /**
   * The earlier review of this task (a re-review after a fix): its findings, and the commit it
   * read. With `incremental`, `diff` holds only the changes since that commit.
   */
  previous?: { headSha: string; summary: string; issues: TaskReviewIssue[] };
  incremental?: boolean;
  /** The task's agent (who wrote the diff). */
  agent?: TaskAgent;
  /** Review it with the other family than `agent` (project setting crossReview). */
  crossReview?: boolean;
}

export type TaskReviewer = (request: ReviewRequest) => Promise<TaskReview>;

/** How long the answer may be (said up front, and again when a reply was cut off). */
const REVIEW_SHORTER_RULE =
  'summary under 200 characters, at most 12 issues, each "what" under 400 characters';
const REVIEW_SHORTER = `${REVIEW_SHORTER_RULE}; merge findings of one class into one.`;

export const REVIEW_SYSTEM_PROMPT = [
  'You are a senior code reviewer. A coding agent finished a task on its own git branch; its',
  'diff passed the project check (tests, lint, types) and is about to be merged into the main',
  'branch without a human looking at it. You are the last pair of eyes.',
  '',
  'SCOPE: review only the lines this diff adds or changes. Never report problems in code the',
  'diff did not touch, even if you see them in the context lines: they are not this task.',
  '',
  'Look for real problems: bugs, logic errors, broken edge cases, crashes, data loss, code that',
  'does not do what the task asked, tests weakened or skipped to pass, debug leftovers.',
  'Then a SECURITY PASS over the same lines: leaked secrets or credentials, injection (shell,',
  'SQL, HTML), unsafe shell commands or string-built argv, path traversal, missing auth or',
  'permission checks, files or sockets left world-readable, unsafe deserialization. Read changes',
  'to authentication and authorization closely (token or JWT verification, session secrets,',
  'password hashing, role and permission checks): a weakened or bypassed check is high.',
  '',
  'Rules:',
  '- A bug that repeats in several places is ONE finding for the whole class (name the places in',
  '  "what"), never one per line.',
  '- Style, naming, formatting and taste are "nit": at most a few, and they never block.',
  '- When the project guidelines below say what matters, follow them.',
  '- A re-review lists the previous findings: report each one again only if the code still has',
  '  it (the agent may have fixed it, or argued in its summary why it is not a problem: accept a',
  '  sound argument). Never raise again something already fixed or soundly argued.',
  '',
  'Severity: high = would break something, lose data or is exploitable; medium = a likely bug,',
  'a real security weakness, or the task is not really done; low = minor, fine to merge.',
  'Category: "bug", "security" or "nit".',
  '',
  'Reply with ONLY one JSON object, no prose, no code fence:',
  '{"verdict":"ok"|"concerns","summary":"<one short line in Spanish>","issues":[{"file":"<path>","line":<number, optional>,"severity":"high"|"medium"|"low","category":"bug"|"security"|"nit","what":"<the problem, in Spanish, one or two sentences>"}]}',
  'verdict "ok" when nothing medium or high is open; then issues may list low ones or be [].',
  // 2026-11-01: a re-review shown code merged in from the base said so in an issue, and the
  // agent was sent to "fix" it; this flag gets the whole diff instead.
  'If the diff shown does not contain the work the task describes at all (for example only code',
  'that came from the main branch), add "diffMismatch":true to the object and do not report that',
  'as an issue: Untether shows you the right diff.',
  // 2026-10-25: a reply that ran long came back unreadable; the answer stays small.
  `Keep it short: ${REVIEW_SHORTER_RULE}. Escape double quotes inside strings as \\".`,
].join('\n');

const GUARD_LINES_MAX = 15;

/**
 * What the command guard blocked (2026-11-02): those calls did not run, but they show what the
 * agent tried; work that needed them may be missing or done another way.
 */
function guardSection(blocks: TaskGuardBlocks | undefined): string[] {
  const shown = (blocks?.recent ?? []).filter((entry) => !guardLetThrough(entry.rule));
  if (!blocks || !shown.length) return [];
  return [
    `BLOCKED BY UNTETHER'S COMMAND GUARD (${blocks.count} tool call(s) the agent tried that did NOT run; latest first):`,
    ...shown
      .slice(-GUARD_LINES_MAX)
      .reverse()
      .map((entry) => `- [${entry.rule}] ${entry.tool}: ${clip(entry.what, 300)}`),
    'Check that the diff does not depend on them and does not try to get around them (another command doing the same).',
    '',
  ];
}

/** The question: the task, what the agent says it did, its commits and its diff. */
export function reviewQuestion(request: ReviewRequest): string {
  const parts = [
    `TASK TITLE: ${request.title}`,
    '',
    'WHAT WAS ASKED (the task prompt):',
    clip(request.prompt.trim(), PROMPT_MAX),
    '',
    ...(request.followUps?.length
      ? [
          'SENT TO THE TASK AFTER ITS PROMPT (oldest first; where they differ from the prompt, the later message is what is asked now):',
          clip(request.followUps.map((text) => `- ${text.trim()}`).join('\n'), PROMPT_MAX),
          '',
        ]
      : []),
    'WHAT THE AGENT SAYS IT DID:',
    clip(request.summary?.trim() || '(nothing said)', SUMMARY_MAX),
    '',
    ...(request.result
      ? [
          "THE AGENT'S STRUCTURED RESULT (its own claims: check each against the diff; a file it says it changed for a reason the diff does not bear out, a test it says passed for code the diff breaks, or a change the diff makes that it does not mention, is a finding):",
          fitResultLines(taskResultLines(request.result), RESULT_MAX),
          ...(request.resultMismatch ? [`UNTETHER NOTICED: ${request.resultMismatch}`] : []),
          '',
        ]
      : []),
    ...guardSection(request.guardBlocks),
    ...(request.guidelines
      ? ['PROJECT GUIDELINES (from the repository):', request.guidelines, '']
      : []),
    ...(request.previous
      ? [
          `PREVIOUS REVIEW (of ${request.previous.headSha.slice(0, 12)}): ${request.previous.summary || '(no summary)'}`,
          ...(request.previous.issues.length
            ? request.previous.issues.map(
                (issue) =>
                  `- ${issue.severity} ${issue.category ?? 'bug'} ${issue.file}${issue.line ? `:${issue.line}` : ''}: ${issue.what}`
              )
            : ['- (no findings)']),
          'Report a previous finding again only if the code below still has it.',
          '',
        ]
      : []),
    `COMMITS (${request.commits.length}):`,
    ...request.commits.slice(0, COMMITS_MAX),
    ...(request.commits.length > COMMITS_MAX
      ? [`… and ${request.commits.length - COMMITS_MAX} more`]
      : []),
    '',
  ];
  if (request.truncated) {
    parts.push(
      'NOTE: the diff is too big to show whole. Below are the --stat and the biggest files, each possibly cut.',
      ...(request.omitted.length
        ? [`Files not shown: ${request.omitted.slice(0, 200).join(', ')}`]
        : []),
      'Judge what you can see; do not raise issues only because something is not shown.',
      ''
    );
  }
  parts.push(
    request.incremental
      ? 'DIFF (only what changed since the previous review):'
      : 'DIFF (base → task):',
    request.diff,
    '',
    'Reply with the JSON object only.'
  );
  return parts.join('\n');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (cut)`;
}

/** One file's part of a unified diff ("diff --git a/x b/x" … up to the next). */
interface FileDiff {
  file: string;
  text: string;
}

export function splitDiff(diff: string): FileDiff[] {
  const sections = diff.split(/^(?=diff --git )/m).filter((part) => part.trim());
  return sections.map((text) => {
    const head = /^diff --git a\/(.+?) b\/(.+)$/m.exec(text);
    return { file: head?.[2] ?? head?.[1] ?? '?', text };
  });
}

/**
 * A diff cut to `max` bytes: unchanged when it fits; else the --stat, then the biggest files'
 * diffs (each cut at REVIEW_FILE_MAX) while they fit, naming the files left out.
 */
export function capDiff(
  diff: string,
  stat: string,
  max = REVIEW_DIFF_MAX
): { diff: string; truncated: boolean; omitted: string[] } {
  if (Buffer.byteLength(diff) <= max) return { diff, truncated: false, omitted: [] };
  const out: string[] = [`--stat:\n${stat.trimEnd()}\n`];
  let used = Buffer.byteLength(out[0]);
  const omitted: string[] = [];
  const files = splitDiff(diff).sort((a, b) => b.text.length - a.text.length);
  for (const file of files) {
    let text = file.text;
    if (Buffer.byteLength(text) > REVIEW_FILE_MAX) {
      const lines = text.split('\n');
      let kept = '';
      let count = 0;
      for (const line of lines) {
        if (Buffer.byteLength(kept) + Buffer.byteLength(line) + 1 > REVIEW_FILE_MAX) break;
        kept += `${line}\n`;
        count++;
      }
      text = `${kept}… (${lines.length - count} more lines of this file not shown)\n`;
    }
    const size = Buffer.byteLength(text);
    if (used + size > max) {
      omitted.push(file.file);
      continue;
    }
    out.push(text);
    used += size;
  }
  return { diff: out.join('\n'), truncated: true, omitted };
}

/**
 * REVIEW.md, CLAUDE.md and AGENTS.md as the base commit has them (never the task's own edits:
 * an agent must not write the rules it is reviewed by), cut to GUIDELINES_MAX in all.
 */
export async function readGuidelines(cwd: string, baseSha: string): Promise<string | undefined> {
  const parts: string[] = [];
  let left = GUIDELINES_MAX;
  for (const file of GUIDELINE_FILES) {
    if (left <= 0) break;
    const shown = await run('git', ['show', `${baseSha}:${file}`], cwd, GIT_TIMEOUT_MS);
    const text = shown.code === 0 ? shown.stdout.trim() : '';
    if (!text) continue;
    const cut = clip(text, left);
    parts.push(`## ${file}\n${cut}`);
    left -= cut.length;
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

/** `git <args>`'s non-empty output lines, or null when it failed. */
async function gitLines(cwd: string, args: string[]): Promise<string[] | null> {
  const r = await run('git', args, cwd, GIT_TIMEOUT_MS);
  if (r.code !== 0) return null;
  return [
    ...new Set(
      r.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * The files `rev` changed against the base: `git diff base...rev` (from their merge-base, the
 * same set `ut task status` calls the task's changes), or null when git failed.
 */
function ownChanges(cwd: string, baseSha: string, rev: string): Promise<string[] | null> {
  return gitLines(cwd, ['diff', '--name-only', `${baseSha}...${rev}`]);
}

/** The reviewed diff names files the task did not change: it is not the task's diff. */
export class ReviewDiffMismatchError extends Error {
  constructor(
    readonly outside: string[],
    readonly missing: string[]
  ) {
    super(
      `the diff to review did not match the task's changes${
        outside.length ? ` (not the task's: ${outside.slice(0, 5).join(', ')})` : ''
      }${missing.length ? ` (missing: ${missing.slice(0, 5).join(', ')})` : ''}`
    );
    this.name = 'ReviewDiffMismatchError';
  }
}

type ReviewInput = Pick<
  ReviewRequest,
  'commits' | 'diff' | 'omitted' | 'truncated' | 'incremental'
>;

/** What was reviewed at `since` is still all the task changed: the earlier verdict stands. */
export interface ReviewUnchanged {
  unchanged: true;
}

/**
 * Only what the task changed since the review of `since`, or null when that cannot be told
 * (then the whole diff is reviewed).
 *
 * 2026-11-01 (bakery e15c0fae): what changed since is head against `since` merged with the
 * base as it is now (`git merge-tree`), never `since..head`: a clean merge of main into the
 * branch changed files both sides had touched (hub/src/server.ts), the old rule took every file
 * a merge left unlike both parents as the task's resolution, and three reviews in a row read
 * main's code (another task's welcomeCard, the AI usage card) as the task's, spent both
 * automatic fixes on it and blocked the merge. Earlier: 2026-10-20 (the base's commits reviewed
 * as the task's), 2026-10-31 (a conflict's resolution or an amend got a full review). A real
 * conflict's file shows the task's whole change to it on the current base. Every reviewed file
 * must be one the task changes now or did at `since`; otherwise the whole diff is reviewed.
 */
async function sinceReview(
  cwd: string,
  baseSha: string,
  headSha: string,
  since: string
): Promise<ReviewInput | ReviewUnchanged | null> {
  const exists = await run('git', ['cat-file', '-e', `${since}^{commit}`], cwd, GIT_TIMEOUT_MS);
  if (exists.code !== 0) return null;
  // `since` as it would be on today's base: exit 1 = conflicts (their files follow the tree).
  const merged = await run(
    'git',
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', baseSha, since],
    cwd,
    GIT_TIMEOUT_MS
  );
  if (merged.code !== 0 && merged.code !== 1) return null;
  const [tree, ...conflictLines] = merged.stdout.split('\n').map((line) => line.trim());
  if (!/^[0-9a-f]{40,64}$/.test(tree ?? '')) return null;
  const conflicted = new Set(conflictLines.filter(Boolean));
  const ancestor = await run(
    'git',
    ['merge-base', '--is-ancestor', since, headSha],
    cwd,
    GIT_TIMEOUT_MS
  );
  const [changed, nowOwn, thenOwn, commits] = await Promise.all([
    gitLines(cwd, ['diff', '--name-only', tree, headSha]),
    ownChanges(cwd, baseSha, headSha),
    ownChanges(cwd, baseSha, since),
    gitLines(cwd, [
      'log',
      '--no-merges',
      '--reverse',
      '--format=%h %s',
      ...(ancestor.code === 0
        ? [`${since}..${headSha}`, '--not', baseSha]
        : [`${baseSha}..${headSha}`]),
    ]),
  ]);
  if (!changed || !nowOwn || !thenOwn || !commits) return null;
  if (!changed.length) return { unchanged: true };
  // The guard: a file neither the task changes now nor changed when reviewed is not its work.
  const allowed = new Set([...nowOwn, ...thenOwn]);
  if (changed.some((file) => !allowed.has(file))) return null;
  const plain = changed.filter((file) => !conflicted.has(file)).slice(0, 500);
  const resolved = changed.filter((file) => conflicted.has(file)).slice(0, 500);
  const diffOf = (range: string[], files: string[], stat: boolean) =>
    files.length
      ? run(
          'git',
          [
            'diff',
            '--no-color',
            '--no-ext-diff',
            ...(stat ? ['--stat=120'] : ['--find-renames']),
            ...range,
            '--',
            ...files,
          ],
          cwd,
          GIT_TIMEOUT_MS
        )
      : Promise.resolve({ code: 0, stdout: '', stderr: '' });
  const sinceMerged = [tree, headSha];
  const onBase = [`${baseSha}...${headSha}`];
  const parts = await Promise.all([
    diffOf(sinceMerged, plain, true),
    diffOf(sinceMerged, plain, false),
    // A conflict's file: the task's whole change to it on today's base.
    diffOf(onBase, resolved, true),
    diffOf(onBase, resolved, false),
  ]);
  const [plainStat, plainDiff, resolvedStat, resolvedDiff] = parts;
  const capped = capDiff(
    plainDiff.stdout + resolvedDiff.stdout,
    plainStat.stdout + resolvedStat.stdout
  );
  return {
    // A round of only a conflict's resolution has no commit of its own but the merge.
    commits: commits.length
      ? commits
      : [`(the merge of ${baseSha.slice(0, 8)} into the task, its conflicts resolved)`],
    diff: capped.diff,
    omitted: capped.omitted,
    truncated:
      capped.truncated ||
      ((plainDiff.code !== 0 || resolvedDiff.code !== 0) &&
        !!(plainDiff.stdout || resolvedDiff.stdout)),
    incremental: true,
  };
}

/**
 * What the reviewer reads: the task's diff against the base from their merge-base (the same
 * files as its changes, whatever merges of the base sit on top), or with `since` only what
 * changed after that review. `changes` (the files `ut task status` shows) is the guard: a whole
 * diff whose files differ from them throws ReviewDiffMismatchError instead of being reviewed.
 */
export async function collectReviewInput(
  cwd: string,
  baseSha: string,
  headSha: string,
  since?: string,
  changes?: string[]
): Promise<ReviewInput | ReviewUnchanged> {
  if (since && since !== headSha) {
    const incremental = await sinceReview(cwd, baseSha, headSha, since);
    if (incremental) return incremental;
  }
  const range = `${baseSha}..${headSha}`;
  const fromMergeBase = `${baseSha}...${headSha}`;
  const [log, files, stat, diff] = await Promise.all([
    run('git', ['log', '--no-merges', '--reverse', '--format=%h %s', range], cwd, GIT_TIMEOUT_MS),
    ownChanges(cwd, baseSha, headSha),
    run(
      'git',
      ['diff', '--no-color', '--no-ext-diff', '--stat=120', fromMergeBase],
      cwd,
      GIT_TIMEOUT_MS
    ),
    run(
      'git',
      ['diff', '--no-color', '--no-ext-diff', '--find-renames', fromMergeBase],
      cwd,
      GIT_TIMEOUT_MS
    ),
  ]);
  if (changes && files) {
    const expected = new Set(changes);
    const outside = files.filter((file) => !expected.has(file));
    const missing = changes.filter((file) => !files.includes(file));
    if (outside.length || missing.length) throw new ReviewDiffMismatchError(outside, missing);
  }
  const commits = log.stdout.split('\n').filter(Boolean);
  // A diff over exec-file's buffer comes back cut with an error: what came still counts.
  const capped = capDiff(diff.stdout, stat.stdout);
  return {
    commits,
    diff: capped.diff,
    omitted: capped.omitted,
    truncated: capped.truncated || (diff.code !== 0 && !!diff.stdout),
  };
}

const SEVERITIES: readonly TaskReviewSeverity[] = ['high', 'medium', 'low'];
const CATEGORIES: readonly TaskReviewCategory[] = ['bug', 'security', 'nit'];

type ReviewAnswer = Pick<TaskReview, 'verdict' | 'summary' | 'issues' | 'diffMismatch'>;

/** The reviewer's JSON answer, or null when it is not the object asked for. */
export function parseReviewReply(reply: string): ReviewAnswer | null {
  const read = extractJsonObject(reply, acceptReview, { unique: true });
  return read.ok ? read.value : null;
}

/** A parsed object as the review it should be, or null when it is not one. */
function acceptReview(data: unknown): ReviewAnswer | null {
  if (!data || typeof data !== 'object') return null;
  const { verdict, summary, issues, diffMismatch } = data as Record<string, unknown>;
  if (verdict !== 'ok' && verdict !== 'concerns') return null;
  if (typeof summary !== 'string') return null;
  if (issues !== undefined && !Array.isArray(issues)) return null;
  const parsed: TaskReviewIssue[] = [];
  for (const raw of (issues as unknown[] | undefined) ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const issue = raw as Record<string, unknown>;
    const severity = SEVERITIES.includes(issue.severity as TaskReviewSeverity)
      ? (issue.severity as TaskReviewSeverity)
      : null;
    if (!severity || typeof issue.what !== 'string' || !issue.what.trim()) continue;
    const line = Number(issue.line);
    const category = CATEGORIES.includes(issue.category as TaskReviewCategory)
      ? (issue.category as TaskReviewCategory)
      : 'bug';
    const what = issue.what.trim().slice(0, 600);
    const file = typeof issue.file === 'string' ? issue.file.slice(0, 300) : '';
    // The same finding twice (a class reported line by line) is one.
    if (parsed.some((other) => other.file === file && other.what === what)) continue;
    parsed.push({
      file,
      ...(Number.isInteger(line) && line > 0 ? { line } : {}),
      // A nit never blocks, whatever severity it was given.
      severity: category === 'nit' ? 'low' : severity,
      category,
      what,
    });
    if (parsed.length >= ISSUES_MAX) break;
  }
  // Blocking findings first; at most LOW_NOTES_MAX notes after them.
  const blocking = parsed.filter((issue) => issueBlocks(issue));
  const notes = parsed.filter((issue) => !issueBlocks(issue)).slice(0, LOW_NOTES_MAX);
  return {
    // The verdict follows the findings (a hard gate): "ok" next to a high issue is concerns.
    verdict: blocking.length ? 'concerns' : 'ok',
    summary: summary.trim().slice(0, 300),
    issues: [...blocking, ...notes],
    ...(diffMismatch === true ? { diffMismatch: true } : {}),
  };
}

/** An empty folder for claude to run in (it gets no tools; nothing there to read anyway). */
function harmlessCwd(): string {
  const dir = path.join(os.tmpdir(), 'untether-review');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return os.tmpdir();
  }
}

/**
 * The family that should review a task: with cross review the other one than its agent (Codex
 * for Claude's tasks, Claude for Codex's); without it Claude, the reviewer before.
 */
export function pickReviewer(author: TaskAgent | undefined, crossReview: boolean): TaskAgent {
  if (!crossReview) return 'claude';
  return author === 'codex' ? 'claude' : 'codex';
}

export interface TaskReviewerOptions extends Partial<ClaudeOnceOptions> {
  now?: () => number;
  /** Where replies that could not be read are kept (default ~/.untether/ai-replies). */
  replyDir?: string;
  /** One question to Codex (default `codex exec`, read-only, no network: security-review.ts). */
  codex?: CodexOnce;
  /**
   * Whether a family's CLI is installed (checked before asking it; a missing one falls back at
   * once). Default: it is just asked, and no answer falls back.
   */
  available?: (agent: TaskAgent) => Promise<boolean>;
}

/**
 * The reviewer (the default in the merge pipeline): Claude through `claude -p`, or with cross
 * review (2026-11-01) the other family than the task's agent. Codex through `codex exec`
 * read-only, in an empty folder, with the same prompt and the same JSON verdict. A cross
 * reviewer that is not installed or gives no usable answer (not logged in, out of quota, timed
 * out, unreadable twice) never blocks: Claude reviews as before and `fallback` says why.
 */
export function createTaskReviewer(options: TaskReviewerOptions = {}): TaskReviewer {
  const { now = Date.now, replyDir, codex = askCodexOnce, available, ...claude } = options;
  const claudeModel = claude.model ?? REVIEW_MODEL;
  const askOne = async (agent: TaskAgent, request: ReviewRequest): Promise<TaskReview> => {
    const model = agent === 'codex' ? `codex (${CODEX_REVIEW_EFFORT})` : claudeModel;
    const base = {
      at: new Date(now()).toISOString(),
      model,
      agent,
      headSha: request.headSha,
      ...(request.truncated ? { truncated: true } : {}),
    };
    const cwd = harmlessCwd();
    const read = await askForJson({
      ask: (question) =>
        agent === 'codex'
          ? codex(`${REVIEW_SYSTEM_PROMPT}\n\n${question}`, {
              effort: CODEX_REVIEW_EFFORT,
              timeoutMs: CODEX_REVIEW_TIMEOUT_MS,
              cwd,
            })
          : askClaudeOnce(
              {
                timeoutMs: REVIEW_TIMEOUT_MS,
                cwd,
                purpose: 'task review',
                ...claude,
                model: claudeModel,
              },
              REVIEW_SYSTEM_PROMPT,
              question
            ),
      question: reviewQuestion(request),
      accept: acceptReview,
      label: agent === 'codex' ? 'task-review-codex' : 'task-review',
      unique: true,
      shorterHint: REVIEW_SHORTER,
      replyDir,
    });
    if (!read.ok && read.noAnswer) {
      return {
        ...base,
        verdict: 'unavailable',
        summary: '',
        issues: [],
        reason:
          agent === 'codex'
            ? 'no answer from codex (not installed, not logged in, out of quota, or it timed out)'
            : 'no answer from claude (not installed, no token, or it timed out)',
      };
    }
    if (!read.ok) {
      return { ...base, verdict: 'unavailable', summary: '', issues: [], reason: read.reason };
    }
    return { ...base, ...(request.incremental ? { incremental: true } : {}), ...read.value };
  };
  return async (request) => {
    const author = request.agent ?? 'claude';
    const wanted = pickReviewer(author, !!request.crossReview);
    let fallback: string | undefined;
    if (wanted !== 'claude') {
      const installed = available ? await available(wanted).catch(() => true) : true;
      if (!installed) {
        fallback = `${wanted} is not installed`;
      } else {
        const review = await askOne(wanted, request);
        if (review.verdict !== 'unavailable') return { ...review, crossReview: true };
        fallback = `${wanted}: ${review.reason ?? 'unavailable'}`;
      }
    }
    const review = await askOne('claude', request);
    return {
      ...review,
      ...(author !== 'claude' ? { crossReview: true } : {}),
      ...(fallback ? { fallback } : {}),
    };
  };
}

/** The files a diff shown to the reviewer touches (with the ones it left out). */
export function diffFiles(input: Pick<ReviewRequest, 'diff' | 'omitted'>): string[] {
  return [...new Set([...splitDiff(input.diff).map((file) => file.file), ...input.omitted])];
}

/**
 * What a reviewer's answer adds to the task's numbers (TaskReviewStats, 2026-11-01): the medium
 * or high findings it raised anew, and what became of the previous review's: raised again
 * (same file and category still reported), fixed (the agent changed that file since), or
 * rejected (not raised again though the file was not touched: argued away and accepted).
 * `changedSince`: the files changed since the previous review, null when not known (then an
 * unraised finding counts as fixed).
 */
export function reviewRound(
  review: Pick<TaskReview, 'issues'>,
  previous: Pick<TaskReview, 'issues' | 'agent'> | undefined,
  changedSince: string[] | null
): TaskReviewRound {
  const blocking = review.issues.filter((issue) => issueBlocks(issue));
  const open = [...blocking];
  let fixed = 0;
  let rejected = 0;
  let reraised = 0;
  for (const issue of previous?.issues.filter((one) => issueBlocks(one)) ?? []) {
    const again = open.findIndex(
      (other) =>
        other.file === issue.file && (other.category ?? 'bug') === (issue.category ?? 'bug')
    );
    if (again >= 0) {
      open.splice(again, 1);
      reraised++;
    } else if (!changedSince || !issue.file || changedSince.includes(issue.file)) {
      fixed++;
    } else {
      rejected++;
    }
  }
  return {
    findings: open.length,
    ...(previous
      ? { previous: { agent: previous.agent ?? 'claude', fixed, rejected, reraised } }
      : {}),
  };
}
