/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisibilityPoller } from './visibility-poller.js';

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('VisibilityPoller', () => {
  let poller: VisibilityPoller | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  });

  afterEach(() => {
    poller?.stop();
    poller = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls once a second while visible: 60 requests per minute', async () => {
    const task = vi.fn(async () => {});
    poller = new VisibilityPoller({ task, nextDelay: () => 1000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(60);
  });

  it('makes no request while hidden and polls at once when shown again', async () => {
    const task = vi.fn(async () => {});
    poller = new VisibilityPoller({ task, nextDelay: () => 1000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(task).toHaveBeenCalledTimes(3);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(task).toHaveBeenCalledTimes(3);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(5);
  });

  it('never overlaps requests when the network is slower than the interval', async () => {
    let active = 0;
    let maxActive = 0;
    const task = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      active--;
    });
    poller = new VisibilityPoller({ task, nextDelay: () => 1000 });
    poller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(maxActive).toBe(1);
    // 1 s wait + 2.5 s request per cycle.
    expect(task.mock.calls.length).toBeLessThanOrEqual(18);
  });

  it('joins a poll already in flight instead of starting another', async () => {
    let resolve!: () => void;
    const task = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    poller = new VisibilityPoller({ task, nextDelay: () => 1000 });
    poller.start();
    const first = poller.pollNow();
    const second = poller.pollNow();
    expect(task).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.all([first, second]);
  });

  it('passes the run of unchanged polls to nextDelay and resets it on a change', async () => {
    const results = [false, false, false, true, false];
    const streaks: number[] = [];
    poller = new VisibilityPoller({
      task: async () => results.shift() ?? false,
      nextDelay: (streak) => {
        streaks.push(streak);
        return 1000;
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(streaks).toEqual([0, 1, 2, 3, 0, 1]);
  });

  it('stops for good', async () => {
    const task = vi.fn(async () => {});
    poller = new VisibilityPoller({ task, nextDelay: () => 1000 });
    poller.start();
    poller.stop();
    setVisibility('hidden');
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).not.toHaveBeenCalled();
  });
});
