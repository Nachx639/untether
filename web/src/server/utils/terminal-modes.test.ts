import { describe, expect, it } from 'vitest';
import { decModesToSequence, trackDecModes } from './terminal-modes.js';

describe('terminal mode tracking', () => {
  it('keeps the latest state of the modes clients need and restores them', () => {
    const modes: Record<string, boolean> = {};

    expect(trackDecModes(modes, 'hi\x1b[?1000h\x1b[?1002;1006h\x1b[?2004h\x1b[?1049h')).toBe(true);
    expect(trackDecModes(modes, '\x1b[?1002l plain text')).toBe(true);
    expect(trackDecModes(modes, '\x1b[?1000h')).toBe(false);

    // 1049 (alternate screen) is not restored: replay prunes around it.
    expect(modes).toEqual({ '1000': true, '1002': false, '1006': true, '2004': true });
    expect(decModesToSequence(modes)).toBe('\x1b[?1000h\x1b[?1002l\x1b[?1006h\x1b[?2004h');
  });

  it('forgets modes on a full or soft terminal reset', () => {
    for (const reset of ['\x1bc', '\x1b[!p']) {
      const modes: Record<string, boolean> = {};
      trackDecModes(modes, '\x1b[?1000h\x1b[?2004h');
      expect(trackDecModes(modes, `${reset}\x1b[?25h`)).toBe(true);
      expect(modes).toEqual({ '25': true });
    }
  });

  it('restores only the modes it tracks, whatever session.json holds', () => {
    expect(
      decModesToSequence({ '1000': true, '1049': true, '9;rm -rf': true, '2004': 'yes' } as never)
    ).toBe('\x1b[?1000h');
  });

  it('applies a sequence once its chunks are rejoined', () => {
    const modes: Record<string, boolean> = {};
    expect(trackDecModes(modes, 'out\x1b[?10')).toBe(false);
    expect(trackDecModes(modes, 'out\x1b[?10' + '06h more')).toBe(true);
    expect(modes).toEqual({ '1006': true });
  });
});
