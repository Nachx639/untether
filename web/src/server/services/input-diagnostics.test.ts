import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { runDiagCli } from '../diag-cli.js';
import {
  browserName,
  cleanDiagBatch,
  DiagInputError,
  diagLogLine,
  formatDiagSummary,
  INPUT_DIAG_FILE,
  INPUT_DIAG_OLDER_FILE,
  InputDiagStore,
  parseSince,
} from './input-diagnostics.js';

const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1';
const ctx = { agent: 'claude', net: 'tailscale', look: 'original' };
const kbd = (over: Record<string, unknown> = {}) => ({
  kind: 'kbd',
  at: 1_000,
  src: 'vv-resize',
  ih: 327,
  vvh: 327,
  vvt: 0,
  w: 393,
  base: 664,
  safari: 0,
  baseline: 337,
  applied: 337,
  edit: 1,
  ...over,
});

describe('input diagnostics: what a device may send', () => {
  it('keeps the known fields of every kind and the browser, cut short', () => {
    const records = cleanDiagBatch({
      ua: `${CHROME_IOS}${'x'.repeat(400)}\n`,
      records: [
        kbd(),
        { kind: 'keys', at: 2_000, ...ctx, n: 12, p50: 41.26, p95: 90, max: 300 },
        {
          kind: 'scroll',
          at: 2_000,
          ...ctx,
          where: 'terminal',
          frames: 80,
          p50: 16.7,
          p95: 33,
          slow: 2,
        },
        { kind: 'open', at: 2_500, ...ctx, ms: 420 },
        { kind: 'ws', at: 3_000, ...ctx, ms: 1500 },
      ],
    });
    expect(records.map((r) => r.kind)).toEqual(['kbd', 'keys', 'scroll', 'open', 'ws']);
    expect(records[0].ua).toHaveLength(300);
    expect(records[0].ua).not.toContain('\n');
    expect(records[1]).toMatchObject({ p50: 41.3, agent: 'claude' });
  });

  it('never keeps a field it does not know: nothing typed can ride along', () => {
    const [record] = cleanDiagBatch({
      ua: 'x',
      records: [{ ...kbd(), text: 'my password', key: 'a', screen: 'secret' }],
    });
    expect(Object.keys(record).sort()).toEqual(
      [
        'applied',
        'at',
        'base',
        'baseline',
        'edit',
        'ih',
        'kind',
        'safari',
        'src',
        'ua',
        'vvh',
        'vvt',
        'w',
      ].sort()
    );
    expect(JSON.stringify(record)).not.toContain('password');
  });

  it('refuses free text where a fixed word or a number goes', () => {
    const bad = (record: unknown) => () => cleanDiagBatch({ ua: 'x', records: [record] });
    expect(bad(kbd({ src: 'the user typed hello' }))).toThrow(DiagInputError);
    expect(bad(kbd({ ih: '327' }))).toThrow(DiagInputError);
    expect(bad(kbd({ ih: Number.NaN }))).toThrow(DiagInputError);
    expect(
      bad({ kind: 'keys', at: 1, ...ctx, agent: 'rm -rf', n: 1, p50: 1, p95: 1, max: 1 })
    ).toThrow(DiagInputError);
    expect(bad({ kind: 'open', at: 1, ...ctx, look: 'a look with spaces', ms: 1 })).toThrow(
      DiagInputError
    );
    expect(bad({ kind: 'typed', at: 1, text: 'hello' })).toThrow(DiagInputError);
    expect(() =>
      cleanDiagBatch({ ua: 'x', records: Array.from({ length: 401 }, () => kbd()) })
    ).toThrow(DiagInputError);
    expect(() => cleanDiagBatch({ records: [] })).toThrow(DiagInputError);
  });

  it('names the browser: Chrome on iOS is not Safari', () => {
    expect(browserName(CHROME_IOS)).toBe('Chrome iOS');
    expect(
      browserName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
      )
    ).toBe('Safari iOS');
    expect(
      browserName('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/142.0 Safari/537.36')
    ).toBe('Chrome');
  });

  it('writes one log line per record, with the two keyboard heights side by side', () => {
    const [record] = cleanDiagBatch({ ua: CHROME_IOS, records: [kbd()] });
    expect(diagLogLine(record)).toBe(
      'kbd src=vv-resize ih=327 vvh=327 vvt=0 w=393 base=664 safari=0 baseline=337 applied=337 edit=1 · Chrome iOS'
    );
  });
});

describe('input diagnostics: kept and summed up', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-diag-'));
  });
  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  const HOUR = 3_600_000;
  const now = 100 * HOUR;
  /** The server's clock: each record is kept with the time it arrived. */
  const clock = { t: now };
  const fill = (store: InputDiagStore) => {
    const keys = (agent: string, p50: number, p95: number, net = 'tailscale') => ({
      kind: 'keys',
      at: 0,
      agent,
      net,
      look: 'original',
      n: 10,
      p50,
      p95,
      max: p95 * 2,
    });
    const arrive = (hoursAgo: number, ...records: unknown[]) => {
      clock.t = now - hoursAgo * HOUR;
      store.record({ ua: CHROME_IOS, records });
    };
    arrive(30, keys('claude', 900, 900)); // older than a day: out of --since 24h
    arrive(3, keys('claude', 40, 90));
    arrive(2, keys('claude', 60, 110));
    arrive(
      1,
      keys('claude', 50, 100, 'lan/wifi'),
      keys('shell', 20, 30),
      {
        kind: 'scroll',
        at: 0,
        ...ctx,
        agent: 'codex',
        look: 'aero',
        where: 'terminal',
        frames: 200,
        p50: 16.7,
        p95: 34,
        slow: 10,
      },
      { kind: 'open', at: 0, ...ctx, ms: 300 },
      { kind: 'open', at: 0, ...ctx, ms: 500 },
      { kind: 'ws', at: 0, ...ctx, ms: 2000 },
      kbd()
    );
    arrive(0.5, kbd({ safari: 336, baseline: 336, applied: 336, ih: 664, vvh: 328 }));
    clock.t = now;
  };

  it('sums up by agent, by network and by interface style, inside the time asked for', () => {
    // A phone's own clock (the `at` it sends) does not count: the time it arrived does.
    const lines: string[] = [];
    const store = new InputDiagStore({ dir, now: () => clock.t, log: (line) => lines.push(line) });
    fill(store);
    expect(lines).toHaveLength(11);

    const day = store.summary(24 * HOUR);
    expect(day.records).toBe(10);
    expect(day.browsers).toEqual(['Chrome iOS']);
    expect(day.byAgent.map((g) => g.name)).toEqual(['claude', 'codex', 'shell']);
    const claude = day.byAgent[0];
    expect(claude.keys).toMatchObject({ samples: 3, count: 30, p50: 50, p95: 100, max: 220 });
    expect(claude.open).toMatchObject({ count: 2, p50: 300 });
    expect(day.byAgent[1].scroll.terminal).toMatchObject({ count: 200, p95: 34, slowPct: 5 });
    expect(day.byNetwork.map((g) => g.name)).toEqual(['lan/wifi', 'tailscale']);
    expect(day.byLook.map((g) => g.name)).toEqual(['aero', 'original']);
    expect(day.reconnections).toEqual({ count: 1, p50: 2000, max: 2000 });
    expect(day.keyboard).toMatchObject({ samples: 2, disagree: 1 });
    expect(day.keyboard.last).toMatchObject({ applied: 336 });

    // The older minute counts once the window reaches it.
    expect(store.summary(48 * HOUR).byAgent[0].keys?.samples).toBe(4);
    expect(store.summary(HOUR / 4).records).toBe(0);
  });

  it('prints a summary a person can read, and says how to turn the mode on when empty', () => {
    const store = new InputDiagStore({ dir, now: () => clock.t });
    expect(formatDiagSummary(store.summary(24 * HOUR))).toContain('Settings → Advanced');
    fill(store);
    const text = formatDiagSummary(store.summary(24 * HOUR));
    expect(text).toContain('By agent');
    expect(text).toMatch(/claude\s+keys 30 \(p50 50 ms, p95 100 ms, max 220 ms\)/);
    expect(text).toContain('terminal scroll 200 frames (p50 17 ms, p95 34 ms, 5 % over 50 ms)');
    expect(text).toContain('WebSocket reconnections: 1 (median 2.0 s down, longest 2.0 s)');
    expect(text).toContain('Keyboard samples: 2, 1 where the two ways differ by over 20 px');
    expect(text).toContain('safari 336, baseline 336, applied 336, field focused');
    expect(text).toContain('Keyboard gap with no field focused: never');
  });

  // 2026-11-11: the keyboard's gap with no keyboard. The two heights of a sample can be wrong
  // in the same way; this goes by the focus.
  it('the gap with no field focused: how often, how many are not a keyboard closing, the longest', () => {
    const store = new InputDiagStore({ dir, now: () => clock.t });
    const gap = (ms: number, px: number, open = 0, id = 9) => ({
      kind: 'gap',
      id,
      at: 5,
      ...ctx,
      ms,
      px,
      open,
    });
    store.record({
      ua: CHROME_IOS,
      // A keyboard closing (its animation), then one that stayed across two batches.
      records: [gap(280, 388, 0, 1), gap(60_000, 388, 1, 2)],
    });
    store.record({ ua: CHROME_IOS, records: [gap(4_500, 388, 0, 2)] });
    // Another tab of the same browser: its own stretches, never added to the open one above,
    // and one left open (the mode was turned off, the tab closed) joins nothing later.
    store.record({ ua: CHROME_IOS, records: [gap(700, 300, 1, 3)] });
    store.record({ ua: CHROME_IOS, records: [gap(600, 300, 0, 4), gap(500, 300, 0, 5)] });
    const summary = store.summary(24 * HOUR);
    expect(summary.gaps).toEqual({ count: 5, stuck: 1, longest: 64_500, longestPx: 388 });
    expect(summary.byAgent).toEqual([]);
    expect(formatDiagSummary(summary)).toContain(
      'Keyboard gap with no field focused: 5 times, 1 over 1.5 s (the gap with no keyboard); longest 64.5 s at 388 px'
    );
    const [kept] = cleanDiagBatch({
      ua: 'x',
      records: [{ ...gap(10, 388), text: 'typed', screen: 'shown' }],
    });
    expect(Object.keys(kept).sort()).toEqual(
      ['agent', 'at', 'id', 'kind', 'look', 'ms', 'net', 'open', 'px', 'ua'].sort()
    );
    expect(() => cleanDiagBatch({ ua: 'x', records: [gap(Number.NaN, 388)] })).toThrow(
      DiagInputError
    );
  });

  it('stays bounded on disk: one older file, and a bad batch writes nothing', () => {
    const store = new InputDiagStore({ dir, now: () => clock.t, maxBytes: 300 });
    for (let i = 0; i < 6; i++) store.record({ ua: 'x', records: [kbd()] });
    expect(fs.readdirSync(dir).sort()).toEqual([INPUT_DIAG_OLDER_FILE, INPUT_DIAG_FILE].sort());
    expect(fs.statSync(path.join(dir, INPUT_DIAG_FILE)).size).toBeLessThan(700);
    const before = store.read().length;
    expect(() => store.record({ ua: 'x', records: [{ kind: 'kbd', text: 'typed' }] })).toThrow(
      DiagInputError
    );
    expect(store.read()).toHaveLength(before);
  });

  it('ut diag input: asks the server for the time given and prints its answer', async () => {
    const store = new InputDiagStore({ dir, now: () => clock.t });
    fill(store);
    const asked: unknown[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const deps = {
      task: async (op: string, args: Record<string, unknown>) => {
        asked.push([op, args]);
        return {
          ok: true as const,
          status: 'done' as const,
          data: { ...store.summary(parseSince(String(args.since)) ?? 0) },
        };
      },
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    };
    expect(await runDiagCli(['input', '--since', '48h'], deps)).toBe(0);
    expect(asked).toEqual([['diag-input', { since: '48h' }]]);
    expect(out[0]).toContain('By network');
    expect(await runDiagCli(['input', '--json'], deps)).toBe(0);
    expect(JSON.parse(out[1]).byAgent[0].name).toBe('claude');
    expect(await runDiagCli(['input', '--since', 'yesterday'], deps)).toBe(2);
    expect(await runDiagCli(['keyboard'], deps)).toBe(2);
    expect(err).toHaveLength(2);
    expect(asked).toHaveLength(2);
  });

  it('reads the time back: 30m, 24h, 7d', () => {
    expect(parseSince('30m')).toBe(30 * 60_000);
    expect(parseSince('24h')).toBe(24 * HOUR);
    expect(parseSince('7d')).toBe(7 * 24 * HOUR);
    expect(parseSince('soon')).toBeNull();
  });
});
