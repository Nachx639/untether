/**
 * 2026-10-20: the server gave up on a Terminal launch at 10 s while the Mac app's AppleScript
 * may take 15 s, then started a web session for the same command: it ran twice. A timeout is
 * now an error (no fallback), and a resume keeps its claim until the window's session shows.
 */
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { controlUnixHandler } from '../websocket/control-unix-handler';
import { createSessionRoutes, requestTerminalSpawn, TERMINAL_SPAWN_TIMEOUT_MS } from './sessions';

vi.mock('../websocket/control-unix-handler', () => ({
  controlUnixHandler: {
    isMacAppConnected: vi.fn(),
    sendControlMessage: vi.fn(),
  },
}));

vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../utils/git-info', () => ({
  detectGitInfo: vi.fn(async () => ({})),
}));

const connected = vi.mocked(controlUnixHandler.isMacAppConnected);
const send = vi.mocked(controlUnixHandler.sendControlMessage);

beforeEach(() => {
  connected.mockReset();
  send.mockReset();
});

describe('requestTerminalSpawn', () => {
  it('waits longer than the Mac app (15 s AppleScript) before giving up', async () => {
    connected.mockReturnValue(true);
    send.mockResolvedValue(null);
    expect(TERMINAL_SPAWN_TIMEOUT_MS).toBeGreaterThan(15_500);
    const result = await requestTerminalSpawn({
      sessionId: 's',
      sessionName: 'n',
      command: ['zsh'],
      workingDir: '/tmp',
    });
    expect(send).toHaveBeenCalledWith(expect.anything(), TERMINAL_SPAWN_TIMEOUT_MS);
    // No answer in time while the app is connected: the window may still open.
    expect(result).toMatchObject({ success: false, mayStillOpen: true });
  });

  it('without the Mac app nothing opens: a plain failure (the fallback may run)', async () => {
    connected.mockReturnValue(false);
    const result = await requestTerminalSpawn({
      sessionId: 's',
      sessionName: 'n',
      command: ['zsh'],
      workingDir: '/tmp',
    });
    expect(send).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.mayStillOpen).toBeFalsy();
  });
});

describe('POST /sessions with spawn_terminal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function routes(sessions: Map<string, object>) {
    const ptyManager = {
      listSessions: vi.fn(() => [...sessions.values()]),
      getSession: vi.fn((id: string) => sessions.get(id) ?? null),
      createSession: vi.fn(async () => ({ sessionId: 'web-1', sessionInfo: {} })),
    };
    const router = createSessionRoutes({
      ptyManager,
      terminalManager: { getRecentText: vi.fn() },
      remoteRegistry: null,
      isHQMode: false,
    } as unknown as Parameters<typeof createSessionRoutes>[0]);
    const layer = (
      router as unknown as {
        stack: Array<{
          route?: {
            path: string;
            methods: { post?: boolean };
            stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
          };
        }>;
      }
    ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.post);
    const post = (command: string[]) => {
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response & {
        json: ReturnType<typeof vi.fn>;
        status: ReturnType<typeof vi.fn>;
      };
      const done = layer?.route?.stack[0].handle(
        { body: { command, workingDir: process.cwd(), spawn_terminal: true } } as Request,
        res
      );
      return { res, done };
    };
    return { post, ptyManager };
  }

  it('a timeout is reported, never followed by a web session of the same command', async () => {
    connected.mockReturnValue(true);
    send.mockResolvedValue(null);
    const { post, ptyManager } = routes(new Map());
    const { res, done } = post(['zsh']);
    await done;
    expect(res.status).toHaveBeenCalledWith(504);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'terminal-spawn-timeout' })
    );
    expect(ptyManager.createSession).not.toHaveBeenCalled();
  });

  it('a resume sent to a Terminal window claims its conversation until the session shows', async () => {
    connected.mockReturnValue(true);
    send.mockResolvedValue({ payload: { success: true } } as never);
    const sessions = new Map<string, object>();
    const { post, ptyManager } = routes(sessions);
    const first = post(['claude', '--resume', 'conv-term']);
    await first.done;
    const spawnedId = first.res.json.mock.calls[0][0].sessionId;
    expect(spawnedId).toBeTruthy();
    // The window's forwarder has not registered the session yet: a second resume waits for it.
    const second = post(['claude', '--resume', 'conv-term']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(second.res.json).not.toHaveBeenCalled();
    sessions.set(spawnedId, { id: spawnedId, status: 'running', claudeSessionId: 'conv-term' });
    await second.done;
    expect(second.res.json).toHaveBeenCalledWith({ sessionId: spawnedId, existing: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(ptyManager.createSession).not.toHaveBeenCalled();
  });
});
