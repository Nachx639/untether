// Outside the twin: the client bundle it serves, and the run started again inside
// scripts/gemelo.sh run --rich, which removes the twin however the run ends.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { REPO_ROOT, WEB_DIR, fail } from './options.mjs';

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    // Tests are not in the bundle: editing one needs no rebuild.
    else if (!entry.name.endsWith('.test.ts')) newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

const BUILD_LOCK_STALE_MS = 10 * 60_000;

/** One build at a time per checkout: two at once collide while publishing the Monaco folder. */
function withBuildLock(run) {
  const lock = path.join(WEB_DIR, 'public/.ui-shots-build.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let heldFor;
      try {
        heldFor = Date.now() - fs.statSync(lock).mtimeMs;
      } catch (statError) {
        // The other run finished between the two calls: the lock is free, try again.
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (heldFor > BUILD_LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  try {
    run();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** The twin serves web/public, ignored by git: built here when missing or older than the code. */
function ensureClientBundle() {
  const bundle = path.join(WEB_DIR, 'public/bundle/client-bundle.js');
  const sources = ['src/client', 'src/shared'].map((dir) => path.join(WEB_DIR, dir));
  const fresh = () => {
    const built = fs.existsSync(bundle) ? fs.statSync(bundle).mtimeMs : 0;
    return built && built >= Math.max(...sources.map(newestMtime));
  };
  if (fresh()) return;
  withBuildLock(() => {
    if (fresh()) return; // another run built it while this one waited
    console.log('ui-shots: building the client');
    const result = spawnSync(process.execPath, ['scripts/build-client.js'], {
      cwd: WEB_DIR,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    // Thrown, not fail(): process.exit would skip the lock's finally and the next run would wait
    // ten minutes for a lock nobody holds.
    if (result.status !== 0) throw new Error('the client build failed');
    // esbuild leaves a file it would write unchanged: without this the bundle stays "older" forever.
    const now = new Date();
    fs.utimesSync(bundle, now, now);
  });
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Starts the twin and, inside it, `entry` (the tool itself) with --inner and the same arguments. */
export async function outside(entry, argv, options) {
  // --built deliberately captures the existing bundle, allowing inventory-script repairs
  // against an immutable before build while the implementation is being edited.
  if (!options.built && !options.assets) {
    try {
      ensureClientBundle();
    } catch (error) {
      fail(error.message);
    }
  }
  else if (!fs.existsSync(path.join(WEB_DIR, 'public/bundle/client-bundle.js'))) fail('--built needs an existing client bundle');
  const home = `/tmp/utt-gemelo-shots-${process.pid}`;
  const port = await freePort();
  const child = spawn(
    'bash',
    [
      path.join(REPO_ROOT, 'scripts/gemelo.sh'),
      'run',
      '--rich',
      '--',
      process.execPath,
      entry,
      '--inner',
      ...argv,
    ],
    {
      cwd: REPO_ROOT,
      detached: true, // its own group: a signal reaches the browsers and then gemelo's trap
      stdio: 'inherit',
      env: {
        ...process.env,
        UTT_GEMELO_HOME: home,
        UTT_GEMELO_PORT: String(port),
        UTT_GEMELO_LOCALE: options.locale,
        UI_SHOTS_PARENT: String(process.pid),
        // gemelo.sh's watchdog removes the twin when this process ends, however it ends
        // (2026-11-10: a kill -9 of the whole tree left /tmp/utt-gemelo-shots-<pid> behind).
        UTT_GEMELO_PARENT: String(process.pid),
      },
    }
  );
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    });
  }
  child.on('close', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Ends this run when the process that started it (even killed with -9) or the twin's server dies:
 * gemelo.sh's own exit then removes the twin, and the browsers go with their pipes.
 */
export function stopWithTheTwin(home) {
  const parent = Number(process.env.UI_SHOTS_PARENT);
  const server = Number(fs.readFileSync(path.join(home, '.gemelo/pid'), 'utf8'));
  setInterval(() => {
    if ((parent && !pidAlive(parent)) || !pidAlive(server)) {
      console.error('ui-shots: its parent or the twin ended: stopping');
      process.exit(1);
    }
  }, 500).unref();
}
