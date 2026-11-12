// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyEdgeFix,
  DEFAULT_EDGE_FIX,
  EDGE_FIX_KEY,
  nextEdgeFix,
  parseEdgeFix,
  readEdgeFix,
} from './edge-fix.js';

describe('edge-fix switch', () => {
  afterEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    document.documentElement.removeAttribute('data-edge-fix');
  });

  it('pads by default and ignores unknown values', () => {
    expect(DEFAULT_EDGE_FIX).toBe('pad');
    expect(parseEdgeFix(null)).toBe('pad');
    expect(parseEdgeFix('blur')).toBe('pad');
    expect(parseEdgeFix('sticky')).toBe('sticky');
  });

  it('cycles pad, sticky, off on each long press', () => {
    expect(nextEdgeFix('pad')).toBe('sticky');
    expect(nextEdgeFix('sticky')).toBe('off');
    expect(nextEdgeFix('off')).toBe('pad');
  });

  it('stores the mode and applies it at once', () => {
    applyEdgeFix('off');
    expect(localStorage.setItem).toHaveBeenCalledWith(EDGE_FIX_KEY, 'off');
    expect(document.documentElement.getAttribute('data-edge-fix')).toBe('off');
    vi.mocked(localStorage.getItem).mockReturnValue('off');
    expect(readEdgeFix()).toBe('off');
  });

  // viewport-init.js applies the stored mode at boot, with its own copy of the parsing.
  it.each(['pad', 'sticky', 'off', 'bogus', null])(
    'boots with the same mode as the app (%s)',
    (stored) => {
      vi.mocked(localStorage.getItem).mockImplementation((key) =>
        key === EDGE_FIX_KEY ? stored : null
      );
      new Function(readFileSync(join(__dirname, '../assets/viewport-init.js'), 'utf8'))();
      expect(document.documentElement.getAttribute('data-edge-fix')).toBe(parseEdgeFix(stored));
    }
  );
});
