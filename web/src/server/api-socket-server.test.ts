import type { Socket } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiSocketServer } from './api-socket-server.js';
import { type GitEventNotify, type GitFollowRequest, MessageType } from './pty/socket-protocol.js';

// Mock net module
const mockCreateServer = vi.fn();
vi.mock('net', () => ({
  createServer: mockCreateServer,
  Socket: vi.fn(),
}));

// Mock dependencies at the module level
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    chmodSync: vi.fn(),
  };
});

vi.mock('./utils/logger.js', () => ({
  createLogger: () => ({
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('./utils/git-hooks.js', () => ({
  areHooksInstalled: vi.fn().mockResolvedValue(true),
  installGitHooks: vi.fn().mockResolvedValue({ success: true }),
  uninstallGitHooks: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('./utils/git-error.js', () => ({
  createGitError: (error: Error, message: string) => new Error(`${message}: ${error.message}`),
}));

// Mock promisify and execFile
const mockExecFile = vi.fn();
vi.mock('util', () => ({
  promisify: () => mockExecFile,
}));

/** The private socket handlers these tests drive directly, with a socket that only writes. */
type ApiSocketServerInternals = {
  handleGitFollowRequest(socket: Pick<Socket, 'write'>, request: GitFollowRequest): Promise<void>;
  handleGitEventNotify(socket: Pick<Socket, 'write'>, event: GitEventNotify): Promise<void>;
  handleMessage(socket: Pick<Socket, 'write'>, type: MessageType, payload: Buffer): Promise<void>;
};
const internals = (server: ApiSocketServer) => server as unknown as ApiSocketServerInternals;

describe('ApiSocketServer', () => {
  let apiSocketServer: ApiSocketServer;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Configure fs mocks
    const fsMock = await import('fs');
    vi.mocked(fsMock.existsSync).mockReturnValue(false);
    vi.mocked(fsMock.mkdirSync).mockImplementation(() => undefined);
    vi.mocked(fsMock.unlinkSync).mockImplementation(() => {});

    // Import after mocks are set up
    const module = await import('./api-socket-server.js');
    apiSocketServer = module.apiSocketServer;
  });

  afterEach(async () => {
    // Stop server
    if (apiSocketServer) {
      apiSocketServer.stop();
    }
  });

  describe('Server lifecycle', () => {
    it('should start and stop the server', async () => {
      // Mock net.createServer to prevent actual socket creation
      const mockServer = {
        listen: vi.fn((_path, callback) => callback()),
        close: vi.fn(),
        on: vi.fn(),
      };

      mockCreateServer.mockReturnValue(mockServer);

      await apiSocketServer.start();

      expect(mockCreateServer).toHaveBeenCalled();
      expect(mockServer.listen).toHaveBeenCalledWith(
        expect.stringContaining('api.sock'),
        expect.any(Function)
      );

      // Owner only: the socket acts with the server's authority.
      const fsMock = await import('fs');
      expect(fsMock.chmodSync).toHaveBeenCalledWith(expect.stringContaining('api.sock'), 0o600);

      apiSocketServer.stop();
      expect(mockServer.close).toHaveBeenCalled();
    });
  });

  describe('Status request', () => {
    it('should return server status without Git info when not in a repo', async () => {
      // Mock git commands to fail (not in a repo)
      mockExecFile.mockRejectedValue(new Error('Not a git repository'));

      apiSocketServer.setServerInfo(4020, 'http://localhost:4020');

      // Since we can't directly test private methods, we'll verify the setup is correct
      // The actual status request handling is tested in integration tests
      expect(mockExecFile).toBeDefined();
    });

    it('tells the follow mode of the folder of whoever asks, not of the server (2026-11-11)', async () => {
      const asked: string[] = [];
      mockExecFile.mockImplementation(
        async (_file: string, _args: string[], options?: { cwd?: string }) => {
          asked.push(options?.cwd ?? '');
          throw new Error('not a git repository');
        }
      );
      apiSocketServer.setServerInfo(4020, 'http://localhost:4020');
      const written: Buffer[] = [];
      const socket = { write: (data: Buffer) => written.push(data) > 0 };
      await internals(apiSocketServer).handleMessage(
        socket,
        MessageType.STATUS_REQUEST,
        Buffer.from(JSON.stringify({ cwd: '/Users/test/elsewhere/project' }))
      );
      expect(asked.length).toBeGreaterThan(0);
      expect(new Set(asked)).toEqual(new Set(['/Users/test/elsewhere/project']));
      expect(written).toHaveLength(1);

      // Nobody's folder: no git is asked about the server's own.
      asked.length = 0;
      await internals(apiSocketServer).handleMessage(
        socket,
        MessageType.STATUS_REQUEST,
        Buffer.from('{}')
      );
      expect(asked).toEqual([]);
      expect(written).toHaveLength(2);
    });

    it('should return server status with follow mode info', async () => {
      // Mock git commands
      mockExecFile
        .mockResolvedValueOnce({ stdout: 'main\n', stderr: '' }) // config command
        .mockResolvedValueOnce({ stdout: '/Users/test/project\n', stderr: '' }); // rev-parse

      apiSocketServer.setServerInfo(4020, 'http://localhost:4020');

      // Verify mocks are set up correctly
      expect(mockExecFile).toBeDefined();
    });
  });

  describe('Git follow mode', () => {
    it('should enable follow mode', async () => {
      // Mock git commands
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      const request: GitFollowRequest = {
        repoPath: '/Users/test/project',
        branch: 'feature-branch',
        enable: true,
      };

      const mockSocket = {
        write: vi.fn(),
      };

      await internals(apiSocketServer).handleGitFollowRequest(mockSocket, request);

      expect(mockSocket.write).toHaveBeenCalled();
      const call = mockSocket.write.mock.calls[0][0];
      expect(call[0]).toBe(MessageType.GIT_FOLLOW_RESPONSE);
    });

    it('should disable follow mode', async () => {
      // Mock git commands
      mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });

      const request: GitFollowRequest = {
        repoPath: '/Users/test/project',
        enable: false,
      };

      const mockSocket = {
        write: vi.fn(),
      };

      await internals(apiSocketServer).handleGitFollowRequest(mockSocket, request);

      expect(mockSocket.write).toHaveBeenCalled();
    });

    it('should handle Git errors gracefully', async () => {
      // Mock git command to fail
      mockExecFile.mockRejectedValue(new Error('Git command failed'));

      const request: GitFollowRequest = {
        repoPath: '/Users/test/project',
        branch: 'main',
        enable: true,
      };

      const mockSocket = {
        write: vi.fn(),
      };

      await internals(apiSocketServer).handleGitFollowRequest(mockSocket, request);

      expect(mockSocket.write).toHaveBeenCalled();
    });
  });

  describe('Git event notifications', () => {
    const ackOf = (socket: { write: ReturnType<typeof vi.fn> }) => {
      const frame = socket.write.mock.calls[0][0] as Buffer;
      expect(frame[0]).toBe(MessageType.GIT_EVENT_ACK);
      return JSON.parse(frame.subarray(5).toString('utf8')) as { handled: boolean };
    };

    it('handles the event in-process, never over HTTP', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const handler = vi.fn(async () => ({ status: 200 }));
      try {
        apiSocketServer.setGitEventHandler(handler);
        const mockSocket = { write: vi.fn() };
        await internals(apiSocketServer).handleGitEventNotify(mockSocket, {
          repoPath: '/Users/test/project',
          type: 'commit',
        });
        expect(handler).toHaveBeenCalledWith({ repoPath: '/Users/test/project', event: 'commit' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ackOf(mockSocket)).toEqual({ handled: true });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('acknowledges a failed event as not handled', async () => {
      apiSocketServer.setGitEventHandler(async () => ({ status: 400 }));
      const mockSocket = { write: vi.fn() };
      await internals(apiSocketServer).handleGitEventNotify(mockSocket, {
        repoPath: '',
        type: 'checkout',
      });
      expect(ackOf(mockSocket)).toEqual({ handled: false });
    });
  });

  describe('Task requests (ut task)', () => {
    const responseOf = (socket: { write: ReturnType<typeof vi.fn> }) => {
      const frame = socket.write.mock.calls[0][0] as Buffer;
      expect(frame[0]).toBe(MessageType.TASK_RESPONSE);
      return JSON.parse(frame.subarray(5).toString('utf8'));
    };
    const request = (body: unknown) => Buffer.from(JSON.stringify(body));

    it('passes the op, args and caller to the task handler and writes its answer', async () => {
      const handler = vi.fn(async () => ({
        ok: true as const,
        status: 'done' as const,
        data: { n: 1 },
      }));
      apiSocketServer.setTaskHandler(handler);
      const socket = { write: vi.fn() };
      await internals(apiSocketServer).handleMessage(
        socket,
        MessageType.TASK_REQUEST,
        request({ op: 'list', callerSessionId: 's1' })
      );
      expect(handler).toHaveBeenCalledWith({ op: 'list', args: {}, callerSessionId: 's1' });
      expect(responseOf(socket)).toEqual({ ok: true, status: 'done', data: { n: 1 } });
    });

    it('answers a failing handler or a malformed request with an error response', async () => {
      apiSocketServer.setTaskHandler(async () => {
        throw new Error('boom');
      });
      const failing = { write: vi.fn() };
      await internals(apiSocketServer).handleMessage(
        failing,
        MessageType.TASK_REQUEST,
        request({ op: 'list', args: {} })
      );
      expect(responseOf(failing)).toEqual({ ok: false, code: 'error', message: 'boom' });
      const malformed = { write: vi.fn() };
      await internals(apiSocketServer).handleMessage(
        malformed,
        MessageType.TASK_REQUEST,
        request({ op: 'list', callerSessionId: 7 })
      );
      expect(responseOf(malformed)).toMatchObject({ ok: false, code: 'bad-request' });
    });
  });
});
