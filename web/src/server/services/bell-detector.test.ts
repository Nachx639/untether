import { describe, expect, it } from 'vitest';
import { BellDetector } from './bell-detector.js';

describe('BellDetector', () => {
  it('ignores the BEL that ends a window-title update', () => {
    const d = new BellDetector();
    // What Claude Code prints about once a second while working.
    expect(d.feed('\x1b]0;✳ Fixing the bug\x07')).toBe(false);
    expect(d.feed('\x1b]2;title\x07text')).toBe(false);
    expect(d.feed('\x1bPdcs\x1b\\')).toBe(false);
  });

  it('detects a bare bell, also right after a title update', () => {
    const d = new BellDetector();
    expect(d.feed('done\x07')).toBe(true);
    expect(d.feed('\x1b]0;t\x07\x07')).toBe(true);
  });

  it('keeps state across chunks', () => {
    const d = new BellDetector();
    expect(d.feed('\x1b]0;long ti')).toBe(false);
    expect(d.feed('tle\x07')).toBe(false);
    expect(d.feed('\x1b')).toBe(false);
    expect(d.feed(']0;x\x07')).toBe(false);
    expect(d.feed('\x07')).toBe(true);
  });
});
