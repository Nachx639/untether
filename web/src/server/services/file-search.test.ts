import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { AuthService } from './auth-service.js';

// mdfind is faked: each test sets what "Spotlight" answers.
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
const mdfind = vi.hoisted(() => ({
  answer: (_args: string[], callback: ExecFileCallback) => callback(null, '', ''),
  calls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(
      (file: string, args: string[], options: Record<string, unknown>, cb: ExecFileCallback) => {
        mdfind.calls.push({ file, args, options });
        setImmediate(() => mdfind.answer(args, cb));
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

import {
  buildSpotlightQuery,
  classifyPath,
  ICLOUD_DRIVE_RELATIVE,
  searchFiles,
} from './file-search.js';

let home: string;
let icloud: string;
const NAME = 'Hoja de inscripción - ejemplo.pdf';

function touch(rel: string, mtime: Date) {
  const full = path.join(home, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, 'x');
  fs.utimesSync(full, mtime, mtime);
  return full;
}

const recent = new Date();
const old = new Date(Date.now() - 400 * 86_400_000);
let inDownloads: string;
let inDownloadsCopy: string;
let inIcloud: string;
let inCache: string;
let inNodeModules: string;
let inHidden: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-search-'));
  icloud = path.join(home, ICLOUD_DRIVE_RELATIVE);
  inDownloads = touch(`Downloads/${NAME}`, old);
  inDownloadsCopy = touch('Downloads/Hoja de inscripción - ejemplo (1).pdf', recent);
  inIcloud = touch(`${ICLOUD_DRIVE_RELATIVE}/Trámites/${NAME}`, old);
  inCache = touch(`Library/Caches/${NAME}`, recent);
  inNodeModules = touch(`code/node_modules/pkg/${NAME}`, recent);
  inHidden = touch(`.cache/${NAME}`, recent);
  touch('Documents/otro.txt', recent);
});

afterAll(() => {
  if (home) fs.rmSync(home, RM_TEST_DIR);
});

beforeEach(() => {
  mdfind.calls.length = 0;
});

describe('buildSpotlightQuery', () => {
  it('ANDs every word, case- and diacritic-insensitive, escaping quotes', () => {
    expect(buildSpotlightQuery(['hoja', 'inscripcion'])).toBe(
      'kMDItemFSName == "*hoja*"cd && kMDItemFSName == "*inscripcion*"cd'
    );
    expect(buildSpotlightQuery(['a"b\\c*'])).toBe('kMDItemFSName == "*a\\"b\\\\c*"cd');
  });
});

describe('classifyPath', () => {
  it('labels home and iCloud Drive and drops hidden, Library and dependency folders', () => {
    expect(classifyPath(path.join(home, 'Downloads', 'a.pdf'), home)).toEqual({
      area: 'home',
      parent: 'Downloads',
    });
    expect(classifyPath(path.join(icloud, 'Trámites', 'a.pdf'), home)).toEqual({
      area: 'icloud',
      parent: 'Trámites',
    });
    expect(classifyPath(path.join(icloud, 'a.pdf'), home)).toEqual({ area: 'icloud', parent: '' });
    expect(classifyPath(path.join(home, 'Library', 'Caches', 'a.pdf'), home)).toBeNull();
    expect(classifyPath(path.join(home, '.git', 'a'), home)).toBeNull();
    expect(classifyPath(path.join(home, 'x', 'node_modules', 'a'), home)).toBeNull();
    expect(classifyPath('/etc/hosts', home)).toBeNull();
  });
});

describe('searchFiles', () => {
  it('asks Spotlight (args, no shell, with a timeout) and ranks the allowed matches', async () => {
    mdfind.answer = (_args, cb) =>
      cb(
        null,
        [inDownloads, inDownloadsCopy, inIcloud, inCache, inNodeModules, inHidden, inDownloads]
          .map((p) => `${p}\0`)
          .join(''),
        ''
      );
    const result = await searchFiles('hoja de INSCRIPCION', { home });
    expect(mdfind.calls[0].file).toBe('mdfind');
    expect(mdfind.calls[0].args).toEqual([
      '-0',
      '-onlyin',
      home,
      'kMDItemFSName == "*hoja*"cd && kMDItemFSName == "*de*"cd && kMDItemFSName == "*inscripcion*"cd',
    ]);
    expect(mdfind.calls[0].options.timeout).toBe(3000);
    expect(result.source).toBe('spotlight');
    expect(result.results.map((r) => r.path).sort()).toEqual(
      [inDownloads, inDownloadsCopy, inIcloud].sort()
    );
    // The shallow one in Downloads before the same name deeper in iCloud Drive.
    const paths = result.results.map((r) => r.path);
    expect(paths.indexOf(inDownloads)).toBeLessThan(paths.indexOf(inIcloud));
    const icloudHit = result.results.find((r) => r.path === inIcloud);
    expect(icloudHit).toMatchObject({ area: 'icloud', parent: 'Trámites', type: 'file' });
  });

  it('keeps what a timed-out Spotlight already printed, minus the cut-off last path', async () => {
    mdfind.answer = (_args, cb) =>
      cb(
        Object.assign(new Error('timeout'), { killed: true }),
        `${inDownloads}\0${home}/Downl`,
        ''
      );
    const result = await searchFiles('inscripcion', { home });
    expect(result.results.map((r) => r.path)).toEqual([inDownloads]);
    expect(result.truncated).toBe(true);
  });

  it('walks home (skipping Library, node_modules, hidden) when mdfind is missing', async () => {
    mdfind.answer = (_args, cb) =>
      cb(Object.assign(new Error('spawn mdfind ENOENT'), { code: 'ENOENT' }), '', '');
    const result = await searchFiles('inscripcion hoja', { home });
    expect(result.source).toBe('walk');
    expect(result.results.map((r) => r.path).sort()).toEqual(
      [inDownloads, inDownloadsCopy, inIcloud].sort()
    );
  });

  it('also walks when Spotlight answers nothing (not indexed)', async () => {
    mdfind.answer = (_args, cb) => cb(null, '', '');
    const result = await searchFiles('ejemplo inscripcion', { home });
    expect(result.source).toBe('walk');
    expect(result.results).toHaveLength(3);
  });

  it('caps the number of results', async () => {
    mdfind.answer = (_args, cb) =>
      cb(null, `${inDownloads}\0${inDownloadsCopy}\0${inIcloud}\0`, '');
    const result = await searchFiles('ejemplo', { home, limit: 2 });
    expect(result.results).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe('GET /api/fs/search', () => {
  let app: express.Express;
  const auth = { Authorization: 'Bearer good' };

  beforeAll(async () => {
    process.env.UNTETHER_FS_SEARCH_HOME = home;
    const { createFilesystemRoutes } = await import('../routes/filesystem.js');
    const { createAuthMiddleware } = await import('../middleware/auth.js');
    const authService = {
      verifyToken: (token: string) =>
        token === 'good' ? { valid: true, userId: 'alice' } : { valid: false },
    } as unknown as AuthService;
    app = express();
    app.use(
      '/api',
      createAuthMiddleware({ authService } as Parameters<typeof createAuthMiddleware>[0])
    );
    app.use('/api', createFilesystemRoutes());
  });

  afterAll(() => {
    delete process.env.UNTETHER_FS_SEARCH_HOME;
  });

  it('requires auth', async () => {
    const res = await request(app).get('/api/fs/search?q=hoja');
    expect(res.status).toBe(401);
    expect(mdfind.calls).toHaveLength(0);
  });

  it('rejects a query shorter than two characters', async () => {
    const res = await request(app).get('/api/fs/search?q=a').set(auth);
    expect(res.status).toBe(400);
  });

  it('answers with ranked hits under the configured home', async () => {
    mdfind.answer = (_args, cb) => cb(null, `${inIcloud}\0${inCache}\0`, '');
    const res = await request(app)
      .get(`/api/fs/search?q=${encodeURIComponent('hoja inscripcion')}`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('hoja inscripcion');
    expect(res.body.results).toEqual([
      expect.objectContaining({ name: NAME, path: inIcloud, area: 'icloud', parent: 'Trámites' }),
    ]);
    expect(mdfind.calls[0].args).toContain(home);
  });
});
