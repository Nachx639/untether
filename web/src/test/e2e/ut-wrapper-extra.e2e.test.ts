import { spawn, spawnSync } from 'child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerInstance } from '../utils/server-utils';
import {
  cleanupTestDirectories,
  START_HOOK_TIMEOUT_MS,
  sleep,
  startTestServer,
  stopServer,
} from '../utils/server-utils';

function resolveForwarderPath(): string {
  const candidates: string[] = [];
  if (process.env.UNTETHER_FWD_BIN) {
    candidates.push(process.env.UNTETHER_FWD_BIN);
  }
  candidates.push(path.join(process.cwd(), 'native', 'untether-fwd'));
  candidates.push(path.join(process.cwd(), 'bin', 'untether-fwd'));

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      accessSync(candidate, constants.X_OK);
      return candidate;
    }
  }

  throw new Error(
    `untether-fwd not found. Run: node scripts/build-fwd-rust.js (cwd: ${process.cwd()})`
  );
}

function createShortHomeDir(): string {
  return mkdtempSync(path.join('/tmp', 'vth-'));
}

function createUntetherCliWrapper(homeDir: string): string {
  const cliPath = path.join(process.cwd(), 'src', 'cli.ts');
  const wrapperDir = path.join(homeDir, 'bin');
  const wrapperPath = path.join(wrapperDir, 'untether');

  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(wrapperPath, `#!/usr/bin/env bash\nexec tsx "${cliPath}" "$@"\n`, 'utf-8');
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function listSessionDirs(controlDir: string): string[] {
  if (!existsSync(controlDir)) {
    return [];
  }
  return readdirSync(controlDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

async function waitForNewSessionDir(
  controlDir: string,
  before: Set<string>,
  timeoutMs = 10000
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const name of listSessionDirs(controlDir)) {
      if (!before.has(name)) {
        return name;
      }
    }
    await sleep(50);
  }
  throw new Error(`No new session directory appeared after ${timeoutMs}ms`);
}

async function waitForSessionText(
  port: number,
  sessionId: string,
  marker: string,
  timeoutMs = 10000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/text`);
    if (response.ok) {
      const text = await response.text();
      if (text.includes(marker)) {
        return;
      }
    }
    await sleep(200);
  }
  throw new Error(`Session ${sessionId} text missing marker after ${timeoutMs}ms`);
}

describe('ut wrapper extra flows', () => {
  let server: ServerInstance | null = null;
  let homeDir = '';
  let controlDir = '';
  let untetherBin = '';

  beforeAll(async () => {
    homeDir = createShortHomeDir();
    controlDir = path.join(homeDir, '.untether', 'control');
    untetherBin = createUntetherCliWrapper(homeDir);

    server = await startTestServer({
      args: ['--port', '0', '--no-auth'],
      controlDir,
      env: { HOME: homeDir },
      waitForHealth: true,
    });
  }, START_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (server) {
      await stopServer(server.process);
    }
    if (homeDir) {
      await cleanupTestDirectories([homeDir]);
    }
  });

  it('resolves bash aliases via ut wrapper (shell wrap)', async () => {
    const forwarderPath = resolveForwarderPath();
    const marker = `ut-alias-ok-${Date.now()}`;
    const utPath = path.join(process.cwd(), 'bin', 'ut');

    writeFileSync(
      path.join(homeDir, '.bashrc'),
      `alias vttest='printf "${marker}\\n"; sleep 1'\n`,
      'utf-8'
    );

    const before = new Set(listSessionDirs(controlDir));

    const child = spawn(utPath, ['vttest'], {
      env: {
        ...process.env,
        HOME: homeDir,
        SHELL: '/bin/bash',
        UNTETHER_CONTROL_DIR: controlDir,
        UNTETHER_FWD_BIN: forwarderPath,
        UNTETHER_BIN: untetherBin,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const stderr: string[] = [];
    child.stderr?.on('data', (data) => stderr.push(data.toString()));

    const exitPromise = new Promise<void>((resolve, reject) => {
      child.on('error', (error) =>
        reject(error instanceof Error ? error : new Error(String(error)))
      );
      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`ut alias exited with code ${code ?? 'null'}:\n${stderr.join('')}`));
      });
    });

    if (!server) {
      throw new Error('Server not started');
    }

    const sessionId = await waitForNewSessionDir(controlDir, before);
    await Promise.all([waitForSessionText(server.port, sessionId, marker), exitPromise]);
  }, 20000);

  it('prefers client-resolved binary paths over server PATH', async () => {
    const forwarderPath = resolveForwarderPath();
    const marker = `ut-path-ok-${Date.now()}`;
    const utPath = path.join(process.cwd(), 'bin', 'ut');
    const binDir = path.join(homeDir, 'bin-extra');
    const ccPath = path.join(binDir, 'cc');

    mkdirSync(binDir, { recursive: true });
    writeFileSync(ccPath, `#!/usr/bin/env bash\nprintf "${marker}\\n"\n`, 'utf-8');
    chmodSync(ccPath, 0o755);

    const before = new Set(listSessionDirs(controlDir));

    const child = spawn(utPath, ['cc'], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
        HOME: homeDir,
        SHELL: '/bin/bash',
        UNTETHER_CONTROL_DIR: controlDir,
        UNTETHER_FWD_BIN: forwarderPath,
        UNTETHER_BIN: untetherBin,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const stderr: string[] = [];
    child.stderr?.on('data', (data) => stderr.push(data.toString()));

    await new Promise<void>((resolve, reject) => {
      child.on('error', (error) =>
        reject(error instanceof Error ? error : new Error(String(error)))
      );
      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(`ut path resolution exited with code ${code ?? 'null'}:\n${stderr.join('')}`)
        );
      });
    });

    if (!server) {
      throw new Error('Server not started');
    }

    const sessionId = await waitForNewSessionDir(controlDir, before);
    await waitForSessionText(server.port, sessionId, marker);
  }, 20000);

  it('returns status via ut wrapper (ut status)', () => {
    const utPath = path.join(process.cwd(), 'bin', 'ut');

    const result = spawnSync(utPath, ['status'], {
      env: {
        ...process.env,
        HOME: homeDir,
        UNTETHER_CONTROL_DIR: controlDir,
        UNTETHER_BIN: untetherBin,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(String(result.stdout)).toContain('Untether Server Status:');
    expect(String(result.stdout)).toContain('Running: Yes');
  });

  it('notifies server via ut git event (ut git event)', () => {
    const utPath = path.join(process.cwd(), 'bin', 'ut');

    const result = spawnSync(utPath, ['git', 'event'], {
      env: {
        ...process.env,
        HOME: homeDir,
        UNTETHER_CONTROL_DIR: controlDir,
        UNTETHER_BIN: untetherBin,
      },
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
  });
});
