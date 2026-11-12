import { describe, expect, it } from 'vitest';
import {
  currentRound,
  formatPhaseDuration,
  summarizeTimings,
  TASK_TIMINGS_MAX,
  withTimings,
} from './task-timings.js';
import type { TaskPhaseTiming } from './tasks.js';

const at = (sec: number) => new Date(Date.UTC(2026, 9, 31, 13, 0, sec)).toISOString();

describe('task timings (2026-10-31)', () => {
  it('a round ends with each hand-back to the agent', () => {
    expect(currentRound(undefined)).toBe(1);
    const timings: TaskPhaseTiming[] = [
      { phase: 'verify', startedAt: at(0), finishedAt: at(10), round: 1 },
      { phase: 'conflict', startedAt: at(10), round: 1 },
    ];
    expect(currentRound(timings)).toBe(2);
  });

  it('sums each phase, counts the rounds and the wall time across overlapping phases', () => {
    const summary = summarizeTimings(
      [
        { phase: 'review', startedAt: at(0), finishedAt: at(30), round: 1 },
        { phase: 'verify', startedAt: at(0), finishedAt: at(280), round: 1 },
        { phase: 'fix', startedAt: at(280), round: 1 },
      ],
      Date.parse(at(400))
    );
    expect(summary).toEqual({
      phases: [
        { phase: 'verify', ms: 280_000, count: 1 },
        { phase: 'review', ms: 30_000, count: 1 },
        { phase: 'fix', ms: 120_000, count: 1 },
      ],
      rounds: 1,
      wallMs: 400_000,
    });
    expect(summarizeTimings([])).toBeNull();
  });

  it('keeps at most TASK_TIMINGS_MAX, the newest', () => {
    const many = Array.from({ length: TASK_TIMINGS_MAX + 5 }, (_, i) => ({
      phase: 'verify' as const,
      startedAt: at(i),
      finishedAt: at(i + 1),
      round: i + 1,
    }));
    const kept = withTimings([], many);
    expect(kept).toHaveLength(TASK_TIMINGS_MAX);
    expect(kept[kept.length - 1]?.round).toBe(TASK_TIMINGS_MAX + 5);
  });

  it('formats durations the short way', () => {
    expect(formatPhaseDuration(9_400)).toBe('9s');
    expect(formatPhaseDuration(278_000)).toBe('4m 38s');
    expect(formatPhaseDuration(120_000)).toBe('2m');
    expect(formatPhaseDuration(3_720_000)).toBe('1h 2m');
  });
});
