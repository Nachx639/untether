/**
 * "Suspend" by hand, end to end (2026-10-31): a real server and tmux, the fake `claude`
 * (fixtures/fake-claude) and the idle setting off. A draft in its input box keeps it awake (409
 * with the reason, the text stays where it was); once sent, the user's Suspend suspends it right
 * away (no idle time), it is listed as suspended, and a tap's wake brings the same session back
 * with `claude --resume` on the same conversation, its screen live again (until 2026-10-31 a
 * woken session's terminal stayed on "[exited]" until the server restarted).
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
const CONVERSATION = '22222222-3333-4444-8555-666666666666';

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

describeTmux('Suspend a Claude session by hand and wake it (E2E, fake claude)', () => {
  let homeDir = '';
  let workDir = '';
  let fakeLog = '';
  let server: ServerInstance | null = null;
  let sessionId = '';

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
  const starts = () =>
    fs.existsSync(fakeLog)
      ? fs
          .readFileSync(fakeLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { pid: number; args: string[] })
      : [];
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    homeDir = markedTempDir('/tmp/vts-');
    workDir = fs.mkdtempSync(path.join('/tmp', 'vtw-'));
    fakeLog = path.join(homeDir, 'fake-claude.log');
    fs.mkdirSync(path.join(homeDir, '.untether'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.untether', 'config.json'),
      // The idle look is off: only the user's Suspend may suspend it.
      JSON.stringify({
        version: 2,
        quickStartCommands: [{ command: 'claude' }],
        suspendIdleClaude: false,
      })
    );
    server = await startTestServer({
      args: ['--port', '0', '--no-auth'],
      env: {
        HOME: homeDir,
        CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'),
        PATH: `${FAKE_DIR}:${process.env.PATH}`,
        FAKE_CLAUDE_LOG: fakeLog,
        FAKE_CLAUDE_CONV: CONVERSATION,
        UNTETHER_SUSPEND_TICK_MS: '1000',
      },
      controlDir: path.join(homeDir, '.untether', 'control'),
      waitForHealth: true,
      logOutput: !!process.env.SUSPEND_E2E_DEBUG,
    });
  }, 60_000);

  afterAll(async () => {
    if (server) await stopServer(server.process);
    await cleanupTestDirectories([homeDir, workDir]);
  });

  it('a draft keeps it awake; sent, Suspend suspends it at once, and a wake brings it back', async () => {
    const created = await api('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        command: ['claude', '--dangerously-skip-permissions'],
        workingDir: workDir,
        name: 'fake claude by hand',
        shielded: true,
        spawn_terminal: false,
      }),
    });
    expect(created.status).toBe(200);
    sessionId = ((await created.json()) as { sessionId: string }).sessionId;
    await waitFor('the fake claude prompt', async () => (await screen()).includes('started'));
    const firstPid = await waitFor('the fake claude pid', () => starts()[0]?.pid);

    // Text typed and not sent: a blocker, never thrown away.
    expect(
      (
        await api(`/sessions/${sessionId}/input`, {
          method: 'POST',
          body: JSON.stringify({ text: 'half typed' }),
        })
      ).status
    ).toBe(200);
    await waitFor('the draft on screen', async () => (await screen()).includes('❯ half typed'));
    const refused = await waitFor('the draft to be seen', async () => {
      const response = await api(`/sessions/${sessionId}/suspend`, { method: 'POST' });
      const body = (await response.json()) as {
        blockers?: Array<{ kind: string; reason: string }>;
      };
      return response.status === 409 && body.blockers?.some((b) => b.kind === 'draft')
        ? body
        : undefined;
    });
    expect(refused.blockers?.map((b) => b.kind)).toContain('draft');
    expect((await session())?.status).toBe('running');
    expect((await session())?.suspended).toBeFalsy();
    expect(alive(firstPid)).toBe(true);
    expect(await screen()).toContain('❯ half typed');

    // Sent: nothing holds it any more; Suspend works right away (no idle time).
    await api(`/sessions/${sessionId}/input`, {
      method: 'POST',
      body: JSON.stringify({ text: '\r' }),
    });
    await waitFor('the second turn', async () =>
      (await screen()).includes('echo half typed (turn 2)')
    );
    const suspendedNow = await waitFor('the suspension', async () => {
      const response = await api(`/sessions/${sessionId}/suspend`, { method: 'POST' });
      return response.status === 200
        ? ((await response.json()) as Record<string, unknown>)
        : undefined;
    });
    expect(suspendedNow).toEqual({ sessionId, suspended: true });
    const paused = await session();
    expect(paused?.status).toBe('exited');
    expect(paused?.suspended).toMatchObject({
      claudeSessionId: CONVERSATION,
      workingDir: workDir,
      byUser: true,
    });
    await waitFor('the fake claude to end', () => (alive(firstPid) ? undefined : true));
    // Listed (what the "Suspended" section reads), not finished.
    const listed = (await (await api('/sessions')).json()) as Array<{
      id: string;
      suspended?: unknown;
    }>;
    expect(listed.find((s) => s.id === sessionId)?.suspended).toBeTruthy();
    expect(starts()).toHaveLength(1);

    // A tap: the same session wakes with its conversation and goes on.
    const woke = await api(`/sessions/${sessionId}/wake`, { method: 'POST' });
    expect(woke.status).toBe(200);
    expect(await woke.json()).toEqual({ sessionId, woke: true });
    const running = await session();
    expect(running?.status).toBe('running');
    expect(running?.suspended).toBeFalsy();
    expect(starts()).toHaveLength(2);
    // The woken Claude gets Untether's hooks again (claude-hooks.ts), on its spawn only.
    expect(starts()[1].args).toEqual([
      '--settings',
      path.join(homeDir, '.untether', 'agent-hooks', 'claude-settings.json'),
      '--resume',
      CONVERSATION,
      '--dangerously-skip-permissions',
    ]);
    await api(`/sessions/${sessionId}/input`, {
      method: 'POST',
      body: JSON.stringify({ text: 'after the wake\r' }),
    });
    await waitFor('the third turn', async () =>
      (await screen()).includes('echo after the wake (turn 3)')
    );
  }, 120_000);
});
