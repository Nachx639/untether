/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanDiagBatch } from '../../server/services/input-diagnostics.js';
import {
  addressAsksForDiagnostics,
  DIAG_ENDPOINT,
  DIAG_KEEP_STORAGE_KEY,
  DIAG_LINE_ID,
  GAP_POLL_MS,
  InputDiagnostics,
  keyboardLine,
  networkKind,
  networkLabel,
} from './input-diagnostics.js';

describe('input diagnostics on the device', () => {
  let clock = 0;
  let frames: FrameRequestCallback[] = [];
  let fetched: Array<{
    url: string;
    body: { ua: string; records: Array<Record<string, unknown>> };
  }>;
  let diag: InputDiagnostics;
  const stored = new Map<string, string>();

  /** Runs the frames asked for so far, `ms` later. */
  const frame = (ms: number) => {
    clock += ms;
    const run = frames;
    frames = [];
    for (const callback of run) callback(clock);
  };

  beforeEach(() => {
    clock = 0;
    frames = [];
    fetched = [];
    stored.clear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        fetched.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(null, { status: 204 });
      })
    );
    diag = new InputDiagnostics(() => clock);
  });

  afterEach(() => {
    diag.setLive(false);
    diag.setKept(false);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.getElementById(DIAG_LINE_ID)?.remove();
    document.body.innerHTML = '';
  });

  it('off, it measures nothing, listens to nothing and sends nothing', async () => {
    const listened = vi.spyOn(document, 'addEventListener');
    diag.keySent(1);
    diag.outputArrived('s1');
    diag.sessionOpening('s1');
    diag.socketState(true);
    diag.socketState(false);
    diag.socketState(true);
    expect(frames).toHaveLength(0);
    expect(listened).not.toHaveBeenCalled();
    await diag.flush();
    expect(fetched).toEqual([]);
    expect(document.getElementById(DIAG_LINE_ID)).toBeNull();
  });

  it('key latency: from the key leaving to the first frame after its echo arrived', () => {
    diag.setKept(true);
    frame(0); // the first keyboard sample
    diag.setAgent('codex');
    diag.keySent(1);
    clock += 30;
    diag.outputArrived('s1');
    frame(12);
    diag.keySent(1);
    clock += 60;
    diag.outputArrived('s1');
    frame(20);
    const keys = diag.takeBatch()?.records.find((r) => r.kind === 'keys');
    expect(keys).toMatchObject({ kind: 'keys', agent: 'codex', n: 2, p50: 42, p95: 80, max: 80 });
  });

  it('a paste is not a key, and a key with no echo (a password) is not a latency', () => {
    diag.setKept(true);
    frame(0);
    diag.keySent(400);
    diag.outputArrived('s1');
    frame(16);
    diag.keySent(1);
    clock += 6_000;
    diag.outputArrived('s1');
    frame(16);
    expect(diag.takeBatch()?.records.some((r) => r.kind === 'keys') ?? false).toBe(false);
  });

  it('opening a session: until the first frame after its own terminal got output', () => {
    diag.setKept(true);
    frame(0);
    diag.setAgent('claude');
    diag.sessionOpening('s2');
    clock += 100;
    diag.outputArrived('s1'); // another session's output does not count
    frame(16);
    clock += 200;
    diag.outputArrived('s2');
    frame(16);
    const opens = diag.takeBatch()?.records.filter((r) => r.kind === 'open');
    expect(opens).toHaveLength(1);
    expect(opens?.[0]).toMatchObject({ agent: 'claude', ms: 332 });
  });

  it('a reconnection: how long the socket was down; the first connection is not one', () => {
    diag.setKept(true);
    frame(0);
    diag.socketState(true);
    clock += 5_000;
    diag.socketState(false);
    clock += 1_500;
    diag.socketState(true);
    const sockets = diag.takeBatch()?.records.filter((r) => r.kind === 'ws');
    expect(sockets).toHaveLength(1);
    expect(sockets?.[0]).toMatchObject({ ms: 1500 });
  });

  it('scrolling: frame durations while the gesture lasts, by place, slow ones counted', () => {
    document.body.innerHTML =
      '<session-view><div id="term"></div></session-view><div id="else"></div>';
    diag.setKept(true);
    frame(0);
    const term = document.getElementById('term') as HTMLElement;
    document.getElementById('else')?.dispatchEvent(new Event('scroll'));
    expect(frames).toHaveLength(0); // not the terminal, not the list
    term.dispatchEvent(new Event('touchmove', { bubbles: true }));
    for (const ms of [16, 16, 70, 16]) {
      term.dispatchEvent(new Event('scroll'));
      frame(ms);
    }
    frame(500); // the gesture is over: this long frame is not part of it
    frame(16);
    const scroll = diag.takeBatch()?.records.find((r) => r.kind === 'scroll');
    expect(scroll).toMatchObject({ where: 'terminal', frames: 4, p50: 16, p95: 70, slow: 1 });
  });

  it('the keyboard: both calculations and the height applied, on screen only in live mode', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(560);
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: Object.assign(new EventTarget(), { height: 560, width: 440, offsetTop: 0 }),
    });
    // Chrome on iOS with the keyboard up: innerHeight shrank with the viewport.
    diag.setKeyboardProbe(() => ({ baseline: 894, applied: 334 }));
    expect(diag.measureKeyboard('focusin')).toMatchObject({
      ih: 560,
      vvh: 560,
      base: 894,
      safari: 0,
      baseline: 334,
      applied: 334,
    });

    diag.setKept(true);
    frame(0);
    expect(document.getElementById(DIAG_LINE_ID)).toBeNull();
    diag.setLive(true);
    frame(0);
    const line = document.getElementById(DIAG_LINE_ID);
    expect(line?.textContent).toBe('ih 560 vv 560+0 max 894 | s 0 b 334 = 334');
    expect(line?.className).toBe('ut-diag-line');
    window.visualViewport?.dispatchEvent(new Event('resize'));
    frame(16);
    expect(diag.takeBatch()?.records.filter((r) => r.kind === 'kbd').length).toBeGreaterThan(1);
    diag.setLive(false);
    expect(document.getElementById(DIAG_LINE_ID)).toBeNull();
    expect(diag.mode).toBe('kept');
  });

  // 2026-11-11: the keyboard's gap with no keyboard (iPhone home-screen app, "sometimes").
  it('the gap with nothing editable focused: how tall and for how long', () => {
    vi.useFakeTimers();
    let applied = 388;
    diag.setKeyboardProbe(() => ({ baseline: 956, applied }));
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();
    diag.setKept(true);

    // A keyboard up for a field is not one.
    clock += 2_000;
    vi.advanceTimersByTime(GAP_POLL_MS);
    expect(diag.measureKeyboard('focusin')).toMatchObject({ applied: 388, edit: 1 });

    // The field loses the focus and the gap stays.
    field.blur();
    vi.advanceTimersByTime(GAP_POLL_MS);
    expect(diag.measureKeyboard('focusout')).toMatchObject({ applied: 388, edit: 0 });
    clock += 3_000;
    vi.advanceTimersByTime(GAP_POLL_MS);
    // Still there when a batch leaves: what it has lasted so far, marked open.
    const first = diag.takeBatch()?.records.filter((r) => r.kind === 'gap');
    expect(first).toMatchObject([{ ms: 3_000, px: 388, open: 1, agent: 'none' }]);

    clock += 1_250;
    applied = 0;
    vi.advanceTimersByTime(GAP_POLL_MS);
    const rest = diag.takeBatch()?.records.filter((r) => r.kind === 'gap');
    expect(rest).toMatchObject([{ ms: 1_250, px: 388, open: 0 }]);
    // The two pieces are one stretch: the same id; the next stretch gets its own.
    const id = (records: typeof first) => ((records ?? [])[0] as { id: number }).id;
    expect(id(first)).toBeGreaterThanOrEqual(0);
    expect(id(rest)).toBe(id(first));
    applied = 200;
    vi.advanceTimersByTime(GAP_POLL_MS);
    // Turned off with the gap there: it ends in the batch that leaves, closed.
    diag.setKept(false);
    const last = fetched.at(-1)?.body.records.filter((r: { kind: string }) => r.kind === 'gap');
    expect(last).toMatchObject([{ px: 200, open: 0 }]);
    expect(last[0].id).not.toBe(id(first));
    applied = 0;
    diag.setKept(true);
    for (const record of [...(first ?? []), ...(rest ?? [])]) {
      for (const [key, value] of Object.entries(record)) {
        if (!['kind', 'agent', 'net', 'look'].includes(key)) expect(typeof value).toBe('number');
      }
    }

    // No gap, no record.
    vi.advanceTimersByTime(GAP_POLL_MS * 4);
    expect(diag.takeBatch()?.records.some((r) => r.kind === 'gap') ?? false).toBe(false);
    vi.useRealTimers();
  });

  it('sends its batch to the server, in the shape the server takes: numbers and fixed words', async () => {
    diag.setLive(true);
    frame(0);
    diag.setAgent('shell');
    diag.keySent(1);
    diag.outputArrived('s1');
    frame(25);
    await diag.flush();
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toBe(DIAG_ENDPOINT);
    const kept = cleanDiagBatch(fetched[0].body);
    expect(kept.map((r) => r.kind).sort()).toEqual(['kbd', 'keys']);
    for (const record of fetched[0].body.records) {
      for (const value of Object.values(record)) {
        expect(typeof value === 'number' || /^[a-z0-9._/-]{1,40}$/.test(String(value))).toBe(true);
      }
    }
    // Nothing new: nothing sent.
    await diag.flush();
    expect(fetched).toHaveLength(1);
  });

  it('"keep on" is remembered on the device; the live mode is not, unless the address asks', () => {
    diag.setLive(true);
    diag.setKept(true);
    expect(stored.get(DIAG_KEEP_STORAGE_KEY)).toBe('1');
    const reloaded = new InputDiagnostics(() => clock);
    reloaded.start();
    expect(reloaded.mode).toBe('kept');
    reloaded.setKept(false);
    expect(stored.has(DIAG_KEEP_STORAGE_KEY)).toBe(false);
    expect(reloaded.mode).toBe('off');
    expect(addressAsksForDiagnostics('?kbdebug=1')).toBe(true);
    expect(addressAsksForDiagnostics('?kbdebug=0&x=1')).toBe(false);
    expect(addressAsksForDiagnostics('')).toBe(false);
  });

  it('names the network from the address used, plus the connection type when the browser tells', () => {
    expect(networkKind('localhost')).toBe('local');
    expect(networkKind('127.0.0.1')).toBe('local');
    expect(networkKind('mac.tail1234.ts.net')).toBe('tailscale');
    expect(networkKind('100.101.7.3')).toBe('tailscale');
    expect(networkKind('192.168.1.20')).toBe('lan');
    expect(networkKind('macbook.local')).toBe('lan');
    expect(networkKind('untether.example.com')).toBe('internet');
    expect(networkLabel('192.168.1.20', { effectiveType: '4g' })).toBe('lan/4g');
    expect(networkLabel('192.168.1.20', { type: 'wifi', effectiveType: '4g' })).toBe('lan/wifi');
    expect(networkLabel('192.168.1.20', undefined)).toBe('lan');
    expect(networkLabel('192.168.1.20', { effectiveType: 'something odd!' })).toBe('lan');
  });

  it('the line fits the width of a phone with a keyboard up', () => {
    const line = keyboardLine({
      kind: 'kbd',
      at: 0,
      src: 'vv-resize',
      ih: 714,
      vvh: 412.5,
      vvt: 0,
      w: 402,
      base: 714,
      safari: 301.5,
      baseline: 301.5,
      applied: 301.5,
    });
    expect(line).toBe('ih 714 vv 412.5+0 max 714 | s 301.5 b 301.5 = 301.5');
    expect(line.length).toBeLessThan(56);
  });
});
