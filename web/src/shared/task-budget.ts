/**
 * A task's budget (2026-11-01, compared with Omnigent's budget policies): bakery tasks ran
 * 2 to 5 hours, and nothing but the automatic fixes per reason had a limit. Every worktree task gets
 * four limits, each with a warning level and a cut:
 *  wall: its clock time while someone works on it (the agent, its setup, the check, the
 *    review, the merge). Not the time it waits: queued for its project's slot, a check slot
 *    (load, disk), its turn in the merge queue, a usage-limit pause, nor waiting on a person
 *    (needs_you, ready).
 *  agent: the time its agent is at work (state working).
 *  rounds: the times the work went back to its agent after it said it was done (a failed
 *    check, a conflict, a review's findings, a fix asked by the user or an orchestrator).
 *  tokens: what its agent's sessions processed (input, cache and output), from the agent's
 *    own transcript (Claude's JSONL usage, Codex's rollout token_count).
 * Defaults below, over them the project's `taskBudget` (`ut project set taskBudget=…`), over
 * that the task's own (`ut task new --budget …`) and what was added later
 * (`ut task budget <id> +…`). At the warning level whoever the task reports to hears it once,
 * with where the time went; at the cut its agent is stopped (its work stays in the worktree)
 * and the task waits for more budget or to be discarded (blocker 'budget').
 *
 * Shared by the scheduler (counting, cutting), the CLI and the phone (gastado / tope).
 */

export type TaskBudgetKey = 'wall' | 'agent' | 'rounds' | 'tokens' | 'usd';

export const TASK_BUDGET_KEYS: readonly TaskBudgetKey[] = [
  'wall',
  'agent',
  'rounds',
  'tokens',
  'usd',
];

/**
 * Limits: milliseconds (wall, agent), a count (rounds, tokens), US dollars (usd). 0 = no limit.
 * `usd` is only meaningful for a task against a priced external provider (model-providers.ts):
 * its tokens turned into dollars; off (0) for every other task.
 */
export type TaskBudgetLimits = Record<TaskBudgetKey, number>;

/** A spec's values: each set limit, and the warning level in percent. */
export interface TaskBudgetSpec {
  limits: Partial<TaskBudgetLimits>;
  warnPct?: number;
}

/** What a task spent so far. */
export type TaskBudgetSpent = Record<TaskBudgetKey, number>;

export const TASK_BUDGET_DEFAULTS: TaskBudgetLimits = {
  wall: 3 * 60 * 60_000,
  agent: 2 * 60 * 60_000,
  rounds: 6,
  // Measured 2026-11-01 on bakery's tasks of 1-2 h: 15 to 72 M tokens processed (cache
  // reads are nearly all of it).
  tokens: 100_000_000,
  // No default dollar cap: only a provider task the user gives `usd=` is limited by money.
  usd: 0,
};
export const TASK_BUDGET_WARN_PCT = 75;

/** A spec's text at most (project setting, --budget). */
export const TASK_BUDGET_SPEC_MAX = 200;

/**
 * Where a task's budget stands (TaskRecord.budget). The scheduler keeps `limits` resolved
 * (defaults, project, the task's own, what was added) so the phone and the CLI show them.
 */
export interface TaskBudget {
  /** The task's own spec (`ut task new --budget`), over the project's. */
  own?: TaskBudgetSpec;
  /** Added later (`ut task budget <id> +…`), on top of the resolved limits. */
  extra?: Partial<TaskBudgetLimits>;
  /** The limits in force (filled in by the scheduler). */
  limits: TaskBudgetLimits;
  warnPct: number;
  spent: TaskBudgetSpent;
  /** Up to when time was counted (ISO): the next count adds from here. */
  countedAt?: string;
  /** Limits whose warning went out (once each; raising a limit lets it warn again). */
  warned?: TaskBudgetKey[];
  /**
   * The cut (state needs_you, blocker 'budget'): which limits, when, and how to go on once
   * there is more: its agent was stopped mid-work (`working`), or a hand-back was held
   * (`handBack`: the blocker it was to fix, the reason and the state it stood in).
   */
  cut?: {
    at: string;
    keys: TaskBudgetKey[];
    working?: boolean;
    handBack?: {
      reason: 'review' | 'verify' | 'conflict' | 'merge-error';
      state: 'ready' | 'needs_you';
      blocker: { kind: string; message: string; detail?: string[]; agentFixable?: boolean };
    };
  };
  /** Tokens per agent conversation (transcript or rollout file name): summed into spent.tokens. */
  tokensBy?: Record<string, number>;
}

export function emptySpent(): TaskBudgetSpent {
  return { wall: 0, agent: 0, rounds: 0, tokens: 0, usd: 0 };
}

/** "5", "$5", "2.50", "10usd", "$0.50" → dollars. NaN when unreadable. */
export function parseBudgetUsd(text: string): number {
  const trimmed = text
    .trim()
    .toLowerCase()
    .replace(/^\$/, '')
    .replace(/(usd|\$|dollars?|d[oó]lares?)$/, '')
    .trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}

const UNITS_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "90m", "2h", "1h30m", "45s", "1d" → ms; a bare number is minutes. NaN when unreadable. */
export function parseBudgetDuration(text: string): number {
  const trimmed = text.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 60_000);
  const parts = trimmed.match(/^(?:(\d+(?:\.\d+)?)([smhd]))+$/);
  if (!parts) return Number.NaN;
  let total = 0;
  for (const [, amount, unit] of trimmed.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) {
    total += Number(amount) * (UNITS_MS[unit] ?? Number.NaN);
  }
  return Math.round(total);
}

/** "100M", "500k", "2.5m", "1g", "12000" → a count. NaN when unreadable. */
export function parseBudgetCount(text: string): number {
  const match = text
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)([kmg]?)$/);
  if (!match) return Number.NaN;
  const scale = { '': 1, k: 1e3, m: 1e6, g: 1e9 }[match[2]] ?? Number.NaN;
  return Math.round(Number(match[1]) * scale);
}

const ALIASES: Record<string, TaskBudgetKey | 'warn'> = {
  wall: 'wall',
  time: 'wall',
  clock: 'wall',
  agent: 'agent',
  rounds: 'rounds',
  round: 'rounds',
  vueltas: 'rounds',
  tokens: 'tokens',
  token: 'tokens',
  usd: 'usd',
  dollars: 'usd',
  dollar: 'usd',
  dolares: 'usd',
  dólares: 'usd',
  warn: 'warn',
  aviso: 'warn',
};

function parseValue(key: TaskBudgetKey, text: string): number {
  const lower = text.trim().toLowerCase();
  if (lower === 'off' || lower === 'none' || lower === 'no' || lower === '0') return 0;
  if (key === 'wall' || key === 'agent') return parseBudgetDuration(text);
  if (key === 'usd') return parseBudgetUsd(text);
  return parseBudgetCount(text);
}

/** Items of a spec: "wall=3h,agent=2h rounds=6". */
function items(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * A budget spec: `wall=3h,agent=2h,rounds=6,tokens=100M,warn=75` (any of them, comma or space
 * separated; 0/off = no limit). Throws with a readable message.
 */
export function parseBudgetSpec(text: string): TaskBudgetSpec {
  if (text.length > TASK_BUDGET_SPEC_MAX) throw new Error('budget spec too long');
  const spec: TaskBudgetSpec = { limits: {} };
  for (const item of items(text)) {
    const [rawKey, ...rest] = item.split('=');
    const key = ALIASES[rawKey.toLowerCase()];
    const value = rest.join('=');
    if (!key || !value) {
      throw new Error(
        `"${item}" is not a budget item: use wall=3h, agent=2h, rounds=6, tokens=100M, usd=5, warn=75`
      );
    }
    if (key === 'warn') {
      const pct = Number(value.replace(/%$/, ''));
      if (!Number.isInteger(pct) || pct < 1 || pct > 99) {
        throw new Error('warn is a percent between 1 and 99');
      }
      spec.warnPct = pct;
      continue;
    }
    const amount = parseValue(key, value);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`"${value}" is not a value for ${key}`);
    }
    spec.limits[key] = amount;
  }
  return spec;
}

/** Whether `text` is a budget spec (the project setting's validation). */
export function isBudgetSpec(text: string): boolean {
  try {
    parseBudgetSpec(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * More budget for a task (`ut task budget <id> …`): what to add to each limit.
 *  "+1h": wall and agent; "+3": rounds; "+50M": tokens; "+50%": every limit by half of it;
 *  "wall=+1h", "rounds=+2": one limit; "wall=5h": that limit becomes 5 h (no + = set).
 * Empty: +50% of the limits that were hit (`hit`), else of all. Returns the amounts to add,
 * computed against `limits` (the limits in force).
 */
export function parseBudgetExtension(
  text: string,
  limits: TaskBudgetLimits,
  hit: readonly TaskBudgetKey[] = []
): Partial<TaskBudgetLimits> {
  const add: Partial<TaskBudgetLimits> = {};
  const grow = (key: TaskBudgetKey, amount: number) => {
    add[key] = (add[key] ?? 0) + amount;
  };
  const byPct = (pct: number, keys: readonly TaskBudgetKey[]) => {
    for (const key of keys) {
      if (limits[key] > 0)
        grow(
          key,
          key === 'usd'
            ? Math.round(limits[key] * pct) / 100
            : Math.max(key === 'rounds' ? 1 : 0, Math.round((limits[key] * pct) / 100))
        );
    }
  };
  const list = items(text);
  if (!list.length) {
    byPct(50, hit.length ? hit : TASK_BUDGET_KEYS);
    return add;
  }
  for (const item of list) {
    const pct = item.match(/^\+(\d+)%$/);
    if (pct) {
      byPct(Number(pct[1]), TASK_BUDGET_KEYS);
      continue;
    }
    if (item.startsWith('+')) {
      const value = item.slice(1);
      // Tokens first: "5M" is 5 million, "5m" 5 minutes.
      if (/^\d+(\.\d+)?[kKMgG]$/.test(value)) {
        grow('tokens', parseBudgetCount(value));
        continue;
      }
      const ms = parseBudgetDuration(value);
      if (/[smhd]$/.test(value) && Number.isFinite(ms)) {
        grow('wall', ms);
        grow('agent', ms);
        continue;
      }
      const count = parseBudgetCount(value);
      if (Number.isFinite(count) && /^\d+$/.test(value) && count < 1000) {
        grow('rounds', count);
        continue;
      }
      throw new Error(`"${item}" is not an amount: +1h (time), +3 (rounds), +50M (tokens), +50%`);
    }
    const [rawKey, ...rest] = item.split('=');
    const key = ALIASES[rawKey.toLowerCase()];
    const value = rest.join('=');
    if (!key || key === 'warn' || !value) {
      throw new Error(`"${item}" is not a budget change: use wall=+1h, rounds=+2, tokens=+50M`);
    }
    const relative = value.startsWith('+');
    const amount = parseValue(key, relative ? value.slice(1) : value);
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error(`"${value}" is not a value for ${key}`);
    // Setting a limit: the difference to what is in force (0 = no limit is not a raise here).
    if (relative) grow(key, amount);
    else if (amount === 0) throw new Error(`${key}=0 would remove the limit: give a value`);
    else grow(key, amount - limits[key]);
  }
  return add;
}

/** The limits in force: defaults, the project's, the task's own, then what was added. */
export function resolveBudget(
  projectSpec: string | undefined,
  own: TaskBudgetSpec | undefined,
  extra: Partial<TaskBudgetLimits> | undefined
): { limits: TaskBudgetLimits; warnPct: number } {
  let project: TaskBudgetSpec = { limits: {} };
  if (projectSpec) {
    try {
      project = parseBudgetSpec(projectSpec);
    } catch {
      // Validated when set; an unreadable one counts as none.
    }
  }
  const limits = { ...TASK_BUDGET_DEFAULTS, ...project.limits, ...(own?.limits ?? {}) };
  for (const key of TASK_BUDGET_KEYS) {
    // A limit that is off stays off whatever was added to it.
    // At least 1 of its unit; dollars are the one fractional limit (2026-11-10: `usd=0.5`
    // became $1, twice what was asked).
    if (limits[key] > 0) {
      limits[key] = Math.max(key === 'usd' ? 0.01 : 1, limits[key] + (extra?.[key] ?? 0));
    }
  }
  return { limits, warnPct: own?.warnPct ?? project.warnPct ?? TASK_BUDGET_WARN_PCT };
}

/** "1h 20m", "45m", "30s". */
export function formatBudgetDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** "12.3M", "850k", "120". */
export function formatTokenCount(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(count >= 1e7 ? 0 : 1)}M`;
  if (count >= 1e3) return `${Math.round(count / 1e3)}k`;
  return String(Math.round(count));
}

/** "$1.20", "$0.05", "$12" (model-providers.ts task cost). */
export function formatBudgetUsd(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function formatBudgetValue(key: TaskBudgetKey, value: number): string {
  if (key === 'wall' || key === 'agent') return formatBudgetDuration(value);
  if (key === 'tokens') return formatTokenCount(value);
  if (key === 'usd') return formatBudgetUsd(value);
  return String(value);
}

/** Share of a limit spent (0..∞), 0 when the limit is off. */
export function budgetShare(
  budget: Pick<TaskBudget, 'limits' | 'spent'>,
  key: TaskBudgetKey
): number {
  const limit = budget.limits[key];
  return limit > 0 ? budget.spent[key] / limit : 0;
}

/** The limits reached (spent ≥ limit; rounds: past it, the round over the limit). */
export function budgetOver(budget: Pick<TaskBudget, 'limits' | 'spent'>): TaskBudgetKey[] {
  return TASK_BUDGET_KEYS.filter((key) => {
    const limit = budget.limits[key];
    if (!(limit > 0)) return false;
    return key === 'rounds' ? budget.spent.rounds > limit : budget.spent[key] >= limit;
  });
}

/** The limits at or past their warning level. */
export function budgetAtWarning(
  budget: Pick<TaskBudget, 'limits' | 'spent' | 'warnPct'>
): TaskBudgetKey[] {
  return TASK_BUDGET_KEYS.filter(
    (key) => budget.limits[key] > 0 && budgetShare(budget, key) * 100 >= budget.warnPct
  );
}

/**
 * "wall 2h 10m/3h · agent 1h/2h · rounds 2/6 · tokens 40M/100M" (CLI, notes, logs). A key with
 * no limit and nothing spent is left out, so `usd` shows only on a priced provider task.
 */
export function budgetLine(budget: Pick<TaskBudget, 'limits' | 'spent'>): string {
  return TASK_BUDGET_KEYS.filter((key) => budget.limits[key] > 0 || budget.spent[key] > 0)
    .map((key) => {
      const limit = budget.limits[key];
      const spent = formatBudgetValue(key, budget.spent[key]);
      return `${key} ${spent}/${limit > 0 ? formatBudgetValue(key, limit) : '∞'}`;
    })
    .join(' · ');
}
