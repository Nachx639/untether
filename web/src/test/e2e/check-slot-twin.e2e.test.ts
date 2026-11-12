/**
 * `ut check-slot` against a real server: the twin (scripts/gemelo.sh), never the real install.
 * 2026-11-10: task agents' heavy checks ran outside the Mac's check slots (load 250 on 12
 * cores). Two runs asked through the real CLI and the API socket take turns in the one slot
 * the twin's config allows; the rewrite the agents' hook makes does the same from a real shell;
 * a holder killed outright frees its slot.
 * 2026-11-11: a check whose command passed on the very same files is not run again, from the
 * real CLI and from the agents' rewrite, in a real git repository.
 */
import { type ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { promisify } from 'util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_SLOT_ENV, slotCommand } from '../../server/services/check-slot-wrap.js';

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '../../../..');
const GEMELO = path.join(ROOT, 'scripts/gemelo.sh');
const CLI = path.join(ROOT, 'web/bin/untether-dev');
const HOME = `/private/tmp/utt-gemelo-slot-${process.pid}`;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 60_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await ok()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

describe.skipIf(process.platform !== 'darwin')('ut check-slot against the twin', () => {
  let gemeloEnv: NodeJS.ProcessEnv;
  let cliEnv: NodeJS.ProcessEnv;
  const log = path.join(HOME, 'order.log');
  const children: ChildProcess[] = [];

  const order = () => {
    try {
      return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const status = async () =>
    JSON.parse((await run(CLI, ['check-slot', 'status', '--json'], { env: cliEnv })).stdout) as {
      running: number;
      limit: number;
      queued: number;
      tickets: Array<{ id: string; pid: number; state: string; label: string }>;
    };
  /** A CLI run in the background: its output and exit code once it ends. */
  const start = (args: string[], cwd?: string) => {
    const child = spawn(CLI, args, { env: cliEnv, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const ended = new Promise<{ code: number | null; stderr: string }>((resolve) =>
      child.on('exit', (code) => resolve({ code, stderr }))
    );
    return { child, ended };
  };

  beforeAll(async () => {
    const port = await freePort();
    gemeloEnv = {
      ...process.env,
      UTT_GEMELO_HOME: HOME,
      UTT_GEMELO_PORT: String(port),
      // The twin goes away with this test run, however it ends.
      UTT_GEMELO_PARENT: String(process.pid),
    };
    await run('bash', [GEMELO, 'start'], { env: gemeloEnv, timeout: 170_000 });
    // One slot, and no wait on the real Mac's load or memory (it may be busy: that gate has
    // its own tests in check-slots.test.ts). Read each time a slot is asked for.
    const config = path.join(HOME, '.untether/config.json');
    const current = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')) : {};
    fs.writeFileSync(
      config,
      JSON.stringify({
        ...current,
        checkLoad: { maxConcurrent: 1, maxLoadPerCore: 0, maxWaitSec: 0 },
      })
    );
    cliEnv = {
      ...process.env,
      HOME,
      UNTETHER_CONTROL_DIR: path.join(HOME, '.untether/control'),
      // Not the session this test may run in, nor a slot it may run inside.
      UNTETHER_TASK_ID: '',
      UNTETHER_SESSION_ID: '',
      [CHECK_SLOT_ENV]: '',
    };
    await until('the twin to read its config', async () => (await status()).limit === 1);
  }, 180_000);

  afterAll(async () => {
    for (const child of children) child.kill('SIGKILL');
    await run('bash', [GEMELO, 'stop'], { env: gemeloEnv, timeout: 60_000 }).catch(() => undefined);
  }, 90_000);

  it('two runs take turns in the one slot; the second says it waits; each ends with its command’s exit code', async () => {
    const a = start([
      'check-slot',
      'run',
      '--',
      `echo A-start >> ${log}; sleep 4; echo A-end >> ${log}; exit 4`,
    ]);
    await until('A to start', () => order().includes('A-start'));
    expect(await status()).toMatchObject({ running: 1, limit: 1 });
    const b = start(['check-slot', 'run', '--', `echo B-start >> ${log}; exit 5`]);
    const [first, second] = await Promise.all([a.ended, b.ended]);
    expect(first.code).toBe(4);
    expect(second.code).toBe(5);
    // B started only after A had ended.
    expect(order()).toEqual(['A-start', 'A-end', 'B-start']);
    expect(second.stderr).toMatch(
      /\[untether\] waiting for a check slot: 0 ahead \(1 of 1 running\)/
    );
    expect(second.stderr).toMatch(/\[untether\] check slot taken after/);
    expect(first.stderr).not.toContain('waiting for a check slot');
    await until('the slot to be free', async () => (await status()).running === 0);
  }, 120_000);

  it("the agents' rewrite, in a real shell: it waits behind a run, then runs as written and frees the slot", async () => {
    fs.rmSync(log, { force: true });
    const holder = start([
      'check-slot',
      'run',
      '--',
      `echo H-start >> ${log}; sleep 4; echo H-end >> ${log}`,
    ]);
    await until('the holder to start', () => order().includes('H-start'));
    const script = slotCommand(
      `echo "W-start $${CHECK_SLOT_ENV}" >> ${log}; (exit 6)`,
      'pnpm run test',
      [CLI]
    );
    const wrapped = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn('/bin/zsh', ['-c', script], {
        env: cliEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('exit', (code) => resolve({ code, stderr }));
    });
    await holder.ended;
    expect(wrapped.code).toBe(6);
    expect(wrapped.stderr).toContain('waiting for a check slot');
    const lines = order();
    expect(lines.slice(0, 2)).toEqual(['H-start', 'H-end']);
    // It ran with its ticket in the environment (a nested `ut check-slot run` would not wait).
    expect(lines[2]).toMatch(/^W-start [0-9a-f]{16}$/);
    await until('the slot to be free', async () => (await status()).running === 0);
  }, 120_000);

  it('a check that passed on the very same files is not run again; one byte of difference, a failure or --fresh and it runs', async () => {
    // A project of its own, with a check that leaves a line per run outside the repository.
    const project = path.join(HOME, 'reuse-project');
    const runs = path.join(HOME, 'reuse-runs.log');
    const ranTimes = () => {
      try {
        return fs.readFileSync(runs, 'utf8').trim().split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    fs.mkdirSync(path.join(project, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'scripts/check.sh'),
      `#!/bin/sh\necho run >> '${runs}'\ngrep -q broken src.txt && exit 1\nexit 0\n`,
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(project, 'src.txt'), 'one\n');
    const git = (...args: string[]) =>
      run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: project,
        env: { ...cliEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
    await git('init', '-q', '-b', 'main');
    await git('add', '.');
    await git('commit', '-q', '-m', 'init');
    const check = (...flags: string[]) =>
      start(['check-slot', 'run', ...flags, '--', 'scripts/check.sh'], project).ended;

    // The first run is made; the same files again are not.
    const first = await check();
    expect(first.code).toBe(0);
    expect(first.stderr).not.toContain('reused');
    expect(ranTimes()).toBe(1);
    const second = await check();
    expect(second.code).toBe(0);
    expect(second.stderr).toMatch(
      /\[untether\] check: reused, same tree as \d{4}-\d\d-\d\dT[\d:.]+Z \(.* ago; it passed in \d+ s on these very files, tree [0-9a-f]{12}\): not run again/
    );
    expect(ranTimes()).toBe(1);

    // The agents' rewrite, from a real shell: reused too, the command is not run, exit code 0.
    const wrapped = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(
        '/bin/zsh',
        ['-c', slotCommand('scripts/check.sh', 'scripts/check.sh', [CLI], true)],
        { env: cliEnv, cwd: project, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      children.push(child);
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('exit', (code) => resolve({ code, stderr }));
    });
    expect(wrapped.code).toBe(0);
    expect(wrapped.stderr).toContain('check: reused, same tree as');
    expect(ranTimes()).toBe(1);

    // --fresh runs it whatever was kept.
    expect((await check('--fresh')).code).toBe(0);
    expect(ranTimes()).toBe(2);

    // One byte of an uncommitted file: another tree, it runs; then that tree stands too.
    fs.writeFileSync(path.join(project, 'src.txt'), 'onf\n');
    expect((await check()).stderr).not.toContain('reused');
    expect(ranTimes()).toBe(3);
    expect((await check()).stderr).toContain('reused');
    expect(ranTimes()).toBe(3);
    // Committed as it is: the same tree, still not run.
    await git('commit', '-q', '-am', 'edit');
    expect((await check()).stderr).toContain('reused');
    expect(ranTimes()).toBe(3);

    // A failure is never reused: the same failing files run every time.
    fs.writeFileSync(path.join(project, 'src.txt'), 'broken\n');
    expect((await check()).code).toBe(1);
    expect((await check()).code).toBe(1);
    expect(ranTimes()).toBe(5);

    // Back to the files that passed: their pass stands, through the agents' rewrite as well.
    fs.writeFileSync(path.join(project, 'src.txt'), 'onf\n');
    const back = await check();
    expect(back.code).toBe(0);
    expect(back.stderr).toContain('reused');
    expect(ranTimes()).toBe(5);
    await until('the slot to be free', async () => (await status()).running === 0);
  }, 180_000);

  it('a holder killed outright frees its slot for the next run', async () => {
    fs.rmSync(log, { force: true });
    const stuck = start(['check-slot', 'run', '--', 'sleep', '300']);
    await until('the stuck run to hold the slot', async () => (await status()).running === 1);
    const { tickets } = await status();
    const next = start(['check-slot', 'run', '--', `echo N-start >> ${log}`]);
    await until('the next run to wait', async () => (await status()).queued === 1);
    // The holder's own child (the sleep this test started through it), by its parent pid:
    // only what this test made is ever killed.
    const holder = tickets[0].pid;
    const kids = (await run('pgrep', ['-P', String(holder)]).catch(() => ({ stdout: '' }))).stdout
      .split('\n')
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 1);
    // kill -9 of the holder the server watches: no release is ever sent.
    process.kill(holder, 'SIGKILL');
    for (const pid of kids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ended with its parent
      }
    }
    await stuck.ended;
    expect((await next.ended).code).toBe(0);
    expect(order()).toEqual(['N-start']);
  }, 120_000);
});
