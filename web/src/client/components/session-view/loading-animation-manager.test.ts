/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadingAnimationManager } from './loading-animation-manager';

describe('LoadingAnimationManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cycles through every spinner glyph (2026-11-10: frames 4-9 never showed)', () => {
    vi.useFakeTimers();
    const manager = new LoadingAnimationManager();
    manager.startLoading();

    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      seen.add(manager.getLoadingText());
      vi.advanceTimersByTime(200);
    }

    expect(seen.size).toBe(10);
    // After a full turn it starts over at the first glyph.
    expect(manager.getLoadingText()).toBe('⠋');
    manager.cleanup();
  });

  it('stops animating and reports not loading after stopLoading', () => {
    vi.useFakeTimers();
    const onUpdate = vi.fn();
    const manager = new LoadingAnimationManager();
    manager.startLoading(onUpdate);
    expect(manager.isLoading()).toBe(true);

    vi.advanceTimersByTime(400);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    manager.stopLoading();
    vi.advanceTimersByTime(1000);
    expect(manager.isLoading()).toBe(false);
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });
});
