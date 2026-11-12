// @vitest-environment happy-dom
import { fixture, html } from '@open-wc/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForCondition } from '@/test/utils/component-helpers';
import { MockFitAddon, MockResizeObserver, MockTerminal } from '@/test/utils/terminal-mocks';

vi.mock('ghostty-web', () => ({
  Terminal: MockTerminal,
  FitAddon: MockFitAddon,
}));
vi.mock('../services/server-config-service.js', () => ({
  serverConfigService: { loadConfig: vi.fn(async () => ({})) },
}));

global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

import type { Terminal } from './terminal';

// 2026-10-12: a forwarded session's history, drawn by Claude Code for the Mac window's 120
// columns, was written into the phone's 80-column grid: words placed with absolute column
// moves came apart into fragments and every repaint left a copy in the history. The grid now
// follows the PTY's size as the stream says it (connection-manager-pty-size.test.ts checks the
// text with the real ghostty).
describe('terminal grid following the PTY size', () => {
  let element: Terminal;
  let term: MockTerminal;
  let fit: MockFitAddon;
  let resizeEvents: Array<{ cols: number; rows: number }>;

  beforeAll(async () => {
    await import('./terminal');
  });

  beforeEach(async () => {
    element = await fixture<Terminal>(html`<ut-terminal session-id="fwd_test"></ut-terminal>`);
    await waitForCondition(() => element.getAttribute('data-ready') === 'true', {
      message: 'terminal not ready',
    });
    const internals = element as unknown as { terminal: MockTerminal; fitAddon: MockFitAddon };
    term = internals.terminal;
    fit = internals.fitAddon;
    // Smaller type, more rows: 24 rows at 14 px.
    fit.proposeDimensions.mockImplementation(() => ({
      cols: Math.floor((80 * 14) / Number(term.options.fontSize)),
      rows: Math.floor((24 * 14) / Number(term.options.fontSize)),
    }));
    element.fitTerminal('test');
    resizeEvents = [];
    element.addEventListener('terminal-resize', (e) =>
      resizeEvents.push((e as CustomEvent).detail)
    );
  });

  afterEach(() => {
    element.remove();
  });

  it('lays a replay out at the PTY sizes and ends at its own size, never resizing the PTY', () => {
    element.followPtySize(120, 52, true);
    expect([term.cols, term.rows]).toEqual([120, 52]);
    element.followPtySize(80, 33, true);
    expect([term.cols, term.rows]).toEqual([80, 33]);
    element.ptyReplayEnded();
    expect([term.cols, term.rows]).toEqual([80, 24]);
    expect(element.isFollowingPtySize()).toBe(false);
    expect(term.options.fontSize).toBe(14);
    // The layout's own resizes never go to the PTY; only the return to its own fit is said.
    expect(resizeEvents.every((size) => size.cols === 80 && size.rows === 24)).toBe(true);
  });

  it('measures the screen once per replay, not after each of its sizes', () => {
    // User report 2026-10-14: a Mac window's history has hundreds of sizes, and measuring
    // after each grid resize forced a page reflow every time.
    fit.proposeDimensions.mockClear();
    element.followPtySize(120, 52, true);
    const measured = fit.proposeDimensions.mock.calls.length;
    for (let i = 0; i < 50; i++) element.followPtySize(100 + (i % 20), 40, true);
    expect(fit.proposeDimensions.mock.calls.length).toBe(measured);
    expect([term.cols, term.rows]).toEqual([109, 40]);
    element.ptyReplayEnded();
    expect(element.isFollowingPtySize()).toBe(true);
    expect(term.cols).toBe(109);
  });

  it('shows a wider live PTY whole, in smaller type, until it has its columns again', () => {
    element.followPtySize(120, 52, false);
    expect(term.cols).toBe(120);
    expect(term.options.fontSize).toBe(9.25);
    expect(term.rows).toBe(Math.floor((24 * 14) / 9.25));
    expect(resizeEvents).toEqual([]);
    // Something else asking for a fit keeps the layout.
    element.fitTerminal('font-loaded');
    expect(term.cols).toBe(120);

    element.followPtySize(80, 24, false);
    expect(element.isFollowingPtySize()).toBe(false);
    expect(term.options.fontSize).toBe(14);
    expect([term.cols, term.rows]).toEqual([80, 24]);
  });

  it('a replay that ends with the PTY wider keeps that width', () => {
    element.followPtySize(120, 52, true);
    element.ptyReplayEnded();
    expect(element.isFollowingPtySize()).toBe(true);
    expect(term.cols).toBe(120);
    expect(term.options.fontSize).toBe(9.25);
  });

  // User report 2026-10-14: only the page that owns the size resizes the PTY; a change of this
  // screen while it shows another's size is reported, and the server decides.
  it('keeps showing the PTY, laid out for its new area, and reports its own size when this screen changes', () => {
    element.followPtySize(120, 52, false);
    const container = (element as unknown as { container: HTMLElement }).container;
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 300 });
    fit.proposeDimensions.mockImplementation(() => ({
      cols: Math.floor((80 * 14) / Number(term.options.fontSize)),
      rows: Math.floor((30 * 14) / Number(term.options.fontSize)),
    }));
    element.fitTerminal('resize-observer');
    expect(element.isFollowingPtySize()).toBe(true);
    expect(term.cols).toBe(120);
    expect(term.rows).toBe(Math.floor((30 * 14) / 9.25));
    expect(resizeEvents).toEqual([
      expect.objectContaining({ cols: 80, rows: 30, source: 'own-size:resize-observer' }),
    ]);
    // The same area again: nothing more to say.
    element.fitTerminal('resize-observer');
    expect(resizeEvents).toHaveLength(1);
  });

  it("shows a narrower live PTY in bigger type, up to one and a half times the user's", () => {
    element.followPtySize(60, 40, false);
    expect(term.cols).toBe(60);
    // No canvas to measure with here: in proportion to its own 80 columns.
    expect(term.options.fontSize).toBe(18.5);
    element.followPtySize(20, 40, false);
    expect(term.options.fontSize).toBe(21);
  });

  it('never shows more rows than the PTY has (the app homes its cursor to repaint)', () => {
    element.followPtySize(120, 20, false);
    expect(term.cols).toBe(120);
    expect(term.rows).toBe(20);
    // A taller PTY: the rows that fit.
    element.followPtySize(120, 80, false);
    expect(term.rows).toBe(Math.floor((24 * 14) / 9.25));
  });

  it("is not held at a Mac window's width: its own fit, whatever the session", () => {
    fit.proposeDimensions.mockImplementation(() => ({ cols: 130, rows: 30 }));
    element.fitTerminal('test');
    expect(term.cols).toBe(130);
  });

  // 2026-10-12: a desktop showed a Mac window's narrower PTY in the left half of its area; the
  // size it claims the PTY at is its own fit, not the layout's (terminal-lifecycle-manager).
  it('says its own size whatever PTY layout it shows, and none while hidden', () => {
    const container = (element as unknown as { container: HTMLElement }).container;
    expect(element.getOwnSize()).toBeNull();
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 900 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 });
    element.followPtySize(60, 40, false);
    expect(term.cols).toBe(60);
    expect(element.getOwnSize()).toEqual({ cols: 80, rows: 24 });
    element.followPtySize(120, 52, false);
    expect(term.options.fontSize).toBe(9.25);
    expect(element.getOwnSize()).toEqual({ cols: 80, rows: 24 });
    element.followPtySize(120, 52, true);
    expect(element.getOwnSize()).toEqual({ cols: 80, rows: 24 });
    // The layout is kept: asking for the size changes nothing on screen.
    expect([term.cols, term.rows]).toEqual([120, 52]);
  });
});
