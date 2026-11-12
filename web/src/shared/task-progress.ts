/**
 * How a working task's last real progress reads (2026-11-02, TaskRecord.progress): in the
 * stall notes, the hourly "still working" note and `ut task status`.
 */
import type { TaskFailureNudge, TaskProgressMark, TaskProgressSource } from './tasks.js';

/** "15:54" in the local time zone. */
export function clockOf(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export const PROGRESS_WORDS: Record<TaskProgressSource, string> = {
  agent: 'its own output or a tool result',
  files: 'a file it changed',
  commit: 'a commit',
  start: 'none since this spell of work began',
};

/** "15:54 (25 min ago, a commit)". */
export function progressLine(mark: Pick<TaskProgressMark, 'at' | 'by'>, now: number): string {
  const at = Date.parse(mark.at);
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return `${clockOf(at)} (${minutes} min ago, ${PROGRESS_WORDS[mark.by]})`;
}

/** Failure-loop nudges kept per task (TaskRecord.failureNudges): the oldest go first. */
export const TASK_FAILURE_NUDGES_KEPT = 20;

/**
 * "2 nudge(s) for a repeated failure: 1 recovered, 1 escalated" (2026-11-03): in `ut task
 * status` and in the result its orchestrator gets. Undefined without any.
 */
export function failureNudgesLine(
  nudges: readonly TaskFailureNudge[] | undefined
): string | undefined {
  if (!nudges?.length) return undefined;
  const recovered = nudges.filter((nudge) => nudge.outcome === 'recovered').length;
  const escalated = nudges.filter((nudge) => nudge.outcome === 'escalated').length;
  const open = nudges.length - recovered - escalated;
  const parts = [
    ...(recovered ? [`${recovered} recovered`] : []),
    ...(escalated ? [`${escalated} escalated`] : []),
    ...(open ? [`${open} still open`] : []),
  ];
  return `${nudges.length} nudge(s) for a repeated failure: ${parts.join(', ')}`;
}

/** One nudge: "15:54 Bash `pnpm test` ×3: «Error: x» → recovered (1 more failure)". */
export function failureNudgeLine(nudge: TaskFailureNudge): string {
  const outcome = nudge.outcome ?? 'still open';
  return `${clockOf(Date.parse(nudge.at))} ${nudge.tool} \`${nudge.command}\` ×${nudge.repeats}: «${nudge.errorLine}» → ${outcome} (${nudge.after} identical failure(s) after it)`;
}
