import { type ChildProcess, spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findTestDirs, markerEnded, type TestMarker } from '../../server/services/stray-tmux';
import { RM_TEST_DIR } from '../helpers/rm-test-dir';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../scripts/gemelo.sh'
);

/**
 * scripts/gemelo.sh against a fake tmux and a fake server (2026-11-08: its first version ran
 * `tmux kill-server` with TMUX inherited from its Untether session and took the real shield
 * tmux server down). Everything runs from a copy of the script next to the fakes, so no real
 * tmux or Untether server is ever reached, and TMUX points at a socket that would be the real
 * one: a regression only shows in the fake tmux's log.
 */
describe.skipIf(process.platform !== 'darwin')('scripts/gemelo.sh', () => {
  let root: string;
  let logDir: string;
  let home: string;
  let port: number;
  let foreign: string | undefined;
  let linked: string | undefined;
  const sockets: net.Server[] = [];
  const children: ChildProcess[] = [];

  /** Installs the fake server: 'ok', 'never-healthy' or 'seed-fails'. */
  function writeFakeServer(mode: 'ok' | 'never-healthy' | 'seed-fails') {
    const file = path.join(root, 'web/node_modules/.bin/tsx');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `#!/usr/bin/env node
const http = require('http'), net = require('net'), fs = require('fs'), path = require('path');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const env = process.env;
const defaultSocket = path.join(env.TMUX_TMPDIR, 'tmux-' + process.getuid(), 'default');
fs.mkdirSync(path.dirname(defaultSocket), { recursive: true });
fs.mkdirSync(env.UNTETHER_CONTROL_DIR, { recursive: true });
net.createServer().listen(defaultSocket);
net.createServer().listen(path.join(env.UNTETHER_CONTROL_DIR, '.shield-tmux'), () => {
  // Written whole, then renamed: the test waits for the file to exist and reads it at once
  // (2026-11-10: under load it read it between its creation and its content, "Unexpected end
  // of JSON input").
  const startedFile = ${JSON.stringify(path.join(logDir, 'started.json'))};
  fs.writeFileSync(startedFile + '.tmp',
    JSON.stringify({ pid: process.pid, tmux: env.TMUX ?? null, home: env.HOME, path: env.PATH,
      clock: env.UTT_GEMELO_CLOCK ?? null, nodeOptions: env.NODE_OPTIONS ?? null, args: process.argv.slice(2) }));
  fs.renameSync(startedFile + '.tmp', startedFile);
});
http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.statusCode = ${mode === 'never-healthy' ? 503 : 200};
    return res.end('{}');
  }
  if (req.method === 'POST') {
    res.statusCode = ${mode === 'seed-fails' ? 500 : 200};
    return res.end('{}');
  }
  res.end('[]');
}).listen(port, '127.0.0.1');
`,
      { mode: 0o755 }
    );
  }

  function env(extra: Record<string, string> = {}) {
    return {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      TMUX: '/private/tmp/tmux-501/default,1,0',
      TMUX_TMPDIR: '/private/tmp',
      UTT_GEMELO_HOME: home,
      UTT_GEMELO_PORT: String(port),
      // A test run killed halfway (a stopped check) never reaches afterEach: its twins go with it.
      UTT_GEMELO_PARENT: String(process.pid),
      ...extra,
    };
  }

  const script = () => path.join(root, 'scripts/gemelo.sh');

  function run(...args: string[]) {
    return spawnSync('bash', [script(), ...args], {
      env: env(),
      encoding: 'utf8',
      timeout: 60_000,
    });
  }

  /** What the fake tmux was called with, one line per call: `<args> | <TMUX>|<TMUX_TMPDIR>`. */
  function tmuxCalls(): string[] {
    const file = path.join(logDir, 'tmux.log');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
  }

  function expectOnlyTwinTmux() {
    for (const call of tmuxCalls()) {
      expect(call).toMatch(new RegExp(`^-S ${home}/\\S+ kill-server \\| \\|$`));
    }
  }

  function started(): {
    pid: number;
    tmux: string | null;
    home: string;
    path: string;
    clock: string | null;
    nodeOptions: string | null;
    args: string[];
  } {
    return JSON.parse(fs.readFileSync(path.join(logDir, 'started.json'), 'utf8'));
  }

  async function until(what: string, condition: () => boolean, ms = 30_000) {
    const deadline = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const freePort = () =>
    new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port: found } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(found));
      });
    });

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemelo-test-'));
    logDir = path.join(root, 'log');
    fs.mkdirSync(logDir);
    fs.mkdirSync(path.join(root, 'bin'));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(SCRIPT, script());
    // Says what a real one says when no server listens: stop must go on regardless.
    fs.writeFileSync(
      path.join(root, 'bin/tmux'),
      `#!/bin/bash
echo "$* | \${TMUX-}|\${TMUX_TMPDIR-}" >> ${JSON.stringify(path.join(logDir, 'tmux.log'))}
# Whether the process the HOME's mark names is alive now, in the middle of a stop.
marked=$(sed 's/.*"pid":\\([0-9]*\\).*/\\1/' "$UTT_GEMELO_HOME/.untether-test-run" 2>/dev/null)
if kill -0 "$marked" 2>/dev/null; then echo alive; else echo "ended $marked"; fi >> ${JSON.stringify(path.join(logDir, 'marked.log'))}
exit 1
`,
      { mode: 0o755 }
    );
    home = `${fs.realpathSync('/tmp')}/utt-gemelo-t${randomBytes(4).toString('hex')}`;
    port = await freePort();
    foreign = undefined;
    linked = undefined;
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    if (fs.existsSync(path.join(root, 'web'))) run('stop');
    for (const server of sockets.splice(0)) server.close();
    if (linked) fs.rmSync(linked, RM_TEST_DIR);
    fs.rmSync(home, RM_TEST_DIR);
    if (foreign) fs.rmSync(foreign, RM_TEST_DIR);
    fs.rmSync(root, RM_TEST_DIR);
  });

  it('start and stop reach only the sockets inside its HOME, whatever TMUX says', () => {
    writeFakeServer('ok');
    const up = run('start');
    expect(up.status, up.stderr).toBe(0);
    expect(started().tmux).toBeNull();
    expect(started().home).toBe(home);

    const { pid } = started();
    const down = run('stop');
    expect(down.status, down.stderr).toBe(0);
    expect(tmuxCalls()).toHaveLength(2);
    expectOnlyTwinTmux();
    expect(alive(pid)).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
  }, 60_000);

  it('the mark names a live process for as long as a stop takes', () => {
    // 2026-11-10: the server's pid stayed in the mark while stop went on without it, so the
    // doctor found the dir "marked by a pid that has ended" (1-2.5 s on every ordinary stop).
    writeFakeServer('ok');
    expect(run('start').status).toBe(0);
    expect(run('stop').status).toBe(0);
    const marked = fs.readFileSync(path.join(logDir, 'marked.log'), 'utf8').trim().split('\n');
    expect(marked).toEqual(['alive', 'alive']);
  }, 60_000);

  /** A process and everything under it, as a tool that kills a process tree finds them. */
  function processTree(root: number): number[] {
    const rows = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
      .stdout.trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number));
    const found = [root];
    for (const parent of found) {
      for (const [pid, ppid] of rows) if (ppid === parent) found.push(pid);
    }
    return found;
  }

  it('kill -9 of the whole tree of a run still removes the twin', async () => {
    // 2026-11-10: the watchdog was a child of the script, so killing the tree (a tool's timeout,
    // a stopped check) took it too and /tmp/utt-gemelo-shots-<pid> stayed for the doctor.
    writeFakeServer('ok');
    const child = spawn('bash', [script(), 'run', '--', 'sleep', '60'], {
      env: env(),
      stdio: 'ignore',
    });
    children.push(child);
    await until('the twin to start', () => {
      return (
        fs.existsSync(path.join(logDir, 'started.json')) &&
        fs.existsSync(path.join(home, '.gemelo/pid'))
      );
    });
    const { pid } = started();
    const tree = processTree(child.pid as number);
    expect(tree).toContain(pid);

    for (const each of tree) {
      try {
        process.kill(each, 'SIGKILL');
      } catch {
        // Ended between the listing and the signal.
      }
    }

    await until('the twin to go', () => !fs.existsSync(home) && !alive(pid), 30_000);
    // Its own stop did it (the two sockets closed), not somebody's sweep of dead test dirs.
    expect(tmuxCalls()).toHaveLength(2);
    expectOnlyTwinTmux();
  }, 60_000);

  it('a twin started for a process goes when that process ends', async () => {
    writeFakeServer('ok');
    const parent = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(parent);
    const up = spawnSync('bash', [script(), 'start'], {
      env: env({ UTT_GEMELO_PARENT: String(parent.pid) }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(up.status, up.stderr).toBe(0);
    const { pid } = started();
    expect(alive(pid)).toBe(true);

    parent.kill('SIGKILL');

    await until('the twin to go', () => !fs.existsSync(home) && !alive(pid), 30_000);
    // Its own stop did it (the two sockets closed), not somebody's sweep of dead test dirs.
    expect(tmuxCalls()).toHaveLength(2);
    expectOnlyTwinTmux();
  }, 60_000);

  it('a watchdog leaves alone the twin another start put in the same HOME', async () => {
    writeFakeServer('ok');
    const parent = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(parent);
    const first = spawnSync('bash', [script(), 'start'], {
      env: env({ UTT_GEMELO_PARENT: String(parent.pid) }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(first.status, first.stderr).toBe(0);
    expect(run('stop').status).toBe(0);
    fs.rmSync(path.join(logDir, 'started.json'));
    expect(run('start').status).toBe(0);
    const { pid } = started();

    parent.kill('SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(alive(pid)).toBe(true);
    expect(fs.existsSync(home)).toBe(true);
  }, 60_000);

  it.each([
    ['no -S', 'twin_tmux kill-server'],
    ['the real shield socket', 'twin_tmux -S "$REAL/.untether/control/.shield-tmux" kill-server'],
    ['a path that climbs out', 'twin_tmux -S "$G_HOME/../other" kill-server'],
  ])('twin_tmux refuses %s without calling tmux', (_name, call) => {
    const result = spawnSync(
      'bash',
      ['-c', `REAL=$HOME; source "$1"; guard; ${call}`, 'bash', script()],
      { env: env(), encoding: 'utf8', timeout: 30_000 }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refused: tmux');
    expect(tmuxCalls()).toEqual([]);
  });

  it('runs tmux only through twin_tmux', () => {
    const code = fs
      .readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'));
    const direct = code.filter((line) =>
      /(?<![\w_-])tmux\s+(-|kill|new|ls|list|attach|has)/.test(line)
    );
    expect(direct).toEqual([]);
  });

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const)(
    '%s in the middle of start leaves nothing',
    async (signal, code) => {
      writeFakeServer('never-healthy');
      const child = spawn('bash', [script(), 'start'], { env: env(), stdio: 'ignore' });
      children.push(child);
      const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
      await until('the server to start', () => {
        return (
          fs.existsSync(path.join(logDir, 'started.json')) &&
          fs.existsSync(path.join(home, '.gemelo/pid'))
        );
      });
      const { pid } = started();

      child.kill(signal);

      expect(await closed).toBe(code);
      await until('the server to end', () => !alive(pid));
      expect(fs.existsSync(home)).toBe(false);
      expect(tmuxCalls()).toHaveLength(2);
      expectOnlyTwinTmux();
    },
    60_000
  );

  it('a failed seed tears the twin down and reports it', () => {
    writeFakeServer('seed-fails');
    const up = run('start');
    expect(up.status).not.toBe(0);
    expect(alive(started().pid)).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
    expectOnlyTwinTmux();
  }, 60_000);

  it('does not remove a directory that is not a twin HOME', () => {
    foreign = home;
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, 'dato'), 'x');
    const result = run('stop');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a twin');
    expect(fs.existsSync(path.join(foreign, 'dato'))).toBe(true);
  });

  /** A socket in a dir of its own, standing for the real control dir. */
  async function realControlDir() {
    linked = `${home}-real`;
    fs.mkdirSync(linked);
    const server = net.createServer();
    sockets.push(server);
    await new Promise<void>((resolve) =>
      server.listen(path.join(linked as string, '.shield-tmux'), resolve)
    );
    return linked;
  }

  it.each([
    ['without the ownership mark', false],
    ['with the ownership mark', true],
  ])('a control dir linked elsewhere gets no tmux call, %s', async (_name, marked) => {
    const target = await realControlDir();
    fs.mkdirSync(path.join(home, '.untether'), { recursive: true });
    fs.symlinkSync(target, path.join(home, '.untether/control'));
    if (marked) {
      fs.mkdirSync(path.join(home, '.gemelo'));
      fs.writeFileSync(path.join(home, '.gemelo/owner'), `untether-gemelo ${home}`);
    }
    const result = run('stop');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(marked ? 'refused: tmux' : 'nothing done');
    expect(tmuxCalls()).toEqual([]);
    expect(fs.existsSync(path.join(target, '.shield-tmux'))).toBe(true);
  });

  it('signals no pid named by a directory that is not a twin HOME', () => {
    const other = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(other);
    foreign = home;
    fs.mkdirSync(path.join(foreign, '.gemelo'), { recursive: true });
    fs.writeFileSync(path.join(foreign, '.gemelo/pid'), String(other.pid));
    expect(run('stop').status).toBe(1);
    expect(alive(other.pid as number)).toBe(true);
  });

  it('refuses a HOME that is a symlink, and leaves its target alone', () => {
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'dato'), 'x');
    fs.symlinkSync(target, home);
    const result = run('stop');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('symlink');
    expect(fs.existsSync(path.join(target, 'dato'))).toBe(true);
    fs.unlinkSync(home);
  });

  it('never signals a reused pid', () => {
    const other = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(other);
    fs.mkdirSync(path.join(home, '.gemelo'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemelo/owner'), `untether-gemelo ${home}`);
    fs.writeFileSync(path.join(home, '.gemelo/pid'), String(other.pid));
    const result = run('stop');
    expect(result.status, result.stderr).toBe(0);
    expect(alive(other.pid as number)).toBe(true);
    expect(fs.existsSync(home)).toBe(false);
  });

  it('leaves alone a process that only names the twin in its arguments', () => {
    const other = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 300000)', ` HOME=${home} `, `${home}/.gemelo/server.log`],
      { stdio: 'ignore' }
    );
    children.push(other);
    writeFakeServer('ok');
    const up = run('start');
    expect(up.status, up.stderr).toBe(0);
    const { pid } = started();
    const down = run('stop');
    expect(down.status, down.stderr).toBe(0);
    expect(alive(pid)).toBe(false);
    expect(alive(other.pid as number)).toBe(true);
  }, 60_000);

  describe('--rich', () => {
    const REAL_ROOT = path.resolve(path.dirname(SCRIPT), '..');

    /** Everything the rich seed reads, next to the copy of the script. */
    function installRichSeed() {
      for (const file of ['gemelo-rich-seed.mjs', 'gemelo-clock.cjs', 'gemelo-keeper.cjs']) {
        fs.copyFileSync(path.join(REAL_ROOT, 'scripts', file), path.join(root, 'scripts', file));
      }
      // The seed's data, one file per fictitious project.
      fs.cpSync(
        path.join(REAL_ROOT, 'scripts/gemelo-seed'),
        path.join(root, 'scripts/gemelo-seed'),
        {
          recursive: true,
        }
      );
      for (const file of ['web/package.json', 'web/src/server/services/task-scheduler-rules.ts']) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.copyFileSync(path.join(REAL_ROOT, file), path.join(root, file));
      }
      writeFakeServer('ok');
    }

    function filesIn(dir: string): string[] {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === '.git' ? [] : filesIn(full);
        return entry.isFile() ? [full] : [];
      });
    }

    const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

    it('writes tasks in every state, sessions and logos, all fictitious, and stop removes them', async () => {
      installRichSeed();
      const up = run('start', '--rich');
      expect(up.status, up.stderr).toBe(0);

      const control = path.join(home, '.untether/control');
      const rich = readJson(path.join(home, '.gemelo/rich.json'));
      const stored = readJson(path.join(control, 'tasks.json'));
      const version = /STORE_VERSION = (\d+)/.exec(
        fs.readFileSync(path.join(root, 'web/src/server/services/task-scheduler-rules.ts'), 'utf8')
      )?.[1];
      expect(stored.version).toBe(Number(version));
      expect(new Set(stored.tasks.map((task: { state: string }) => task.state))).toEqual(
        new Set(['queued', 'working', 'needs_you', 'ready', 'merged', 'failed'])
      );
      // None the scheduler takes up on start and runs for real.
      for (const task of stored.tasks) {
        expect(['verifying', 'merging', 'preparing']).not.toContain(task.state);
        expect(task.mergePolicy).toBe('ask');
      }

      const projects = readJson(path.join(home, '.untether/projects.json')).projects;
      expect(Object.keys(projects)).toHaveLength(4);
      for (const [repo, settings] of Object.entries<{ icon: string; maxActiveTasks: number }>(
        projects
      )) {
        expect(repo.startsWith(`${home}/`)).toBe(true);
        expect(settings.maxActiveTasks).toBe(1);
        const logo = fs.readFileSync(path.join(repo, settings.icon));
        expect(logo.subarray(1, 4).toString()).toBe('PNG');
      }
      expect(fs.statSync(path.join(control, 'icons/nimbo.png')).size).toBeGreaterThan(0);
      const provider = readJson(path.join(home, '.untether/config.json')).modelProviders[0];
      expect(provider.icon).toBe('nimbo.png');

      // Nothing of the person running it: no real home, user or path in anything written.
      const leaks = [os.homedir(), os.userInfo().username, REAL_ROOT];
      for (const file of filesIn(home).filter((name) => /\.(json|jsonl)$|stdout$/.test(name))) {
        const text = fs.readFileSync(file, 'utf8');
        for (const leak of leaks) expect(text.includes(leak), `${leak} in ${file}`).toBe(false);
      }

      // Running states have the files their agents would leave, and a process behind them.
      const pids = fs
        .readdirSync(path.join(home, '.claude/sessions'))
        .map((name) => Number.parseInt(name, 10));
      expect(pids.length).toBeGreaterThan(0);
      expect(pids.every(alive)).toBe(true);
      const statuses = pids.map(
        (pid) => readJson(path.join(home, '.claude/sessions', `${pid}.json`)).status
      );
      expect(new Set(statuses)).toEqual(new Set(['busy', 'idle', 'waiting']));
      const sessions = fs
        .readdirSync(control)
        .filter((name) => /^[0-9a-f]{8}-/.test(name))
        .map((name) => readJson(path.join(control, name, 'session.json')));
      expect(sessions).toHaveLength(rich.sessions);
      expect(sessions.some((session) => session.suspended)).toBe(true);
      expect(sessions.some((session) => session.status === 'exited')).toBe(true);

      // The server: no agent of the Mac first on its PATH, the fixed clock, no login.
      const server = started();
      expect(server.path.split(':')[0]).toBe(path.join(home, 'fake-bin'));
      expect(Number(server.clock)).toBe(rich.now);
      expect(server.nodeOptions).toContain('gemelo-clock.cjs');
      expect(server.args).toContain('--no-auth');
      for (const agent of ['claude', 'codex', 'gemini']) {
        const stub = spawnSync(path.join(home, 'fake-bin', agent), ['-p', 'hola'], {
          encoding: 'utf8',
          timeout: 5_000,
        });
        expect(stub.status).toBe(0);
        expect(stub.stdout).toBe('');
      }

      // Every fake process (a Claude session's or not) and its keeper end with stop.
      const fake = fs
        .readFileSync(path.join(home, '.gemelo/fake-pids'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(Number);
      expect(fake.length).toBeGreaterThan(pids.length);
      expect(fake.every(alive)).toBe(true);

      const down = run('stop');
      expect(down.status, down.stderr).toBe(0);
      await until('the fake processes to end', () => !fake.some(alive));
      expect(alive(server.pid)).toBe(false);
      expect(fs.existsSync(home)).toBe(false);
    }, 60_000);

    // 2026-11-10: tracked without the executable bit, so `scripts/gemelo.sh run -- …`, as
    // CLAUDE.md and its own usage text give it, ended in "permission denied" in every checkout.
    it('is tracked as an executable, the way it is documented to be run', () => {
      const repo = path.resolve(path.dirname(SCRIPT), '..');
      const entry = spawnSync('git', ['ls-files', '-s', 'scripts/gemelo.sh'], {
        cwd: repo,
        encoding: 'utf8',
      });
      expect(entry.stdout).toMatch(/^100755 /);
    });

    // 2026-11-10 (scripts/docs audit): the token was in curl's arguments, readable with ps.
    it('never puts the token in the arguments of curl', () => {
      const result = spawnSync(
        'bash',
        [
          '-c',
          `source "$1"; guard; mkdir -m 700 "$G_HOME"; mkdir -p -m 700 "$G_META"
printf 'the-twin-token' >"$G_META/token"
curl() { printf 'ARGS %s\\n' "$*"; printf 'STDIN %s\\n' "$(cat)"; }
api POST /api/sessions '{"a":1}'; rc=$?
rm -rf -- "$G_HOME"; exit $rc`,
          'bash',
          script(),
        ],
        { env: env(), encoding: 'utf8', timeout: 30_000 }
      );
      expect(result.status, result.stderr).toBe(0);
      const args = result.stdout.split('\n').find((line) => line.startsWith('ARGS '));
      expect(args).toContain('-H @-');
      expect(args).toContain('/api/sessions');
      expect(args).not.toContain('the-twin-token');
      expect(result.stdout).toContain('STDIN X-Untether-Local: the-twin-token');
    });

    it('carries the mark the doctor sweeps from the very start', () => {
      installRichSeed();
      // The twin's HOME as start leaves it just before the seed runs.
      const result = spawnSync(
        'bash',
        [
          '-c',
          'source "$1"; guard; mkdir -m 700 "$G_HOME"; mkdir -p -m 700 "$G_META"; mark_run "$$"; cat "$G_HOME/.untether-test-run"; rm -rf -- "$G_HOME"',
          'bash',
          script(),
        ],
        { env: env(), encoding: 'utf8', timeout: 30_000 }
      );
      expect(result.status, result.stderr).toBe(0);
      const marker = JSON.parse(result.stdout);
      expect(marker.runDir).toBe(home);
      expect(Number.isInteger(marker.pid)).toBe(true);
      expect(typeof marker.at).toBe('number');
    });

    it.each([
      ['closed pipe', 'SIGPIPE', 141],
      ['closed terminal', 'SIGHUP', 129],
    ] as const)(
      'a %s (%s) during run still removes the twin',
      async (_name, signal, code) => {
        installRichSeed();
        const child = spawn('bash', [script(), 'run', '--rich', '--', 'sleep', '30'], {
          env: env(),
          stdio: 'ignore',
        });
        children.push(child);
        const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
        await until('the twin to start', () => {
          return (
            fs.existsSync(path.join(logDir, 'started.json')) &&
            fs.existsSync(path.join(home, '.gemelo/fake-pids'))
          );
        });
        const { pid } = started();
        child.kill(signal);
        // bash takes a trapped signal when the foreground command ends.
        spawnSync('pkill', ['-P', String(child.pid), 'sleep']);
        expect(await closed).toBe(code);
        expect(alive(pid)).toBe(false);
        expect(fs.existsSync(home)).toBe(false);
      },
      60_000
    );

    it('kill -9 of the script: the watchdog removes the twin and its fake processes', async () => {
      installRichSeed();
      const child = spawn('bash', [script(), 'run', '--rich', '--', 'sleep', '60'], {
        env: env(),
        stdio: 'ignore',
      });
      children.push(child);
      await until('the twin to start', () => {
        return (
          fs.existsSync(path.join(logDir, 'started.json')) &&
          fs.existsSync(path.join(home, '.gemelo/fake-pids'))
        );
      });
      await until('the seed to finish', () => fs.existsSync(path.join(home, 'fake-bin/gemini')));
      const fake = fs
        .readFileSync(path.join(home, '.gemelo/fake-pids'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(Number);
      const { pid } = started();

      child.kill('SIGKILL');

      await until('the twin to go', () => !fs.existsSync(home) && !alive(pid), 30_000);
      await until('the fake processes to end', () => !fake.some(alive), 15_000);
    }, 60_000);

    it('the keeper ends the fake processes when the marked run has ended', async () => {
      installRichSeed();
      const up = run('start', '--rich');
      expect(up.status, up.stderr).toBe(0);
      const fake = fs
        .readFileSync(path.join(home, '.gemelo/fake-pids'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(Number);
      expect(fake.every(alive)).toBe(true);

      // What the doctor sweeps: the server gone with nobody left to run stop.
      process.kill(started().pid, 'SIGKILL');

      await until('the keeper to end them', () => !fake.some(alive), 15_000);
      // The rest (the HOME, with the mark of a pid that ended) is for the doctor's stale-test-dirs.
      const found = findTestDirs([path.dirname(home)]).find((info) => info.dir === home);
      expect(found?.marker?.runDir).toBe(home);
      expect(markerEnded(found?.marker as TestMarker)).toBe(true);
    }, 60_000);

    it('starts from a checkout whose path holds spaces', () => {
      const outer = root;
      root = path.join(outer, 'con espacio');
      try {
        fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
        fs.cpSync(path.join(outer, 'bin'), path.join(root, 'bin'), { recursive: true });
        fs.copyFileSync(SCRIPT, script());
        installRichSeed();
        const up = run('start', '--rich');
        expect(up.status, up.stderr).toBe(0);
        expect(started().nodeOptions).toBe(
          `--require="${path.join(root, 'scripts/gemelo-clock.cjs')}"`
        );
        expect(run('stop').status).toBe(0);
      } finally {
        root = outer;
      }
    }, 60_000);

    it('takes other ports for its previews when the usual ones are busy', async () => {
      installRichSeed();
      const busy = [port + 10, port + 11];
      for (const taken of busy) {
        const server = net.createServer();
        sockets.push(server);
        await new Promise<void>((resolve) => server.listen(taken, '127.0.0.1', resolve));
      }
      const up = run('start', '--rich');
      expect(up.status, up.stderr).toBe(0);

      const { previews } = readJson(path.join(home, '.untether/previews.json'));
      const ports: number[] = previews.map((preview: { port: number }) => preview.port);
      expect(new Set(ports).size).toBe(2);
      for (const taken of busy) expect(ports).not.toContain(taken);
      // The keeper owns the active one, and is alive to end the fake processes.
      const response = await fetch(`http://127.0.0.1:${ports[0]}/`);
      expect(await response.text()).toContain('Vista previa ficticia');
    }, 60_000);

    it('the keeper survives losing its preview port', async () => {
      const server = net.createServer();
      sockets.push(server);
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
      fs.mkdirSync(path.join(home, '.gemelo'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.untether-test-run'),
        JSON.stringify({ pid: process.pid, at: Date.now(), runDir: home })
      );
      const keeper = spawn(
        process.execPath,
        [path.join(REAL_ROOT, 'scripts/gemelo-keeper.cjs'), home, String(port)],
        { stdio: 'ignore' }
      );
      children.push(keeper);
      const exited = new Promise<'exited'>((resolve) => keeper.on('exit', () => resolve('exited')));
      const outcome = await Promise.race([
        exited,
        new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 1_500)),
      ]);
      expect(outcome).toBe('alive');
      fs.rmSync(path.join(home, '.untether-test-run'));
      await until('the keeper to end with its mark', () => !alive(keeper.pid as number));
    }, 30_000);

    it('run --rich passes the rich twin to the command and removes it', () => {
      installRichSeed();
      const result = spawnSync(
        'bash',
        [
          script(),
          'run',
          '--rich',
          '--',
          'sh',
          '-c',
          'test -f "$GEMELO_HOME/.gemelo/rich.json" && echo "$GEMELO_HOME"',
        ],
        { env: env(), encoding: 'utf8', timeout: 60_000 }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(home);
      expect(fs.existsSync(home)).toBe(false);
    }, 60_000);

    // 2026-11-11: the README's captures showed Spanish data under an English interface.
    it('UTT_GEMELO_LOCALE=en writes the same state in English, with nothing left in Spanish', () => {
      installRichSeed();
      const spanish = run('start', '--rich');
      expect(spanish.status, spanish.stderr).toBe(0);
      const states = (file: string) =>
        readJson(file).tasks.map(
          (task: { id: string; state: string }) => `${task.id} ${task.state}`
        );
      const tasksFile = path.join(home, '.untether/control/tasks.json');
      const before = states(tasksFile);
      expect(run('stop').status).toBe(0);

      const up = spawnSync('bash', [script(), 'start', '--rich'], {
        env: env({ UTT_GEMELO_LOCALE: 'en' }),
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(up.status, up.stderr).toBe(0);
      expect(states(tasksFile)).toEqual(before);
      expect(readJson(path.join(home, '.gemelo/rich.json')).sessionTitles).toEqual([
        'Add card payments to the checkout',
        'Coordinate the summer bookings',
      ]);
      expect(fs.existsSync(path.join(home, 'projects/harbor-bookings/.git'))).toBe(true);
      const written = filesIn(home).filter((name) => /\.(json|jsonl|md)$|stdout$/.test(name));
      expect(written.length).toBeGreaterThan(30);
      for (const file of written) {
        const text = fs.readFileSync(file, 'utf8');
        expect(text.match(/[^\n"]*[áéíóúñ¿¡][^\n"]*/i)?.[0], file).toBeUndefined();
        expect(file).not.toMatch(/proyectos|faro-reservas|huerto/);
      }
    }, 120_000);

    it('a text with no translation fails the seed, names it and leaves no twin', () => {
      installRichSeed();
      fs.writeFileSync(
        path.join(root, 'scripts/gemelo-seed/zz-nuevo.mjs'),
        "export default { sessions: ({ home }) => [{ key: 'nueva', n: 99, name: 'nueva', command: ['/bin/bash'], workingDir: home, screen: ['Una frase recién escrita'] }] };\n"
      );
      const up = spawnSync('bash', [script(), 'start', '--rich'], {
        env: env({ UTT_GEMELO_LOCALE: 'en' }),
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(up.status).not.toBe(0);
      expect(up.stderr).toContain('no «en» translation');
      expect(up.stderr).toContain('"Una frase recién escrita"');
      expect(fs.existsSync(home)).toBe(false);

      const unknown = spawnSync('bash', [script(), 'start', '--rich'], {
        env: env({ UTT_GEMELO_LOCALE: 'xx' }),
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(unknown.status).not.toBe(0);
      expect(unknown.stderr).toContain('no seed in «xx»');
      expect(fs.existsSync(home)).toBe(false);
    }, 120_000);

    it('the seed refuses a folder that is not a twin HOME', () => {
      const result = spawnSync(
        process.execPath,
        [path.join(REAL_ROOT, 'scripts/gemelo-rich-seed.mjs'), os.homedir(), `${os.homedir()}/x`],
        { encoding: 'utf8', timeout: 30_000 }
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('refused');
    });

    it('the clock starts at its date and goes on, leaving explicit dates alone', () => {
      const code = `require(${JSON.stringify(path.join(REAL_ROOT, 'scripts/gemelo-clock.cjs'))});
        const a = Date.now(); const b = new Date().getTime();
        console.log(JSON.stringify({ a, b, fixed: new Date(0).getTime(), isDate: new Date() instanceof Date }));`;
      const start = Date.UTC(2026, 10, 9, 10, 30, 0);
      const result = spawnSync(process.execPath, ['-e', code], {
        env: { ...process.env, UTT_GEMELO_CLOCK: String(start) },
        encoding: 'utf8',
        timeout: 30_000,
      });
      const out = JSON.parse(result.stdout);
      expect(out.a).toBeGreaterThanOrEqual(start);
      expect(out.a).toBeLessThan(start + 5_000);
      expect(out.b).toBeGreaterThanOrEqual(out.a);
      expect(out.fixed).toBe(0);
      expect(out.isDate).toBe(true);
    });
  });

  // 2026-11-11: trying a change on a phone meant a development server on the network with the
  // real HOME. The twin can listen there instead, with its login; never the one without login.
  describe('UTT_GEMELO_BIND', () => {
    const runWith = (extra: Record<string, string>, ...args: string[]) =>
      spawnSync('bash', [script(), ...args], {
        env: env(extra),
        encoding: 'utf8',
        timeout: 60_000,
      });

    it('listens on 127.0.0.1 unless asked', () => {
      writeFakeServer('ok');
      const up = run('start');
      expect(up.status, up.stderr).toBe(0);
      const { args } = started();
      expect(args[args.indexOf('--bind') + 1]).toBe('127.0.0.1');
    }, 60_000);

    it('0.0.0.0: the server binds the network and keeps its login', () => {
      writeFakeServer('ok');
      const up = runWith({ UTT_GEMELO_BIND: '0.0.0.0' }, 'start');
      expect(up.status, up.stderr).toBe(0);
      const { args } = started();
      expect(args[args.indexOf('--bind') + 1]).toBe('0.0.0.0');
      expect(args).not.toContain('--no-auth');
      expect(up.stdout).toContain("this Mac's user and password");
    }, 60_000);

    it('refuses the network for a --rich twin, which has no login', () => {
      writeFakeServer('ok');
      for (const command of ['start', 'reset', 'run']) {
        const result = runWith({ UTT_GEMELO_BIND: '0.0.0.0' }, command, '--rich', '--', 'true');
        expect(result.status, command).toBe(1);
        expect(result.stderr).toContain('no login');
      }
      expect(fs.existsSync(path.join(logDir, 'started.json'))).toBe(false);
      expect(fs.existsSync(home)).toBe(false);
    }, 60_000);

    it('refuses any other address', () => {
      const result = runWith({ UTT_GEMELO_BIND: '192.168.1.5; rm -rf /' }, 'status');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('UTT_GEMELO_BIND');
    });
  });

  it('refuses the real server ports', () => {
    const result = spawnSync('bash', [script(), 'status'], {
      env: env({ UTT_GEMELO_PORT: '4020' }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('real server');
  });
});
