// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { waitForCondition } from '@/test/utils/component-helpers';
import { type MockRenderer, MockResizeObserver, MockTerminal } from '@/test/utils/terminal-mocks';
import { outputChunks } from './terminal';
import { bandSharpness, canvasSizeMismatch, describeCanvas } from './terminal-canvas-health';

/** The next terminal made throws on its first write, as ghostty did on a 16 MB one. */
const writes = vi.hoisted(() => ({ failFirst: false }));

vi.mock('ghostty-web', async () => {
  const mocks = await import('@/test/utils/terminal-mocks');
  class FailingWriteTerminal extends mocks.MockTerminal {
    constructor(...args: ConstructorParameters<typeof mocks.MockTerminal>) {
      super(...args);
      if (writes.failFirst) {
        writes.failFirst = false;
        this.write.mockImplementationOnce(() => {
          throw new RangeError('Offset should not be negative');
        });
      }
    }
  }
  return { Terminal: FailingWriteTerminal, FitAddon: mocks.MockFitAddon };
});
vi.mock('../services/server-config-service.js', () => ({
  serverConfigService: { loadConfig: vi.fn(async () => ({})) },
}));

global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

import type { Terminal } from './terminal';

function setPixelRatio(ratio: number) {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ratio });
}

const sized = (width: number, height: number, cssWidth: string, cssHeight: string) => ({
  width,
  height,
  style: { width: cssWidth, height: cssHeight },
});
const cell = { width: 5, height: 10 };

describe('canvasSizeMismatch', () => {
  it('is false for a canvas ghostty sized at the ratio', () => {
    expect(canvasSizeMismatch(sized(1200, 2160, '400px', '720px'), 80, 72, cell, 3)).toBe(false);
  });

  it("catches the 1x pixels ghostty's resize and font change leave", () => {
    expect(canvasSizeMismatch(sized(400, 720, '400px', '720px'), 80, 72, cell, 3)).toBe(true);
  });

  it('catches a CSS size for other cells', () => {
    expect(canvasSizeMismatch(sized(1200, 2160, '450px', '720px'), 80, 72, cell, 3)).toBe(true);
  });

  it('takes the whole pixels a canvas keeps at a fractional ratio', () => {
    // 80 × 5 × 2.625 = 1050, 72 × 10 × 2.625 = 1890; 81 cells: 1063.125 kept as 1063.
    expect(canvasSizeMismatch(sized(1063, 1890, '405px', '720px'), 81, 72, cell, 2.625)).toBe(
      false
    );
  });

  it('takes a fractional CSS size as the browser gives it back, rounded', () => {
    // Touch cells 22/3 px wide (terminal-touch-cells.ts): 80 of them are 586.6666666666666 px,
    // read back as "586.667px"; as strings, the canvas was resized on every frame.
    const touchCell = { width: 22 / 3, height: 14 };
    expect(canvasSizeMismatch(sized(1760, 882, '586.667px', '294px'), 80, 21, touchCell, 3)).toBe(
      false
    );
    expect(canvasSizeMismatch(sized(1760, 882, '593.333px', '294px'), 80, 21, touchCell, 3)).toBe(
      true
    );
  });

  it('says nothing without a grid or cells', () => {
    expect(canvasSizeMismatch(sized(0, 0, '', ''), 0, 0, cell, 3)).toBe(false);
    expect(canvasSizeMismatch(sized(0, 0, '', ''), 80, 24, { width: 0, height: 0 }, 3)).toBe(false);
  });
});

describe('bandSharpness', () => {
  /** A band of `rows` rows from one row of luminance. */
  const band = (row: number[], rows = 3) => Array.from({ length: rows }, () => row).flat();
  /** Black and white strokes, `stretch` pixels for each one drawn. */
  const strokes = (stretch: number) => {
    const row: number[] = [];
    for (let i = 0; i < 40; i++) {
      const value = i % 4 < 2 ? 0 : 255;
      for (let s = 0; s < stretch; s++) row.push(value);
    }
    if (stretch === 1) return row;
    // Stretched as a browser scales a bitmap: linear between the drawn pixels.
    return row.map((_, x) => {
      const at = x / stretch;
      const i = Math.floor(at);
      const t = at - i;
      const a = i % 4 < 2 ? 0 : 255;
      const b = (i + 1) % 4 < 2 ? 0 : 255;
      return a + (b - a) * t;
    });
  };

  it('tells hard edges from a bitmap stretched 3x', () => {
    const sharp = bandSharpness(band(strokes(3).map((v) => (v > 127 ? 255 : 0))), 120, 3);
    const soft = bandSharpness(band(strokes(3)), 120, 3);
    expect(sharp).toBeGreaterThan(1.8);
    expect(soft).toBeLessThan(1.35);
  });

  it('is null for a band with no edges', () => {
    expect(bandSharpness(band(Array.from({ length: 50 }, () => 30)), 50, 3)).toBeNull();
  });
});

describe('outputChunks', () => {
  it('keeps short output whole', () => {
    expect(outputChunks('abc', 10)).toEqual(['abc']);
  });

  it('cuts long output into pieces that join back to it', () => {
    const text = 'x'.repeat(25);
    const chunks = outputChunks(text, 10);
    expect(chunks.map((c) => c.length)).toEqual([10, 10, 5]);
    expect(chunks.join('')).toBe(text);
  });

  it('never ends a piece between the halves of a surrogate pair', () => {
    const text = `${'a'.repeat(9)}😀${'b'.repeat(10)}`;
    const chunks = outputChunks(text, 10);
    expect(chunks[0]).toBe('a'.repeat(9));
    expect(chunks[1].startsWith('😀')).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});

describe('the terminal canvas after a cold start', () => {
  let element: Terminal | null = null;

  beforeAll(async () => {
    await import('./terminal');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    element?.remove();
    element = null;
    MockTerminal.withRenderer = false;
    writes.failFirst = false;
    setPixelRatio(1);
  });

  async function openAt(ratio: number) {
    setPixelRatio(ratio);
    MockTerminal.withRenderer = true;
    element = await fixture<Terminal>(html`<ut-terminal session-id="canvas-1"></ut-terminal>`);
    const el = element;
    await waitForCondition(() => el.getAttribute('data-ready') === 'true', {
      message: 'terminal not ready',
    });
    const term = (el as unknown as { terminal: MockTerminal }).terminal;
    const renderer = term.renderer as MockRenderer;
    const canvas = renderer.getCanvas() as HTMLCanvasElement;
    term.wasmTerm.isDirty.mockReturnValue(false);
    const frame = () => renderer.render(term.wasmTerm, false, 0, term);
    frame();
    renderer.paint.mockClear();
    renderer.resize.mockClear();
    return { el, term, renderer, canvas, frame };
  }

  /** What ghostty's Terminal.resize does after its renderer sized the canvas: pixels at 1x. */
  function leaveAt1x(canvas: HTMLCanvasElement) {
    canvas.width = Number.parseFloat(canvas.style.width);
    canvas.height = Number.parseFloat(canvas.style.height);
  }

  it('sizes a canvas left at 1x on the next frame, though nothing changed, and redraws it', async () => {
    const { renderer, canvas, frame } = await openAt(3);
    expect(canvas.width).toBe(80 * 9 * 3);
    leaveAt1x(canvas);

    frame();
    expect(renderer.resize).toHaveBeenCalledWith(80, 24);
    expect(canvas.width).toBe(80 * 9 * 3);
    expect(canvas.height).toBe(24 * 18 * 3);
    expect(renderer.paint).toHaveBeenCalledTimes(1);
    expect(renderer.paint.mock.calls[0]?.[1]).toBe(true);

    // Then unchanged frames are skipped again.
    frame();
    expect(renderer.paint).toHaveBeenCalledTimes(1);
  });

  it('sizes it while a replay holds the paint, and paints every row when let go', async () => {
    const { el, renderer, canvas, frame } = await openAt(3);
    el.holdPaint();
    leaveAt1x(canvas);

    frame();
    expect(canvas.width).toBe(80 * 9 * 3);
    expect(renderer.paint).not.toHaveBeenCalled();

    el.releasePaint();
    expect(renderer.paint).toHaveBeenCalledTimes(1);
    expect(renderer.paint.mock.calls[0]?.[1]).toBe(true);
  });

  it('remakes the canvas a while after a replay is let go: off its layer for a frame, sized and drawn again', async () => {
    const { el, renderer, canvas } = await openAt(3);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    el.holdPaint();
    el.releasePaint();
    renderer.paint.mockClear();
    renderer.resize.mockClear();

    vi.advanceTimersByTime(1000);
    expect(canvas.style.transform).toBe('none');
    expect(renderer.resize).not.toHaveBeenCalled();
    // The canvas as it was, in the log.
    const report = warn.mock.calls
      .map((call) => call.join(' '))
      .find((l) => l.includes('released'));
    expect(report).toContain('canvas 2160x1296');
    expect(report).toContain('dpr 3 renderer 3');
    expect(report).toContain('size mismatch false');

    vi.advanceTimersByTime(40);
    expect(canvas.style.transform).toBe('translate3d(0, 0px, 0)');
    expect(renderer.resize).toHaveBeenCalledWith(80, 24);
    expect(renderer.paint).toHaveBeenCalledTimes(1);
    expect(renderer.paint.mock.calls[0]?.[1]).toBe(true);
  });

  it('remakes the canvas when the page is shown again', async () => {
    const { renderer, canvas } = await openAt(3);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    window.dispatchEvent(new Event('pageshow'));
    expect(canvas.style.transform).toBe('none');
    vi.advanceTimersByTime(40);
    expect(canvas.style.transform).toBe('translate3d(0, 0px, 0)');
    expect(renderer.paint.mock.calls.some((call) => call[1] === true)).toBe(true);
  });

  it('waits for a canvas shifted between rows to settle before remaking it', async () => {
    const { el, renderer, canvas } = await openAt(3);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    const view = el as unknown as { canvasShift: number; renewCanvas: () => void };
    view.canvasShift = 4;
    view.renewCanvas();
    expect(canvas.style.transform).not.toBe('none');
    view.canvasShift = 0;
    vi.advanceTimersByTime(500);
    expect(canvas.style.transform).toBe('none');
    vi.advanceTimersByTime(40);
    expect(renderer.resize).toHaveBeenCalled();
  });

  it('writes a long buffered replay in pieces, and one that fails does not stop the terminal opening', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writes.failFirst = true;
    const pending = document.createElement('ut-terminal') as Terminal;
    pending.setAttribute('session-id', 'canvas-2');
    const replay = 'y'.repeat(600 * 1024);
    pending.write(replay);
    document.body.appendChild(pending);
    element = pending;
    await waitForCondition(() => pending.getAttribute('data-ready') === 'true', {
      message: 'terminal not ready after a failed write',
    });
    const term = (pending as unknown as { terminal: MockTerminal }).terminal;
    const written = term.write.mock.calls.map((call) => String(call[0]));
    expect(written.length).toBe(3);
    expect(Math.max(...written.map((w) => w.length))).toBeLessThanOrEqual(256 * 1024);
    expect(written.join('')).toBe(replay);
    expect((pending as unknown as { resizeObserver: unknown }).resizeObserver).not.toBeNull();
  });
});

describe('describeCanvas', () => {
  it('reports sizes, ratio and the layers above in one line', () => {
    const host = document.createElement('div');
    host.style.transform = 'scale(0.5)';
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 720;
    canvas.style.width = '400px';
    canvas.style.height = '720px';
    host.appendChild(canvas);
    document.body.appendChild(host);
    setPixelRatio(3);
    const line = describeCanvas({
      canvas,
      cols: 80,
      rows: 72,
      metrics: cell,
      rendererRatio: 3,
      fontSize: 7.75,
      paintHeld: false,
      followingPty: '80xfit',
    });
    expect(line).not.toContain('\n');
    expect(line).toContain('canvas 400x720');
    expect(line).toContain('size mismatch true');
    expect(line).toContain('grid 80x72 font 7.75 cell 5x10');
    expect(line).toContain('pty 80xfit');
    expect(line).toContain('div{transform scale(0.5)}');
    host.remove();
    setPixelRatio(1);
  });
});
