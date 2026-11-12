/**
 * Suspend and wake a real shielded session end to end (2026-10-31, session-suspender.ts): a
 * real server and tmux, and a fake `claude` first in PATH (fixtures/fake-claude) that writes
 * what Untether reads from Claude Code (its sessions/<pid>.json and the transcript). The
 * session is suspended on its own, survives a server restart as suspended, wakes under the same
 * id with `claude --resume <conversation>` and its flags, and the conversation goes on.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { markedTempDir } from '../helpers/test-dirs.js';
import {
  cleanupTestDirectories,
  type ServerInstance,
  sleep,
  startTestServer,
  stopServer,
} from '../utils/server-utils';

vi.unmock('node-pty');

const hasTmux = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
const describeTmux = hasTmux && process.platform === 'darwin' ? describe : describe.skip;

const FAKE_DIR = path.resolve(__dirname, '..', 'fixtures', 'fake-claude');
const CONVERSATION = '11111111-2222-4333-8444-555555555555';

async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) return value as T;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describeTmux('Suspend and wake an idle Claude session (E2E, fake claude)', () => {
  let homeDir = '';
  let controlDir = '';
  let workDir = '';
  let fakeLog = '';
  let server: ServerInstance | null = null;
  /** What the server printed (both streams), every start. */
  const serverLines: string[] = [];
  let sessionId = '';

  const start = async () => {
    server = await startTestServer({
      args: ['--port', '0', '--no-auth'],
      env: {
        HOME: homeDir,
        CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'),
        PATH: `${FAKE_DIR}:${process.env.PATH}`,
        FAKE_CLAUDE_LOG: fakeLog,
        FAKE_CLAUDE_CONV: CONVERSATION,
        UNTETHER_SUSPEND_TICK_MS: '1000',
        // Debug: the suspender says there why a session stays awake (read by serverSaid).
        UNTETHER_LOG_LEVEL: 'debug',
      },
      controlDir,
      waitForHealth: true,
      logOutput: !!process.env.SUSPEND_E2E_DEBUG,
    });
    for (const stream of [server.process.stdout, server.process.stderr]) {
      stream?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          serverLines.push(line);
          if (process.env.SUSPEND_E2E_DEBUG && /suspend|wak|shield|error/i.test(line)) {
            console.log(`[SERVER] ${line}`);
          }
        }
      });
    }
  };
  const api = (route: string, init?: RequestInit) =>
    fetch(`http://localhost:${server?.port}/api${route}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  const session = async () => {
    const response = await api(`/sessions/${sessionId}`);
    return response.ok ? ((await response.json()) as Record<string, unknown>) : undefined;
  };
  const screen = async () => (await (await api(`/sessions/${sessionId}/text`)).text()) as string;
  /** The session's output, as if nothing had been written for three hours. */
  const ageOutput = () => {
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(path.join(controlDir, sessionId, 'stdout'), old, old);
  };

  beforeAll(async () => {
    homeDir = markedTempDir('/tmp/vts-');
    controlDir = path.join(homeDir, '.untether', 'control');
    workDir = fs.mkdtempSync(path.join('/tmp', 'vtw-'));
    fakeLog = path.join(homeDir, 'fake-claude.log');
    fs.mkdirSync(path.join(homeDir, '.untether'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.untether', 'config.json'),
      JSON.stringify({
        version: 2,
        quickStartCommands: [{ command: 'claude' }],
        suspendIdleClaude: true,
        suspendIdleMinutes: 15,
      })
    );
    await start();
  }, 60_000);

  afterAll(async () => {
    if (server) await stopServer(server.process);
    await cleanupTestDirectories([homeDir, workDir]);
  });

  it('suspends the idle session, keeps it through a restart, wakes it in place and goes on', async () => {
    // A shielded Claude session with the flags it must come back with.
    const created = await api('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        command: ['claude', '--dangerously-skip-permissions', '--allowedTools', 'Bash(ut task:*)'],
        workingDir: workDir,
        name: 'fake claude',
        shielded: true,
        spawn_terminal: false,
      }),
    });
    expect(created.status).toBe(200);
    sessionId = ((await created.json()) as { sessionId: string }).sessionId;
    await waitFor('the fake claude prompt', async () => (await screen()).includes('started'));
    const firstPid = await waitFor('the fake claude pid', () => {
      const lines = fs.existsSync(fakeLog)
        ? fs.readFileSync(fakeLog, 'utf8').trim().split('\n')
        : [];
      return lines.length ? (JSON.parse(lines[0]) as { pid: number }).pid : undefined;
    });

    // Nothing for hours: the suspender takes it on one of its looks.
    ageOutput();
    const suspended = await waitFor(
      'the session to be suspended',
      async () => {
        const current = await session();
        // Its end state: the record is written before tmux is ended (so that end reads as a
        // suspension), and the session turns exited a moment later. 2026-11-01: under load
        // (1-min load 52) the look in between saw suspended and still running.
        if (current?.suspended && current.status === 'exited') return current;
        ageOutput(); // tmux redraws on attach; keep it looking idle
        return undefined;
      },
      45_000
    );
    expect(suspended.status).toBe('exited');
    expect(suspended.suspended).toMatchObject({
      claudeSessionId: CONVERSATION,
      workingDir: workDir,
      shielded: true,
    });
    // Claude is gone; the session is still listed (not finished, not cleaned up).
    await waitFor('the fake claude to end', () => {
      try {
        process.kill(firstPid, 0);
        return undefined;
      } catch {
        return true;
      }
    });
    const cleanup = await api('/cleanup-exited', { method: 'POST' });
    expect(cleanup.ok).toBe(true);
    expect(await session()).toBeTruthy();

    // A server restart (tsx watch, a Mac reboot) keeps it suspended, and does not restore it.
    if (server) await stopServer(server.process);
    await start();
    const afterRestart = await waitFor('the session after the restart', session);
    expect(afterRestart.status).toBe('exited');
    expect((afterRestart.suspended as { claudeSessionId: string }).claudeSessionId).toBe(
      CONVERSATION
    );
    expect(fs.readFileSync(fakeLog, 'utf8').trim().split('\n')).toHaveLength(1);

    // Input through the API wakes it first (same id), then goes in.
    const input = await api(`/sessions/${sessionId}/input`, {
      method: 'POST',
      body: JSON.stringify({ text: 'second message\r' }),
    });
    expect(input.status).toBe(200);
    const woke = await waitFor('the woken session', async () => {
      const current = await session();
      return current?.status === 'running' && !current.suspended ? current : undefined;
    });
    expect(woke.id).toBe(sessionId);
    const starts = fs
      .readFileSync(fakeLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(starts).toHaveLength(2);
    // The woken Claude gets Untether's hooks again (claude-hooks.ts), on its spawn only.
    expect(starts[1].args).toEqual([
      '--settings',
      path.join(homeDir, '.untether', 'agent-hooks', 'claude-settings.json'),
      '--resume',
      CONVERSATION,
      '--dangerously-skip-permissions',
      '--allowedTools',
      'Bash(ut task:*)',
    ]);
    // The same conversation: the resumed Claude saw its first turn, and the input is turn 2.
    await waitFor('the second turn', async () =>
      (await screen()).includes('echo second message (turn 2)')
    );
    const transcript = fs.readFileSync(
      path.join(
        homeDir,
        '.claude',
        'projects',
        // Claude names the folder after its real path (/private/tmp on macOS).
        fs.realpathSync(workDir).replace(/[^A-Za-z0-9]/g, '-'),
        `${CONVERSATION}.jsonl`
      ),
      'utf8'
    );
    expect(transcript).toContain('first message');
    expect(transcript).toContain('second message');

    // "Don't suspend" is respected: idle again, it stays awake.
    const keep = await api(`/sessions/${sessionId}/keep-awake`, {
      method: 'POST',
      body: JSON.stringify({ keepAwake: true }),
    });
    expect(keep.status).toBe(200);
    // The suspender's own word for it (its log): the minute's look kept it awake for that rule.
    await waitFor('the keep-awake rule', async () => {
      ageOutput();
      return serverLines.some(
        (line) => line.includes('stays awake') && line.includes('marked "keep awake"')
      );
    });
    expect((await session())?.status).toBe('running');
    await api(`/sessions/${sessionId}/keep-awake`, {
      method: 'POST',
      body: JSON.stringify({ keepAwake: false }),
    });

    // Another restart: its Claude comes back with the shield (as after a reboot), and with no
    // input since, idle again, it is suspended again.
    if (server) await stopServer(server.process);
    await start();
    await waitFor(
      'the second suspension',
      async () => {
        const current = await session();
        // Its end state, as above: suspended and exited.
        if (current?.suspended && current.status === 'exited') return current;
        if (current?.status === 'running') ageOutput();
        return undefined;
      },
      60_000
    );
    const startsBefore = fs.readFileSync(fakeLog, 'utf8').trim().split('\n').length;

    // "Resume Claude" from the history of that conversation wakes this same session: never a
    // second `claude --resume` next to it.
    const resumed = await api('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        command: ['claude', '--resume', CONVERSATION],
        workingDir: workDir,
        spawn_terminal: false,
      }),
    });
    expect(resumed.status).toBe(200);
    expect(((await resumed.json()) as { sessionId: string }).sessionId).toBe(sessionId);
    expect((await session())?.status).toBe('running');
    // One more start: the wake (no second writer).
    expect(fs.readFileSync(fakeLog, 'utf8').trim().split('\n')).toHaveLength(startsBefore + 1);
  }, 180_000);
});
