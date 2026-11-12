/**
 * A task's phase timings (TaskRecord.timings): where the time between «ready» and «merged»
 * went (2026-10-31). Shared by the scheduler (recording), `ut task show` and the board.
 */
import type { TaskPhase, TaskPhaseTiming } from './tasks.js';

/** Timings kept per task: the oldest go first. */
export const TASK_TIMINGS_MAX = 80;

/** The order phases are listed in. */
export const TASK_PHASES: readonly TaskPhase[] = [
  'queue',
  'merge-queue',
  'verify',
  'review',
  'risk-review',
  'fix',
  'conflict',
  'merge',
];

/** Phases of the agent's own work (a hand-back): each one ends a round. */
const AGENT_PHASES: ReadonlySet<TaskPhase> = new Set(['fix', 'conflict']);

/** The round a pipeline run starts now: 1 + the hand-backs so far. */
export function currentRound(timings: readonly TaskPhaseTiming[] | undefined): number {
  return 1 + (timings ?? []).filter((t) => AGENT_PHASES.has(t.phase)).length;
}

/** Milliseconds a timing took; one still going counts up to `now`. Null when unreadable. */
export function timingMs(timing: TaskPhaseTiming, now = Date.now()): number | null {
  const start = Date.parse(timing.startedAt);
  const end = timing.finishedAt ? Date.parse(timing.finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/** "4m 38s", "9s", "1h 2m". */
export function formatPhaseDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export interface PhaseTotal {
  phase: TaskPhase;
  ms: number;
  /** Times it ran. */
  count: number;
}

export interface TimingSummary {
  /** Per phase, in TASK_PHASES order, only the phases that ran. */
  phases: PhaseTotal[];
  rounds: number;
  /** First start to last end (phases may overlap: the check and the review run together). */
  wallMs: number;
}

export function summarizeTimings(
  timings: readonly TaskPhaseTiming[] | undefined,
  now = Date.now()
): TimingSummary | null {
  const list = timings ?? [];
  if (!list.length) return null;
  const totals = new Map<TaskPhase, PhaseTotal>();
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  for (const timing of list) {
    const ms = timingMs(timing, now);
    if (ms === null) continue;
    const total = totals.get(timing.phase) ?? { phase: timing.phase, ms: 0, count: 0 };
    total.ms += ms;
    total.count += 1;
    totals.set(timing.phase, total);
    const start = Date.parse(timing.startedAt);
    first = Math.min(first, start);
    last = Math.max(last, start + ms);
  }
  if (!totals.size) return null;
  return {
    phases: TASK_PHASES.flatMap((phase) => totals.get(phase) ?? []),
    rounds: Math.max(...list.map((t) => t.round)),
    wallMs: Math.max(0, last - first),
  };
}

/** Appends `entries`, keeping at most TASK_TIMINGS_MAX (the oldest go). */
export function withTimings(
  timings: readonly TaskPhaseTiming[] | undefined,
  entries: readonly TaskPhaseTiming[]
): TaskPhaseTiming[] {
  return [...(timings ?? []), ...entries].slice(-TASK_TIMINGS_MAX);
}
