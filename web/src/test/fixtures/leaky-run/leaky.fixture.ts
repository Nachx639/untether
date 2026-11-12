import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { expect, it } from 'vitest';
import { findTmuxBinary, shieldSocketArgs } from '../../../server/services/shielded-tmux.js';
import { markedTempDir } from '../../helpers/test-dirs.js';

// Leaks on purpose (run-cleanup.test.ts): a shield tmux server in a throwaway HOME straight in
// /tmp (the run's cleanup only looks there), named LEAK_HOME_PREFIX so the outer test can remove it,
// outside the inner run's dir, marked as the short-socket tests do (markedTempDir), and no
// cleanup at all. Then it fails (LEAK_MODE=fail) or hangs until the run is killed
// (LEAK_MODE=hang). LEAK_MODE=late leaves the leaking to a child that outlives the run, the way
// a test server does on a loaded Mac: it starts the tmux server one second after the run's
// main process is gone, when the run's own cleanup has already passed, and stays.
const LATE_CHILD = `
const { execFileSync } = require('child_process');
const fs = require('fs');
const [tmux, main, infoFile, ...socketArgs] = process.argv.slice(1);
const alive = () => { try { process.kill(Number(main), 0); return true; } catch { return false; } };
const timer = setInterval(() => {
  if (alive()) return;
  clearInterval(timer);
  setTimeout(() => {
    execFileSync(tmux, [...socketArgs, 'new-session', '-d', '-s', 'ut-x', 'bash']);
    const pid = Number(execFileSync(tmux, [...socketArgs, 'display', '-p', '#{pid}'], { encoding: 'utf8' }).trim());
    fs.writeFileSync(infoFile + '.late', JSON.stringify({ pid }));
    setInterval(() => undefined, 1000);
  }, 1000);
}, 100);
`;

it('leaks a shield tmux server', async () => {
  const tmux = findTmuxBinary() as string;
  const home = markedTempDir(process.env.LEAK_HOME_PREFIX as string);
  const controlDir = path.join(home, '.untether', 'control');
  fs.mkdirSync(controlDir, { recursive: true });
  const runDir = process.env.UNTETHER_TEST_RUN_DIR;
  const infoFile = process.env.LEAK_INFO_FILE as string;
  if (process.env.LEAK_MODE === 'late') {
    const child = spawn(
      process.execPath,
      ['-e', LATE_CHILD, tmux, String(process.ppid), infoFile, ...shieldSocketArgs(controlDir)],
      { detached: true, stdio: 'ignore' }
    );
    child.unref();
    fs.writeFileSync(infoFile, JSON.stringify({ pid: child.pid, home, runDir }));
    await new Promise(() => undefined);
  }
  execFileSync(tmux, [...shieldSocketArgs(controlDir), 'new-session', '-d', '-s', 'ut-x', 'bash']);
  const pid = Number(
    execFileSync(tmux, [...shieldSocketArgs(controlDir), 'display', '-p', '#{pid}'], {
      encoding: 'utf8',
    }).trim()
  );
  fs.writeFileSync(infoFile, JSON.stringify({ pid, home, runDir }));
  if (process.env.LEAK_MODE === 'hang') await new Promise(() => undefined);
  expect('failed on purpose').toBe('passed');
});
