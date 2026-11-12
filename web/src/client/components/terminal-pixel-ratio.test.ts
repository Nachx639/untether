// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { waitForCondition } from '@/test/utils/component-helpers';
import {
  MockFitAddon,
  type MockRenderer,
  MockResizeObserver,
  MockTerminal,
} from '@/test/utils/terminal-mocks';
import { currentPixelRatio, syncRendererPixelRatio } from './terminal-pixel-ratio';

vi.mock('ghostty-web', () => ({
  Terminal: MockTerminal,
  FitAddon: MockFitAddon,
}));
vi.mock('../services/server-config-service.js', () => ({
  serverConfigService: { loadConfig: vi.fn(async () => ({})) },
}));

global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

import type { Terminal } from './terminal';

/** The page's pixel ratio as the test sets it (a cold-launched web view, then the screen's). */
function setPixelRatio(ratio: number) {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: ratio });
}

describe('syncRendererPixelRatio', () => {
  it("brings the renderer's ratio to the page's and says what it was", () => {
    const renderer = { devicePixelRatio: 1 };
    expect(syncRendererPixelRatio(renderer, 3)).toBe(1);
    expect(renderer.devicePixelRatio).toBe(3);
    expect(syncRendererPixelRatio(renderer, 3)).toBeNull();
  });

  it('leaves a renderer without a ratio alone', () => {
    const renderer: { devicePixelRatio?: number } = {};
    expect(syncRendererPixelRatio(renderer, 3)).toBeNull();
    expect(renderer.devicePixelRatio).toBeUndefined();
    expect(syncRendererPixelRatio(null, 3)).toBeNull();
  });

  it('takes 1 for a page without a usable ratio', () => {
    setPixelRatio(0);
    expect(currentPixelRatio()).toBe(1);
    setPixelRatio(Number.NaN);
    expect(currentPixelRatio()).toBe(1);
    setPixelRatio(2);
    expect(currentPixelRatio()).toBe(2);
  });
});

describe('the terminal canvas and the pixel ratio', () => {
  let element: Terminal | null = null;

  beforeAll(async () => {
    await import('./terminal');
  });

  afterEach(() => {
    element?.remove();
    element = null;
    MockTerminal.withRenderer = false;
    setPixelRatio(1);
  });

  /** A terminal opened while the page said `ratio`, its renderer and a frame of ghostty's loop. */
  async function openAt(ratio: number) {
    setPixelRatio(ratio);
    MockTerminal.withRenderer = true;
    element = await fixture<Terminal>(html`<ut-terminal session-id="dpr-1"></ut-terminal>`);
    const el = element;
    await waitForCondition(() => el.getAttribute('data-ready') === 'true', {
      message: 'terminal not ready',
    });
    const term = (el as unknown as { terminal: MockTerminal }).terminal;
    const renderer = term.renderer as MockRenderer;
    term.wasmTerm.isDirty.mockReturnValue(false);
    const frame = () => renderer.render(term.wasmTerm, false, 0, term);
    // A first frame paints; nothing has changed after it.
    frame();
    renderer.paint.mockClear();
    return { el, renderer, frame };
  }

  it('redraws the canvas at the new ratio on the next frame (cold start of the home-screen app)', async () => {
    const { renderer, frame } = await openAt(1);
    expect(renderer.devicePixelRatio).toBe(1);

    // Nothing changed: the frame is skipped.
    frame();
    expect(renderer.paint).not.toHaveBeenCalled();

    // The web view is on the screen now, at 3x: the next frame paints at it, though no row changed.
    setPixelRatio(3);
    frame();
    expect(renderer.devicePixelRatio).toBe(3);
    expect(renderer.paint).toHaveBeenCalledTimes(1);

    // And only once.
    frame();
    expect(renderer.paint).toHaveBeenCalledTimes(1);
  });

  it('takes the new ratio while a replay holds the paint, and paints at it when let go', async () => {
    const { el, renderer, frame } = await openAt(1);
    el.holdPaint();
    setPixelRatio(3);
    frame();
    expect(renderer.devicePixelRatio).toBe(3);
    expect(renderer.paint).not.toHaveBeenCalled();

    el.releasePaint();
    expect(renderer.paint).toHaveBeenCalledTimes(1);
    expect(renderer.paint.mock.calls[0]?.[1]).toBe(true);
  });

  it('keeps skipping unchanged frames when the ratio is right from the start', async () => {
    const { renderer, frame } = await openAt(3);
    expect(renderer.devicePixelRatio).toBe(3);
    frame();
    frame();
    expect(renderer.paint).not.toHaveBeenCalled();
  });
});
