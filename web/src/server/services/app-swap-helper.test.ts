/**
 * The helper that swaps the installed app (web/scripts/app-swap-helper.cjs), run for real
 * against a folder that plays /Applications. Nothing here knows the real app: the "app" is a
 * bundle whose executable is a small node server, and quit, open and codesign are doubles.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';

const HELPER = path.resolve(__dirname, '..', '..', '..', 'scripts', 'app-swap-helper.cjs');

/** The fake app: answers /api/health with its version, unless its bundle says it is broken. */
const APP_MAIN = `
const fs = require('fs');
const http = require('http');
const path = require('path');
const resources = path.join(__dirname, '..', 'Resources');
const port = Number(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'port'), 'utf8'));
if (fs.existsSync(path.join(resources, 'broken'))) setInterval(() => {}, 1000);
else
  http
    .createServer((_request, response) =>
      response.end(fs.readFileSync(path.join(resources, 'version'), 'utf8'))
    )
    .listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

/** codesign's double: a bundle with Resources/bad-signature does not verify; its signer is a file. */
const CODESIGN = `#!/bin/sh
bundle=""
for arg in "$@"; do bundle="$arg"; done
case "$1" in
  --verify)
    if [ -e "$bundle/Contents/Resources/bad-signature" ]; then
      echo "$bundle: invalid signature (code or signature have been modified)" >&2
      exit 1
    fi
    exit 0 ;;
  -d)
    echo "Executable=$bundle/Contents/MacOS/main.cjs" >&2
    echo "designated => $(cat "$bundle/Contents/Resources/signer")"
    exit 0 ;;
esac
exit 2
`;

const OPEN = `
const { spawn } = require('child_process');
const path = require('path');
const main = path.join(process.argv[2], 'Contents', 'MacOS', 'main.cjs');
spawn(process.execPath, [main], { detached: true, stdio: 'ignore' }).unref();
`;

const QUIT = `
const { execFileSync } = require('child_process');
const marker = process.argv[2] + '/Contents/MacOS/';
for (const line of execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\\n')) {
  const match = line.match(/^\\s*(\\d+)\\s+(.*)$/);
  if (match && match[2].includes(marker)) process.kill(Number(match[1]), 'SIGTERM');
}
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function health(port: number): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}

async function waitFor<T>(read: () => Promise<T | undefined>, ms = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(process.platform === 'win32')('the helper that swaps the installed app', () => {
  let tmp: string;
  let apps: string;
  let installed: string;
  let state: string;
  let port: number;
  const children: ChildProcess[] = [];

  /** A bundle saying `version`, signed by `signer`. */
  const makeApp = (
    dir: string,
    version: string,
    options: { signer?: string; broken?: boolean; badSignature?: boolean } = {}
  ) => {
    const bundle = path.join(dir, 'Fake.app');
    fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'Contents', 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'main.cjs'), APP_MAIN);
    fs.writeFileSync(path.join(bundle, 'Contents', 'Resources', 'version'), version);
    fs.writeFileSync(
      path.join(bundle, 'Contents', 'Resources', 'signer'),
      options.signer ?? 'team T1'
    );
    if (options.broken) fs.writeFileSync(path.join(bundle, 'Contents', 'Resources', 'broken'), '');
    if (options.badSignature) {
      fs.writeFileSync(path.join(bundle, 'Contents', 'Resources', 'bad-signature'), '');
    }
    return bundle;
  };

  const versionOf = (bundle: string) =>
    fs.readFileSync(path.join(bundle, 'Contents', 'Resources', 'version'), 'utf8');

  const appPids = () =>
    execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes(`${installed}/Contents/MacOS/`))
      .map((line) => Number(line.trim().split(/\s+/)[0]));

  const open = () => spawnSync(process.execPath, [path.join(tmp, 'open.cjs'), installed]);

  const plan = (newAppPath: string, extra: Record<string, unknown> = {}) => {
    const file = path.join(state, 'plan.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        appPath: installed,
        newAppPath,
        backupPath: path.join(state, 'Fake.app.previous'),
        resultPath: path.join(state, 'result.json'),
        logPath: path.join(state, 'swap.log'),
        commit: 'new1234',
        previousCommit: 'old1234',
        quit: [process.execPath, path.join(tmp, 'quit.cjs'), installed],
        open: [process.execPath, path.join(tmp, 'open.cjs'), installed],
        healthUrl: `http://127.0.0.1:${port}/api/health`,
        codesign: path.join(tmp, 'codesign'),
        timeouts: { quitMs: 5000, healthMs: 3000, pollMs: 100 },
        ...extra,
      })
    );
    return file;
  };

  const runHelper = (planFile: string) =>
    new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [HELPER, planFile], { stdio: 'ignore' });
      children.push(child);
      child.on('exit', (code) => resolve(code));
    });

  const result = () => JSON.parse(fs.readFileSync(path.join(state, 'result.json'), 'utf8'));

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-app-swap-')));
    apps = path.join(tmp, 'Applications');
    state = path.join(tmp, 'state');
    fs.mkdirSync(apps);
    fs.mkdirSync(state);
    port = await freePort();
    fs.writeFileSync(path.join(apps, 'port'), String(port));
    fs.writeFileSync(path.join(tmp, 'codesign'), CODESIGN, { mode: 0o755 });
    fs.writeFileSync(path.join(tmp, 'open.cjs'), OPEN);
    fs.writeFileSync(path.join(tmp, 'quit.cjs'), QUIT);
    installed = makeApp(apps, 'old');
    open();
    expect(await waitFor(() => health(port))).toBe('old');
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const pid of appPids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  it('puts the new build in place, keeps a copy of the old one and says so once the server answers', async () => {
    const built = makeApp(path.join(tmp, 'build'), 'new');

    expect(await runHelper(plan(built))).toBe(0);

    expect(versionOf(installed)).toBe('new');
    expect(await health(port)).toBe('new');
    expect(versionOf(path.join(state, 'Fake.app.previous'))).toBe('old');
    expect(result()).toMatchObject({
      outcome: 'updated',
      commit: 'new1234',
      previousCommit: 'old1234',
    });
    // Nothing of the swap is left next to the app.
    expect(fs.readdirSync(apps).sort()).toEqual(['Fake.app', 'port']);
  });

  it('changes nothing for a build whose signature does not verify', async () => {
    const built = makeApp(path.join(tmp, 'build'), 'new', { badSignature: true });
    const [pid] = appPids();

    expect(await runHelper(plan(built))).toBe(1);

    expect(result()).toMatchObject({ outcome: 'refused', reason: 'signature' });
    expect(versionOf(installed)).toBe('old');
    // The app was never closed.
    expect(appPids()).toEqual([pid]);
    expect(fs.existsSync(path.join(state, 'Fake.app.previous'))).toBe(false);
  });

  it('changes nothing for a build signed by someone else (macOS would ask every permission again)', async () => {
    const built = makeApp(path.join(tmp, 'build'), 'new', { signer: 'cdhash ad-hoc' });
    const [pid] = appPids();

    expect(await runHelper(plan(built))).toBe(1);

    expect(result()).toMatchObject({ outcome: 'refused', reason: 'signer' });
    expect(result().detail).toContain('team T1');
    expect(versionOf(installed)).toBe('old');
    expect(appPids()).toEqual([pid]);
  });

  it('puts the old app back when the server does not answer with the new one', async () => {
    const built = makeApp(path.join(tmp, 'build'), 'new', { broken: true });

    expect(await runHelper(plan(built))).toBe(2);

    expect(result()).toMatchObject({ outcome: 'rolled-back', reason: 'no-answer' });
    expect(versionOf(installed)).toBe('old');
    expect(fs.existsSync(path.join(installed, 'Contents', 'Resources', 'broken'))).toBe(false);
    expect(await health(port)).toBe('old');
    expect(fs.readdirSync(apps).sort()).toEqual(['Fake.app', 'port']);
  });

  it('says so when the server answers with neither app', async () => {
    // The old app answers now, but would not after a restart: its copy carries the flaw.
    const built = makeApp(path.join(tmp, 'build'), 'new', { broken: true });
    const planFile = plan(built);
    fs.writeFileSync(path.join(installed, 'Contents', 'Resources', 'broken'), '');

    expect(await runHelper(planFile)).toBe(3);

    expect(result()).toMatchObject({ outcome: 'broken', reason: 'no-answer' });
    // Even then the old app is the one in place.
    expect(versionOf(installed)).toBe('old');
  });

  it('insists with SIGTERM when asking the app to quit does nothing, and still swaps', async () => {
    const built = makeApp(path.join(tmp, 'build'), 'new');
    // A quit that fails, like osascript without the Automation permission.
    const planFile = plan(built, {
      quit: ['/bin/sh', '-c', 'echo "Not authorized to send Apple events" >&2; exit 1'],
      timeouts: { quitMs: 500, healthMs: 3000, pollMs: 100 },
    });

    expect(await runHelper(planFile)).toBe(0);

    expect(await health(port)).toBe('new');
    expect(fs.readFileSync(path.join(state, 'swap.log'), 'utf8')).toContain('Not authorized');
  });

  it('ends the server the old app left behind (its process group) before opening the new one', async () => {
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    children.push(orphan);
    const built = makeApp(path.join(tmp, 'build'), 'new');

    const planFile = plan(built, {
      serverGroup: orphan.pid,
      timeouts: { quitMs: 5000, orphanMs: 300, healthMs: 3000, pollMs: 100 },
    });
    const exited = new Promise((resolve) => orphan.on('exit', resolve));
    expect(await runHelper(planFile)).toBe(0);

    await exited;
    expect(fs.readFileSync(path.join(state, 'swap.log'), 'utf8')).toContain('outlived its app');
  });

  it('survives the death of the process that started it, like the server the app takes down', async () => {
    const built = makeApp(path.join(tmp, 'build'), 'new');
    const planFile = plan(built);
    // The starter does what the server does (detached, unref) and dies at once.
    const starter = `
      const { spawn } = require('child_process');
      spawn(process.execPath, [${JSON.stringify(HELPER)}, ${JSON.stringify(planFile)}], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      process.kill(process.pid, 'SIGKILL');
    `;
    spawnSync(process.execPath, ['-e', starter]);

    const outcome = await waitFor(async () => {
      try {
        return result().outcome as string;
      } catch {
        return undefined;
      }
    }, 20_000);
    expect(outcome).toBe('updated');
    expect(await health(port)).toBe('new');
  });
});
