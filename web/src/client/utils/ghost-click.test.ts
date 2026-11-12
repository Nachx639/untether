// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { isSwallowingGhostClick, resetGhostClickGuard, swallowNextClick } from './ghost-click.js';

describe('ghost click guard', () => {
  afterEach(() => resetGhostClickGuard());

  it("swallows the click that finishes a tap, and nothing of a new touch's", () => {
    swallowNextClick();
    expect(isSwallowingGhostClick()).toBe(true);
    const ghost = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(ghost);
    expect(ghost.defaultPrevented).toBe(true);
    expect(isSwallowingGhostClick()).toBe(false);
  });

  it('ends with a new touch, so a real tap right after one that never got a click works', () => {
    // A swipe closing the lightbox or a long press sets the guard and never gets a click:
    // a tap on the search or keyboard button within 700 ms was lost (review of 2026-10-03).
    swallowNextClick();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(isSwallowingGhostClick()).toBe(false);
    const real = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(real);
    expect(real.defaultPrevented).toBe(false);
  });
});
