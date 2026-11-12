/**
 * What a task cost and how good its work was (2026-11-03), so the token-saving features of task
 * agents (usage-based tool pruning, summarised test output, failure-loop nudges) can be weighed
 * against the quality of the work they produce.
 *
 *  Usage, read from the agent's own transcript or rollout (server/services/agent-usage.ts):
 *    tokens by kind (input, cache write, cache read, output), a weighted cost
 *    (COST_WEIGHTS, the one place they live), model calls, the largest context and compactions.
 *  Quality, seen on the task as it goes (observeQuality): whether its first check passed, its
 *    automatic fix rounds, the AI review's verdict on its first review, the risk rules it hit,
 *    whether it was undone later or thrown away.
 *  Features: which saving features were on for it, with their version, or that it was one of
 *    the project's holdout tasks run without any (shared/saving-features.ts).
 *
 * Shared by the server (scheduler, ledger, guard) and the CLI.
 */
import type { TaskRecord } from './tasks.js';

/**
 * The weighted cost of a task's tokens: an input token counts 1, a cache write 1.25, a cache
 * read 0.1 and an output token 5 (roughly the providers' price ratios). Changing them changes
 * every comparison: they live here only.
 */
export const COST_WEIGHTS = {
  input: 1,
  cacheWrite: 1.25,
  cacheRead: 0.1,
  output: 5,
} as const;

/** Tokens of one model, for per-model cost (model-providers.ts). */
export interface ModelTokens {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface AgentUsage {
  /** Input tokens not read from a cache. */
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** Model calls (Claude: assistant messages; Codex: token_count events with usage). */
  turns: number;
  /** The largest context of one call: its input, cache writes and cache reads together. */
  maxContext: number;
  compactions: number;
  /**
   * Tokens by the model that produced them (Claude's `message.model`), for per-model cost: a
   * session that switches model with `/model`, or uses a cheaper internal model, is billed at
   * each model's own rate (model-provider cost). Absent when the agent/transcript gives no model.
   */
  byModel?: Record<string, ModelTokens>;
  /**
   * The model of its newest message (Claude's `message.model`, Codex's turn_context) and that
   * message's time (2026-11-08, agent-models.ts): the model the agent really runs with now.
   */
  lastModel?: { model: string; at: string };
}

export function emptyUsage(): AgentUsage {
  return {
    input: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    turns: 0,
    maxContext: 0,
    compactions: 0,
  };
}

/** Tokens processed, every kind together (what the budget's token limit counts). */
export function usageTokens(usage: AgentUsage): number {
  return usage.input + usage.cacheWrite + usage.cacheRead + usage.output;
}

/** COST_WEIGHTS applied: one number to compare tasks by, in "input-token equivalents". */
export function weightedCost(usage: AgentUsage): number {
  return Math.round(
    usage.input * COST_WEIGHTS.input +
      usage.cacheWrite * COST_WEIGHTS.cacheWrite +
      usage.cacheRead * COST_WEIGHTS.cacheRead +
      usage.output * COST_WEIGHTS.output
  );
}

/** Several conversations of one task together (sums; the largest context is the largest). */
export function sumUsage(parts: Iterable<AgentUsage>): AgentUsage {
  const total = emptyUsage();
  let byModel: Record<string, ModelTokens> | undefined;
  for (const part of parts) {
    total.input += part.input;
    total.cacheWrite += part.cacheWrite;
    total.cacheRead += part.cacheRead;
    total.output += part.output;
    total.turns += part.turns;
    total.compactions += part.compactions;
    total.maxContext = Math.max(total.maxContext, part.maxContext);
    for (const [model, tokens] of Object.entries(part.byModel ?? {})) {
      byModel ??= {};
      byModel[model] ??= { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
      const into = byModel[model];
      into.input += tokens.input;
      into.cacheWrite += tokens.cacheWrite;
      into.cacheRead += tokens.cacheRead;
      into.output += tokens.output;
    }
    if (part.lastModel && (!total.lastModel || part.lastModel.at >= total.lastModel.at)) {
      total.lastModel = part.lastModel;
    }
  }
  if (byModel) total.byModel = byModel;
  return total;
}

/** The quality signals of a task, each set once when first seen (observeQuality). */
export interface TaskQuality {
  /** Its first finished check (not one stopped by the review, nor one cut by a low disk). */
  firstCheck?: { passed: boolean; at: string };
  /** Automatic fix rounds, every reason together. */
  autoFixRounds: number;
  /** The AI review's verdict the first time it read the task (not carried, not unavailable). */
  firstReview?: { verdict: 'ok' | 'concerns'; at: string };
  /**
   * The lines its change added and removed when it was first known (2026-11-11): tasks are
   * compared within changes of a like size (saving-features.ts sizeBucket), a big change
   * failing its first review more whatever it ran with.
   */
  lines?: number;
  /** The risk rules its changes hit (task-risk.ts), each once. */
  riskRules: string[];
  /** A revert task was made for it after it merged ("Deshacer"). */
  reverted?: boolean;
  /** Thrown away. */
  discarded?: boolean;
}

/** The saving features a task ran with (shared/saving-features.ts). */
export interface TaskSavings {
  /** Feature id → its version, for each feature that was on. */
  on: Record<string, number>;
  /** One of the project's holdout tasks: run without any feature, to keep a baseline. */
  holdout?: boolean;
}

/**
 * How much a task ran into its project's other tasks (2026-11-11, task-scheduler-overlap.ts):
 * what it shared with them while it worked, what Untether did about it and what it still cost
 * at the merge. Kept in the ledger, so conflict rounds can be compared over time.
 */
export interface TaskConflictMetrics {
  /** Each other task that changed files it changed too, with how many, when first seen. */
  overlaps: { taskId: string; files: number; at: string }[];
  /** The base merged into its branch by Untether while its agent worked (clean merges). */
  baseSyncs: number;
  /** Conflicts with the base told to its agent while it worked (before it finished). */
  earlyConflicts: number;
  /** Conflict rounds at the merge: the pipeline handed a conflict back to its agent. */
  conflictRounds: number;
}

export function conflictMetrics(metrics: TaskMetrics): TaskConflictMetrics {
  metrics.conflicts ??= { overlaps: [], baseSyncs: 0, earlyConflicts: 0, conflictRounds: 0 };
  return metrics.conflicts;
}

/** "overlapped 2 task(s) · base merged in 1× while working · 1 conflict told early · 0 conflict round(s) at the merge". */
export function conflictsLine(conflicts: TaskConflictMetrics): string {
  return [
    `overlapped ${conflicts.overlaps.length} task(s)`,
    `base merged in ${conflicts.baseSyncs}× while working`,
    `${conflicts.earlyConflicts} conflict(s) told early`,
    `${conflicts.conflictRounds} conflict round(s) at the merge`,
  ].join(' · ');
}

/**
 * A task's check runs (2026-11-11, check-results.ts): how many were made, how many were not
 * because the same tree had passed already, and how many failed by the Mac's load. Kept in the
 * ledger, so what to cut next is decided on numbers.
 */
export interface TaskCheckMetrics {
  /** Runs made: Untether's (verification, merge queue, batch) and its agent's heavy ones. */
  runs: number;
  /** The time those runs took. */
  runMs: number;
  /** Of `runs`, the heavy ones its agent started itself (through a check slot). */
  agentRuns: number;
  /** Runs not made: the same command had passed on the same tree and lockfiles. */
  reused: number;
  /** The time the reused runs had taken when they were made. */
  savedMs: number;
  /** Of Untether's runs, the ones that failed with the Mac over its load threshold. */
  loadFailed: number;
}

export function checkMetrics(metrics: TaskMetrics): TaskCheckMetrics {
  metrics.checks ??= { runs: 0, runMs: 0, agentRuns: 0, reused: 0, savedMs: 0, loadFailed: 0 };
  return metrics.checks;
}

const shortDuration = (ms: number): string => {
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec}s`;
  const min = Math.round(sec / 60);
  return min < 90 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
};

/** "3 check runs (1 by its agent, 9m), 2 reused (saved 6m), 1 failed by load". */
export function checksLine(checks: TaskCheckMetrics): string {
  return [
    `${checks.runs} check run${checks.runs === 1 ? '' : 's'}${
      checks.runs
        ? ` (${checks.agentRuns ? `${checks.agentRuns} by its agent, ` : ''}${shortDuration(checks.runMs)})`
        : ''
    }`,
    `${checks.reused} reused${checks.reused ? ` (saved ${shortDuration(checks.savedMs)})` : ''}`,
    `${checks.loadFailed} failed by load`,
  ].join(', ');
}

/** Several tasks' check runs together (`ut project stats`). */
export function sumCheckMetrics(list: readonly (TaskCheckMetrics | undefined)[]): {
  tasks: number;
  checks: TaskCheckMetrics;
} {
  const checks: TaskCheckMetrics = {
    runs: 0,
    runMs: 0,
    agentRuns: 0,
    reused: 0,
    savedMs: 0,
    loadFailed: 0,
  };
  let tasks = 0;
  for (const item of list) {
    if (!item) continue;
    tasks++;
    checks.runs += item.runs;
    checks.runMs += item.runMs;
    checks.agentRuns += item.agentRuns;
    checks.reused += item.reused;
    checks.savedMs += item.savedMs;
    checks.loadFailed += item.loadFailed;
  }
  return { tasks, checks };
}

export interface TaskMetrics {
  /** The project (its main checkout) whose ledger it goes to, resolved when it was made. */
  project?: string;
  savings: TaskSavings;
  quality: TaskQuality;
  /** Its agent's usage per conversation file (a task may have several: reopened, handed over). */
  usageBy?: Record<string, AgentUsage>;
  /** Every file's usage together. */
  usage?: AgentUsage;
  /** weightedCost(usage). */
  cost?: number;
  /** Absent while it never shared a file with another task nor met a conflict. */
  conflicts?: TaskConflictMetrics;
  /** Absent while no check of it ran nor was reused. */
  checks?: TaskCheckMetrics;
}

export function newTaskMetrics(savings: TaskSavings): TaskMetrics {
  return { savings, quality: { autoFixRounds: 0, riskRules: [] } };
}

/** The file usage read now replaces what was known of those files; the totals follow. */
export function applyUsage(metrics: TaskMetrics, byFile: Record<string, AgentUsage>): void {
  metrics.usageBy = { ...(metrics.usageBy ?? {}), ...byFile };
  metrics.usage = sumUsage(Object.values(metrics.usageBy));
  metrics.cost = weightedCost(metrics.usage);
}

type QualitySource = Pick<
  TaskRecord,
  'state' | 'verify' | 'review' | 'risk' | 'autoFixes' | 'revertedBy' | 'metrics' | 'stats'
>;

/**
 * Records what the task shows now that was not seen yet: its first check's result, its first
 * review's verdict, risk rules, fix rounds, an undo, a discard. True when something changed.
 * Called on every save, so each first result is caught before a later round replaces it.
 */
export function observeQuality(task: QualitySource, now: number): boolean {
  const metrics = task.metrics;
  if (!metrics) return false;
  const quality = metrics.quality;
  let changed = false;
  const at = new Date(now).toISOString();
  const verify = task.verify;
  if (
    !quality.firstCheck &&
    verify?.finishedAt &&
    !verify.queued &&
    !verify.cancelled &&
    !verify.diskLow &&
    typeof verify.exitCode === 'number'
  ) {
    quality.firstCheck = { passed: verify.exitCode === 0, at };
    changed = true;
  }
  const review = task.review;
  if (
    !quality.firstReview &&
    review &&
    !review.carriedFrom &&
    (review.verdict === 'ok' || review.verdict === 'concerns')
  ) {
    quality.firstReview = { verdict: review.verdict, at };
    changed = true;
  }
  if (quality.lines === undefined && task.stats && task.stats.commits > 0) {
    quality.lines = task.stats.insertions + task.stats.deletions;
    changed = true;
  }
  for (const risk of task.risk ?? []) {
    if (!quality.riskRules.includes(risk.rule)) {
      quality.riskRules.push(risk.rule);
      changed = true;
    }
  }
  const rounds = Object.values(task.autoFixes ?? {}).reduce<number>((n, c) => n + (c ?? 0), 0);
  if (rounds > quality.autoFixRounds) {
    quality.autoFixRounds = rounds;
    changed = true;
  }
  if (task.revertedBy && !quality.reverted) {
    quality.reverted = true;
    changed = true;
  }
  if (task.state === 'discarded' && !quality.discarded) {
    quality.discarded = true;
    changed = true;
  }
  return changed;
}

/** "1.2M", "340k", "812". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** "in 1.2M · cache write 300k · cache read 20M · out 80k · cost 4.1M · 52 turns · …". */
export function usageLine(usage: AgentUsage): string {
  return [
    `in ${formatTokens(usage.input)}`,
    `cache write ${formatTokens(usage.cacheWrite)}`,
    `cache read ${formatTokens(usage.cacheRead)}`,
    `out ${formatTokens(usage.output)}`,
    `weighted cost ${formatTokens(weightedCost(usage))}`,
    `${usage.turns} turn${usage.turns === 1 ? '' : 's'}`,
    `max context ${formatTokens(usage.maxContext)}`,
    `${usage.compactions} compaction${usage.compactions === 1 ? '' : 's'}`,
  ].join(' · ');
}

/** "first check passed · 1 auto-fix round · first review ok · risk: auth · undone". */
export function qualityLine(quality: TaskQuality): string {
  const parts = [
    quality.firstCheck
      ? `first check ${quality.firstCheck.passed ? 'passed' : 'failed'}`
      : 'no check yet',
    `${quality.autoFixRounds} auto-fix round${quality.autoFixRounds === 1 ? '' : 's'}`,
    quality.firstReview ? `first review ${quality.firstReview.verdict}` : 'no review yet',
    quality.riskRules.length ? `risk: ${quality.riskRules.join(', ')}` : 'no risk flags',
  ];
  if (quality.reverted) parts.push('undone later');
  if (quality.discarded) parts.push('discarded');
  return parts.join(' · ');
}

/** "tool-pruning v1, test-summary v1", "holdout (no features)", "none". */
export function savingsLine(savings: TaskSavings): string {
  if (savings.holdout) return 'holdout (run without the saving features, as a baseline)';
  const on = Object.entries(savings.on).map(([id, version]) => `${id} v${version}`);
  return on.length ? on.join(', ') : 'none';
}
