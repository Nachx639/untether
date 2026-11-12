/** One task in full (`ut task status <id>`). */

import * as path from 'path';
import { modelMatches, taskActualModel } from '../../shared/agent-models.js';
import { promptLines } from '../../shared/agent-prompt.js';
import { budgetLine, type TaskBudget } from '../../shared/task-budget.js';
import type { TaskConfirmation } from '../../shared/task-confirmations.js';
import {
  checksLine,
  conflictsLine,
  qualityLine,
  savingsLine,
  usageLine,
} from '../../shared/task-metrics.js';
import { baseSyncLines, overlapLine } from '../../shared/task-overlap.js';
import { failureNudgeLine, failureNudgesLine, PROGRESS_WORDS } from '../../shared/task-progress.js';
import { measurementLine, testLine } from '../../shared/task-result.js';
import { formatPhaseDuration, summarizeTimings, timingMs } from '../../shared/task-timings.js';
import {
  reviewIssueLine,
  TASK_FINAL_STATES,
  type TaskPhase,
  type TaskProgressMark,
  type TaskRecord,
  type TaskStall,
} from '../../shared/tasks.js';
import type { TaskToolsInfo } from '../services/tool-pruning.js';
import {
  age,
  type FormatContext,
  pendingNote,
  queuedNote,
  reportsTo,
  STATE_LABEL,
  shortId,
  waitsInMergeQueue,
} from './format-task-line.js';

/** The agent's structured result (`ut task done --result`), in order, for `ut task show`. */
function resultLines(task: Pick<TaskRecord, 'result' | 'resultMismatch'>): string[] {
  const result = task.result;
  const lines: string[] = [];
  if (result) {
    lines.push(`  outcome:  ${result.outcome}`);
    for (const file of result.files) lines.push(`  touched:  ${file.path}: ${file.why}`);
    for (const test of result.tests) lines.push(`  test:     ${testLine(test)}`);
    for (const risk of result.risks) lines.push(`  known risk: ${risk}`);
    for (const next of result.followUps) lines.push(`  follow-up: ${next}`);
    for (const m of result.measurements ?? []) lines.push(`  measured: ${measurementLine(m)}`);
  }
  if (task.resultMismatch) lines.push(`  mismatch: ${task.resultMismatch}`);
  return lines;
}

/** What `ut task status` adds from the server: the agent's live state and pending OKs. */
export interface TaskStatusExtras {
  live?: { status?: string; progress?: TaskProgressMark; stall?: TaskStall };
  confirmations?: TaskConfirmation[];
  /** Its start context and pruned tools (tool-pruning.ts, 2026-11-03). */
  tools?: TaskToolsInfo;
}

/** "start context 31.2k tokens; went without 2 plugins, 3 MCP servers, 40 skills (by name only)". */
export function toolsLine(tools: TaskToolsInfo): string {
  const parts: string[] = [];
  if (tools.startTokens !== undefined) {
    parts.push(`start context ${(tools.startTokens / 1000).toFixed(1)}k tokens`);
  }
  if (tools.pruned === null) parts.push('every tool loaded');
  else if (tools.pruned) {
    const without = [
      tools.pruned.plugins ? `${tools.pruned.plugins} plugin(s)` : '',
      tools.pruned.mcpServers ? `${tools.pruned.mcpServers} MCP server(s)` : '',
      tools.pruned.claudeAi ? 'claude.ai connectors' : '',
      tools.pruned.skills ? `${tools.pruned.skills} skill(s) by name only` : '',
    ].filter(Boolean);
    parts.push(`pruned: ${without.join(', ')} (ut project tools)`);
  }
  return parts.join('; ');
}

/**
 * "sonnet · fast, router: rename only; real: claude-sonnet-5-5" / "agent's default; real:
 * claude-opus-4-8" (2026-11-08: the real model, read from its transcript, next to the asked one).
 */
export function modelLine(
  task: Pick<TaskRecord, 'model' | 'modelChoice' | 'modelProvider' | 'metrics'>
): string {
  // A provider task (model-providers.ts): "<provider>:<model> (external provider)".
  const model = task.modelProvider
    ? `${task.modelProvider}:${task.model ?? '?'} (external provider)`
    : (task.model ?? "the agent's default");
  const choice = task.modelChoice;
  const level = choice?.tier ? `${choice.tier}, ` : '';
  const asked = choice ? `${model} · ${level}${choice.by}: ${choice.reason}` : model;
  const actual = taskActualModel(task);
  if (!actual) return asked;
  const differs = task.model && !task.modelProvider && !modelMatches(task.model, actual);
  return `${asked}; real: ${actual}${differs ? ' (not the asked model)' : ''}`;
}

export function formatTaskDetail(
  task: TaskRecord,
  context: FormatContext & TaskStatusExtras = {}
): string {
  const now = context.now ?? Date.now();
  const lines = [
    `${task.name}  (${task.id})`,
    `  state:    ${STATE_LABEL[task.state]} since ${task.stateSince} (${age(task.stateSince, now)} ago)`,
    `  agent:    ${task.runner ?? task.agent}${task.sessionId ? `, session ${task.sessionId}` : ''}`,
    `  model:    ${modelLine(task)}`,
    `  reports:  to ${reportsTo(task, context.me)}`,
  ];
  if (context.tools && toolsLine(context.tools))
    lines.push(`  tools:    ${toolsLine(context.tools)}`);
  for (const change of task.agentChanges ?? []) {
    lines.push(
      `  changed:  ${change.at} ${change.from.runner}${change.from.model ? ` (${change.from.model})` : ''} → ${change.to.runner}${change.to.model ? ` (${change.to.model})` : ''}, ${change.by === 'auto' ? 'by itself' : 'by the user'}: ${change.reason.slice(0, 160)}`
    );
  }
  if (task.state === 'paused' && task.halt?.offer) {
    lines.push(
      `  offer:    'ut task retry ${task.id.slice(0, 8)} --agent ${task.halt.offer.runner}' goes on with it in the same worktree`
    );
  }
  if (task.urgent && !TASK_FINAL_STATES.includes(task.state)) {
    lines.push('  priority: urgent (ahead in the merge queue and for a check slot)');
  }
  if (context.live) {
    // 2026-11-02: "last activity" was the screen printing (a spinner), 0m ago through 1h40m of
    // waiting on a Monitor. It is the agent's last real progress now, and what it waits on.
    const { status, progress, stall } = context.live;
    lines.push(
      `  live:     ${status ?? 'unknown'}${progress ? `, last progress ${age(progress.at, now)} ago (${PROGRESS_WORDS[progress.by]})` : ''}`
    );
    if (progress?.waitingOn) {
      lines.push(
        `  waiting:  on ${progress.waitingOn.what} since ${progress.waitingOn.since} (${age(progress.waitingOn.since, now)})`
      );
    }
    if (stall) {
      lines.push(
        `  stalled:  no progress since ${stall.progressAt}; told and nudged at ${stall.notedAt}${stall.escalatedAt ? `, still stalled at ${stall.escalatedAt} (its agent time no longer counts)` : ''}`
      );
    }
  }
  // 2026-11-03: its agent kept failing the same way; each nudge and whether it helped.
  const loops = failureNudgesLine(task.failureNudges);
  if (loops) {
    lines.push(`  loops:    ${loops}`);
    for (const nudge of (task.failureNudges ?? []).slice(-5)) {
      lines.push(`            ${failureNudgeLine(nudge)}`);
    }
  }
  if (task.branch) {
    lines.push(`  branch:   ${task.branch} → ${task.baseBranch ?? '?'}`);
  }
  // 2026-11-11: the other open tasks that change its files, and its branch against its base.
  if (!TASK_FINAL_STATES.includes(task.state)) {
    for (const [index, overlap] of (task.overlaps ?? []).entries()) {
      lines.push(`  ${index ? '         ' : 'overlap: '} touches too: ${overlapLine(overlap)}`);
    }
  }
  for (const [index, line] of baseSyncLines(task.baseSync, task.baseBranch).entries()) {
    lines.push(`  ${index ? '         ' : 'base:    '} ${line}`);
  }
  if (task.worktreePath) lines.push(`  folder:   ${task.worktreePath}`);
  else lines.push(`  folder:   ${task.workingDir}`);
  if (task.stats) {
    const { commits, files, insertions, deletions } = task.stats;
    lines.push(`  changes:  ${commits} commit(s), ${files} file(s), +${insertions} -${deletions}`);
  }
  if (task.files.length) {
    lines.push(
      `  files:    ${task.files.slice(0, 15).join(', ')}${task.files.length > 15 ? `, … (${task.files.length})` : ''}`
    );
  }
  if (task.summary) lines.push(`  summary:  ${task.summary}`);
  if (task.report?.verified) lines.push(`  verified: ${task.report.verified}`);
  if (task.report?.undo) lines.push(`  undo:     ${task.report.undo}`);
  lines.push(...resultLines(task));
  if (task.blocker) {
    lines.push(`  blocker:  ${task.blocker.kind}: ${task.blocker.message}`);
    for (const detail of task.blocker.detail ?? []) lines.push(`            ${detail}`);
    // What its agent's own prompt asks, and how to answer it from here (2026-11-10).
    if (task.blocker.prompt && task.state === 'needs_you') {
      const [first, ...rest] = promptLines(task.blocker.prompt, shortId(task.id));
      lines.push(`  prompt:   ${first}`);
      for (const more of rest) lines.push(`            ${more}`);
    } else if (task.blocker.fromPrompt && task.state === 'needs_you') {
      lines.push(
        `  prompt:   not read yet; 'ut task answer ${shortId(task.id)} approve | deny | <number> | --text "…"' answers it`
      );
    }
  }
  if (task.autoFix) {
    lines.push(
      `  autofix:  Untether is fixing it by itself (attempt ${task.autoFix.attempts} of ${task.autoFix.max}, ${task.autoFix.reason}): nothing to do`
    );
  }
  if (task.reviewRetryAt) {
    lines.push(`  review:   unavailable; Untether tries it again at ${task.reviewRetryAt}`);
  }
  if (task.zones?.length) lines.push(`  zone:     ${task.zones.join(', ')}`);
  if (task.after?.length && !TASK_FINAL_STATES.includes(task.state)) {
    lines.push(`  after:    ${task.after.map(shortId).join(', ')}`);
  }
  if (task.state === 'queued') lines.push(`  queue:    ${queuedNote(task)}`);
  if (task.baseWait && task.state === 'ready') {
    lines.push(
      `  waiting:  since ${task.baseWait.since} for ${task.baseBranch ?? 'the base'} to be clean; Untether merges it by itself then: nothing to do`
    );
  }
  for (const risk of task.risk ?? []) {
    lines.push(`  risk:     ${risk.rule}: ${risk.file}${risk.detail ? ` (${risk.detail})` : ''}`);
  }
  if (task.review) {
    const { verdict, summary, reason, issues } = task.review;
    lines.push(
      `  review:   ${verdict}${summary ? `: ${summary}` : ''}${reason ? ` (${reason})` : ''}`
    );
    if (task.blocker?.kind !== 'review') {
      for (const issue of issues) lines.push(`            ${reviewIssueLine(issue)}`);
    }
    const { model, crossReview, fallback } = task.review;
    lines.push(
      `            by ${model}${crossReview ? ' (cross review)' : ''}${fallback ? `; cross reviewer unavailable: ${fallback}` : ''}`
    );
  }
  if (task.reviewStats) {
    const per = Object.entries(task.reviewStats.byAgent)
      .map(
        ([agent, t]) =>
          `${agent} ${t.rounds} round(s), ${t.findings} finding(s): ${t.fixed} fixed, ${t.rejected} rejected`
      )
      .join('; ');
    lines.push(`  reviews:  ${task.reviewStats.rounds} round(s)${per ? ` · ${per}` : ''}`);
  }
  if (waitsInMergeQueue(task) && task.mergeQueue) {
    lines.push(`  merge:    ${mergeQueueLine(task)}`);
  }
  if (task.verify) {
    const { command, exitCode, queued, cancelled } = task.verify;
    const result = cancelled
      ? 'stopped (the AI review found problems first; it runs again on the next commit)'
      : queued
        ? 'queued'
        : exitCode === undefined
          ? 'running'
          : exitCode === 0
            ? task.verify.reused
              ? `passed (reused: the same tree passed ${task.verify.reused.at}, not run again)`
              : 'passed'
            : `failed (${exitCode})`;
    lines.push(`  check:    ${command} — ${result}`);
    const level = checkLevelLine(task.verify);
    if (level) lines.push(`  level:    ${level}`);
    const { load, firstRunLoad, flakyUnderLoad } = task.verify;
    if (load?.samples) {
      lines.push(
        `  load:     peak ${load.peak}, mean ${load.mean} (threshold ${load.threshold})${firstRunLoad !== undefined ? ` · first run failed under a load of ${firstRunLoad}, run again` : ''}`
      );
    }
    if (flakyUnderLoad) {
      lines.push(
        `  flaky:    under load, passed on the rerun: ${flakyUnderLoad.length ? flakyUnderLoad.join('; ') : 'no test named'} (ut doctor lists them per project)`
      );
    }
  }
  lines.push(...formatTimings(task, now));
  if (task.budget) lines.push(`  budget:   ${formatBudget(task.budget)}`);
  if (task.metrics) {
    const { usage, quality, savings } = task.metrics;
    if (usage) lines.push(`  usage:    ${usageLine(usage)}`);
    lines.push(`  quality:  ${qualityLine(quality)}`);
    lines.push(`  savings:  ${savingsLine(savings)}`);
    if (task.metrics.conflicts) lines.push(`  shared:   ${conflictsLine(task.metrics.conflicts)}`);
  }
  if (task.mergedSha) lines.push(`  merged:   ${task.mergedSha}`);
  if (task.revertedBy) lines.push(`  undone:   by task ${shortId(task.revertedBy)}`);
  if (task.revertOf) lines.push(`  undoes:   task ${shortId(task.revertOf.taskId)}`);
  if (task.followUps.length)
    lines.push(`  messages: ${task.followUps.length} sent after the prompt`);
  if (task.pendingInput?.length) lines.push(`  waiting:  ${pendingNote(task)}`);
  for (const confirmation of context.confirmations ?? []) {
    lines.push(
      `  pending:  the user's OK on the phone for "${confirmation.summary}" (confirmation ${shortId(confirmation.id)})`
    );
  }
  return lines.join('\n');
}

/**
 * "wall 1h 10m/3h · agent 40m/2h · rounds 2/6 · tokens 31M/100M (warned: tokens)" (2026-11-01):
 * spent / limit, and what was warned or cut.
 */
export function formatBudget(budget: TaskBudget): string {
  const notes = [
    ...(budget.cut ? [`stopped at ${budget.cut.keys.join(', ')}`] : []),
    ...(budget.warned?.length && !budget.cut ? [`warned: ${budget.warned.join(', ')}`] : []),
  ];
  return `${budgetLine(budget)}${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

/**
 * Where the time went (TaskRecord.timings): each phase's total, then each round's phases in
 * order. The check and the review run together, so they may add up to more than the wall time.
 */
export function formatTimings(task: TaskRecord, now = Date.now()): string[] {
  const summary = summarizeTimings(task.timings, now);
  // Its check runs: made, reused (the same tree had passed) and failed by the Mac's load.
  const checks = task.metrics?.checks ? checksLine(task.metrics.checks) : '';
  if (!summary) return checks ? [`  time:     ${checks}`] : [];
  const totals = summary.phases
    .map(
      (p) =>
        `${PHASE_LABEL[p.phase]} ${formatPhaseDuration(p.ms)}${p.count > 1 ? ` (×${p.count})` : ''}`
    )
    .join(', ');
  const lines = [
    `  time:     ${totals}; ${summary.rounds} round${summary.rounds === 1 ? '' : 's'}, ${formatPhaseDuration(summary.wallMs)} in all${checks ? `; ${checks}` : ''}`,
  ];
  for (let round = 1; round <= summary.rounds; round++) {
    const phases = (task.timings ?? []).filter((t) => t.round === round);
    if (!phases.length) continue;
    const text = phases
      .map((t) => {
        const ms = timingMs(t, now);
        const took = ms === null ? '?' : formatPhaseDuration(ms);
        const label = t.level ? `${PHASE_LABEL[t.phase]} [${t.level}]` : PHASE_LABEL[t.phase];
        return `${label} ${t.finishedAt ? took : `${took} so far`}${t.outcome ? ` (${t.outcome})` : ''}`;
      })
      .join(', ');
    lines.push(`            round ${round}: ${text}`);
  }
  return lines;
}

/**
 * Which check ran (two-level projects, 2026-11-02): "related tests of 3 files" / "whole check
 * (package.json reaches tests no import shows)" / "whole check of the merge batch"; with its
 * duration when it finished.
 */
export function checkLevelLine(verify: TaskRecord['verify']): string | null {
  if (!verify?.level) return null;
  const text =
    verify.level === 'related'
      ? `related tests only${verify.relatedFiles !== undefined ? ` (of ${verify.relatedFiles} changed file${verify.relatedFiles === 1 ? '' : 's'})` : ''}; the whole check runs on the merge batch`
      : verify.level === 'batch'
        ? 'whole check of the merge batch'
        : `whole check${verify.fullReason ? ` (${verify.fullReason})` : ''}`;
  const ms =
    verify.finishedAt && !verify.queued
      ? Date.parse(verify.finishedAt) - Date.parse(verify.startedAt)
      : Number.NaN;
  return Number.isFinite(ms) && ms >= 0 ? `${text}, ${formatPhaseDuration(ms)}` : text;
}

/** "2nd in bakery's merge queue (1 ahead, ...)". */
export function mergeQueueLine(task: TaskRecord): string {
  const spot = task.mergeQueue;
  if (!spot) return '';
  const n = spot.position;
  const suffix =
    n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  const project = task.repoPath ? path.basename(task.repoPath) : 'its project';
  const ahead = n - 1;
  return `${n}${suffix} in ${project}'s merge queue (${ahead} ahead, ${spot.of} in line${spot.priority === 'urgent' ? ', urgent' : spot.priority === 'user' ? ', put first by the user' : ''}); its check runs at its turn, on ${task.baseBranch ?? 'the base'} as it is then`;
}

const PHASE_LABEL: Record<TaskPhase, string> = {
  queue: 'queued',
  'merge-queue': 'merge queue',
  verify: 'check',
  review: 'AI review',
  'risk-review': 'risk review',
  fix: 'agent fixing',
  conflict: 'agent on a conflict',
  merge: 'merge',
};
