/**
 * Task metrics and the saving features' guard (2026-11-03): the weighted cost, the quality
 * signals, the with/without comparison and the rule that turns a feature off.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectSettings } from './projects.js';
import {
  assignSavings,
  compareFeature,
  formatSavingsReport,
  groupStats,
  median,
  ranTogether,
  rateDifference,
  SAVING_FEATURES,
  SAVINGS_GUARD,
  type SavingFeature,
  type SavingsSample,
  savingFeatureState,
  savingsVerdict,
  signalVerdictLine,
  sizeBucket,
  taskSavingOn,
  wilson,
} from './saving-features.js';
import {
  applyUsage,
  COST_WEIGHTS,
  emptyUsage,
  newTaskMetrics,
  observeQuality,
  sumUsage,
  type TaskQuality,
  type TaskSavings,
  usageTokens,
  weightedCost,
} from './task-metrics.js';
import type { TaskRecord } from './tasks.js';

/** A feature switched by a default-on setting, as failure-loop nudges are. */
const feature: SavingFeature = {
  id: 'tool-pruning',
  version: 2,
  label: 'pruning',
  setting: 'failureLoopNudge',
  enabled: (settings) => settings?.failureLoopNudge !== false,
};

/** `n` samples: `passed` of them passed their first check, `ok` were approved first. */
function samples(
  n: number,
  {
    on,
    passed,
    ok,
    cost = 1000,
    lines,
  }: { on: boolean; passed: number; ok: number; cost?: number; lines?: number }
): SavingsSample[] {
  return Array.from({ length: n }, (_, i) => {
    const quality: TaskQuality = {
      autoFixRounds: i < n - passed ? 1 : 0,
      riskRules: [],
      firstCheck: { passed: i < passed, at: 'x' },
      firstReview: { verdict: i < ok ? 'ok' : 'concerns', at: 'x' },
      ...(lines !== undefined ? { lines } : {}),
    };
    return {
      savings: (on ? { on: { 'tool-pruning': 2 } } : { on: {}, holdout: true }) as TaskSavings,
      quality,
      cost,
    };
  });
}

describe('weighted cost', () => {
  it('weighs input 1, cache write 1.25, cache read 0.1, output 5', () => {
    expect(COST_WEIGHTS).toEqual({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
    const usage = {
      ...emptyUsage(),
      input: 1000,
      cacheWrite: 400,
      cacheRead: 20_000,
      output: 300,
    };
    // 1000 + 500 + 2000 + 1500
    expect(weightedCost(usage)).toBe(5000);
    expect(usageTokens(usage)).toBe(21_700);
    expect(weightedCost(emptyUsage())).toBe(0);
  });

  it('adds conversations: sums, the largest context stays the largest', () => {
    const a = {
      input: 1,
      cacheWrite: 2,
      cacheRead: 3,
      output: 4,
      turns: 5,
      maxContext: 90,
      compactions: 1,
    };
    const b = {
      input: 10,
      cacheWrite: 20,
      cacheRead: 30,
      output: 40,
      turns: 2,
      maxContext: 60,
      compactions: 0,
    };
    expect(sumUsage([a, b])).toEqual({
      input: 11,
      cacheWrite: 22,
      cacheRead: 33,
      output: 44,
      turns: 7,
      maxContext: 90,
      compactions: 1,
    });
    const metrics = newTaskMetrics({ on: {} });
    applyUsage(metrics, { '/a.jsonl': a });
    applyUsage(metrics, { '/b.jsonl': b });
    // A file read again replaces what was known of it.
    applyUsage(metrics, { '/a.jsonl': { ...a, output: 14 } });
    expect(metrics.usage?.output).toBe(54);
    expect(metrics.cost).toBe(weightedCost(metrics.usage as typeof a));
  });
});

describe('quality signals', () => {
  it('keeps the first check and the first review, counts rounds, risks, undo and discard', () => {
    const task = {
      state: 'verifying',
      metrics: newTaskMetrics({ on: {} }),
    } as Partial<TaskRecord> as TaskRecord;
    // A check still running, one stopped by the review, one cut by a low disk: not a result.
    task.verify = { command: 'c', cwd: '/', startedAt: 'x' };
    task.review = { verdict: 'unavailable', summary: '', issues: [], at: 'x', model: 'm' };
    expect(observeQuality(task, 0)).toBe(false);
    task.verify = {
      command: 'c',
      cwd: '/',
      startedAt: 'x',
      finishedAt: 'y',
      exitCode: 1,
      cancelled: true,
    };
    expect(observeQuality(task, 0)).toBe(false);
    task.verify = {
      command: 'c',
      cwd: '/',
      startedAt: 'x',
      finishedAt: 'y',
      exitCode: 1,
      diskLow: {},
    };
    expect(observeQuality(task, 0)).toBe(false);
    task.verify = { command: 'c', cwd: '/', startedAt: 'x', finishedAt: 'y', exitCode: 1 };
    task.review = { verdict: 'concerns', summary: '', issues: [], at: 'x', model: 'm' };
    task.risk = [{ rule: 'auth', file: 'a.ts' }];
    task.autoFixes = { verify: 1 };
    expect(observeQuality(task, 0)).toBe(true);
    // The later rounds pass: the first ones stay.
    task.verify = { ...task.verify, exitCode: 0 };
    task.review = { ...task.review, verdict: 'ok' };
    task.risk = [
      { rule: 'auth', file: 'b.ts' },
      { rule: 'ci', file: '.github/x.yml' },
    ];
    task.autoFixes = { verify: 1, review: 1 };
    task.state = 'merged';
    task.revertedBy = 'r1';
    observeQuality(task, 0);
    expect(task.metrics?.quality).toMatchObject({
      firstCheck: { passed: false },
      firstReview: { verdict: 'concerns' },
      riskRules: ['auth', 'ci'],
      autoFixRounds: 2,
      reverted: true,
    });
    task.state = 'discarded';
    observeQuality(task, 0);
    expect(task.metrics?.quality.discarded).toBe(true);
    expect(observeQuality(task, 0)).toBe(false);
  });

  it('a review carried over from an earlier commit is not a first review', () => {
    const task = { state: 'verifying', metrics: newTaskMetrics({ on: {} }) } as TaskRecord;
    task.review = {
      verdict: 'ok',
      summary: '',
      issues: [],
      at: 'x',
      model: 'm',
      carriedFrom: 'abc',
    };
    observeQuality(task, 0);
    expect(task.metrics?.quality.firstReview).toBeUndefined();
  });
});

describe('feature assignment', () => {
  it('on by its own setting unless the guard turned that version off; a newer version is on again', () => {
    expect(savingFeatureState(undefined, feature)).toBe('on');
    expect(savingFeatureState({ failureLoopNudge: false }, feature)).toBe('off');
    const autoOff = [{ feature: 'tool-pruning', version: 2, at: 'x', reason: 'r' }];
    expect(savingFeatureState({ savingAutoOff: autoOff }, feature)).toBe('auto-off');
    expect(savingFeatureState({ savingAutoOff: autoOff }, { ...feature, version: 3 })).toBe('on');
    // The real ones: summarised output opt-in (Claude only), loop nudges on by default.
    const [pruning, summary, nudge] = SAVING_FEATURES;
    expect(pruning).toMatchObject({ id: 'tool-pruning', setting: 'toolPruning' });
    expect(savingFeatureState(undefined, pruning)).toBe('off');
    expect(assignSavings({ toolPruning: true }, 'codex', () => 0.5)).toEqual({
      on: { 'loop-nudge': 1 },
    });
    expect(assignSavings({ toolPruning: true }, 'claude', () => 0.5)).toEqual({
      on: { 'tool-pruning': 1, 'loop-nudge': 1 },
    });
    expect(summary).toMatchObject({ id: 'test-summary', setting: 'summarizeOutput' });
    expect(savingFeatureState(undefined, summary)).toBe('off');
    expect(savingFeatureState({ summarizeOutput: true }, summary)).toBe('on');
    expect(nudge).toMatchObject({ id: 'loop-nudge', setting: 'failureLoopNudge' });
    expect(savingFeatureState(undefined, nudge)).toBe('on');
    expect(assignSavings({ summarizeOutput: true }, 'codex', () => 0.5)).toEqual({
      on: { 'loop-nudge': 1 },
    });
    expect(assignSavings({ summarizeOutput: true }, 'claude', () => 0.5)).toEqual({
      on: { 'test-summary': 1, 'loop-nudge': 1 },
    });
  });

  it('a holdout share runs without any feature (10 % by default)', () => {
    const assign = (settings: Partial<ProjectSettings> | undefined, r: number) =>
      assignSavings(settings, 'claude', () => r, [feature]);
    expect(assign(undefined, 0.05)).toEqual({ on: {}, holdout: true });
    expect(assign(undefined, 0.1)).toEqual({ on: { 'tool-pruning': 2 } });
    expect(assign({ savingHoldoutPct: 50 }, 0.3)).toEqual({ on: {}, holdout: true });
    expect(assign({ savingHoldoutPct: 0 }, 0).holdout).toBeUndefined();
    // Nothing on: nothing to hold out.
    expect(assign({ failureLoopNudge: false }, 0)).toEqual({ on: {} });
    const share = Array.from({ length: 1000 }, (_, i) => assign(undefined, i / 1000));
    expect(share.filter((s) => s.holdout)).toHaveLength(100);
  });

  it("a feature's code asks the task: what it recorded, else its project's state", () => {
    const on = { metrics: newTaskMetrics({ on: { 'tool-pruning': 2 } }) };
    const holdout = { metrics: newTaskMetrics({ on: {}, holdout: true }) };
    expect(taskSavingOn(on, 'tool-pruning', { failureLoopNudge: false }, [feature])).toBe(true);
    expect(taskSavingOn(holdout, 'tool-pruning', undefined, [feature])).toBe(false);
    // From before metrics: the project's setting and the guard decide.
    expect(taskSavingOn({}, 'tool-pruning', undefined, [feature])).toBe(true);
    expect(taskSavingOn({}, 'tool-pruning', { failureLoopNudge: false }, [feature])).toBe(false);
    expect(
      taskSavingOn(
        {},
        'tool-pruning',
        { savingAutoOff: [{ feature: 'tool-pruning', version: 2, at: 'x', reason: 'r' }] },
        [feature]
      )
    ).toBe(false);
    expect(taskSavingOn({}, 'unknown', undefined, [feature])).toBe(false);
  });
});

describe('comparison', () => {
  it('median cost, first-try pass rate, first-review approval and fix rounds per group', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    const all = [
      ...samples(20, { on: true, passed: 16, ok: 15, cost: 800 }),
      ...samples(10, { on: false, passed: 9, ok: 9, cost: 1200 }),
      // Another version of the feature: in neither group.
      { ...samples(1, { on: true, passed: 0, ok: 0 })[0], savings: { on: { 'tool-pruning': 1 } } },
    ];
    const cmp = compareFeature(all, feature);
    expect(cmp.with).toMatchObject({
      tasks: 20,
      medianCost: 800,
      firstCheckPassRate: 0.8,
      checkTasks: 20,
      firstReviewOkRate: 0.75,
      meanAutoFixRounds: 0.2,
      small: false,
    });
    expect(cmp.without).toMatchObject({
      tasks: 10,
      medianCost: 1200,
      firstCheckPassRate: 0.9,
      firstReviewOkRate: 0.9,
      small: true,
    });
    expect(cmp.small).toBe(true);
  });

  it('tasks without a signal do not count in its rate; no usage, no cost', () => {
    const [a, b] = samples(2, { on: true, passed: 2, ok: 2 });
    const stats = groupStats([
      a,
      { ...b, quality: { autoFixRounds: 0, riskRules: [] }, cost: undefined },
    ]);
    expect(stats).toMatchObject({
      tasks: 2,
      checkTasks: 1,
      firstCheckPassRate: 1,
      costTasks: 1,
      reviewTasks: 1,
    });
    expect(groupStats([])).toMatchObject({ tasks: 0, medianCost: null, firstCheckPassRate: null });
  });
});

describe('auto-off rule (rule 2, 2026-11-11)', () => {
  const review = (cmp: ReturnType<typeof compareFeature>) =>
    cmp.signals.find((signal) => signal.signal === 'review') as (typeof cmp.signals)[number];
  const check = (cmp: ReturnType<typeof compareFeature>) =>
    cmp.signals.find((signal) => signal.signal === 'check') as (typeof cmp.signals)[number];

  it('the interval of a difference: Wilson per rate, Newcombe for the two', () => {
    // Newcombe 1998, the worked example of his paper: 56/70 against 48/80, 95 %.
    const d = rateDifference({ hits: 56, n: 70 }, { hits: 48, n: 80 }, 1.96);
    expect(d?.diff).toBeCloseTo(0.2, 10);
    expect(d?.low).toBeCloseTo(0.0524, 3);
    expect(d?.high).toBeCloseTo(0.3339, 3);
    const [low, high] = wilson({ hits: 4, n: 5 }, 1.96);
    expect(low).toBeCloseTo(0.3755, 3);
    expect(high).toBeCloseTo(0.9638, 3);
    expect(wilson({ hits: 0, n: 0 }, 1.96)).toEqual([0, 1]);
    expect(rateDifference({ hits: 0, n: 0 }, { hits: 1, n: 2 })).toBeNull();
  });

  it('the real case: loop-nudge, 61 % of 87 against 80 % of 5, is not turned off: not enough data', () => {
    const cmp = compareFeature(
      [
        ...samples(87, { on: true, passed: 80, ok: 53 }),
        ...samples(5, { on: false, passed: 5, ok: 4 }),
      ],
      feature
    );
    expect(cmp.with.firstReviewOkRate).toBeCloseTo(0.61, 2);
    expect(cmp.without.firstReviewOkRate).toBe(0.8);
    // The first rule turned it off on this: 19 points lower, 87 tasks with it, 5 without.
    expect(review(cmp)).toMatchObject({
      with: { hits: 53, n: 87 },
      without: { hits: 4, n: 5 },
      verdict: 'insufficient',
    });
    // The interval says the same: anything from far worse to far better.
    expect(review(cmp).difference?.low).toBeLessThan(-0.4);
    expect(review(cmp).difference?.high).toBeGreaterThan(0.3);
    expect(savingsVerdict(cmp)).toEqual({ worse: false, insufficient: true });
    expect(signalVerdictLine(review(cmp))).toBe(
      'first-review approval rate: not enough data yet (87 task(s) with it, 5 without; the guard needs 10 in each)'
    );
  });

  it('the same rates on a baseline of 10 are still within what chance gives', () => {
    const cmp = compareFeature(
      [
        ...samples(87, { on: true, passed: 80, ok: 53 }),
        ...samples(10, { on: false, passed: 10, ok: 8 }),
      ],
      feature
    );
    expect(review(cmp).verdict).toBe('unclear');
    expect(review(cmp).difference?.high).toBeGreaterThan(0);
    expect(savingsVerdict(cmp)).toEqual({ worse: false, insufficient: false });
    expect(signalVerdictLine(review(cmp))).toMatch(
      /^first-review approval rate 61% with it \(53\/87\) vs 80% without \(8\/10\): −19 points, 99% interval −\d+ to \+\d+ → not clearly worse$/
    );
  });

  it('the real case: tool-pruning and test-summary, 31 % of 26 against 74 % of 66, stay off', () => {
    const cmp = compareFeature(
      [
        ...samples(26, { on: true, passed: 20, ok: 8 }),
        ...samples(66, { on: false, passed: 50, ok: 49 }),
      ],
      feature
    );
    expect(cmp.with.firstReviewOkRate).toBeCloseTo(0.31, 2);
    expect(cmp.without.firstReviewOkRate).toBeCloseTo(0.74, 2);
    const signal = review(cmp);
    expect(signal.verdict).toBe('worse');
    // 43 points lower; even the kindest end of the 99 % interval is well below 0.
    expect(signal.difference?.diff).toBeCloseTo(-0.435, 2);
    expect(signal.difference?.high).toBeLessThan(-0.1);
    const verdict = savingsVerdict(cmp);
    expect(verdict.worse && verdict.reasons).toEqual([
      expect.stringMatching(
        /^first-review approval rate 31% with it \(8\/26\) vs 74% without \(49\/66\): −43 points, 99% interval −\d+ to −\d+$/
      ),
    ]);
    // The check rate, as good in both: not a reason.
    expect(check(cmp).verdict).toBe('unclear');
  });

  it('a difference beyond the margin that chance gives often is not enough (12 of 20 against 16 of 20)', () => {
    const cmp = compareFeature(
      [
        ...samples(20, { on: true, passed: 12, ok: 20 }),
        ...samples(20, { on: false, passed: 16, ok: 20 }),
      ],
      feature
    );
    expect(check(cmp).difference?.diff).toBeCloseTo(-0.2, 10);
    expect(check(cmp).verdict).toBe('unclear');
    expect(savingsVerdict(cmp)).toEqual({ worse: false, insufficient: false });
  });

  it('a sure difference within the margin is not acted on; cheaper and as good is kept', () => {
    // 80 % against 90 % over 1000 tasks each: sure, and 10 points.
    const small = compareFeature(
      [
        ...samples(1000, { on: true, passed: 800, ok: 1000 }),
        ...samples(1000, { on: false, passed: 900, ok: 1000 }),
      ],
      feature
    );
    expect(check(small).difference?.high).toBeLessThan(0);
    expect(check(small).verdict).toBe('unclear');
    // Exactly the margin (15 points) is not "more than" it.
    const atMargin = compareFeature(
      [
        ...samples(1000, { on: true, passed: 650, ok: 1000 }),
        ...samples(1000, { on: false, passed: 800, ok: 1000 }),
      ],
      feature
    );
    expect(check(atMargin).verdict).toBe('unclear');
    const cheaper = compareFeature(
      [
        ...samples(20, { on: true, passed: 18, ok: 18, cost: 500 }),
        ...samples(20, { on: false, passed: 18, ok: 18, cost: 1000 }),
      ],
      feature
    );
    expect(savingsVerdict(cheaper)).toEqual({ worse: false, insufficient: false });
    expect(SAVINGS_GUARD).toMatchObject({ rule: 2, minGroup: 10, margin: 0.15, confidence: 0.99 });
  });

  it('never under 10 tasks in either group, whatever the rates', () => {
    for (const [withIt, without] of [
      [9, 40],
      [40, 9],
    ]) {
      const cmp = compareFeature(
        [
          ...samples(withIt, { on: true, passed: 0, ok: 0 }),
          ...samples(without, { on: false, passed: without, ok: without }),
        ],
        feature
      );
      expect(savingsVerdict(cmp)).toEqual({ worse: false, insufficient: true });
    }
    // A clear case on 10 in the baseline: turned off.
    const clear = compareFeature(
      [
        ...samples(40, { on: true, passed: 12, ok: 40 }),
        ...samples(10, { on: false, passed: 10, ok: 10 }),
      ],
      feature
    );
    expect(check(clear).verdict).toBe('worse');
  });

  it('big changes fail more whatever they ran with: compared within a like size, not blamed on the feature', () => {
    expect([undefined, 0, 50, 51, 300, 301, 1000, 1001].map(sizeBucket)).toEqual([
      'unknown',
      'small',
      'small',
      'medium',
      'medium',
      'large',
      'large',
      'huge',
    ]);
    // The feature ran mostly on big audits (30 % approved first, with it or not); the baseline
    // is mostly small changes (90 % approved, with it or not).
    const confounded = compareFeature(
      [
        ...samples(40, { on: true, passed: 40, ok: 12, lines: 2000 }),
        ...samples(10, { on: true, passed: 10, ok: 9, lines: 20 }),
        ...samples(10, { on: false, passed: 10, ok: 3, lines: 2000 }),
        ...samples(40, { on: false, passed: 40, ok: 36, lines: 20 }),
      ],
      feature
    );
    const signal = review(confounded);
    // Taken together: 42 % against 78 %, the interval wholly below 0.
    expect(signal.difference?.diff).toBeCloseTo(-0.36, 10);
    expect(signal.difference?.high).toBeLessThan(0);
    // Within each size: no difference at all.
    expect(signal.adjusted).toBeCloseTo(0, 10);
    expect(signal.sized).toBe(100);
    expect(signal.verdict).toBe('unclear');
    expect(signalVerdictLine(signal)).toMatch(
      /−36 points, 99% interval −\d+ to −\d+; 0 within changes of a like size \(size known for 100 of 100\) → not clearly worse/
    );
    // Worse within each size too: turned off.
    const worse = compareFeature(
      [
        ...samples(40, { on: true, passed: 40, ok: 4, lines: 2000 }),
        ...samples(10, { on: true, passed: 10, ok: 5, lines: 20 }),
        ...samples(10, { on: false, passed: 10, ok: 5, lines: 2000 }),
        ...samples(40, { on: false, passed: 40, ok: 36, lines: 20 }),
      ],
      feature
    );
    expect(review(worse).adjusted).toBeCloseTo(-0.4, 10);
    expect(review(worse).verdict).toBe('worse');
    // No size has tasks of both groups: size and feature cannot be told apart, nothing goes off.
    const apart = compareFeature(
      [
        ...samples(40, { on: true, passed: 40, ok: 4, lines: 2000 }),
        ...samples(40, { on: false, passed: 40, ok: 36, lines: 20 }),
      ],
      feature
    );
    expect(review(apart)).toMatchObject({ adjusted: null, verdict: 'unclear' });
    expect(signalVerdictLine(review(apart))).toMatch(/no size of change has tasks of both groups/);
  });

  it("a feature of some agents is compared among those agents' tasks; features always on together are named", () => {
    const claudeOnly = { ...feature, agents: ['claude'] as const };
    const all: SavingsSample[] = [
      ...samples(20, { on: true, passed: 10, ok: 20 }).map((s) => ({
        ...s,
        agent: 'claude' as const,
        savings: { on: { 'tool-pruning': 2, 'test-summary': 1 } },
      })),
      ...samples(12, { on: false, passed: 6, ok: 12 }).map((s) => ({
        ...s,
        agent: 'claude' as const,
      })),
      // Codex tasks cannot run it: not its baseline.
      ...samples(30, { on: false, passed: 30, ok: 30 }).map((s) => ({
        ...s,
        agent: 'codex' as const,
      })),
    ];
    expect(compareFeature(all, claudeOnly).without).toMatchObject({ tasks: 12, checkPassed: 6 });
    expect(compareFeature(all, feature).without).toMatchObject({ tasks: 42, checkPassed: 36 });
    expect(ranTogether(all, feature)).toEqual(['test-summary']);
    expect(ranTogether(all, { id: 'loop-nudge', version: 1 })).toEqual([]);
  });

  it("a task's size is the lines of its change when first known", () => {
    const task = {
      state: 'running',
      metrics: newTaskMetrics({ on: {} }),
      stats: { commits: 0, files: 0, insertions: 0, deletions: 0 },
    } as unknown as TaskRecord;
    observeQuality(task, 0);
    expect(task.metrics?.quality.lines).toBeUndefined();
    task.stats = { commits: 2, files: 3, insertions: 120, deletions: 30 };
    expect(observeQuality(task, 0)).toBe(true);
    expect(task.metrics?.quality.lines).toBe(150);
    // A fix round later does not move it to another size.
    task.stats = { commits: 5, files: 9, insertions: 900, deletions: 300 };
    expect(observeQuality(task, 0)).toBe(false);
    expect(task.metrics?.quality.lines).toBe(150);
  });
});

describe('report', () => {
  it('labels small samples and says what the guard did', () => {
    const text = formatSavingsReport({
      repoPath: '/repo',
      window: 100,
      tasks: 12,
      holdout: 2,
      holdoutPct: 10,
      all: groupStats(samples(12, { on: true, passed: 10, ok: 10 })),
      features: [
        {
          id: 'tool-pruning',
          version: 2,
          label: 'pruning',
          setting: 'failureLoopNudge',
          state: 'auto-off',
          autoOff: {
            feature: 'tool-pruning',
            version: 2,
            at: '2026-11-03T00:00:00.000Z',
            reason: 'worse',
          },
          comparison: compareFeature(
            [
              ...samples(10, { on: true, passed: 8, ok: 8, cost: 2_500_000 }),
              ...samples(2, { on: false, passed: 2, ok: 2 }),
            ],
            feature
          ),
        },
      ],
      guard: { minGroup: 10, marginPct: 15, confidencePct: 99 },
    });
    expect(text).toMatch(/last 12 finished task\(s\) of \/repo.*holdout 2, 10% of new tasks/);
    expect(text).toMatch(
      /tool-pruning v2 \(pruning\): turned off by the guard 2026-11-03.*: worse/
    );
    expect(text).toMatch(
      /with: {4}10 tasks \(small sample\) · median cost 2\.5M · first-try check 80% \(10\)/
    );
    expect(text).toMatch(/small sample: read these numbers with care/);
    expect(text).toMatch(
      /guard: {3}first-review approval rate: not enough data yet \(10 task\(s\) with it, 2 without; the guard needs 10 in each\)/
    );
    expect(text).toMatch(
      /99% confidence interval of the difference wholly below 0 and at least 10 tasks in each group; with fewer it says "not enough data yet" and turns nothing off/
    );
  });
});
