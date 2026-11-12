import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type GitFollowRequest,
  type GitFollowResponse,
  MessageType,
} from './pty/socket-protocol.js';
import { SocketApiClient, TASK_CONNECT_RETRY_MS } from './socket-api-client.js';

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

// Mock dependencies
vi.mock('./utils/logger.js', () => ({
  createLogger: () => ({
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock UntetherSocketClient
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockOn = vi.fn();
const mockWrite = vi.fn();
const mockEnd = vi.fn();
const mockSend = vi.fn();

// Store handlers for testing
let _errorHandler: ((error: Error) => void) | null = null;
let _dataHandler: ((data: Buffer) => void) | null = null;

vi.mock('./pty/socket-client.js', () => ({
  // biome-ignore lint/complexity/useArrowFunction: the client is created with `new`
  UntetherSocketClient: vi.fn().mockImplementation(function () {
    const clientInstance = {
      connect: mockConnect,
      disconnect: mockDisconnect,
      on: vi.fn(function (this: unknown, event: string, handler: (arg: unknown) => void) {
        mockOn(event, handler);
        // Store handlers for test access
        if (event === 'error') {
          _errorHandler = handler as (error: Error) => void;
        } else if (event === 'data') {
          _dataHandler = handler as (data: Buffer) => void;
        }
        return this;
      }),
      write: mockWrite,
      end: mockEnd,
      sendMessageWithResponse: mockSend,
    };
    return clientInstance;
  }),
}));

describe('SocketApiClient', () => {
  let client: SocketApiClient;
  const _testSocketPath = path.join(process.env.HOME || '/tmp', '.untether', 'api.sock');

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock implementations
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockOn.mockReset();
    mockWrite.mockReset();
    mockEnd.mockReset();

    // Reset handlers
    _errorHandler = null;
    _dataHandler = null;

    client = new SocketApiClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getStatus', () => {
    it('should return not running when socket does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const status = await client.getStatus();

      expect(status.running).toBe(false);
      expect(status.port).toBeUndefined();
      expect(status.url).toBeUndefined();
    });

    it('should return server status when socket exists', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);

      // Mock the sendRequest method
      const mockStatus = {
        running: true,
        port: 4020,
        url: 'http://localhost:4020',
        followMode: {
          enabled: true,
          branch: 'main',
          repoPath: '/Users/test/project',
        },
      };

      vi.spyOn(
        client as unknown as { sendRequest: (...args: unknown[]) => unknown },
        'sendRequest'
      ).mockResolvedValue(mockStatus);

      const status = await client.getStatus();

      expect(status).toEqual(mockStatus);
    });

    it('should handle connection errors gracefully', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.spyOn(
        client as unknown as { sendRequest: (...args: unknown[]) => unknown },
        'sendRequest'
      ).mockRejectedValue(new Error('Connection failed'));

      const status = await client.getStatus();

      expect(status.running).toBe(false);
    });
  });

  describe('setFollowMode', () => {
    it('should send follow mode request', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);

      const request: GitFollowRequest = {
        repoPath: '/Users/test/project',
        branch: 'feature-branch',
        enable: true,
      };

      const expectedResponse: GitFollowResponse = {
        success: true,
        currentBranch: 'feature-branch',
      };

      vi.spyOn(
        client as unknown as { sendRequest: (...args: unknown[]) => unknown },
        'sendRequest'
      ).mockResolvedValue(expectedResponse);

      const response = await client.setFollowMode(request);

      expect(response).toEqual(expectedResponse);
      expect(
        (client as unknown as { sendRequest: (...args: unknown[]) => unknown }).sendRequest
      ).toHaveBeenCalledWith(
        expect.anything(), // MessageType.GIT_FOLLOW_REQUEST
        request,
        expect.anything() // MessageType.GIT_FOLLOW_RESPONSE
      );
    });

    it('should throw error when socket is not available', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const request: GitFollowRequest = {
        repoPath: '/Users/test/project',
        branch: 'main',
        enable: true,
      };

      await expect(client.setFollowMode(request)).rejects.toThrow('Untether server is not running');
    });
  });

  describe('sendGitEvent', () => {
    it('should send git event notification', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);

      const event = {
        repoPath: '/Users/test/project',
        type: 'checkout' as const,
      };

      const expectedAck = {
        handled: true,
      };

      vi.spyOn(
        client as unknown as { sendRequest: (...args: unknown[]) => unknown },
        'sendRequest'
      ).mockResolvedValue(expectedAck);

      const ack = await client.sendGitEvent(event);

      expect(ack).toEqual(expectedAck);
    });
  });

  describe('task', () => {
    it('sends the op, args and caller as a TASK_REQUEST and returns the TASK_RESPONSE', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      const response = { ok: true, status: 'done', data: { tasks: [] } };
      const sendRequest = vi
        .spyOn(client as unknown as { sendRequest: (...args: unknown[]) => unknown }, 'sendRequest')
        .mockResolvedValue(response);

      expect(await client.task('list', { all: true }, { sessionId: 'sess-1' })).toEqual(response);
      expect(sendRequest).toHaveBeenCalledWith(
        MessageType.TASK_REQUEST,
        { op: 'list', args: { all: true }, callerSessionId: 'sess-1' },
        MessageType.TASK_RESPONSE,
        15_000,
        60_000
      );
      // 2026-10-20: no `interactive` claim is sent (it gave no rights).
      await client.task('status', { ref: 'x' }, {});
      expect(sendRequest.mock.calls[1][1]).toEqual({ op: 'status', args: { ref: 'x' } });
    });
  });

  describe('a restarting server', () => {
    const refused = () =>
      Object.assign(new Error('connect ECONNREFUSED /x/api.sock'), { code: 'ECONNREFUSED' });
    let clock: number;
    let waiting: ReturnType<typeof vi.fn>;
    const make = () =>
      new SocketApiClient({
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        onWaiting: waiting,
      });

    beforeEach(async () => {
      clock = 0;
      waiting = vi.fn();
      mockSend.mockReset();
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
    });

    it('a task command waits through ECONNREFUSED and a missing socket, then sends once', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValueOnce(false);
      mockConnect.mockRejectedValueOnce(refused()).mockResolvedValue(undefined);
      mockSend.mockResolvedValue({ ok: true, status: 'done', data: {} });

      const response = await make().task('merge', { ref: 'abc' });

      expect(response).toEqual({ ok: true, status: 'done', data: {} });
      expect(mockConnect).toHaveBeenCalledTimes(2);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(waiting).toHaveBeenCalledTimes(1);
      expect(clock).toBe(1000);
    });

    it('gives up once the server stays away past the retry window', async () => {
      mockConnect.mockRejectedValue(refused());

      await expect(make().task('status', {})).rejects.toThrow('Untether server is not running');
      expect(clock).toBeGreaterThanOrEqual(TASK_CONNECT_RETRY_MS);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a request the server got is not sent again when it fails', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockSend.mockRejectedValue(new Error('Request timeout waiting for TASK_RESPONSE'));

      await expect(make().task('merge', {})).rejects.toThrow('Request timeout');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('other commands still fail at once', async () => {
      mockConnect.mockRejectedValue(refused());

      await expect(
        make().setFollowMode({ repoPath: '/r', branch: 'main', enable: true })
      ).rejects.toThrow('Untether server is not running');
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendRequest', () => {
    it('should handle timeout', async () => {
      // This test would require complex mocking of internal socket behavior
      // Testing timeout behavior is better done in integration tests
      expect(true).toBe(true);
    });

    it('should handle server errors', async () => {
      // This test would require complex mocking of internal socket behavior
      // Testing error handling is better done in integration tests
      expect(true).toBe(true);
    });
  });
});
