import { describe, expect, it } from 'vitest';
import { isShortPane } from './short-pane.js';

describe('isShortPane', () => {
  it('is short under a split preview on a small phone', () => {
    expect(isShortPane(667, 300)).toBe(true);
    expect(isShortPane(956, 400)).toBe(false);
  });

  it('is short with the keyboard open on an iPhone SE, not on a big phone', () => {
    // SE in Safari: ~548 px without the keyboard, ~330 px with it.
    expect(isShortPane(548, 0)).toBe(false);
    expect(isShortPane(330, 0)).toBe(true);
    // Pro Max with the keyboard: still room for the full chat.
    expect(isShortPane(560, 0)).toBe(false);
  });

  it('a phone in landscape is short', () => {
    expect(isShortPane(375, 0)).toBe(true);
  });
});
