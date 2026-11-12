import * as realFs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';

// User report (2026-10-14): after a fresh install of the Mac app, listing Downloads and the new
// "search the Mac" hung forever: macOS held the folders behind a privacy prompt nobody could
// answer. These tests stand in for that with an fs whose calls never return for chosen folders.

/** fs calls on paths under these prefixes never settle (like a read waiting on a TCC prompt). */
const hang = vi.hoisted(() => ({ prefixes: [] as string[], calls: 0 }));
// Spotlight is faked too: each test sets its answer.
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
const mdfind = vi.hoisted(() => ({ stdout: '' }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      const target = String(args[0]);
      if (hang.prefixes.some((prefix) => target === prefix || target.startsWith(`${prefix}/`))) {
        hang.calls++;
        return new Promise<R>(() => {});
      }
      return fn(...args);
    };
  return {
    ...actual,
    stat: wrap(actual.stat),
    readdir: wrap(actual.readdir),
    readFile: wrap(actual.readFile),
    open: wrap(actual.open),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(
      (file: string, args: string[], options: unknown, cb: ExecFileCallback | undefined) => {
        if (file !== 'mdfind') return actual.execFile(file, args, options as never, cb as never);
        setImmediate(() => cb?.(null, mdfind.stdout, ''));
        return { kill: vi.fn() };
      }
    ),
  };
});

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { searchFiles } from './file-search.js';
import {
  FolderAccessError,
  FolderAccessGuard,
  type ProbeVerdict,
  probeInChildProcess,
} from './folder-access.js';

let home: string;

beforeAll(() => {
  home = realFs.realpathSync(realFs.mkdtempSync(path.join(os.tmpdir(), 'folder-access-')));
  for (const dir of ['Downloads', 'Desktop', 'Documents', 'Projects']) {
    realFs.mkdirSync(path.join(home, dir));
  }
  realFs.writeFileSync(path.join(home, 'Downloads', 'informe.pdf'), '%PDF-1.4\n');
  realFs.writeFileSync(path.join(home, 'Projects', 'informe.txt'), 'hola\n');
});

afterAll(() => {
  realFs.rmSync(home, RM_TEST_DIR);
});

afterEach(() => {
  hang.prefixes = [];
  hang.calls = 0;
  mdfind.stdout = '';
});

/** A guard over the fixture home whose probe answers `verdicts[folder]` (default 'ok'). */
function makeGuard(verdicts: Record<string, ProbeVerdict> = {}, extra = {}) {
  const probe = vi.fn(async (dir: string) => verdicts[path.basename(dir)] ?? 'ok');
  const log = vi.fn();
  const guard = new FolderAccessGuard({
    home,
    protectFolders: true,
    timeoutMs: 80,
    probe,
    log,
    ...extra,
  });
  return { guard, probe, log };
}

describe('FolderAccessGuard', () => {
  it('answers permission-pending for a held folder without touching it, and logs one line', async () => {
    const { guard, probe, log } = makeGuard({ Downloads: 'permission-pending' });
    const fn = vi.fn(async () => 'read');
    const target = path.join(home, 'Downloads', 'informe.pdf');

    const first = await guard.run(target, fn).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(FolderAccessError);
    expect((first as FolderAccessError).toJSON()).toEqual({
      error: 'permission-pending',
      folder: 'Downloads',
      place: 'downloads',
    });
    await expect(guard.run(target, fn)).rejects.toBeInstanceOf(FolderAccessError);
    expect(fn).not.toHaveBeenCalled();
    // The verdict is cached: one probe, one log line, no file names in it.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('Downloads');
    expect(log.mock.calls[0][0]).not.toContain('informe');
  });

  it('probes a folder once even when many requests arrive together', async () => {
    let release: (v: ProbeVerdict) => void = () => {};
    const probe = vi.fn(() => new Promise<ProbeVerdict>((resolve) => (release = resolve)));
    const guard = new FolderAccessGuard({ home, protectFolders: true, probe });
    const checks = [1, 2, 3].map(() => guard.check(path.join(home, 'Desktop')));
    release('ok');
    expect(await Promise.all(checks)).toEqual([null, null, null]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-probes a held folder in the background after a while, and recovers when allowed', async () => {
    let now = 1000;
    const verdicts: Record<string, ProbeVerdict> = { Downloads: 'permission-pending' };
    const { guard, probe, log } = makeGuard(verdicts, { now: () => now, blockedTtlMs: 15_000 });
    const target = path.join(home, 'Downloads');
    expect((await guard.check(target))?.error).toBe('permission-pending');

    now += 5_000;
    expect((await guard.check(target))?.error).toBe('permission-pending');
    expect(probe).toHaveBeenCalledTimes(1);

    verdicts.Downloads = 'ok';
    now += 20_000;
    // Still answers at once from the cache; the re-probe runs behind it.
    expect((await guard.check(target))?.error).toBe('permission-pending');
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => expect(await guard.check(target)).toBeNull());
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('can be read again'));
  });

  it('a call that never returns answers permission-pending at the deadline', async () => {
    const { guard } = makeGuard();
    const started = Date.now();
    const error = await guard
      .run(path.join(home, 'Projects'), () => new Promise(() => {}))
      .catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(error).toBeInstanceOf(FolderAccessError);
    expect((error as FolderAccessError).kind).toBe('permission-pending');
    expect((error as FolderAccessError).folder).toBe('Projects');
    // The stalled folder answers at once for a while instead of piling up more stuck calls.
    const fn = vi.fn(async () => 1);
    await expect(guard.run(path.join(home, 'Projects', 'x'), fn)).rejects.toBeInstanceOf(
      FolderAccessError
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('maps EPERM / EACCES to permission-denied', async () => {
    const { guard } = makeGuard();
    const eperm = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    const error = await guard
      .run(path.join(home, 'Documents', 'a'), () => Promise.reject(eperm))
      .catch((e: unknown) => e);
    expect((error as FolderAccessError).toJSON()).toEqual({
      error: 'permission-denied',
      folder: 'Documents',
      place: 'documents',
    });
    const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
    await expect(guard.run(path.join(home, 'x'), () => Promise.reject(enoent))).rejects.toBe(
      enoent
    );
  });

  it('protects nothing off macOS unless asked', async () => {
    const probe = vi.fn(async (): Promise<ProbeVerdict> => 'permission-denied');
    const guard = new FolderAccessGuard({ home, protectFolders: false, probe });
    expect(await guard.check(path.join(home, 'Downloads'))).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('the real child-process probe lists a readable folder and kills a stuck one', async () => {
    expect(await probeInChildProcess(path.join(home, 'Projects'), 4000)).toBe('ok');
    // A FIFO-free stand-in for "stuck": a timeout too short for the child to even start.
    // 2026-10-18: under the full suite's load a spawn can fail outright, and the probe then
    // answers 'ok' (it can't tell) on purpose; a few tries keep that from failing the run.
    let verdict: ProbeVerdict = 'ok';
    for (let attempt = 0; attempt < 5 && verdict !== 'permission-pending'; attempt++) {
      verdict = await probeInChildProcess(path.join(home, 'Projects'), 1);
    }
    expect(verdict).toBe('permission-pending');
    // Missing folder: let the real call answer 404.
    expect(await probeInChildProcess(path.join(home, 'nope'), 4000)).toBe('ok');
  });

  it.skipIf(process.getuid?.() === 0)(
    'the real probe reports an unreadable folder as denied',
    async () => {
      const locked = path.join(home, 'locked');
      realFs.mkdirSync(locked, { recursive: true });
      realFs.chmodSync(locked, 0o000);
      try {
        expect(await probeInChildProcess(locked, 4000)).toBe('permission-denied');
      } finally {
        realFs.chmodSync(locked, 0o755);
        realFs.rmSync(locked, RM_TEST_DIR);
      }
    }
  );

  it('a probe that never ends answers pending after the deadline and starts no second probe', async () => {
    const probe = vi.fn(() => new Promise<ProbeVerdict>(() => {}));
    const guard = new FolderAccessGuard({ home, protectFolders: true, timeoutMs: 50, probe });
    const started = Date.now();
    expect((await guard.check(path.join(home, 'Downloads')))?.error).toBe('permission-pending');
    expect(Date.now() - started).toBeLessThan(3000);
    await guard.check(path.join(home, 'Downloads'));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('an item whose stat stalled answers at once next time (listing its parent stays fast)', async () => {
    const { guard } = makeGuard();
    const item = path.join(home, 'Projects', 'dead-mount');
    const stuck = vi.fn(() => new Promise(() => {}));
    await expect(guard.withDeadline(item, stuck)).rejects.toBeInstanceOf(FolderAccessError);
    const started = Date.now();
    await expect(guard.withDeadline(item, stuck)).rejects.toBeInstanceOf(FolderAccessError);
    expect(Date.now() - started).toBeLessThan(40);
    expect(stuck).toHaveBeenCalledTimes(1);
    // Its siblings are unaffected.
    expect(await guard.withDeadline(path.join(home, 'Projects', 'ok'), async () => 1)).toBe(1);
  });

  it('an ordinary EACCES on one item does not lock the whole protected folder', async () => {
    const { guard } = makeGuard();
    const eacces = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    const error = await guard
      .run(path.join(home, 'Downloads', 'root-owned'), () => Promise.reject(eacces))
      .catch((e: unknown) => e);
    expect((error as FolderAccessError).kind).toBe('permission-denied');
    expect(await guard.run(path.join(home, 'Downloads', 'informe.pdf'), async () => 'read')).toBe(
      'read'
    );
  });

  it('a stalled folder is re-checked in a child process, never by piling up in-process calls', async () => {
    let now = 1000;
    let childVerdict: ProbeVerdict = 'permission-pending';
    const probe = vi.fn(async () => childVerdict);
    const guard = new FolderAccessGuard({
      home,
      protectFolders: true,
      timeoutMs: 50,
      blockedTtlMs: 15_000,
      probe,
      now: () => now,
    });
    const target = path.join(home, 'Projects');
    const stuck = vi.fn(() => new Promise(() => {}));
    await expect(guard.run(target, stuck)).rejects.toBeInstanceOf(FolderAccessError);
    expect(stuck).toHaveBeenCalledTimes(1);

    // Past the TTL, still stuck: the child probe says so, and no new in-process call is made.
    for (let round = 0; round < 3; round++) {
      now += 20_000;
      await expect(guard.run(target, stuck)).rejects.toBeInstanceOf(FolderAccessError);
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(round + 1));
    }
    expect(stuck).toHaveBeenCalledTimes(1);

    // Once the child can read it, the folder is cleared.
    childVerdict = 'ok';
    now += 20_000;
    await guard.check(target).catch(() => null);
    await vi.waitFor(async () => expect(await guard.check(target)).toBeNull());
    expect(await guard.run(target, async () => 'read')).toBe('read');
  });
});

describe('fs routes with a held folder', () => {
  let createFilesystemRoutes: typeof import('../routes/filesystem.js').createFilesystemRoutes;
  let verdicts: Record<string, ProbeVerdict>;
  let app: express.Express;

  beforeAll(async () => {
    ({ createFilesystemRoutes } = await import('../routes/filesystem.js'));
  });

  // A fresh guard (and so a fresh verdict cache) per test.
  beforeEach(() => {
    verdicts = {};
    const guard = new FolderAccessGuard({
      home,
      protectFolders: true,
      timeoutMs: 100,
      probe: async (dir) => verdicts[path.basename(dir)] ?? 'ok',
    });
    app = express();
    app.use('/api', createFilesystemRoutes({ access: guard }));
  });

  const inDownloads = () => path.join(home, 'Downloads', 'informe.pdf');

  it('browse answers 503 permission-pending instead of hanging', async () => {
    verdicts.Downloads = 'permission-pending';
    const res = await request(app)
      .get('/api/fs/browse')
      .query({ path: path.join(home, 'Downloads'), gitFilter: 'none' })
      .timeout(3000);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'permission-pending',
      folder: 'Downloads',
      place: 'downloads',
    });
  });

  it('browse answers 403 permission-denied when macOS said no', async () => {
    verdicts.Downloads = 'permission-denied';
    const res = await request(app)
      .get('/api/fs/browse')
      .query({ path: path.join(home, 'Downloads'), gitFilter: 'none' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('permission-denied');
  });

  it('listing home still works while Downloads is held', async () => {
    verdicts.Downloads = 'permission-pending';
    const res = await request(app).get('/api/fs/browse').query({ path: home, gitFilter: 'none' });
    expect(res.status).toBe(200);
    expect(res.body.files.map((f: { name: string }) => f.name)).toContain('Downloads');
  });

  // /api/fs/content had no caller and is gone (2026-11-11): the two that read a file remain.
  it('preview and raw answer with the structured error too', async () => {
    verdicts.Downloads = 'permission-pending';
    for (const route of ['preview', 'raw']) {
      const res = await request(app).get(`/api/fs/${route}`).query({ path: inDownloads() });
      expect(res.status, route).toBe(503);
      expect(res.body.folder, route).toBe('Downloads');
    }
  });

  it('a readdir that never returns answers within the deadline (mocked hanging fs)', async () => {
    hang.prefixes = [path.join(home, 'Projects')];
    const started = Date.now();
    const res = await request(app)
      .get('/api/fs/browse')
      .query({ path: path.join(home, 'Projects'), gitFilter: 'none' })
      .timeout(3000);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'permission-pending', folder: 'Projects', place: 'other' });
  });

  it('completions say why they are empty instead of hanging', async () => {
    verdicts.Downloads = 'permission-pending';
    const res = await request(app)
      .get('/api/fs/completions')
      .query({ path: `${path.join(home, 'Downloads')}/` });
    expect(res.status).toBe(200);
    expect(res.body.completions).toEqual([]);
    expect(res.body.blocked).toMatchObject({ error: 'permission-pending', folder: 'Downloads' });
  });
});

describe('search with a held folder', () => {
  it('returns the readable matches plus the held folders, without touching them', async () => {
    const { guard } = makeGuard({ Downloads: 'permission-pending' });
    // Spotlight knows a name in Downloads; stat there would hang.
    hang.prefixes = [path.join(home, 'Downloads')];
    mdfind.stdout = `${inDownloadsPath()}\0${path.join(home, 'Projects', 'informe.txt')}\0`;
    const result = await searchFiles('informe', { home, access: guard });
    expect(result.results.map((hit) => hit.name)).toEqual(['informe.txt']);
    expect(result.blocked).toEqual([
      { error: 'permission-pending', folder: 'Downloads', place: 'downloads' },
    ]);
    expect(hang.calls).toBe(0);
  });

  it('the fallback walk skips a held folder instead of blocking on it', async () => {
    const { guard } = makeGuard({ Desktop: 'permission-denied' });
    hang.prefixes = [path.join(home, 'Desktop')];
    mdfind.stdout = '';
    const started = Date.now();
    const result = await searchFiles('informe', { home, access: guard });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.source).toBe('walk');
    expect(result.results.map((hit) => hit.name).sort()).toEqual(['informe.pdf', 'informe.txt']);
    expect(result.blocked).toEqual([
      { error: 'permission-denied', folder: 'Desktop', place: 'desktop' },
    ]);
    expect(hang.calls).toBe(0);
  });
});

function inDownloadsPath() {
  return path.join(home, 'Downloads', 'informe.pdf');
}
