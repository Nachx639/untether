import * as childProcess from 'child_process';
import express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '../../shared/types';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { createAuthMiddleware } from '../middleware/auth';

// Record every program the routes start, to assert arg arrays and the absence of --force.
const calls: { bin: string; args: string[]; opts: Record<string, unknown> }[] = [];
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  const execFile = (bin: string, args: string[], opts: Record<string, unknown>, cb: unknown) => {
    calls.push({ bin, args: [...args], opts });
    return (actual.execFile as unknown as (...a: unknown[]) => unknown)(bin, args, opts, cb);
  };
  // Keep `promisify(execFile)` (used by the changes list) resolving to { stdout, stderr }.
  Object.assign(execFile, { [promisify.custom]: promisify(actual.execFile) });
  return { ...actual, execFile };
});
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

const { createGitShipRoutes, assertNoForce, prefillPr } = await import('./git-ship');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const savedEnv: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
  return childProcess
    .execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
    .toString()
    .trim();
}

let tmp: string;
let repo: string;
let remote: string;
let workingDir: string;

function appWith(opts: { auth?: boolean; ghBin?: string } = {}) {
  const app = express();
  app.use(express.json());
  if (opts.auth) {
    app.use(
      '/api',
      createAuthMiddleware({
        enableSSHKeys: false,
        disallowUserPassword: false,
        noAuth: false,
        isHQMode: false,
      })
    );
  }
  app.use(
    '/api',
    createGitShipRoutes({
      ptyManager: {
        getSession: (id: string) =>
          id === 's1' ? ({ id: 's1', workingDir } as unknown as SessionInfo) : null,
      },
      ...(opts.ghBin ? { ghBin: opts.ghBin } : {}),
    })
  );
  return app;
}

// 2026-11-02: the bare remote + clone (pushed main, feature/ship checked out) is built once per
// file and copied into each test's folder: 7 git processes per test became 0. The copy is the
// same repository state; only the remote URL in .git/config names the template folder, so it is
// pointed at the copy's own remote.
let template: string;

beforeAll(() => {
  for (const [k, v] of Object.entries(GIT_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  template = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-ship-template-')));
  const tRemote = path.join(template, 'remote.git');
  const tRepo = path.join(template, 'repo');
  git(template, 'init', '-q', '--bare', '-b', 'main', tRemote);
  git(template, 'init', '-q', '-b', 'main', tRepo);
  fs.writeFileSync(path.join(tRepo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(tRepo, 'b.txt'), 'b\n');
  git(tRepo, 'add', '.');
  git(tRepo, 'commit', '-q', '-m', 'init');
  git(tRepo, 'remote', 'add', 'origin', tRemote);
  git(tRepo, 'push', '-q', '-u', 'origin', 'main');
  git(tRepo, 'checkout', '-q', '-b', 'feature/ship');
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(template, RM_TEST_DIR);
});

beforeEach(() => {
  calls.length = 0;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-ship-')));
  remote = path.join(tmp, 'remote.git');
  repo = path.join(tmp, 'repo');
  fs.cpSync(template, tmp, { recursive: true });
  const config = path.join(repo, '.git', 'config');
  fs.writeFileSync(
    config,
    fs.readFileSync(config, 'utf8').replaceAll(path.join(template, 'remote.git'), remote)
  );
  workingDir = repo;
});

afterEach(() => {
  fs.rmSync(tmp, RM_TEST_DIR);
});

describe('commit', () => {
  it('commits only the selected files, including a new untracked one', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a2\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b2\n');
    fs.writeFileSync(path.join(repo, 'new file.txt'), 'n\n');
    git(repo, 'add', 'b.txt'); // staged beforehand but not chosen: must stay out
    const res = await request(appWith())
      .post('/api/sessions/s1/git/commit')
      .send({ files: [{ path: 'a.txt' }, { path: 'new file.txt' }], message: 'feat: ship it' });
    expect(res.status).toBe(200);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('feat: ship it');
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'a.txt',
      'new file.txt',
    ]);
    expect(git(repo, 'status', '--porcelain')).toContain('b.txt');
    const commitCall = calls.find((c) => c.bin === 'git' && c.args[0] === 'commit');
    expect(commitCall?.args).toEqual([
      'commit',
      '--only',
      '-m',
      'feat: ship it',
      '--',
      ':(literal)a.txt',
      ':(literal)new file.txt',
    ]);
    expect(commitCall?.args).not.toContain('--no-verify');
  });

  it('surfaces a failing pre-commit hook and commits nothing', async () => {
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "lint: 3 errors in a.txt" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a2\n');
    const before = git(repo, 'rev-parse', 'HEAD');
    const res = await request(appWith())
      .post('/api/sessions/s1/git/commit')
      .send({ files: ['a.txt'], message: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('commit-failed');
    expect(res.body.output).toContain('lint: 3 errors in a.txt');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('rejects paths outside the repository and empty messages', async () => {
    const app = appWith();
    for (const bad of ['../outside.txt', '/etc/passwd', 'a/../../x', '']) {
      const res = await request(app)
        .post('/api/sessions/s1/git/commit')
        .send({ files: [bad], message: 'x' });
      expect(res.status).toBe(400);
    }
    const res = await request(app)
      .post('/api/sessions/s1/git/commit')
      .send({ files: ['a.txt'], message: '  ' });
    expect(res.status).toBe(400);
    expect(calls.some((c) => c.args[0] === 'commit' || c.args[0] === 'add')).toBe(false);
  });

  it('treats shell metacharacters in the message and file names as plain text', async () => {
    const name = '$(touch pwned);`x`.txt';
    fs.writeFileSync(path.join(repo, name), '1\n');
    const res = await request(appWith())
      .post('/api/sessions/s1/git/commit')
      .send({ files: [name], message: '"; touch pwned2; echo "' });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(repo, 'pwned'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'pwned2'))).toBe(false);
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('"; touch pwned2; echo "');
  });
});

describe('ship-status and push', () => {
  it('reports branch, missing upstream and ahead count; pushes with -u when asked', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a2\n');
    git(repo, 'commit', '-q', '-am', 'one');
    const app = appWith();
    let status = await request(app).get('/api/sessions/s1/git/ship-status');
    expect(status.body).toMatchObject({
      branch: 'feature/ship',
      detached: false,
      upstream: null,
      ahead: 1,
      protectedBranch: false,
    });

    const refused = await request(app).post('/api/sessions/s1/git/push').send({});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('no-upstream');

    const res = await request(app).post('/api/sessions/s1/git/push').send({ setUpstream: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ upstream: 'origin/feature/ship', ahead: 0, behind: 0 });
    expect(git(remote, 'rev-parse', 'feature/ship')).toBe(git(repo, 'rev-parse', 'HEAD'));

    fs.writeFileSync(path.join(repo, 'b.txt'), 'b2\n');
    git(repo, 'commit', '-q', '-am', 'two');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b3\n');
    git(repo, 'commit', '-q', '-am', 'three');
    status = await request(app).get('/api/sessions/s1/git/ship-status');
    expect(status.body).toMatchObject({ upstream: 'origin/feature/ship', ahead: 2, behind: 0 });
    expect(status.body.files).toEqual([]);

    const again = await request(app).post('/api/sessions/s1/git/push').send({});
    expect(again.status).toBe(200);
    expect(again.body.ahead).toBe(0);

    const pushes = calls.filter((c) => c.bin === 'git' && c.args[0] === 'push');
    expect(pushes).toHaveLength(2);
    for (const p of pushes) {
      expect(p.args.some((a) => /force|^-f$|^\+|:\+|--mirror|--delete/.test(a))).toBe(false);
    }
  });

  it('refuses main/master unless explicitly confirmed', async () => {
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'm\n');
    git(repo, 'commit', '-q', '-am', 'on main');
    const app = appWith();
    expect((await request(app).get('/api/sessions/s1/git/ship-status')).body.protectedBranch).toBe(
      true
    );
    const refused = await request(app).post('/api/sessions/s1/git/push').send({});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('protected');
    const notTrue = await request(app)
      .post('/api/sessions/s1/git/push')
      .send({ confirmMain: 'yes' });
    expect(notTrue.status).toBe(409);
    expect(calls.some((c) => c.args[0] === 'push')).toBe(false);
    const ok = await request(app).post('/api/sessions/s1/git/push').send({ confirmMain: true });
    expect(ok.status).toBe(200);
    expect(git(remote, 'rev-parse', 'main')).toBe(git(repo, 'rev-parse', 'HEAD'));
  });

  it('refuses a feature branch whose upstream is main without confirmation', async () => {
    git(repo, 'branch', '-q', '--set-upstream-to=origin/main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'f\n');
    git(repo, 'commit', '-q', '-am', 'f');
    const res = await request(appWith()).post('/api/sessions/s1/git/push').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('protected');
  });

  it('refuses a detached HEAD', async () => {
    git(repo, 'checkout', '-q', '--detach');
    const app = appWith();
    expect((await request(app).get('/api/sessions/s1/git/ship-status')).body.detached).toBe(true);
    const res = await request(app).post('/api/sessions/s1/git/push').send({ setUpstream: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('detached');
  });

  it('surfaces a rejected (non-fast-forward) push instead of forcing it', async () => {
    git(repo, 'checkout', '-q', 'main');
    const other = path.join(tmp, 'other');
    git(tmp, 'clone', '-q', remote, other);
    fs.writeFileSync(path.join(other, 'a.txt'), 'theirs\n');
    git(other, 'commit', '-q', '-am', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'ours\n');
    git(repo, 'commit', '-q', '-am', 'ours');
    const res = await request(appWith())
      .post('/api/sessions/s1/git/push')
      .send({ confirmMain: true });
    expect(res.status).toBe(422);
    expect(res.body.output).toMatch(/rejected|non-fast-forward|fetch first/);
  });

  it('never lets a force argument through', () => {
    for (const a of [
      '--force',
      '-f',
      '--force-with-lease',
      '--force-with-lease=x',
      '+main',
      'a:+b',
      '--mirror',
      '--delete',
      ':main',
    ]) {
      expect(() => assertNoForce(['push', a])).toThrow();
    }
    expect(() =>
      assertNoForce(['push', '-u', 'origin', 'refs/heads/a:refs/heads/a'])
    ).not.toThrow();
  });
});

describe('pull request', () => {
  let binDir: string;
  let logFile: string;

  beforeEach(() => {
    binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    logFile = path.join(tmp, 'gh-args.log');
  });

  function fakeGh(authOk = true): string {
    const gh = path.join(binDir, 'gh');
    fs.writeFileSync(
      gh,
      `#!/bin/sh
case "$1" in
  --version) echo "gh version 9.9.9"; exit 0 ;;
  auth) ${authOk ? 'echo "Logged in to github.com"; exit 0' : 'echo "You are not logged into any GitHub hosts" >&2; exit 1'} ;;
  repo) echo "trunk"; exit 0 ;;
  pr) for a in "$@"; do printf '%s\\n' "$a" >> "${logFile}"; done
      echo "https://github.com/acme/app/pull/42"; exit 0 ;;
esac
exit 3
`
    );
    fs.chmodSync(gh, 0o755);
    return gh;
  }

  it('creates a PR through gh with argument arrays and returns its URL', async () => {
    const gh = fakeGh();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
    git(repo, 'commit', '-q', '-am', 'feat: first');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'x\n');
    git(repo, 'commit', '-q', '-am', 'fix: second');
    const app = appWith({ ghBin: gh });

    const status = await request(app)
      .get('/api/sessions/s1/git/ship-status')
      .query({ pr: '1', base: 'main' });
    expect(status.body.pr).toMatchObject({
      gh: { available: true, authenticated: true, defaultBranch: 'trunk' },
      base: 'main',
      title: 'feat: first',
      body: '- feat: first\n- fix: second',
    });

    const title = '--draft $(rm -rf ~) `x`';
    const res = await request(app)
      .post('/api/sessions/s1/git/pr')
      .send({ title, body: 'line 1\nline "2"', base: 'main', draft: true });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://github.com/acme/app/pull/42');
    expect(fs.readFileSync(logFile, 'utf8').split('\n')).toEqual([
      'pr',
      'create',
      `--title=${title}`,
      '--body=line 1',
      'line "2"',
      '--base=main',
      '--head=feature/ship',
      '--draft',
      '',
    ]);
    const prCall = calls.find((c) => c.bin === gh && c.args[0] === 'pr');
    expect(prCall?.opts.shell).toBeUndefined();
  });

  it('defaults the base to the repository default branch', async () => {
    const gh = fakeGh();
    const status = await request(appWith({ ghBin: gh }))
      .get('/api/sessions/s1/git/ship-status')
      .query({ pr: '1' });
    expect(status.body.pr.base).toBe('trunk');
  });

  it('explains when gh is missing or not signed in', async () => {
    const missing = await request(appWith({ ghBin: path.join(binDir, 'nope') }))
      .post('/api/sessions/s1/git/pr')
      .send({ title: 't', body: '', base: 'main' });
    expect(missing.status).toBe(412);
    expect(missing.body.code).toBe('gh-missing');

    const gh = fakeGh(false);
    const app = appWith({ ghBin: gh });
    const unauth = await request(app)
      .post('/api/sessions/s1/git/pr')
      .send({ title: 't', body: '', base: 'main' });
    expect(unauth.status).toBe(412);
    expect(unauth.body.code).toBe('gh-unauthenticated');
    const status = await request(app).get('/api/sessions/s1/git/ship-status').query({ pr: '1' });
    expect(status.body.pr.gh).toMatchObject({ available: true, authenticated: false });
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it('rejects an option-like or malformed base branch', async () => {
    const gh = fakeGh();
    for (const base of ['--help', 'a..b', 'main;rm', '']) {
      const res = await request(appWith({ ghBin: gh }))
        .post('/api/sessions/s1/git/pr')
        .send({ title: 't', base });
      expect(res.status).toBe(400);
    }
    expect(fs.existsSync(logFile)).toBe(false);
  });

  it('prefills a single commit PR from its subject and body', () => {
    expect(prefillPr([{ subject: 's', body: 'b' }], 'x')).toEqual({ title: 's', body: 'b' });
    expect(prefillPr([], 'agent/fix-the-thing').title).toBe('fix the thing');
  });
});

describe('routes', () => {
  it('require authentication', async () => {
    const app = appWith({ auth: true });
    const results = await Promise.all([
      request(app).get('/api/sessions/s1/git/ship-status'),
      request(app)
        .post('/api/sessions/s1/git/commit')
        .send({ files: ['a.txt'], message: 'x' }),
      request(app).post('/api/sessions/s1/git/push').send({ setUpstream: true }),
      request(app).post('/api/sessions/s1/git/pr').send({ title: 't', base: 'main' }),
    ]);
    for (const r of results) expect(r.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('404 for an unknown session', async () => {
    const res = await request(appWith()).get('/api/sessions/nope/git/ship-status');
    expect(res.status).toBe(404);
  });

  it('never use a shell: only execFile with argument arrays', () => {
    const src = fs.readFileSync(path.join(__dirname, 'git-ship.ts'), 'utf8');
    expect(src).not.toMatch(
      /\bexec\(|execSync|spawnSync|shell:\s*true|from 'child_process'.*\bexec\b/
    );
    expect(src).not.toMatch(/\bspawn\(/);
    for (const c of calls) expect(c.opts.shell).toBeUndefined();
  });
});
