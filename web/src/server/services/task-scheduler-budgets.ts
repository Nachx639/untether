/**
 * Task budgets: the time, rounds and tokens a worktree task may spend, counted, warned about and
 * cut (2026-11-01).
 * One layer of TaskScheduler (task-scheduler.ts).
 */
import {
  budgetAtWarning,
  budgetLine,
  budgetOver,
  budgetShare,
  emptySpent,
  formatBudgetDuration,
  formatBudgetValue,
  parseBudgetExtension,
  resolveBudget,
  TASK_BUDGET_KEYS,
  type TaskBudget,
  type TaskBudgetKey,
  type TaskBudgetSpec,
} from '../../shared/task-budget.js';
import { usageTokens } from '../../shared/task-metrics.js';
import { formatPhaseDuration, summarizeTimings } from '../../shared/task-timings.js';
import type { TaskBlocker, TaskRecord, TaskState } from '../../shared/tasks.js';
import { TaskSchedulerMetrics } from './task-scheduler-metrics.js';
import {
  BUDGET_CONTINUE_TEXT,
  BUDGET_SAVE_EVERY_MS,
  BUDGET_TOKENS_EVERY_MS,
  budgetAdvice,
  budgeted,
  isFinal,
} from './task-scheduler-rules.js';
import type { TaskActionResult } from './task-scheduler-types.js';

export abstract class TaskSchedulerBudgets extends TaskSchedulerMetrics {
  /** A budgeted task past one of its limits (shared/task-budget.ts). */
  protected budgetSpent(task: TaskRecord): boolean {
    return budgeted(task) && budgetOver(this.budgetOf(task)).length > 0;
  }

  // ── Budgets (shared/task-budget.ts, 2026-11-01) ─────────────────────────────────────────

  /**
   * The task's budget with its limits resolved now (defaults, the project's taskBudget, its
   * own, what was added): made for a new task, and for one from before budgets.
   */
  protected budgetOf(task: TaskRecord, own?: TaskBudgetSpec): TaskBudget {
    const budget: TaskBudget = task.budget ?? {
      ...(own ? { own } : {}),
      limits: { wall: 0, agent: 0, rounds: 0, tokens: 0, usd: 0 },
      warnPct: 0,
      spent: emptySpent(),
    };
    const settings = task.repoPath ? this.deps.settings?.get(task.repoPath) : undefined;
    Object.assign(budget, resolveBudget(settings?.taskBudget, budget.own, budget.extra));
    task.budget = budget;
    return budget;
  }

  /**
   * What the time now counts as: the agent at work ('agent', also wall), Untether at work on it
   * ('wall': setup, check, review, merge), or nothing: a wait for its project's slot, a check
   * slot (load, disk), its turn in the merge queue, a retry later, a usage-limit pause, a
   * person (needs_you, ready).
   */
  protected budgetClock(task: TaskRecord): 'agent' | 'wall' | null {
    switch (task.state) {
      case 'working':
        // Stalled past its nudge's deadline, its orchestrator told (task-scheduler-stall.ts):
        // that idle time is not the agent's work.
        if (task.stall?.escalatedAt) return null;
        // Its agent's heavy check waits for a check slot (check-slots.ts, 2026-11-10): the
        // wait is the Mac's, not its work.
        return this.deps.checkSlotWait?.(task.id).waiting ? null : 'agent';
      case 'preparing':
        return 'wall';
      case 'verifying':
      case 'merging':
        if (task.verify?.queued && !task.verify.finishedAt) return null;
        if ((task.mergeQueue?.position ?? 1) > 1) return null;
        if (task.internalRetryAt || task.reviewRetryAt || task.baseWait) return null;
        return 'wall';
      default:
        return null;
    }
  }

  /**
   * A move to working that is a new round of the agent's: its work went back to it after it
   * said it was done (a hand-back, a fix, new instructions), not an answer to its question,
   * a usage-limit pause going on, or more budget.
   */
  protected newRound(task: TaskRecord, before: TaskState): boolean {
    if (!['ready', 'needs_you', 'verifying', 'merging', 'failed'].includes(before)) return false;
    if (!task.finishedAt) return false;
    // A conflict the base's moves brought (freshConflict): its time counts, not a round.
    if (task.autoFix?.baseMoved) return false;
    const kind = task.blocker?.kind;
    return kind !== 'question' && kind !== 'permission' && kind !== 'budget' && kind !== 'halted';
  }

  /**
   * Every few seconds (checkExited): time spent, the agent's usage read now and then (every
   * task's, for its metrics), warnings, cuts.
   */
  protected countBudgets(): void {
    const now = this.now();
    let changed = false;
    // Whether any open task was looked at: with none, nothing was counted and tasks.json is
    // not rewritten whole every minute by an idle server (2026-11-10).
    let counted = false;
    for (const task of this.tasks) {
      if (isFinal(task)) continue;
      counted = true;
      this.readAgentUsage(task, now);
      if (!budgeted(task)) continue;
      this.countTime(task, now);
      if (this.checkBudget(task)) changed = true;
    }
    if (changed || (counted && now - this.budgetSavedAt >= BUDGET_SAVE_EVERY_MS)) {
      this.budgetSavedAt = now;
      this.save();
    }
  }

  /** Adds the time since it was last counted, as what the task is doing (budgetClock). */
  protected countTime(task: TaskRecord, now: number): void {
    const budget = this.budgetOf(task);
    const from = budget.countedAt ? Date.parse(budget.countedAt) : Number.NaN;
    budget.countedAt = new Date(now).toISOString();
    const elapsed = Number.isFinite(from) ? Math.max(0, now - from) : 0;
    const clock = this.budgetClock(task);
    if (elapsed > 0 && clock) {
      budget.spent.wall += elapsed;
      if (clock === 'agent') budget.spent.agent += elapsed;
    }
  }

  /**
   * Reads what a working task's agent processed (every minute), and once after it stopped:
   * its metrics take all of it, its budget the tokens.
   */
  protected readAgentUsage(task: TaskRecord, now: number): void {
    const read = this.deps.agentUsage;
    if (!read || !task.sessionId || this.readingTokens.has(task.id)) return;
    const last = this.tokensReadAt.get(task.id) ?? 0;
    const every = this.deps.budgetTokensEveryMs ?? BUDGET_TOKENS_EVERY_MS;
    const due = task.state === 'working' ? now - last >= every : last < Date.parse(task.stateSince);
    if (!due) return;
    this.tokensReadAt.set(task.id, now);
    this.readingTokens.add(task.id);
    const known = Object.keys(task.metrics?.usageBy ?? task.budget?.tokensBy ?? {});
    this.track(
      read(task, known)
        .then(async (byFile) => {
          if (!byFile) return;
          this.takeUsage(task, byFile);
          // Finished: its ledger entry takes the last read now. Unbudgeted: the next save.
          if (isFinal(task)) {
            this.save();
            return;
          }
          if (!budgeted(task)) return;
          const budget = this.budgetOf(task);
          const tokens = Object.fromEntries(
            Object.entries(byFile).map(([file, usage]) => [file, usageTokens(usage)])
          );
          budget.tokensBy = { ...(budget.tokensBy ?? {}), ...tokens };
          budget.spent.tokens = Object.values(budget.tokensBy).reduce((sum, n) => sum + n, 0);
          // A priced provider task: its tokens turned into dollars for the `usd` budget.
          if (task.modelProvider && this.deps.taskUsd) {
            const usd = await this.deps.taskUsd(task).catch(() => undefined);
            if (usd !== undefined && budgeted(task)) budget.spent.usd = usd;
          }
          if (this.checkBudget(task)) this.save();
        })
        .finally(() => this.readingTokens.delete(task.id))
    );
  }

  /**
   * A working task past a limit is cut; a limit at its warning level is told once (not when
   * the cut already says it). True when something changed.
   */
  protected checkBudget(task: TaskRecord): boolean {
    const budget = task.budget;
    if (!budget || isFinal(task)) return false;
    let changed = false;
    const over = budgetOver(budget);
    if (task.state === 'working' && over.length) {
      this.cutBudget(task, over, { working: true });
      changed = true;
    }
    const warn = budgetAtWarning(budget).filter((key) => !budget.warned?.includes(key));
    if (warn.length) {
      budget.warned = [...(budget.warned ?? []), ...warn];
      changed = true;
      if (!budget.cut) this.warnBudget(task, warn);
    }
    return changed;
  }

  /** The limits one more round of the agent would go past (or that are spent already). */
  protected handBackOver(task: TaskRecord, freeRound = false): TaskBudgetKey[] {
    const budget = this.budgetOf(task);
    return budgetOver({
      limits: budget.limits,
      spent: { ...budget.spent, rounds: budget.spent.rounds + (freeRound ? 0 : 1) },
    });
  }

  /**
   * The task reached its budget: its agent is stopped (Escape: its session, conversation,
   * worktree and branch stay) or the round it was to get is held, and it waits for more
   * budget (`ut task budget`) or to be discarded. Told once per cut.
   */
  protected cutBudget(
    task: TaskRecord,
    keys: TaskBudgetKey[],
    how: Pick<NonNullable<TaskBudget['cut']>, 'working' | 'handBack'>
  ): void {
    const budget = this.budgetOf(task);
    const again = !!budget.cut;
    budget.cut = {
      at: new Date(this.now()).toISOString(),
      keys,
      ...(how.working ? { working: true } : {}),
      ...(how.handBack ? { handBack: how.handBack } : {}),
    };
    if (how.working && task.sessionId && this.deps.sessionStatus(task.sessionId) === 'running') {
      try {
        this.deps.interrupt?.(task.sessionId);
      } catch (error) {
        this.deps.onError?.(`task ${task.id}: could not stop its agent`, error);
      }
    }
    this.cancelHold(task.id);
    this.endAgentPhase(task);
    delete task.autoFix;
    this.setState(task, 'needs_you', { kind: 'budget', message: this.budgetNote(task, keys) });
    budget.warned = [...new Set([...(budget.warned ?? []), ...budgetAtWarning(budget)])];
    this.save();
    this.deps.onError?.(
      `Task ${task.id}: budget reached (${budgetLine(budget)}), ${how.working ? 'its agent stopped' : 'its next round held'}`
    );
    if (!again) this.notifyState(task, '');
  }

  /** "Budget reached: agent 2h of 2h …: its agent was stopped, its work kept; …". */
  protected budgetNote(task: TaskRecord, keys: TaskBudgetKey[]): string {
    const budget = this.budgetOf(task);
    const id = task.id.slice(0, 8);
    const spent = keys
      .map(
        (key) =>
          `${key} ${formatBudgetValue(key, budget.spent[key])} of ${formatBudgetValue(key, budget.limits[key])}`
      )
      .join(', ');
    return `Budget reached (${spent}): its agent was stopped, its work kept. \`ut task budget ${id} +50%\` gives it more and it goes on, or discard it · ${budgetAdvice(task, keys)}`;
  }

  /** At the warning level: whoever the task reports to hears where it stands and a suggestion. */
  protected warnBudget(task: TaskRecord, keys: TaskBudgetKey[]): void {
    const budget = this.budgetOf(task);
    const levels = keys
      .map(
        (key) =>
          `${key} ${formatBudgetValue(key, budget.spent[key])} of ${formatBudgetValue(key, budget.limits[key])} (${Math.round(budgetShare(budget, key) * 100)}%)`
      )
      .join(', ');
    const text = `Budget at ${budget.warnPct}%: ${levels}. ${this.budgetSpentBy(task)}. ${budgetAdvice(task, keys)}`;
    this.deps.onError?.(`Task ${task.id}: ${text}`);
    const toOrchestrator = task.origin === 'orchestrator' && !!task.orchestratorSessionId;
    if (!task.notify && !toOrchestrator) return;
    const payload = this.taskPayload(task, 'task-budget', text);
    const pct = Math.max(...keys.map((key) => Math.round(budgetShare(budget, key) * 100)));
    payload.data = { ...payload.data, budgetKeys: keys, budgetPct: pct };
    this.post(payload);
  }

  /** "Spent: agent 1h 20m at work, 3 rounds; verify 12m ×3, review 1m ×3, fix 40m ×2". */
  protected budgetSpentBy(task: TaskRecord): string {
    const budget = this.budgetOf(task);
    const phases = (summarizeTimings(task.timings, this.now())?.phases ?? []).map(
      (phase) =>
        `${phase.phase} ${formatPhaseDuration(phase.ms)}${phase.count > 1 ? ` ×${phase.count}` : ''}`
    );
    return `Spent: agent ${formatBudgetDuration(budget.spent.agent)} at work, ${formatBudgetDuration(budget.spent.wall)} in all, ${budget.spent.rounds} rounds${phases.length ? `; by phase: ${phases.join(', ')}` : ''}`;
  }

  /**
   * More budget (`ut task budget <id> +1h`, the phone): the limits grow (shared/task-budget.ts
   * parseBudgetExtension). A task stopped by its budget goes on where it stopped: its agent is
   * told to go on, or the round that was held is handed over. A raised limit warns again.
   */
  async extendBudget(id: string, spec: string): Promise<TaskActionResult> {
    const task = this.tasks.find((entry) => entry.id === id);
    if (!task) return { ok: false, code: 'not-found', message: 'Task not found' };
    if (isFinal(task)) return { ok: false, code: 'not-open', message: `The task is ${task.state}` };
    if (!budgeted(task)) {
      return { ok: false, code: 'bad-budget', message: 'A task without a worktree has no budget' };
    }
    const budget = this.budgetOf(task);
    let add: Partial<Record<TaskBudgetKey, number>>;
    try {
      add = parseBudgetExtension(spec, budget.limits, budget.cut?.keys ?? budgetOver(budget));
    } catch (error) {
      return { ok: false, code: 'bad-budget', message: (error as Error).message };
    }
    const extra = { ...(budget.extra ?? {}) };
    for (const key of TASK_BUDGET_KEYS) {
      if (add[key]) extra[key] = (extra[key] ?? 0) + (add[key] ?? 0);
    }
    budget.extra = extra;
    this.budgetOf(task);
    // A limit raised below its warning level warns again when it gets there.
    budget.warned = budget.warned?.filter(
      (key) => !(add[key] && add[key] > 0) || budgetShare(budget, key) * 100 >= budget.warnPct
    );
    this.deps.onError?.(`Task ${task.id}: budget now ${budgetLine(budget)}`);
    const cut = budget.cut;
    if (!cut) {
      this.save();
      return { ok: true, task: this.copy(task) };
    }
    const still = cut.handBack
      ? this.handBackOver(
          task,
          cut.handBack.reason === 'conflict' &&
            this.freshConflict(task, cut.handBack.blocker as TaskBlocker)
        )
      : budgetOver(budget);
    if (still.length) {
      if (task.blocker?.kind === 'budget') task.blocker.message = this.budgetNote(task, still);
      this.save();
      return {
        ok: false,
        code: 'over-budget',
        message: `Still over its budget (${budgetLine(budget)}): give it more than that`,
      };
    }
    delete budget.cut;
    if (this.piping.has(task.id) || this.discarding.has(task.id)) {
      this.save();
      return { ok: true, task: this.copy(task) };
    }
    if (cut.handBack) {
      this.setState(task, cut.handBack.state, cut.handBack.blocker as TaskBlocker);
      this.save();
      if (!(await this.startAutoFix(task, cut.handBack.reason))) this.notifyState(task, '');
      return { ok: true, task: this.copy(task) };
    }
    return await this.deliverText(task, BUDGET_CONTINUE_TEXT, 'ui', true);
  }
}
