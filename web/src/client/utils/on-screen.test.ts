// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOnScreen } from './on-screen.js';

type Box = { left: number; top: number; width: number; height: number };

function boxed(el: HTMLElement, box: Box) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => ({}),
  } as DOMRect);
}

describe('isOnScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function pillIn(strip: Box, pill: Box) {
    const container = document.createElement('div');
    container.style.overflowX = 'auto';
    const el = document.createElement('button');
    container.appendChild(el);
    document.body.appendChild(container);
    boxed(container, strip);
    boxed(el, pill);
    return el;
  }

  it('a pill inside the viewport and its strip is on screen', () => {
    const el = pillIn(
      { left: 0, top: 0, width: 300, height: 40 },
      { left: 10, top: 5, width: 80, height: 30 }
    );
    expect(isOnScreen(el)).toBe(true);
  });

  it('a pill scrolled out of its strip is not', () => {
    const el = pillIn(
      { left: 0, top: 0, width: 300, height: 40 },
      { left: 400, top: 5, width: 80, height: 30 }
    );
    expect(isOnScreen(el)).toBe(false);
  });

  it('a pill mostly clipped by its strip is not', () => {
    const el = pillIn(
      { left: 0, top: 0, width: 300, height: 40 },
      { left: 280, top: 5, width: 80, height: 30 }
    );
    expect(isOnScreen(el)).toBe(false);
  });

  it('a pill below the fold is not', () => {
    const el = pillIn(
      { left: 0, top: window.innerHeight + 10, width: 300, height: 40 },
      { left: 10, top: window.innerHeight + 15, width: 80, height: 30 }
    );
    expect(isOnScreen(el)).toBe(false);
  });

  it('an element with no box (display: none) is not', () => {
    const el = pillIn(
      { left: 0, top: 0, width: 300, height: 40 },
      { left: 0, top: 0, width: 0, height: 0 }
    );
    expect(isOnScreen(el)).toBe(false);
  });
});
