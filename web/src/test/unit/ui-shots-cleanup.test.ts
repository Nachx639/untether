import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

/**
 * ui-shots.mjs killed halfway leaves nothing behind (2026-11-09: the doctor found
 * /tmp/utt-gemelo-* dirs left by runs cut short). Real runs of the tool against the twin, so off by
 * default (a minute per signal): UNTETHER_TEST_UI_SHOTS=1 pnpm exec vitest run --mode=server
 * src/test/unit/ui-shots-cleanup.test.ts
 */
const WEB = path.resolve(__dirname, '../../..');
const REAL = process.env.UNTETHER_TEST_UI_SHOTS === '1';

const twinProcesses = (home: string) => {
  const result = spawnSync('ps', ['-axEww', '-o', 'pid=,command='], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  return result.stdout
    .split('\n')
    .filter((line) => line.includes(home) && !line.includes('vitest'));
};

/** A process and everything under it, as a tool that kills a process tree finds them. */
const processTree = (root: number): number[] => {
  const rows = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .stdout.trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const found = [root];
  for (const parent of found) {
    for (const [pid, ppid] of rows) if (ppid === parent) found.push(pid);
  }
  return found;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await wait(200);
  }
  return condition();
}

describe.runIf(REAL)('ui-shots killed halfway', () => {
  // 'tree': kill -9 of the tool and everything under it at once (2026-11-10: a tool's timeout
  // killed the twin's watchdog with the rest and the folder stayed for the doctor).
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL', 'tree'] as const)(
    '%s leaves no twin process and no folder',
    async (signal) => {
      const out = fs.mkdtempSync(path.join(WEB, '.ui-shots-cleanup-'));
      const child = spawn(
        process.execPath,
        [
          'scripts/ui-shots.mjs',
          '--views',
          'mobile,desktop,task',
          '--browsers',
          'chromium',
          '--out',
          out,
        ],
        { cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
      const home = `/tmp/utt-gemelo-shots-${child.pid}`;
      const leftNothing = () => !fs.existsSync(home) && twinProcesses(home).length === 0;
      try {
        let printed = '';
        const collect = (chunk: Buffer) => {
          printed += chunk.toString();
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        expect(await until(() => printed.includes('gemelo: up'), 180_000), printed).toBe(true);
        // In the middle of its work: the first picture written, or the browser running.
        await until(() => fs.readdirSync(out).length > 0, 30_000);
        const marker = JSON.parse(
          fs.readFileSync(path.join(fs.realpathSync(home), '.untether-test-run'), 'utf8')
        );
        expect(marker.pid).toBeGreaterThan(0);

        if (signal === 'tree') {
          for (const pid of processTree(child.pid as number)) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // Ended between the listing and the signal.
            }
          }
        } else expect(child.kill(signal)).toBe(true);
        const gone = await until(leftNothing, 60_000);
        expect(gone, `${home} left: ${twinProcesses(home).join('\n')}`).toBe(true);
      } finally {
        // A failure above must not leave the tool and its twin running.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await Promise.race([ended, wait(30_000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await until(leftNothing, 60_000);
        fs.rmSync(out, RM_TEST_DIR);
      }
    },
    300_000
  );
});
