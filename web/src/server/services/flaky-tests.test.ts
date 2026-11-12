import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { flakyUnderLoadCheck } from './doctor-checks.js';
import { FlakyTestStore } from './flaky-tests.js';

const DAY = 24 * 60 * 60 * 1000;

describe('tests flaky under load, per project (2026-11-02)', () => {
  let dir: string;
  let file: string;
  let now: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-flaky-'));
    file = path.join(dir, 'flaky-under-load.json');
    now = Date.parse('2026-11-02T15:00:00Z');
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  const store = () => new FlakyTestStore(file, { now: () => now });

  it('counts each test per project, kept on disk, the most recently seen first', () => {
    const first = store();
    first.record('/p/untether', ['a > one', 'b > two'], { taskId: 't1', load: 40 });
    now += 60_000;
    first.record('/p/untether', ['b > two'], { taskId: 't2', load: 55 });
    first.record('/p/bakery', ['c > three'], { taskId: 't3' });

    const again = store().list();
    const untether = again.find((p) => p.repoPath === '/p/untether');
    expect(untether?.tests.map((t) => [t.name, t.count, t.lastTaskId, t.lastLoad])).toEqual([
      ['b > two', 2, 't2', 55],
      ['a > one', 1, 't1', 40],
    ]);
    expect(again.find((p) => p.repoPath === '/p/bakery')?.tests).toHaveLength(1);
  });

  it('a rerun that named no test still shows, with the first run last line', () => {
    const s = store();
    s.record('/p/x', [], { fallback: 'lint: 1 error' });
    expect(s.list()[0].tests[0].name).toBe('(no test named) lint: 1 error');
  });

  it('drops tests not seen for two weeks, and caps each project', () => {
    const s = new FlakyTestStore(file, { now: () => now, maxPerProject: 3 });
    s.record('/p/x', ['old']);
    now += 15 * DAY;
    s.record('/p/x', ['n1', 'n2', 'n3', 'n4']);
    const names = s.list()[0].tests.map((t) => t.name);
    expect(names).toHaveLength(3);
    expect(names).not.toContain('old');
    now += 15 * DAY;
    expect(s.list()).toEqual([]);
  });

  it('follows a renamed project folder, merging into what the new one has', () => {
    const s = store();
    s.record('/p/toolshed', ['a', 'b']);
    s.record('/p/bakery', ['b']);
    expect(s.projectsMoved([{ from: '/p/toolshed', to: '/p/bakery' }])).toBe(1);
    const [only] = store().list();
    expect(only.repoPath).toBe('/p/bakery');
    expect(only.tests.map((t) => [t.name, t.count]).sort()).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(s.projectsMoved([{ from: '/p/gone', to: '/p/x' }])).toBe(0);
  });

  it('an unreadable file starts empty and is rewritten on the next record', () => {
    fs.writeFileSync(file, '{ not json');
    const s = store();
    expect(s.list()).toEqual([]);
    s.record('/p/x', ['a']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).projects['/p/x']).toHaveLength(1);
  });

  it('ut doctor: one warning per project naming its tests', async () => {
    const s = store();
    s.record('/p/untether', ['sessions-api > creates', 'css-watch > rebuilds']);
    s.record('/p/untether', ['css-watch > rebuilds']);
    const findings = await flakyUnderLoadCheck({ list: () => s.list() }).run();
    expect(findings).toEqual([
      expect.objectContaining({
        key: 'flaky-under-load:/p/untether',
        check: 'flaky-under-load',
        severity: 'warning',
      }),
    ]);
    expect(findings[0].problem).toContain('2 test(s)');
    expect(findings[0].problem).toContain('css-watch > rebuilds (×2)');
    expect(findings[0].problem).toContain('sessions-api > creates');
    expect(await flakyUnderLoadCheck({ list: () => [] }).run()).toEqual([]);
  });
});
