/**
 * Task metrics (2026-11-03, shared/task-metrics.ts): what a task's agent processed, the quality
 * signals the task showed, the saving features it ran with; the finished ones go to the
 * project's ledger, where the saving features are compared and the guard turns a feature off
 * when the quality of tasks with it is clearly worse (shared/saving-features.ts).
 * One layer of TaskScheduler (task-scheduler.ts).
 */
import {
  assignSavings,
  compareFeature,
  groupStats,
  ranTogether,
  SAVING_FEATURES,
  SAVINGS_GUARD,
  SAVINGS_HOLDOUT_PCT_DEFAULT,
  type SavingAutoOff,
  type SavingFeature,
  type SavingsReport,
  savingFeatureState,
  savingsVerdict,
  signalVerdictLine,
} from '../../shared/saving-features.js';
import {
  type AgentUsage,
  applyUsage,
  checkMetrics,
  formatTokens,
  newTaskMetrics,
  observeQuality,
  sumCheckMetrics,
  type TaskMetrics,
} from '../../shared/task-metrics.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { type TaskMetricsEntry, TaskMetricsLedger } from './task-metrics-ledger.js';
import { TaskSchedulerCore } from './task-scheduler-core.js';

/** The states whose tasks count in the ledger: finished with their work kept or thrown away. */
const LEDGER_STATES: ReadonlySet<string> = new Set(['merged', 'done', 'discarded']);

export abstract class TaskSchedulerMetrics extends TaskSchedulerCore {
  private ledgerSigs = new Map<string, string>();

  protected override forget(taskId: string): void {
    this.ledgerSigs.delete(taskId);
    super.forget(taskId);
  }
  private ownLedger: TaskMetricsLedger | undefined;

  protected get ledger(): TaskMetricsLedger {
    if (this.deps.metricsLedger) return this.deps.metricsLedger;
    this.ownLedger ??= new TaskMetricsLedger();
    return this.ownLedger;
  }

  /**
   * A new task's metrics: the saving features on for its project, or none (holdout). Its
   * project is resolved now (a task without a worktree may never have a repoPath): its ledger.
   */
  protected async newMetrics(task: TaskRecord): Promise<TaskMetrics> {
    const project = (await this.projectOf(task).catch(() => undefined)) ?? task.repoPath;
    // Outside a repository git knows of: the folder's own settings (the defaults, mostly).
    const settings = this.deps.settings?.get(project ?? task.workingDir);
    const metrics = newTaskMetrics(
      assignSavings(settings, task.agent, this.deps.random ?? Math.random)
    );
    if (project) metrics.project = project;
    return metrics;
  }

  /** The metrics of a task from before they existed: no features recorded. */
  protected metricsOf(task: TaskRecord): TaskMetrics {
    task.metrics ??= newTaskMetrics({ on: {} });
    return task.metrics;
  }

  /** Usage read from the agent's files (budgets read it): the task's metrics take it. */
  protected takeUsage(task: TaskRecord, byFile: Record<string, AgentUsage>): void {
    applyUsage(this.metricsOf(task), byFile);
  }

  /**
   * A heavy check its agent started through a check slot ended (check-slots.ts): one more run
   * of the task's, or one not made because the same tree had passed already.
   */
  noteAgentCheck(taskId: string, run: { ms: number; reusedMs?: number }): void {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    const checks = checkMetrics(this.metricsOf(task));
    if (run.reusedMs !== undefined) {
      checks.reused += 1;
      checks.savedMs += run.reusedMs;
    } else {
      checks.runs += 1;
      checks.agentRuns += 1;
      checks.runMs += Math.max(0, run.ms);
    }
    this.save();
  }

  /**
   * Before every write of tasks.json: each task's quality signals seen now, and the finished
   * tasks whose metrics changed written to the ledger; then the guard looks at their projects.
   */
  protected observeMetrics(): void {
    const now = this.now();
    const projects = new Set<string>();
    for (const task of this.tasks) {
      if (!task.metrics) continue;
      observeQuality(task, now);
      const project = task.metrics.project ?? task.repoPath;
      if (!project || !LEDGER_STATES.has(task.state)) continue;
      const entry = this.ledgerEntry(task);
      const sig = JSON.stringify(entry);
      if (this.ledgerSigs.get(task.id) === sig) continue;
      this.ledgerSigs.set(task.id, sig);
      this.ledger.upsert(project, entry);
      projects.add(project);
    }
    if (!projects.size) return;
    this.ledger.flush();
    for (const repoPath of projects) this.guardSavings(repoPath);
  }

  private ledgerEntry(task: TaskRecord): TaskMetricsEntry {
    const metrics = task.metrics as TaskMetrics;
    return {
      taskId: task.id,
      name: task.name,
      agent: task.agent,
      state: task.state,
      finishedAt: task.finishedAt ?? task.stateSince,
      savings: metrics.savings,
      quality: metrics.quality,
      ...(metrics.usage ? { usage: metrics.usage } : {}),
      ...(metrics.cost !== undefined ? { cost: metrics.cost } : {}),
      // A provider task is counted apart in the savings report (model-providers.ts).
      ...(task.modelProvider ? { modelProvider: task.modelProvider } : {}),
      ...(task.budget?.spent.usd ? { usd: task.budget.spent.usd } : {}),
      ...(metrics.conflicts ? { conflicts: metrics.conflicts } : {}),
      ...(metrics.checks ? { checks: metrics.checks } : {}),
    };
  }

  private samples(repoPath: string, last: number): TaskMetricsEntry[] {
    return this.ledger.list(repoPath, last);
  }

  /**
   * The guard: each feature on for the project whose tasks show clearly worse quality than the
   * baseline (savingsVerdict) over the project's last SAVINGS_GUARD.window tasks is turned off
   * for it (that version), and its orchestrator told the numbers with their uncertainty. New
   * tasks run without it.
   *
   * A feature it turned off under an earlier rule (SavingAutoOff.rule, 2026-11-11: loop-nudge
   * went off in untether on 4 tasks out of 5) is judged again under the present one, once: on
   * again when the numbers no longer hold, kept off with the new numbers when they do. One
   * judged under the present rule stays off: its tasks only leave the window from then on.
   */
  protected guardSavings(
    repoPath: string,
    features: readonly SavingFeature[] = SAVING_FEATURES
  ): void {
    const store = this.deps.settings;
    if (!store?.update) return;
    const settings = store.get(repoPath);
    // Provider tasks are excluded (model-providers.ts): their cost is the provider's.
    const samples = this.samples(repoPath, SAVINGS_GUARD.window).filter((s) => !s.modelProvider);
    const autoOff = settings.savingAutoOff ?? [];
    /** Entries written now: turned off, or kept off under the present rule. */
    const written: SavingAutoOff[] = [];
    /** Features whose entry goes: turned off again above, or on again. */
    const dropped = new Set<string>();
    const notices: string[] = [];
    for (const feature of features) {
      const state = savingFeatureState(settings, feature);
      const old = autoOff.find(
        (entry) =>
          entry.feature === feature.id &&
          entry.version === feature.version &&
          (entry.rule ?? 1) < SAVINGS_GUARD.rule
      );
      if (state !== 'on' && !(state === 'auto-off' && old)) continue;
      const comparison = compareFeature(samples, feature);
      const verdict = savingsVerdict(comparison);
      const name = `Saving feature ${feature.id} v${feature.version}`;
      if (!verdict.worse) {
        if (!old) continue;
        dropped.add(feature.id);
        notices.push(
          `${name} is on again for this project: the guard turned it off on ${old.at} under an earlier rule, and under the present one ${verdict.insufficient ? 'there is not enough data yet to judge it' : 'its tasks are not clearly worse than those without it'}. ${comparison.signals.map((signal) => signalVerdictLine(signal)).join('; ')}. New tasks run with it again; \`ut project stats\` shows the comparison.`
        );
        continue;
      }
      const together = ranTogether(samples, feature);
      const reason = `${verdict.reasons.join('; ')} (last ${samples.length} tasks; median cost ${comparison.with.medianCost === null ? '–' : formatTokens(comparison.with.medianCost)} with it vs ${comparison.without.medianCost === null ? '–' : formatTokens(comparison.without.medianCost)} without${together.length ? `; it ran together with ${together.join(', ')} in nearly all of those tasks: the numbers cannot tell them apart` : ''})`;
      dropped.add(feature.id);
      written.push({
        feature: feature.id,
        version: feature.version,
        // Kept off: since when it has been off.
        at: old?.at ?? new Date(this.now()).toISOString(),
        reason,
        rule: SAVINGS_GUARD.rule,
      });
      notices.push(
        old
          ? `${name} stays off for this project: judged again under the guard's present rule, tasks with it are still clearly worse than those without. ${reason}. \`ut project stats\` shows the comparison, \`ut project set savingAutoOff=\` turns it on again.`
          : `${name} turned off for this project: tasks with it are clearly worse than those without. ${reason}. New tasks run without it; \`ut project stats\` shows the comparison, \`ut project set savingAutoOff=\` turns it on again.`
      );
    }
    if (!dropped.size) return;
    const kept = autoOff.filter((entry) => !dropped.has(entry.feature));
    try {
      store.update(repoPath, { savingAutoOff: [...kept, ...written] });
    } catch (error) {
      this.deps.onError?.(
        `saving features of ${repoPath}: could not write the guard's verdict`,
        error
      );
      return;
    }
    for (const text of notices) {
      this.deps.onError?.(`${repoPath}: ${text}`);
      this.deps.projectNotice?.(repoPath, text);
    }
  }

  /** `ut project stats`: over the project's last `last` finished tasks, each feature compared. */
  savingsReport(
    repoPath: string,
    last: number = SAVINGS_GUARD.window,
    features: readonly SavingFeature[] = SAVING_FEATURES
  ): SavingsReport {
    const settings = this.deps.settings?.get(repoPath);
    const allSamples = this.samples(repoPath, last);
    // Provider tasks are counted apart: their token behaviour is the provider's, not Untether's
    // saving features, so they never enter the comparison (model-providers.ts).
    const providerSamples = allSamples.filter((sample) => sample.modelProvider);
    const samples = allSamples.filter((sample) => !sample.modelProvider);
    const providers = providerSamples.length
      ? {
          tasks: providerSamples.length,
          priced: providerSamples.filter((sample) => sample.usd !== undefined).length,
          usd: providerSamples.reduce((sum, sample) => sum + (sample.usd ?? 0), 0),
        }
      : undefined;
    const seen = new Map<string, number>();
    for (const sample of samples) {
      for (const [id, version] of Object.entries(sample.savings.on)) {
        if (!features.some((f) => f.id === id && f.version === version)) seen.set(id, version);
      }
    }
    // A version no longer in the registry still shows, as a feature of its own.
    const listed: SavingFeature[] = [
      ...features,
      ...[...seen].map(([id, version]) => ({
        id,
        version,
        label: '(not in this build)',
        setting: features.find((f) => f.id === id)?.setting ?? ('savingAutoOff' as const),
        enabled: () => false,
      })),
    ];
    return {
      repoPath,
      window: last,
      tasks: samples.length,
      holdout: samples.filter((s) => s.savings.holdout).length,
      holdoutPct: settings?.savingHoldoutPct ?? SAVINGS_HOLDOUT_PCT_DEFAULT,
      all: groupStats(samples),
      features: listed.map((feature) => {
        const autoOff = settings?.savingAutoOff?.find(
          (entry) => entry.feature === feature.id && entry.version >= feature.version
        );
        return {
          id: feature.id,
          version: feature.version,
          label: feature.label,
          setting: feature.setting,
          state: savingFeatureState(settings, feature),
          ...(autoOff ? { autoOff } : {}),
          comparison: compareFeature(samples, feature),
        };
      }),
      guard: {
        minGroup: SAVINGS_GUARD.minGroup,
        marginPct: Math.round(SAVINGS_GUARD.margin * 100),
        confidencePct: Math.round(SAVINGS_GUARD.confidence * 100),
      },
      ...(providers ? { providers } : {}),
      // Every task's check runs, provider tasks included: the Mac ran them all the same.
      checks: sumCheckMetrics(allSamples.map((sample) => sample.checks)),
    };
  }
}
