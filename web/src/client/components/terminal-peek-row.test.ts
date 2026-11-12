// @vitest-environment happy-dom
import type { GhosttyCell } from 'ghostty-web';
import { describe, expect, it, vi } from 'vitest';
import { paintCellRow } from './terminal-peek-row';

const cell = (char: string, extra: Partial<GhosttyCell> = {}): GhosttyCell => ({
  codepoint: char.codePointAt(0) ?? 0,
  fg_r: 200,
  fg_g: 200,
  fg_b: 200,
  bg_r: 0,
  bg_g: 0,
  bg_b: 0,
  flags: 0,
  width: 1,
  hyperlink_id: 0,
  grapheme_len: 0,
  ...extra,
});

/** A 2D context that records what was drawn, with the style in effect at each call. */
function recordingContext() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    globalAlpha: 1,
    lineWidth: 1,
    textBaseline: '',
    textAlign: '',
    fillRect: vi.fn((x: number, y: number, w: number, h: number) =>
      calls.push(`rect ${ctx.fillStyle} ${x},${y} ${w}x${h}`)
    ),
    fillText: vi.fn((text: string, x: number, y: number) =>
      calls.push(`text "${text}" ${ctx.fillStyle} ${ctx.font} a${ctx.globalAlpha} ${x},${y}`)
    ),
    beginPath: vi.fn(),
    moveTo: vi.fn((x: number, y: number) => calls.push(`line ${x},${y}`)),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  };
  return { ctx, calls };
}

describe('paintCellRow', () => {
  it('paints a row the way ghostty-web paints one', () => {
    const { ctx, calls } = recordingContext();
    paintCellRow(
      ctx as unknown as CanvasRenderingContext2D,
      [
        cell('a'),
        cell('b', { flags: 1 | 2, bg_r: 10, bg_g: 20, bg_b: 30 }), // bold italic, own background
        cell('c', { flags: 16 }), // inverse: black on the light color
        cell('d', { flags: 128 }), // faint
        cell('e', { flags: 32 }), // invisible
        cell('世', { width: 2 }),
        cell('', { width: 0 }), // the wide glyph's second cell
        cell('u', { flags: 4 }), // underline
      ],
      10,
      { width: 9, height: 18, baseline: 14 },
      { size: 15, family: 'monospace' },
      '#101010'
    );
    expect(calls).toEqual([
      'rect #101010 0,0 90x18',
      'rect rgb(10, 20, 30) 9,0 9x18',
      'rect rgb(200, 200, 200) 18,0 9x18',
      'text "a" rgb(200, 200, 200) 15px monospace a1 0,14',
      'text "b" rgb(200, 200, 200) italic bold 15px monospace a1 9,14',
      'text "c" rgb(0, 0, 0) 15px monospace a1 18,14',
      'text "d" rgb(200, 200, 200) 15px monospace a0.5 27,14',
      'text "世" rgb(200, 200, 200) 15px monospace a1 45,14',
      'text "u" rgb(200, 200, 200) 15px monospace a1 63,14',
      'line 63,16',
    ]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('paints a cell of several code points as its whole cluster', () => {
    const { ctx } = recordingContext();
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    paintCellRow(
      ctx as unknown as CanvasRenderingContext2D,
      [cell('a'), cell('\u{1F468}', { grapheme_len: 4, width: 2 }), cell('', { width: 0 })],
      3,
      { width: 9, height: 18, baseline: 14 },
      { size: 15, family: 'monospace' },
      '#000',
      (col) => (col === 1 ? family : '?')
    );
    expect(ctx.fillText).toHaveBeenCalledWith('a', 0, 14);
    expect(ctx.fillText).toHaveBeenCalledWith(family, 9, 14);
    // Without the lookup it shows its first code point, as before.
    const plain = recordingContext();
    paintCellRow(
      plain.ctx as unknown as CanvasRenderingContext2D,
      [cell('\u{1F468}', { grapheme_len: 4 })],
      1,
      { width: 9, height: 18, baseline: 14 },
      { size: 15, family: 'monospace' },
      '#000'
    );
    expect(plain.ctx.fillText).toHaveBeenCalledWith('\u{1F468}', 0, 14);
  });

  it('paints an empty cell as a space', () => {
    const { ctx } = recordingContext();
    paintCellRow(
      ctx as unknown as CanvasRenderingContext2D,
      [cell('', { codepoint: 0 })],
      1,
      { width: 9, height: 18, baseline: 14 },
      { size: 15, family: 'monospace' },
      '#000'
    );
    expect(ctx.fillText).toHaveBeenCalledWith(' ', 0, 14);
  });
});
