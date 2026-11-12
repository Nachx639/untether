// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForCondition } from '@/test/utils/component-helpers';
import {
  MockFitAddon,
  type MockRenderer,
  MockResizeObserver,
  MockTerminal,
} from '@/test/utils/terminal-mocks';
import { TERMINAL_FONT_FAMILY } from '../utils/terminal-constants';
import { resetTerminalIconFonts, TERMINAL_FONT_NAME } from '../utils/terminal-fonts';

vi.mock('ghostty-web', () => ({
  Terminal: MockTerminal,
  FitAddon: MockFitAddon,
}));
vi.mock('../services/server-config-service.js', () => ({
  serverConfigService: { loadConfig: vi.fn(async () => ({})) },
}));

global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

import type { Terminal } from './terminal';

/** document.fonts with loads the test settles itself. */
function installFonts() {
  const target = new EventTarget();
  let settle: (ok: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const load = vi.fn(async (_spec: string, _text?: string) => {
    if (!(await ready)) throw new Error('font failed');
    return [{ family: `"${TERMINAL_FONT_NAME}"` } as FontFace];
  });
  // The icon face (U+E000-F8FF less Powerline) as document.fonts lists it; loads when told.
  let iconArrives: () => void = () => {};
  const iconLoaded = new Promise<void>((resolve) => {
    iconArrives = resolve;
  });
  const iconFace = {
    family: `"${TERMINAL_FONT_NAME}"`,
    unicodeRange: 'U+e000-e09f, U+e0d8-f8ff',
    load: vi.fn(async () => {
      await iconLoaded;
      return iconFace;
    }),
  };
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      load,
      forEach: (callback: (face: FontFace) => void) => callback(iconFace as unknown as FontFace),
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    },
  });
  const loadingdone = () => {
    const event = new Event('loadingdone');
    Object.defineProperty(event, 'fontfaces', {
      value: [{ family: `"${TERMINAL_FONT_NAME}"` }],
    });
    target.dispatchEvent(event);
  };
  return { load, settle: (ok: boolean) => settle(ok), loadingdone, iconFace, iconArrives };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const terminalOf = (element: Terminal) =>
  (element as unknown as { terminal: MockTerminal | null }).terminal;

describe('the terminal and its font', () => {
  let element: Terminal | null = null;

  beforeAll(async () => {
    await import('./terminal');
  });

  beforeEach(() => resetTerminalIconFonts());

  afterEach(() => {
    element?.remove();
    element = null;
    MockTerminal.withRenderer = false;
    Reflect.deleteProperty(document, 'fonts');
  });

  it('names Hack Nerd Font Mono first, so the canvas draws with it', () => {
    expect(TERMINAL_FONT_FAMILY.startsWith(`"${TERMINAL_FONT_NAME}",`)).toBe(true);
  });

  it('opens only once the font has loaded: its cells are never measured on a fallback', async () => {
    const fonts = installFonts();
    element = await fixture<Terminal>(html`<ut-terminal session-id="font-1"></ut-terminal>`);
    await tick();
    expect(fonts.load).toHaveBeenCalledWith(`16px "${TERMINAL_FONT_NAME}"`);
    expect(fonts.load).toHaveBeenCalledWith(`bold 16px "${TERMINAL_FONT_NAME}"`);
    expect(terminalOf(element)).toBeNull();
    expect(element.getAttribute('data-ready')).toBeNull();

    fonts.settle(true);
    const el = element;
    await waitForCondition(() => el.getAttribute('data-ready') === 'true', {
      message: 'terminal not ready',
    });
    expect(terminalOf(element)?.open).toHaveBeenCalledOnce();
  });

  it('a font that fails does not keep the terminal from opening', async () => {
    const fonts = installFonts();
    element = await fixture<Terminal>(html`<ut-terminal session-id="font-2"></ut-terminal>`);
    fonts.settle(false);
    const el = element;
    await waitForCondition(() => el.getAttribute('data-ready') === 'true', {
      message: 'terminal not ready',
    });
  });

  it('a snapshot replayed before ghostty opens loads the icon file, and the rows are repainted when it arrives', async () => {
    const fonts = installFonts();
    MockTerminal.withRenderer = true;
    element = await fixture<Terminal>(html`<ut-terminal session-id="font-4"></ut-terminal>`);
    // The session's snapshot comes while the terminal still waits for its core font.
    element.write('\x1b[2J\x1b[H\uF07B folder  \u{F0219} md\r\n');
    expect(terminalOf(element)).toBeNull();
    expect(fonts.iconFace.load).toHaveBeenCalledOnce();

    fonts.settle(true);
    const el = element;
    await waitForCondition(() => el.getAttribute('data-ready') === 'true', {
      message: 'terminal not ready',
    });
    const renderer = (terminalOf(element) as MockTerminal).renderer as MockRenderer;
    renderer.paint.mockClear();
    // No loadingdone event: the load's own promise brings the repaint.
    fonts.iconArrives();
    await waitForCondition(() => renderer.paint.mock.calls.some((call) => call[1] === true), {
      message: 'no full repaint after the icon font loaded',
    });
  });

  it('asks for the icon file when output draws an icon, and repaints every row when it arrives', async () => {
    const fonts = installFonts();
    fonts.settle(true);
    MockTerminal.withRenderer = true;
    element = await fixture<Terminal>(html`<ut-terminal session-id="font-3"></ut-terminal>`);
    const el = element;
    await waitForCondition(() => el.getAttribute('data-ready') === 'true', {
      message: 'terminal not ready',
    });
    const term = terminalOf(element) as MockTerminal;
    const renderer = term.renderer as MockRenderer;

    element.write('\x1b[34m\uF07B\x1b[0m src\r\n');
    expect(fonts.iconFace.load).toHaveBeenCalledOnce();
    renderer.paint.mockClear();
    fonts.iconArrives();
    await waitForCondition(() => renderer.paint.mock.calls.some((call) => call[1] === true), {
      message: 'no full repaint after the icon font loaded',
    });

    renderer.paint.mockClear();
    renderer.remeasureFont.mockClear();
    renderer.resize.mockClear();
    fonts.loadingdone();
    expect(renderer.remeasureFont).toHaveBeenCalledOnce();
    // Same cells: no resize, one full render.
    expect(renderer.resize).not.toHaveBeenCalled();
    expect(renderer.paint).toHaveBeenCalledOnce();
    expect(renderer.paint.mock.calls[0][1]).toBe(true);

    // The core came after the wait gave up: cells measured anew, canvas resized to them.
    renderer.getMetrics
      .mockReturnValueOnce({ width: 9, height: 18, baseline: 14 })
      .mockReturnValueOnce({ width: 8, height: 17, baseline: 13 });
    renderer.paint.mockClear();
    fonts.loadingdone();
    expect(renderer.resize).toHaveBeenCalledWith(term.cols, term.rows);
    expect(renderer.paint.mock.calls[0][1]).toBe(true);
  });
});
