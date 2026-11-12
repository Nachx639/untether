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
import type { Session } from '../../shared/types.js';

type SubscribeOpts = {
  onStdout?: (data: Uint8Array) => void;
  onEvent?: (data: unknown) => void;
};

const subscriptions: SubscribeOpts[] = [];

vi.mock('ghostty-web', () => ({
  Terminal: MockTerminal,
  FitAddon: MockFitAddon,
}));
vi.mock('../services/server-config-service.js', () => ({
  serverConfigService: { loadConfig: vi.fn(async () => ({})) },
}));
vi.mock('../services/terminal-socket-client.js', () => ({
  terminalSocketClient: {
    subscribe: vi.fn((_sessionId: string, opts: SubscribeOpts) => {
      subscriptions.push(opts);
      return () => {};
    }),
  },
}));

global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

import type { Terminal } from './terminal';

const encoder = new TextEncoder();
const FRAME_MS = 16;

/** A long session's history: `bytes` of numbered lines, as the cast replay streams them. */
function history(bytes: number): string[] {
  const lines: string[] = [];
  let size = 0;
  for (let i = 1; size < bytes; i++) {
    const line = `${String(i).padStart(7, '0')} ${'claude output '.repeat(6)}\r\n`;
    lines.push(line);
    size += line.length;
  }
  return lines;
}

describe('opening a session with a long history', () => {
  let element: Terminal | null = null;

  beforeAll(async () => {
    await import('./terminal');
  });

  afterEach(() => {
    vi.useRealTimers();
    element?.remove();
    element = null;
    MockTerminal.withRenderer = false;
    subscriptions.length = 0;
  });

  /**
   * The replay as a phone gets it: 64 KB of history per frame, while ghostty's
   * requestAnimationFrame loop asks for a paint every frame. Each paint records how much of
   * the history the canvas showed and where its view was.
   */
  async function openWithReplay(bytes: number) {
    MockTerminal.withRenderer = true;
    element = await fixture<Terminal>(html`<ut-terminal session-id="long-1"></ut-terminal>`);
    const el = element;
    await waitForCondition(() => el.getAttribute('data-ready') === 'true', {
      message: 'terminal not ready',
    });
    const term = (el as unknown as { terminal: MockTerminal }).terminal;
    const renderer = term.renderer as MockRenderer;

    // ghostty's rows and dirty state follow what is written; the view stays on the bottom.
    let written = 0;
    let dirty = false;
    term.write.mockImplementation((data: string | Uint8Array, callback?: () => void) => {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      written += text.length;
      term.buffer.active.length += text.split('\n').length - 1;
      dirty = true;
      callback?.();
    });
    term.wasmTerm.isDirty.mockImplementation(() => dirty);
    const paints: Array<{ written: number; top: number; viewportY: number }> = [];
    renderer.paint.mockImplementation((_buffer, _forceAll, viewportY: number) => {
      dirty = false;
      paints.push({
        written,
        top: Math.max(0, term.buffer.active.length - term.rows) - viewportY,
        viewportY,
      });
    });

    vi.useFakeTimers();
    const { ConnectionManager } = await import('./session-view/connection-manager.js');
    const manager = new ConnectionManager(vi.fn(), vi.fn());
    manager.setTerminal(el);
    manager.setSession({ id: 'long-1' } as Session);
    manager.setConnected(true);
    manager.connectToStream();
    const sub = subscriptions[subscriptions.length - 1];

    const lines = history(bytes);
    const total = lines.reduce((sum, line) => sum + line.length, 0);
    const finalTop = Math.max(0, lines.length - term.rows);
    const frames = setInterval(() => {
      term.renderer && (term.renderer as MockRenderer).render(term.wasmTerm, false, 0, term);
    }, FRAME_MS);

    sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 } });
    let next = 0;
    while (next < lines.length) {
      let chunk = 0;
      while (next < lines.length && chunk < 64 * 1024) {
        // One STDOUT frame per cast event, as the server sends them.
        sub.onStdout?.(encoder.encode(lines[next]));
        chunk += lines[next].length;
        next++;
      }
      await vi.advanceTimersByTimeAsync(FRAME_MS);
    }
    const paintsDuringReplay = paints.length;
    sub.onEvent?.({ kind: 'replay-end' });
    await vi.advanceTimersByTimeAsync(FRAME_MS * 4);

    // Live output after the replay paints as before.
    const beforeLive = paints.length;
    sub.onStdout?.(encoder.encode('$ live\r\n'));
    await vi.advanceTimersByTimeAsync(FRAME_MS * 4);
    const livePaints = paints.length - beforeLive;
    clearInterval(frames);

    return { paints, paintsDuringReplay, livePaints, total, finalTop };
  }

  it('paints once, at the bottom, after a 4 MB replay is all written', async () => {
    const { paints, paintsDuringReplay, livePaints, total, finalTop } = await openWithReplay(
      4 * 1024 * 1024
    );

    // Before the fix: a paint every frame of the replay (64 for 4 MB), the first one showing
    // the first 64 KB of the history and each next one further down.
    expect(paintsDuringReplay).toBe(0);
    expect(paints[0]).toEqual({ written: total, top: finalTop, viewportY: 0 });
    expect(new Set(paints.map((paint) => paint.top)).size).toBeLessThanOrEqual(2);
    expect(livePaints).toBeGreaterThan(0);
  });

  it('writes a replay as its large chunks come and says it is loading while it takes', async () => {
    MockTerminal.withRenderer = true;
    element = await fixture<Terminal>(html`<ut-terminal session-id="long-2"></ut-terminal>`);
    const el = element;
    await waitForCondition(() => el.getAttribute('data-ready') === 'true', {
      message: 'terminal not ready',
    });
    const term = (el as unknown as { terminal: MockTerminal }).terminal;
    let written = 0;
    term.write.mockImplementation((data: string | Uint8Array, callback?: () => void) => {
      written += typeof data === 'string' ? data.length : data.length;
      callback?.();
    });

    vi.useFakeTimers();
    const { ConnectionManager } = await import('./session-view/connection-manager.js');
    const manager = new ConnectionManager(vi.fn(), vi.fn());
    manager.setTerminal(el);
    manager.setSession({ id: 'long-2' } as Session);
    manager.setConnected(true);
    manager.connectToStream();
    const sub = subscriptions[subscriptions.length - 1];
    sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 } });

    // The server's replay frames (256 KB each): each one goes to ghostty as it comes, no
    // 16 ms wait between them while nothing is painted anyway.
    const chunk = 'x'.repeat(255 * 1024).concat('\r\n'.repeat(512));
    for (let i = 0; i < 8; i++) sub.onStdout?.(encoder.encode(chunk));
    expect(written).toBe(8 * chunk.length);

    const overlay = () => el.querySelector('[data-testid="terminal-loading-history"]');
    await vi.advanceTimersByTimeAsync(250);
    await el.updateComplete;
    expect(overlay()).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    await el.updateComplete;
    expect(overlay()?.textContent?.trim()).toBe('Loading history…');

    sub.onEvent?.({ kind: 'replay-end' });
    await el.updateComplete;
    expect(overlay()).toBeNull();
    expect(el.isPaintHeld()).toBe(false);
  });
});
