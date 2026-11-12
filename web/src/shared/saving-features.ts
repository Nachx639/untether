/**
 * Token-saving features of task agents and the guard that keeps them honest (2026-11-03).
 *
 * Each feature has an id, a version and its own project setting (SAVING_FEATURES). A task
 * records which ones were on for it when it was made (TaskMetrics.savings): its project's
 * choice, less what the guard turned off, except for a holdout share of tasks (savingHoldoutPct,
 * default 10 %) that run without any, so there is always a baseline to compare with. A
 * feature's code asks taskSavingOn(), so the holdout and the guard really turn it off.
 *
 * Over a project's last tasks (the ledger: server/services/task-metrics-ledger.ts), tasks with
 * a feature are compared with tasks without it (compareFeature): median weighted cost, first
 * check pass rate, first review approval rate, auto-fix rounds. When the quality of tasks with
 * it is clearly worse (savingsVerdict), the guard turns that version of the feature off for the
 * project (ProjectSettings.savingAutoOff) and tells its orchestrator the numbers. A new version
 * of the feature starts over: it is on again and compared afresh.
 *
 * The rule (2026-11-11, rule 2). The first one (15 points lower over 15 tasks with it and 5
 * without) turned loop-nudge off in untether on 61 % of 87 tasks against 80 % of 5: four tasks
 * out of five, a difference that says nothing. Now a rate is clearly worse only when all hold:
 *  - both groups have at least SAVINGS_GUARD.minGroup tasks with that signal (fewer: "not
 *    enough data yet", never a verdict);
 *  - the rate is lower by more than SAVINGS_GUARD.margin (a difference worth acting on);
 *  - the confidence interval of the difference of the two rates (Newcombe's hybrid score
 *    interval, built on Wilson's: it holds on small groups and rates near 0 or 1, where the
 *    textbook ± interval does not) lies wholly below 0. Its level is 99 %, not 95 %: the guard
 *    looks again after every finished task, at two signals of every feature, and looking that
 *    often at 95 % would find a "significant" difference by chance far more than 1 time in 20;
 *  - compared within tasks of a like size (sizeBucket, the lines their change had), the rate is
 *    still lower by more than the margin: big changes fail their first review more whatever
 *    they ran with, so a feature that happened to run on the big ones is not blamed for it.
 * The interval was chosen over a plain "N tasks in each group": a minimum alone still acts on
 * 12 of 20 against 16 of 20, which chance gives often; the interval asks for more tasks the
 * smaller the difference is, and says how unsure the numbers are.
 * The baseline is tasks of the agents that can use the feature only (a Claude-only feature is
 * not compared with Codex tasks). What is left uncontrolled: tasks without a feature that are
 * not holdout ones (it was off then) come from another time, and features that always ran
 * together cannot be told apart (ranTogether says so in the guard's message).
 */
import type { ProjectSettings } from './projects.js';
import {
  checksLine,
  formatTokens,
  type TaskCheckMetrics,
  type TaskMetrics,
  type TaskQuality,
  type TaskSavings,
} from './task-metrics.js';
import type { TaskAgent } from './tasks.js';

export interface SavingFeature {
  id: string;
  /** Raised whenever the feature's behaviour changes: tasks are compared per version. */
  version: number;
  /** What it does, in a few words. */
  label: string;
  /** The project setting that switches it (shown by the report). */
  setting: keyof ProjectSettings;
  /** On for the project by its own setting. */
  enabled: (settings: Partial<ProjectSettings> | undefined) => boolean;
  /** Only tasks of these agents can use it (unset: every agent). */
  agents?: readonly TaskAgent[];
}

/**
 * The features, each with its own project setting. A feature that lands is added here, and its
 * code asks taskSavingOn() instead of reading its setting: the holdout and the guard then hold.
 */
export const SAVING_FEATURES: readonly SavingFeature[] = [
  {
    id: 'tool-pruning',
    version: 1,
    label: 'usage-based tool pruning',
    setting: 'toolPruning',
    enabled: (settings) => settings?.toolPruning === true,
    // Claude task sessions only (tool-pruning.ts).
    agents: ['claude'],
  },
  {
    id: 'test-summary',
    version: 1,
    label: 'summarised test/check output',
    setting: 'summarizeOutput',
    enabled: (settings) => settings?.summarizeOutput === true,
    // Codex is not asked for a PreToolUse rewrite (task-guard-setup.ts).
    agents: ['claude'],
  },
  {
    id: 'loop-nudge',
    version: 1,
    label: 'failure-loop nudges',
    setting: 'failureLoopNudge',
    enabled: (settings) => settings?.failureLoopNudge !== false,
  },
];

/** The share of tasks run without any feature when ProjectSettings.savingHoldoutPct is unset. */
export const SAVINGS_HOLDOUT_PCT_DEFAULT = 10;

/** The comparison and the guard's thresholds: all in one place. */
export const SAVINGS_GUARD = {
  /**
   * The rule's number, kept in what the guard turned off (SavingAutoOff.rule): a feature turned
   * off under an older rule is judged again under this one, and turned on again if it no longer
   * holds. Raise it whenever the rule below changes.
   */
  rule: 2,
  /** Tasks in EACH group (that have the signal) before the guard may judge it. */
  minGroup: 10,
  /** A rate (0..1) lower than the baseline's by more than this is worth acting on. */
  margin: 0.15,
  /** The level of the confidence interval of the difference, and its normal quantile. */
  confidence: 0.99,
  z: 2.5758,
  /**
   * The last tasks of the project the guard looks at. 300, not 100: the baseline of a feature
   * on by default is the holdout tasks alone, 10 % of them, which never reach minGroup in 100.
   */
  window: 300,
  /** Fewer tasks than this in a group: its numbers are labelled a small sample. */
  smallSample: 15,
} as const;

/**
 * Sizes of a change, by the lines it added and removed: tasks are compared within each
 * (adjustedDifference). A task whose size is not known (finished before 2026-11-11) is in a
 * group of its own.
 */
export const SIZE_BUCKETS = [
  { id: 'small', upTo: 50 },
  { id: 'medium', upTo: 300 },
  { id: 'large', upTo: 1000 },
  { id: 'huge', upTo: Number.POSITIVE_INFINITY },
] as const;

export function sizeBucket(lines: number | undefined): string {
  if (lines === undefined) return 'unknown';
  return (SIZE_BUCKETS.find((bucket) => lines <= bucket.upTo) ?? SIZE_BUCKETS[3]).id;
}

/** The guard turned a feature's version off for a project (ProjectSettings.savingAutoOff). */
export interface SavingAutoOff {
  feature: string;
  version: number;
  at: string;
  /** The numbers that turned it off. */
  reason: string;
  /** SAVINGS_GUARD.rule it was judged under; unset: the first rule. */
  rule?: number;
}

export type SavingFeatureState = 'on' | 'off' | 'auto-off';

/** Whether a feature is on for the project: its setting, unless the guard turned it off. */
export function savingFeatureState(
  settings: Partial<ProjectSettings> | undefined,
  feature: SavingFeature
): SavingFeatureState {
  const autoOff = settings?.savingAutoOff?.some(
    (entry) => entry.feature === feature.id && entry.version >= feature.version
  );
  if (autoOff) return 'auto-off';
  return feature.enabled(settings) ? 'on' : 'off';
}

/**
 * The features a new task runs with: those on for its project (and its agent), or none for a
 * holdout task (`random() < savingHoldoutPct / 100`). No feature on: nothing to hold out.
 */
export function assignSavings(
  settings: Partial<ProjectSettings> | undefined,
  agent: TaskAgent,
  random: () => number,
  features: readonly SavingFeature[] = SAVING_FEATURES
): TaskSavings {
  const on = features.filter(
    (feature) =>
      savingFeatureState(settings, feature) === 'on' &&
      (!feature.agents || feature.agents.includes(agent))
  );
  if (!on.length) return { on: {} };
  const pct = settings?.savingHoldoutPct ?? SAVINGS_HOLDOUT_PCT_DEFAULT;
  if (random() < pct / 100) return { on: {}, holdout: true };
  return { on: Object.fromEntries(on.map((feature) => [feature.id, feature.version])) };
}

/**
 * A feature's code: is it on for this task? What the task recorded when it was made (its
 * project's choice, holdout, the guard); a task from before metrics: its project's state now.
 */
export function taskSavingOn(
  task: { metrics?: TaskMetrics },
  id: string,
  settings: Partial<ProjectSettings> | undefined,
  features: readonly SavingFeature[] = SAVING_FEATURES
): boolean {
  if (task.metrics) return task.metrics.savings.on[id] !== undefined;
  const feature = features.find((f) => f.id === id);
  return !!feature && savingFeatureState(settings, feature) === 'on';
}

/** A finished task as the comparison reads it. */
export interface SavingsSample {
  savings: TaskSavings;
  quality: TaskQuality;
  cost?: number;
  /** Its agent: a feature of some agents only is compared among their tasks. */
  agent?: TaskAgent;
  /** The external provider it ran against (model-providers.ts); kept out of the comparison. */
  modelProvider?: string;
  /** Its cost in US dollars, when it ran against a priced provider. */
  usd?: number;
}

export interface SavingsGroupStats {
  tasks: number;
  /** Median weighted cost of the tasks with a usage read; null when none. */
  medianCost: number | null;
  costTasks: number;
  /** First checks passed / tasks whose check ran; null when none ran. */
  firstCheckPassRate: number | null;
  checkPassed: number;
  checkTasks: number;
  /** First reviews ok / tasks reviewed; null when none was. */
  firstReviewOkRate: number | null;
  reviewOk: number;
  reviewTasks: number;
  meanAutoFixRounds: number | null;
  reverted: number;
  /** Fewer than SAVINGS_GUARD.smallSample tasks. */
  small: boolean;
}

export type SavingsSignalId = 'check' | 'review';

const SIGNALS: readonly {
  id: SavingsSignalId;
  label: string;
  /** Whether the task has the signal, and whether it was good. */
  read: (quality: TaskQuality) => boolean | undefined;
}[] = [
  { id: 'check', label: 'first-try check pass rate', read: (q) => q.firstCheck?.passed },
  {
    id: 'review',
    label: 'first-review approval rate',
    read: (q) => (q.firstReview ? q.firstReview.verdict === 'ok' : undefined),
  },
];

export interface RateCount {
  hits: number;
  n: number;
}

/** One quality rate of tasks with the feature against tasks without it, with its uncertainty. */
export interface SavingsSignal {
  signal: SavingsSignalId;
  label: string;
  with: RateCount;
  without: RateCount;
  /**
   * Rate with it less rate without (negative: worse with it) and its confidence interval
   * (SAVINGS_GUARD.confidence); null while either group has no task with the signal.
   */
  difference: { diff: number; low: number; high: number } | null;
  /**
   * The same difference within tasks of a like size (adjustedDifference); null when no size
   * has tasks of both groups: size and feature cannot be told apart.
   */
  adjusted: number | null;
  /** How many of those tasks have a known size. */
  sized: number;
  /**
   * 'insufficient': a group under SAVINGS_GUARD.minGroup, no verdict. 'worse': every condition
   * of the rule holds. 'unclear': neither.
   */
  verdict: 'insufficient' | 'worse' | 'unclear';
}

export interface SavingsComparison {
  feature: string;
  version: number;
  with: SavingsGroupStats;
  without: SavingsGroupStats;
  /** Either group is a small sample: read its numbers as such. */
  small: boolean;
  signals: SavingsSignal[];
}

/** Wilson's score interval of a rate. */
export function wilson({ hits, n }: RateCount, z: number): [number, number] {
  if (!n) return [0, 1];
  const p = hits / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, (centre - half) / (1 + z2 / n)), Math.min(1, (centre + half) / (1 + z2 / n))];
}

/**
 * a's rate less b's with its confidence interval: Newcombe's hybrid score interval (1998,
 * method 10), from each rate's Wilson interval.
 */
export function rateDifference(
  a: RateCount,
  b: RateCount,
  z: number = SAVINGS_GUARD.z
): { diff: number; low: number; high: number } | null {
  if (!a.n || !b.n) return null;
  const pa = a.hits / a.n;
  const pb = b.hits / b.n;
  const [la, ua] = wilson(a, z);
  const [lb, ub] = wilson(b, z);
  const diff = pa - pb;
  return {
    diff,
    low: diff - Math.sqrt((pa - la) ** 2 + (ub - pb) ** 2),
    high: diff + Math.sqrt((ua - pa) ** 2 + (pb - lb) ** 2),
  };
}

/**
 * The difference of the two rates within each stratum (a size of change), the strata weighed
 * as Mantel and Haenszel do (n1·n0/(n1+n0): a stratum counts for as much as its smaller group
 * lets it). Null when no stratum has tasks of both groups.
 */
export function adjustedDifference(
  strata: readonly { with: RateCount; without: RateCount }[]
): number | null {
  let weights = 0;
  let sum = 0;
  for (const { with: a, without: b } of strata) {
    if (!a.n || !b.n) continue;
    const weight = (a.n * b.n) / (a.n + b.n);
    weights += weight;
    sum += weight * (a.hits / a.n - b.hits / b.n);
  }
  return weights ? sum / weights : null;
}

function compareSignal(
  signal: (typeof SIGNALS)[number],
  withIt: readonly SavingsSample[],
  without: readonly SavingsSample[],
  guard: { minGroup: number; margin: number; z: number }
): SavingsSignal {
  const strata = new Map<string, { with: RateCount; without: RateCount }>();
  const total = { with: { hits: 0, n: 0 }, without: { hits: 0, n: 0 } };
  let sized = 0;
  const add = (group: 'with' | 'without', samples: readonly SavingsSample[]) => {
    for (const sample of samples) {
      const good = signal.read(sample.quality);
      if (good === undefined) continue;
      const bucket = sizeBucket(sample.quality.lines);
      if (bucket !== 'unknown') sized++;
      let stratum = strata.get(bucket);
      if (!stratum) {
        stratum = { with: { hits: 0, n: 0 }, without: { hits: 0, n: 0 } };
        strata.set(bucket, stratum);
      }
      for (const count of [stratum[group], total[group]]) {
        count.n++;
        if (good) count.hits++;
      }
    }
  };
  add('with', withIt);
  add('without', without);
  const difference = rateDifference(total.with, total.without, guard.z);
  const adjusted = adjustedDifference([...strata.values()]);
  // A tiny epsilon: 0.45 - 0.6 is -0.15000000000000002, not "more than" 15 points lower.
  const beyond = (diff: number) => -diff > guard.margin + 1e-9;
  const verdict =
    total.with.n < guard.minGroup || total.without.n < guard.minGroup || !difference
      ? 'insufficient'
      : beyond(difference.diff) && difference.high < 0 && adjusted !== null && beyond(adjusted)
        ? 'worse'
        : 'unclear';
  return {
    signal: signal.id,
    label: signal.label,
    with: total.with,
    without: total.without,
    difference,
    adjusted,
    sized,
    verdict,
  };
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function groupStats(samples: readonly SavingsSample[]): SavingsGroupStats {
  const costs = samples.flatMap((s) => (s.cost && s.cost > 0 ? [s.cost] : []));
  const checks = samples.flatMap((s) => (s.quality.firstCheck ? [s.quality.firstCheck] : []));
  const reviews = samples.flatMap((s) => (s.quality.firstReview ? [s.quality.firstReview] : []));
  const rate = (hits: number, of: number) => (of ? hits / of : null);
  const checkPassed = checks.filter((c) => c.passed).length;
  const reviewOk = reviews.filter((r) => r.verdict === 'ok').length;
  return {
    tasks: samples.length,
    medianCost: median(costs),
    costTasks: costs.length,
    firstCheckPassRate: rate(checkPassed, checks.length),
    checkPassed,
    checkTasks: checks.length,
    firstReviewOkRate: rate(reviewOk, reviews.length),
    reviewOk,
    reviewTasks: reviews.length,
    meanAutoFixRounds: samples.length
      ? samples.reduce((sum, s) => sum + s.quality.autoFixRounds, 0) / samples.length
      : null,
    reverted: samples.filter((s) => s.quality.reverted).length,
    small: samples.length < SAVINGS_GUARD.smallSample,
  };
}

/**
 * Tasks with this version of the feature against tasks without the feature at all (holdout
 * tasks, and those of a time or project it was off), among the tasks of the agents that can
 * use it. Tasks with another version of it are in neither group.
 */
export function compareFeature(
  samples: readonly SavingsSample[],
  feature: Pick<SavingFeature, 'id' | 'version' | 'agents'>,
  guard: { minGroup: number; margin: number; z: number } = SAVINGS_GUARD
): SavingsComparison {
  const agents = feature.agents;
  const comparable = agents
    ? samples.filter((s) => s.agent === undefined || agents.includes(s.agent))
    : samples;
  const withIt = comparable.filter((s) => s.savings.on[feature.id] === feature.version);
  const without = comparable.filter((s) => s.savings.on[feature.id] === undefined);
  const a = groupStats(withIt);
  const b = groupStats(without);
  return {
    feature: feature.id,
    version: feature.version,
    with: a,
    without: b,
    small: a.small || b.small,
    signals: SIGNALS.map((signal) => compareSignal(signal, withIt, without, guard)),
  };
}

/**
 * 'worse': a signal meets the whole rule (reasons: its numbers with their uncertainty).
 * 'insufficient': none does and no signal has enough tasks in both groups: no verdict yet.
 */
export type SavingsVerdict =
  | { worse: false; insufficient: boolean }
  | { worse: true; reasons: string[] };

const pct = (rate: number) => `${Math.round(rate * 100)}%`;
const points = (diff: number) => {
  const rounded = Math.round(diff * 100);
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded)}`;
};
const confidencePct = Math.round(SAVINGS_GUARD.confidence * 100);

/**
 * A signal's numbers with their uncertainty: "first-review approval rate 61% with it (53/87)
 * vs 80% without (4/5): −19 points, 99% interval −41 to +34".
 */
export function signalLine(signal: SavingsSignal): string {
  const { with: a, without: b, difference } = signal;
  if (!difference) {
    return `${signal.label}: ${a.n} task(s) with it, ${b.n} without`;
  }
  const size =
    signal.adjusted === null
      ? '; no size of change has tasks of both groups'
      : signal.sized
        ? `; ${points(signal.adjusted)} within changes of a like size (size known for ${signal.sized} of ${a.n + b.n})`
        : '';
  return `${signal.label} ${pct(a.hits / a.n)} with it (${a.hits}/${a.n}) vs ${pct(b.hits / b.n)} without (${b.hits}/${b.n}): ${points(difference.diff)} points, ${confidencePct}% interval ${points(difference.low)} to ${points(difference.high)}${size}`;
}

/** What the guard makes of a signal, for `ut project stats`. */
export function signalVerdictLine(
  signal: SavingsSignal,
  guard: { minGroup: number } = SAVINGS_GUARD
): string {
  if (signal.verdict === 'insufficient') {
    return `${signal.label}: not enough data yet (${signal.with.n} task(s) with it, ${signal.without.n} without; the guard needs ${guard.minGroup} in each)`;
  }
  return `${signalLine(signal)} → ${signal.verdict === 'worse' ? 'clearly worse' : 'not clearly worse'}`;
}

/** Clearly worse: a signal of the comparison meets every condition of the rule (see above). */
export function savingsVerdict(comparison: SavingsComparison): SavingsVerdict {
  const worse = comparison.signals.filter((signal) => signal.verdict === 'worse');
  if (worse.length) return { worse: true, reasons: worse.map(signalLine) };
  return {
    worse: false,
    insufficient: comparison.signals.every((signal) => signal.verdict === 'insufficient'),
  };
}

/**
 * The other features that were on in nearly every task this one ran in (9 in 10): the
 * comparison cannot tell which of them the difference comes from.
 */
export function ranTogether(
  samples: readonly SavingsSample[],
  feature: Pick<SavingFeature, 'id' | 'version'>
): string[] {
  const withIt = samples.filter((s) => s.savings.on[feature.id] === feature.version);
  if (!withIt.length) return [];
  const counts = new Map<string, number>();
  for (const sample of withIt) {
    for (const id of Object.keys(sample.savings.on)) {
      if (id !== feature.id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts]
    .filter(([, count]) => count >= withIt.length * 0.9)
    .map(([id]) => id)
    .sort();
}

const num = (value: number | null, digits = 0) => (value === null ? '–' : value.toFixed(digits));

/** One group's numbers in a line ("23 tasks · median cost 4.1M · check 87% (23) · …"). */
export function groupLine(stats: SavingsGroupStats, formatCost: (n: number) => string): string {
  return [
    `${stats.tasks} task${stats.tasks === 1 ? '' : 's'}${stats.small ? ' (small sample)' : ''}`,
    `median cost ${stats.medianCost === null ? '–' : formatCost(stats.medianCost)}`,
    `first-try check ${stats.firstCheckPassRate === null ? '–' : pct(stats.firstCheckPassRate)} (${stats.checkTasks})`,
    `first review ok ${stats.firstReviewOkRate === null ? '–' : pct(stats.firstReviewOkRate)} (${stats.reviewTasks})`,
    `auto-fix rounds ${num(stats.meanAutoFixRounds, 2)}`,
    ...(stats.reverted ? [`${stats.reverted} undone`] : []),
  ].join(' · ');
}

/** `ut project stats`: one feature's state and comparison. */
export interface SavingsFeatureReport {
  id: string;
  version: number;
  label: string;
  /** Its project setting. */
  setting: string;
  state: SavingFeatureState;
  /** The guard turned it off: when and why. */
  autoOff?: SavingAutoOff;
  comparison: SavingsComparison;
}

export interface SavingsReport {
  repoPath: string;
  /** The last tasks looked at, how many there were and how many were holdout. */
  window: number;
  tasks: number;
  holdout: number;
  holdoutPct: number;
  all: SavingsGroupStats;
  features: SavingsFeatureReport[];
  guard: { minGroup: number; marginPct: number; confidencePct: number };
  /**
   * Tasks that ran against an external provider (model-providers.ts), counted apart: their
   * token behaviour is the provider's, so they are left out of the saving-feature comparison.
   * `usd` is the total cost of the priced ones.
   */
  providers?: { tasks: number; priced: number; usd: number };
  /**
   * The check runs of those tasks together (2026-11-11, check-results.ts): `tasks` is how many
   * of them have the count (tasks finished before it existed have none).
   */
  checks?: { tasks: number; checks: TaskCheckMetrics };
}

/** The report as text (`ut project stats`). */
export function formatSavingsReport(report: SavingsReport): string {
  const cost = formatTokens;
  const lines = [
    `Saving features over the last ${report.tasks} finished task(s) of ${report.repoPath} (window ${report.window}; holdout ${report.holdout}, ${report.holdoutPct}% of new tasks)`,
    `  all:      ${groupLine(report.all, cost)}`,
  ];
  for (const feature of report.features) {
    const state =
      feature.state === 'auto-off'
        ? `turned off by the guard ${feature.autoOff?.at ?? ''}: ${feature.autoOff?.reason ?? ''}`
        : feature.state === 'off'
          ? `off for this project (${feature.setting})`
          : `on (${feature.setting})`;
    lines.push(`  ${feature.id} v${feature.version} (${feature.label}): ${state}`);
    const { with: w, without, small } = feature.comparison;
    lines.push(`    with:    ${groupLine(w, cost)}`);
    lines.push(`    without: ${groupLine(without, cost)}`);
    if (small) lines.push('    small sample: read these numbers with care');
    for (const signal of feature.comparison.signals) {
      lines.push(`    guard:   ${signalVerdictLine(signal, report.guard)}`);
    }
  }
  if (report.providers?.tasks) {
    const { tasks, priced, usd } = report.providers;
    const money = priced ? `, ${priced} priced at $${usd.toFixed(2)} in all` : '';
    lines.push(
      `  providers: ${tasks} task(s) ran against an external model provider${money} (left out of the comparison above)`
    );
  }
  if (report.checks?.tasks) {
    const { tasks, checks } = report.checks;
    const total = checks.runs + checks.reused;
    lines.push(
      `  checks:   ${checksLine(checks)} over ${tasks} task(s)${total ? `; ${Math.round((checks.reused / total) * 100)}% of the checks asked for were not run again` : ''}`
    );
  }
  lines.push(
    `  guard: a feature goes off when its first-try check or first-review rate is more than ${report.guard.marginPct} points below the baseline's, also within changes of a like size, with the ${report.guard.confidencePct}% confidence interval of the difference wholly below 0 and at least ${report.guard.minGroup} tasks in each group; with fewer it says "not enough data yet" and turns nothing off`
  );
  return lines.join('\n');
}
