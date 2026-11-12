import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlUnixHandler } from '../../server/websocket/control-unix-handler.js';

const netMock = vi.hoisted(() => ({
  connectionHandler: undefined as ((socket: unknown) => void) | undefined,
  close: vi.fn((callback?: () => void) => callback?.()),
}));

// Mock dependencies
vi.mock('fs', () => ({
  promises: {
    unlink: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  chmod: vi.fn((_path, _mode, cb) => cb(null)),
}));

vi.mock('net', () => ({
  createServer: vi.fn((connectionHandler: (socket: unknown) => void) => {
    netMock.connectionHandler = connectionHandler;
    return {
      listen: vi.fn((_path, cb) => cb?.()),
      close: netMock.close,
      on: vi.fn(),
    };
  }),
}));

// Mock logger
const { moduleLogger } = vi.hoisted(() => ({
  moduleLogger: { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../server/utils/logger', () => ({
  logger: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: vi.fn(() => moduleLogger),
}));

describe('Control Unix Handler', () => {
  let controlUnixHandler: ControlUnixHandler;

  beforeEach(async () => {
    vi.clearAllMocks();
    netMock.connectionHandler = undefined;
    // Import after mocks are set up
    const module = await import('../../server/websocket/control-unix-handler');
    controlUnixHandler = new module.ControlUnixHandler();
  });

  afterEach(() => {
    controlUnixHandler.stop();
    vi.restoreAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should start the Unix socket server', async () => {
      await controlUnixHandler.start();

      const net = await vi.importMock<typeof import('net')>('net');
      expect(net.createServer).toHaveBeenCalled();
    });

    it('rejects startup when restrictive socket permissions cannot be set', async () => {
      const fs = await import('fs');
      vi.mocked(fs.chmod).mockImplementationOnce((_path, _mode, callback) => {
        callback(new Error('permission denied'));
      });

      await expect(controlUnixHandler.start()).rejects.toThrow('permission denied');
      expect(netMock.close).toHaveBeenCalledOnce();
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('should check if Mac app is connected', () => {
      expect(controlUnixHandler.isMacAppConnected()).toBe(false);
    });

    it('should stop the Unix socket server', () => {
      controlUnixHandler.stop();
      // Just verify it doesn't throw
      expect(true).toBe(true);
    });
  });

  describe('Message Handling', () => {
    it('should handle browser WebSocket connections', () => {
      const mockWs = {
        on: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        readyState: 1,
      } as unknown as import('ws').WebSocket;

      // Should not throw
      controlUnixHandler.handleBrowserConnection(mockWs, 'test-user');

      expect(mockWs.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWs.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockWs.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should return null when Mac is not connected', async () => {
      const message = {
        id: 'test-123',
        type: 'request' as const,
        category: 'system' as const,
        action: 'test',
        payload: { test: true },
      };

      // When Mac is not connected, sendControlMessage should return null immediately
      const result = await controlUnixHandler.sendControlMessage(message);
      expect(result).toBe(null);
    }, 1000);

    it('greets a new Mac connection with a pong, so the app does not reconnect forever', async () => {
      class MockSocket extends EventEmitter {
        destroyed = false;
        readable = true;
        writable = true;
        setNoDelay = vi.fn();
        write = vi.fn((_data: Buffer, callback?: (error?: Error) => void) => {
          callback?.();
          return true;
        });
        destroy = vi.fn();
      }
      await controlUnixHandler.start();
      const socket = new MockSocket();
      netMock.connectionHandler?.(socket);
      const frames = socket.write.mock.calls.map(([data]) =>
        JSON.parse((data as Buffer).subarray(4).toString('utf8'))
      );
      expect(frames).toContainEqual(
        expect.objectContaining({ type: 'event', category: 'system', action: 'ready' })
      );
      // What Untether.app takes as a keep-alive pong (type, category and action only).
      expect(frames).toContainEqual(
        expect.objectContaining({ type: 'response', category: 'system', action: 'ping' })
      );
    });

    it('does not carry a partial frame into a replacement Mac connection', async () => {
      class MockSocket extends EventEmitter {
        destroyed = false;
        readable = true;
        writable = true;
        localAddress = 'local';
        remoteAddress = 'remote';
        setNoDelay = vi.fn();
        write = vi.fn((_data: Buffer, callback?: (error?: Error) => void) => {
          callback?.();
          return true;
        });
        destroy = vi.fn(() => {
          this.destroyed = true;
          this.emit('close', false);
        });
      }

      await controlUnixHandler.start();
      const firstSocket = new MockSocket();
      netMock.connectionHandler?.(firstSocket);
      firstSocket.write.mockClear();

      const incompleteHeader = Buffer.alloc(4);
      incompleteHeader.writeUInt32BE(100, 0);
      firstSocket.emit('data', Buffer.concat([incompleteHeader, Buffer.from('partial')]));

      const secondSocket = new MockSocket();
      netMock.connectionHandler?.(secondSocket);
      secondSocket.write.mockClear();

      const ping = Buffer.from(
        JSON.stringify({
          id: 'ping-1',
          type: 'request',
          category: 'system',
          action: 'ping',
        })
      );
      const pingHeader = Buffer.alloc(4);
      pingHeader.writeUInt32BE(ping.length, 0);
      secondSocket.emit('data', Buffer.concat([pingHeader, ping]));

      expect(secondSocket.write).toHaveBeenCalledOnce();
    });

    it("logs the app's keep-alive pings at debug level only", async () => {
      class MockSocket extends EventEmitter {
        destroyed = false;
        readable = true;
        writable = true;
        setNoDelay = vi.fn();
        write = vi.fn((_data: Buffer, callback?: (error?: Error) => void) => {
          callback?.();
          return true;
        });
        destroy = vi.fn();
      }
      await controlUnixHandler.start();
      const socket = new MockSocket();
      netMock.connectionHandler?.(socket);
      const ping = Buffer.from(
        JSON.stringify({ id: 'ping-2', type: 'request', category: 'system', action: 'ping' })
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(ping.length, 0);
      socket.emit('data', Buffer.concat([header, ping]));

      const at = (fn: typeof moduleLogger.log) => fn.mock.calls.flat().join('\n');
      expect(at(moduleLogger.log)).not.toContain('Parsed Mac message');
      expect(at(moduleLogger.debug)).toContain('action=ping');
    });
  });
});
