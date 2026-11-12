import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GIT_INIT_MAX_FILES } from '../../shared/git-init.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  createGitInit,
  createGitInitReviewer,
  GIT_INIT_COMMIT_MESSAGE,
  type GitInitScan,
  gitignorePathLine,
  mergeGitignore,
  parseReview,
  REVIEW_SYSTEM_PROMPT,
  redactSecrets,
  reviewQuestion,
} from './project-git-init.js';
import type { RouteChild, RouteSpawner } from './task-router-llm.js';

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return childProcess
    .execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
    .toString()
    .trim();
}

const AWS_KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`;

function write(root: string, rel: string, content: string | Buffer = 'x\n') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('project-git-init', () => {
  let home: string;
  let folder: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of Object.keys(GIT_ENV)) saved[key] = process.env[key];
    Object.assign(process.env, GIT_ENV);
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-git-init-home-')));
    folder = path.join(home, 'Projects', 'tele-ambiente');
    write(folder, 'index.html', '<h1>hola</h1>\n');
    write(folder, 'src/app.js', 'console.log(1)\n');
    write(folder, 'package.json', '{"name":"tele"}\n');
    write(folder, 'node_modules/lit/index.js', 'export {}\n');
    write(folder, 'cache/thumb.bin', 'x');
    write(folder, 'dist/bundle.js', 'x');
    write(folder, 'logs/server.txt', 'x');
    write(folder, 'debug.log', 'x');
    write(folder, '.env', 'API_KEY=1\n');
    write(folder, '.env.example', 'API_KEY=\n');
    write(folder, 'notes/keys.txt', `aws = ${AWS_KEY}\n`);
    write(folder, 'credentials.json', '{}\n');
    write(folder, 'video.mp4', Buffer.alloc(6 * 1024 * 1024, 1));
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, RM_TEST_DIR);
  });

  const noReview = async () => ({ status: 'unavailable' as const, verdicts: [] });

  it('previews: patterns that match, what goes in, and the suspicious files', async () => {
    const service = createGitInit({ home, reviewer: noReview });
    const preview = await service.preview(folder);
    const patterns = preview.ignore.map((entry) => entry.pattern);
    expect(patterns).toEqual(
      expect.arrayContaining([
        'node_modules/',
        '/cache/',
        '/dist/',
        'logs/',
        '*.log',
        '.env',
        '.env.*',
        '.DS_Store',
        '!.env.example',
      ])
    );
    // Only what is there (plus .DS_Store/.env): no Python or Rust lines.
    expect(patterns).not.toContain('__pycache__/');
    expect(patterns).not.toContain('target/');
    expect(preview.ignore.find((entry) => entry.pattern === '.DS_Store')?.matches).toBe(0);
    expect(preview.ignore.find((entry) => entry.pattern === 'node_modules/')?.matches).toBe(1);

    // index.html, src/app.js, package.json, .env.example, notes/keys.txt, credentials.json, video
    expect(preview.files).toBe(7);
    expect(preview.size).toBeGreaterThan(6 * 1024 * 1024);
    expect(preview.capped).toBe(false);
    expect(preview.hasGitignore).toBe(false);
    expect(preview.flagged).toEqual([
      {
        path: 'credentials.json',
        size: 3,
        reasons: [{ kind: 'secret-name' }],
        defaultExcluded: true,
      },
      {
        path: 'notes/keys.txt',
        size: expect.any(Number),
        reasons: [{ kind: 'secret-content', detail: 'AWS access key' }],
        defaultExcluded: true,
      },
      {
        path: 'video.mp4',
        size: 6 * 1024 * 1024,
        reasons: [{ kind: 'big' }],
        defaultExcluded: false,
      },
    ]);
  });

  it('keeps a cache/ folder holding code, and build output only next to a manifest', async () => {
    write(folder, 'lib/cache/index.ts', 'export {}\n');
    write(folder, 'docs/build/page.md', '# doc\n');
    const preview = await createGitInit({ home, reviewer: noReview }).preview(folder);
    expect(preview.ignore.find((entry) => entry.pattern === '/cache/')?.matches).toBe(1);
    expect(preview.ignore.map((entry) => entry.pattern)).not.toContain('/lib/cache/');
    expect(preview.ignore.map((entry) => entry.pattern)).not.toContain('/docs/build/');
    expect(preview.files).toBe(9);
  });

  it('respects a .gitignore already there', async () => {
    write(folder, '.gitignore', 'video.mp4\n');
    const preview = await createGitInit({ home, reviewer: noReview }).preview(folder);
    expect(preview.hasGitignore).toBe(true);
    expect(preview.flagged.map((file) => file.path)).not.toContain('video.mp4');
  });

  it('refuses the home folder, folders outside it, and folders inside a repository', async () => {
    const service = createGitInit({ home, reviewer: noReview });
    await expect(service.preview(home)).rejects.toMatchObject({ code: 'bad-request' });
    await expect(service.preview(os.tmpdir())).rejects.toMatchObject({ code: 'bad-request' });
    await expect(service.preview('relative/path')).rejects.toMatchObject({ code: 'bad-request' });
    await expect(service.preview(path.join(home, 'nope'))).rejects.toMatchObject({
      code: 'bad-request',
    });
    const repo = path.join(home, 'Projects', 'repo');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    git(repo, 'init', '-q');
    await expect(service.preview(repo)).rejects.toMatchObject({ code: 'conflict' });
    await expect(service.init(path.join(repo, 'sub'), [])).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('makes the repository: .gitignore merged, left-out files kept out, one commit', async () => {
    write(folder, '.gitignore', '# mine\nsecret-stuff/\n!keep.log');
    const service = createGitInit({ home, reviewer: noReview });
    const result = await service.init(folder, ['notes/keys.txt', 'credentials.json']);
    expect(result.repoPath).toBe(folder);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);

    const ignore = fs.readFileSync(path.join(folder, '.gitignore'), 'utf8');
    expect(ignore.startsWith('# mine\nsecret-stuff/\n!keep.log\n\n')).toBe(true);
    expect(ignore).toContain('node_modules/\n');
    expect(ignore).toContain('/notes/keys.txt\n');
    expect(ignore).toContain('/credentials.json\n');

    expect(git(folder, 'branch', '--show-current')).toBe('main');
    expect(git(folder, 'log', '--format=%s')).toBe(GIT_INIT_COMMIT_MESSAGE);
    // No identity configured (GIT_CONFIG_GLOBAL=/dev/null): the repo-local fallback.
    expect(git(folder, 'log', '--format=%an <%ae>')).toBe('Untether <untether@localhost>');
    const tracked = git(folder, 'ls-files').split('\n').sort();
    expect(tracked).toEqual(
      ['.env.example', '.gitignore', 'index.html', 'package.json', 'src/app.js', 'video.mp4'].sort()
    );
    expect(result.files).toBe(6);
    expect(git(folder, 'status', '--porcelain')).toBe('');

    // Now a repository: refused.
    await expect(service.init(folder, [])).rejects.toMatchObject({ code: 'conflict' });
  });

  it("uses the user's identity when there is one", async () => {
    const config = path.join(home, '.gitconfig-test');
    fs.writeFileSync(config, '[user]\n\tname = Alex\n\temail = alex@example.com\n');
    process.env.GIT_CONFIG_GLOBAL = config;
    await createGitInit({ home, reviewer: noReview }).init(folder, []);
    expect(git(folder, 'log', '--format=%an <%ae>')).toBe('Alex <alex@example.com>');
    expect(git(folder, 'config', '--local', '--list')).not.toContain('user.name');
  }, 20_000);

  it('refuses a folder bigger than the scan can check (2026-10-20: unscanned folders went in)', async () => {
    // 2026-11-02: the limit is passed in small (the logic is the same at any size), instead of
    // writing GIT_INIT_MAX_FILES + 1 files, which took 2-6 s under load.
    const maxFiles = 50;
    const many = path.join(folder, 'many');
    fs.mkdirSync(many);
    for (let i = 0; i <= maxFiles; i++) fs.writeFileSync(path.join(many, `f${i}`), '');
    // Without the option the service uses the real limit, far above this folder.
    expect(GIT_INIT_MAX_FILES).toBeGreaterThan(maxFiles * 10);
    expect((await createGitInit({ home, reviewer: noReview }).preview(folder)).capped).toBe(false);
    const service = createGitInit({ home, reviewer: noReview, maxFiles });
    expect((await service.preview(folder)).capped).toBe(true);
    await expect(service.init(folder, [])).rejects.toMatchObject({
      code: 'bad-request',
      message: expect.stringContaining(`more than ${maxFiles} files`),
    });
    expect(fs.existsSync(path.join(folder, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(folder, '.gitignore'))).toBe(false);
  });

  it('rejects excludes that leave the folder', async () => {
    const service = createGitInit({ home, reviewer: noReview });
    for (const bad of ['../x', '/etc/passwd', 'a/../../b', '.git/config', 'a//b']) {
      await expect(service.init(folder, [bad])).rejects.toMatchObject({ code: 'bad-request' });
    }
    expect(fs.existsSync(path.join(folder, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(folder, '.gitignore'))).toBe(false);
  });

  it('puts .gitignore back and removes .git when the commit fails', async () => {
    write(folder, '.gitignore', 'old\n');
    const hooks = path.join(home, 'hooks');
    write(hooks, 'pre-commit', '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755);
    const config = path.join(home, '.gitconfig-hooks');
    fs.writeFileSync(config, `[core]\n\thooksPath = ${hooks}\n`);
    process.env.GIT_CONFIG_GLOBAL = config;
    await expect(
      createGitInit({ home, reviewer: noReview }).init(folder, [])
    ).rejects.toMatchObject({ code: 'failed' });
    expect(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8')).toBe('old\n');
    expect(fs.existsSync(path.join(folder, '.git'))).toBe(false);
  });

  describe('mergeGitignore', () => {
    it('never drops a line and adds only what is missing', () => {
      expect(mergeGitignore('a\nnode_modules/', ['node_modules/', '.env'], ['x y.txt'])).toBe(
        `a\nnode_modules/\n\n# ${GIT_INIT_COMMIT_MESSAGE}\n.env\n/x y.txt\n`
      );
      expect(mergeGitignore(null, ['.env'], [])).toBe(`# ${GIT_INIT_COMMIT_MESSAGE}\n.env\n`);
      expect(mergeGitignore('.env\n', ['.env'], [])).toBeNull();
    });

    it('escapes left-out paths', () => {
      expect(gitignorePathLine('a/b*[1]?.txt')).toBe('/a/b\\*\\[1]\\?.txt');
      expect(gitignorePathLine('#notes ')).toBe('/#notes\\ ');
    });
  });

  describe('AI review', () => {
    class FakeChild extends EventEmitter implements RouteChild {
      stdout = new PassThrough();
      kill() {
        return true;
      }
    }
    let tokenFile: string;
    let calls: string[][];
    beforeEach(() => {
      tokenFile = path.join(home, 'token');
      fs.writeFileSync(tokenFile, 'tok\n');
      calls = [];
    });
    const spawner =
      (reply: string | null): RouteSpawner =>
      (_bin, args) => {
        calls.push(args);
        const child = new FakeChild();
        if (reply !== null) {
          setImmediate(() => {
            child.stdout.write(`${JSON.stringify({ type: 'result', result: reply })}\n`);
            child.stdout.end();
            setImmediate(() => child.emit('close'));
          });
        }
        return child;
      };

    it('asks with the file list, flags and redacted snippets, and keeps known paths', async () => {
      const reviewer = createGitInitReviewer({
        claudeBin: '/bin/claude',
        tokenFile,
        spawn: spawner(
          JSON.stringify({
            summary: 'Hay una clave de AWS',
            verdicts: [
              { path: 'notes/keys.txt', action: 'exclude', reason: 'Clave de AWS' },
              { path: 'video.mp4', action: 'exclude', reason: 'Vídeo pesado' },
              { path: 'not/listed.txt', action: 'exclude', reason: 'x' },
              { path: 'index.html', action: 'maybe', reason: 'x' },
            ],
          })
        ),
      });
      const service = createGitInit({ home, reviewer });
      await service.preview(folder);
      const review = await service.review(folder, 'es');
      expect(review).toEqual({
        status: 'done',
        summary: 'Hay una clave de AWS',
        verdicts: [
          { path: 'notes/keys.txt', action: 'exclude', reason: 'Clave de AWS' },
          { path: 'video.mp4', action: 'exclude', reason: 'Vídeo pesado' },
        ],
      });
      const args = calls[0];
      expect(args).toContain(REVIEW_SYSTEM_PROMPT);
      const question = args[args.length - 1];
      expect(question).toContain('- notes/keys.txt');
      expect(question).toContain('content looks like a AWS access key');
      expect(question).toContain('--- notes/keys.txt');
      expect(question).not.toContain(AWS_KEY);
      expect(question).toContain('in Spanish');
    });

    it('is unavailable without a token, on garbage or on a timeout', async () => {
      const scan: GitInitScan = {
        preview: {
          folder,
          files: 1,
          size: 1,
          capped: false,
          ignore: [],
          flagged: [],
          hasGitignore: false,
        },
        entries: [{ path: 'a', size: 1 }],
        snippets: new Map(),
      };
      const noToken = createGitInitReviewer({
        claudeBin: '/bin/claude',
        tokenFile: path.join(home, 'missing'),
        spawn: spawner('{}'),
      });
      expect(await noToken(scan, 'es')).toEqual({ status: 'unavailable', verdicts: [] });
      const garbage = createGitInitReviewer({
        claudeBin: '/bin/claude',
        tokenFile,
        spawn: spawner('no sé'),
      });
      expect((await garbage(scan, 'es')).status).toBe('unavailable');
      const hang = createGitInitReviewer({
        claudeBin: '/bin/claude',
        tokenFile,
        spawn: spawner(null),
        timeoutMs: 20,
      });
      expect((await hang(scan, 'es')).status).toBe('unavailable');
      const noClaude = createGitInitReviewer({ claudeBin: null, tokenFile });
      expect((await noClaude(scan, 'es')).status).toBe('unavailable');
    });

    it('parses replies around prose and drops bad verdicts', () => {
      const known = new Set(['a.txt', 'b.bin']);
      expect(
        parseReview(
          'Here: {"verdicts":[{"path":"a.txt","action":"include","reason":"ok"},{"path":"a.txt","action":"exclude"},{"path":"b.bin","action":"exclude"}]}',
          known
        )
      ).toEqual({
        verdicts: [
          { path: 'a.txt', action: 'include', reason: 'ok' },
          { path: 'b.bin', action: 'exclude', reason: '' },
        ],
      });
      expect(parseReview('{"verdicts": "x"}', known)).toBeNull();
      expect(parseReview('nothing', known)).toBeNull();
    });

    it('redacts token-looking values and writes the question in the locale', () => {
      expect(redactSecrets(`key ${AWS_KEY} end`)).toBe('key AKIA…[redacted] end');
      const scan: GitInitScan = {
        preview: {
          folder,
          files: 0,
          size: 0,
          capped: false,
          ignore: [],
          flagged: [],
          hasGitignore: false,
        },
        entries: [],
        snippets: new Map(),
      };
      expect(reviewQuestion(scan, 'fr')).toContain('in French');
    });
  });
});
