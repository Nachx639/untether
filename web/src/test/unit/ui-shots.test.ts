import { type ChildProcess, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir';

const TOOL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/ui-shots.mjs'
);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function runTool(args: string[]) {
  const child = spawn(process.execPath, [TOOL, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  return new Promise<{ code: number | null; output: string; pid: number }>((resolve) => {
    child.on('close', (code) => resolve({ code, output, pid: child.pid as number }));
  });
}

/** The real tool: the rich twin, its real server, WebKit and Chromium (macOS, like gemelo.sh). */
describe.skipIf(process.platform !== 'darwin')('web/scripts/ui-shots.mjs', () => {
  let out: string;
  const children: ChildProcess[] = [];

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-shots-test-'));
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGTERM');
    fs.rmSync(out, RM_TEST_DIR);
  });

  it('saves a real PNG per browser and view, and removes the twin', async () => {
    const result = await runTool(['--style', 'dark', '--out', out]);
    expect(result.code, result.output).toBe(0);

    const expected = ['webkit', 'chromium'].flatMap((browser) =>
      [
        'mobile',
        'desktop',
        'task',
        'session',
        'chat',
        'settings',
        'settings-desktop',
        'create',
        'create-desktop',
      ].map((view) => `${browser}-${view}-dark.png`)
    );
    expect(fs.readdirSync(out).sort()).toEqual([...expected].sort());
    for (const name of expected) {
      const png = fs.readFileSync(path.join(out, name));
      expect(png.subarray(0, 8).equals(PNG_SIGNATURE), name).toBe(true);
      // A blank page compresses to a few KB; the seeded interface does not.
      expect(png.length, name).toBeGreaterThan(30_000);
    }
    expect(fs.existsSync(`/tmp/utt-gemelo-shots-${result.pid}`)).toBe(false);
  }, 240_000);

  /** A run started for real, up to the moment its twin is up. */
  async function startedRun() {
    const child = spawn(process.execPath, [TOOL, '--out', out], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const home = `/tmp/utt-gemelo-shots-${child.pid}`;
    const physical = `/private${home}`;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the twin did not start')), 90_000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('gemelo: up')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const fake = fs
      .readFileSync(path.join(physical, '.gemelo/fake-pids'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(Number);
    const server = Number(fs.readFileSync(path.join(physical, '.gemelo/pid'), 'utf8'));
    return { child, physical, fake, server };
  }

  /** Nothing of the run left: its processes (any naming its HOME, tmux too), its folder, its sleeps. */
  async function expectNothingLeft(run: { physical: string; fake: number[]; server: number }) {
    const deadline = Date.now() + 45_000;
    const left = () =>
      [
        fs.existsSync(run.physical) ? `folder ${run.physical}` : '',
        ...run.fake.filter(alive).map((pid) => `fake process ${pid}`),
        alive(run.server) ? `server ${run.server}` : '',
        spawnSync('pgrep', ['-f', run.physical], { encoding: 'utf8' }).stdout.trim(),
      ].filter(Boolean);
    while (left().length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(left()).toEqual([]);
  }

  it.each(['SIGTERM', 'SIGKILL'] as const)(
    '%s of the tool in the middle of a run leaves nothing',
    async (signal) => {
      const run = await startedRun();
      run.child.kill(signal);
      await expectNothingLeft(run);
    },
    180_000
  );

  it('the twin dying in the middle of a run ends it and leaves nothing', async () => {
    const run = await startedRun();
    const closed = new Promise<number | null>((resolve) => run.child.on('close', resolve));
    process.kill(run.server, 'SIGKILL');
    expect(await closed).not.toBe(0);
    await expectNothingLeft(run);
  }, 180_000);

  it('refuses an unknown style before starting anything', async () => {
    const result = await runTool(['--style', 'no-existe', '--out', out]);
    expect(result.code).toBe(2);
    expect(result.output).toContain('unknown style no-existe');
    expect(fs.readdirSync(out)).toEqual([]);
    expect(fs.existsSync(`/tmp/utt-gemelo-shots-${result.pid}`)).toBe(false);
  }, 30_000);
});
