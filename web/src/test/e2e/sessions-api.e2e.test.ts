import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SNAPSHOT_VERSION } from '../../shared/terminal-text-formatter.js';
import { WsV3MessageType } from '../../shared/ws-v3.js';
import type { SessionData } from '../types/test-types';
import { type ServerInstance, startTestServer, stopServer } from '../utils/server-utils';
import { testLogger } from '../utils/test-logger';
import {
  connectWsV3,
  sendSubscribe,
  WS_V3_FLAGS,
  waitForWsV3Frame,
} from '../utils/ws-v3-test-utils';

// Waits for what the next step needs, with a deadline, never a fixed sleep: under load
// (2026-11-02, load 35-177 on 12 cores) a fixed pause is either too short or wasted.
const UNDER_LOAD = { timeout: 15_000, interval: 100 };

async function listedSession(port: number | undefined, id: string) {
  const sessions = (await (await fetch(`http://localhost:${port}/api/sessions`)).json()) as
    | SessionData[]
    | undefined;
  return sessions?.find((s) => s.id === id);
}

describe('Sessions API Tests', () => {
  let server: ServerInstance | null = null;

  beforeAll(async () => {
    // Start server with no authentication
    server = await startTestServer({
      args: ['--port', '0', '--no-auth'],
      env: {},
      waitForHealth: true,
    });
    // startTestServer waits up to 30 s for the server's health itself; the default 10 s hook
    // budget cut it short with 12 copies running at once.
  }, 60_000);

  afterAll(async () => {
    if (server) {
      await stopServer(server.process);
    }
  });

  describe('GET /api/sessions', () => {
    it('should return empty array when no sessions exist', async () => {
      const response = await fetch(`http://localhost:${server?.port}/api/sessions`);

      expect(response.status).toBe(200);
      const sessions = await response.json();
      expect(sessions).toEqual([]);
    });

    it('should accept requests without authentication when using --no-auth', async () => {
      const response = await fetch(`http://localhost:${server?.port}/api/sessions`);
      expect(response.status).toBe(200);
    });
  });

  describe('POST /api/sessions', () => {
    it('should create a new session', async () => {
      const response = await fetch(`http://localhost:${server?.port}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: ['echo', 'hello world'],
        }),
      });

      if (response.status !== 200) {
        await testLogger.logHttpError('Session creation', response);
      }
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toHaveProperty('sessionId');
      expect(result.sessionId).toMatch(/^[a-f0-9-]{36}$/); // UUID format
    });

    it('should create session with name', async () => {
      const sessionName = 'Test Session';
      const response = await fetch(`http://localhost:${server?.port}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: ['echo', 'named session'],
          name: sessionName,
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();

      // Verify session was created with the name
      const listResponse = await fetch(`http://localhost:${server?.port}/api/sessions`);
      const sessions = await listResponse.json();
      const createdSession = sessions.find((s: SessionData) => s.id === result.sessionId);
      expect(createdSession?.name).toBe(sessionName);
    });

    it('should create session with fallback for invalid working directory', async () => {
      const response = await fetch(`http://localhost:${server?.port}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: ['echo', 'test'],
          workingDir: '/nonexistent/directory',
        }),
      });

      // Server creates session even with invalid directory (it will use cwd as fallback)
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toHaveProperty('sessionId');
    });

    it('should create session with initial dimensions', async () => {
      const response = await fetch(`http://localhost:${server?.port}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: ['echo', 'dimension test'],
          cols: 120,
          rows: 30,
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toHaveProperty('sessionId');

      // Verify session was created with initial dimensions
      const sessionResponse = await fetch(
        `http://localhost:${server?.port}/api/sessions/${result.sessionId}`
      );
      const session = await sessionResponse.json();
      expect(session.initialCols).toBe(120);
      expect(session.initialRows).toBe(30);
    });
  });

  describe('Session lifecycle', () => {
    let sessionId: string;

    beforeAll(async () => {
      // Create a long-running session
      const response = await fetch(`http://localhost:${server?.port}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: ['bash', '-c', 'while true; do echo "running"; sleep 1; done'],
          name: 'Long Running Test',
        }),
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toHaveProperty('sessionId');
      sessionId = result.sessionId;

      // Started: listed as running and its loop has printed.
      await vi.waitFor(async () => {
        expect((await listedSession(server?.port, sessionId))?.status).toBe('running');
        const text = await fetch(`http://localhost:${server?.port}/api/sessions/${sessionId}/text`);
        expect(await text.text()).toContain('running');
      }, UNDER_LOAD);
    }, 30_000);

    it('should list the created session', async () => {
      const response = await fetch(`http://localhost:${server?.port}/api/sessions`);

      expect(response.status).toBe(200);
      const sessions = await response.json();

      const session = sessions.find((s: SessionData) => s.id === sessionId);
      expect(session).toBeDefined();
      expect(session.name).toBe('Long Running Test');
      expect(session.status).toBe('running');
      expect(session.command).toEqual([
        'bash',
        '-c',
        'while true; do echo "running"; sleep 1; done',
      ]);
    });

    it('should send input to session', async () => {
      const response = await fetch(
        `http://localhost:${server?.port}/api/sessions/${sessionId}/input`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: 'echo "test input"\n' }),
        }
      );

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
    });

    it('should resize session', async () => {
      const response = await fetch(
        `http://localhost:${server?.port}/api/sessions/${sessionId}/resize`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ cols: 120, rows: 40 }),
        }
      );

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);
      expect(result.cols).toBe(120);
      expect(result.rows).toBe(40);
    });

    it('should get session text', async () => {
      const response = await fetch(
        `http://localhost:${server?.port}/api/sessions/${sessionId}/text`
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      // The text might be empty initially or contain the echo output
      expect(text).toBeDefined();
      expect(typeof text).toBe('string');
    });

    it('should get session text with styles', async () => {
      const response = await fetch(
        `http://localhost:${server?.port}/api/sessions/${sessionId}/text?styles=true`
      );

      expect(response.status).toBe(200);
      const text = await response.text();
      // Should contain style markup if terminal has any styled output
      expect(text).toBeDefined();
    });

    it('should receive a VT snapshot via WebSocket v3', async () => {
      const port = server?.port;
      if (!port) throw new Error('Server not started');
      const { ws } = await connectWsV3({ port });

      sendSubscribe({
        ws,
        sessionId,
        flags: WS_V3_FLAGS.Snapshots,
      });

      // The snapshot taken after the resize above (its header's cols), not a fixed pause for it.
      const snapshotCols = (payload: Uint8Array) =>
        payload.byteLength >= 8
          ? new DataView(payload.buffer, payload.byteOffset).getUint32(4, true)
          : null;
      const snapshotFrame = await waitForWsV3Frame(
        ws,
        (frame) =>
          frame.type === WsV3MessageType.SNAPSHOT_VT &&
          frame.sessionId === sessionId &&
          snapshotCols(frame.payload) === 120 &&
          // …and with the loop's output on it: under load the first snapshot after the
          // resize came before any line was redrawn (45 bytes, 2026-11-10); the next one, at
          // the loop's next line, has it.
          frame.payload.byteLength > 50,
        UNDER_LOAD.timeout
      );

      expect(snapshotFrame.payload.byteLength).toBeGreaterThan(50);
      expect(snapshotFrame.payload.byteLength).toBeLessThan(100000);

      const view = new DataView(snapshotFrame.payload.buffer, snapshotFrame.payload.byteOffset);
      expect(view.getUint16(0, true)).toBe(0x5654); // "VT"
      expect(view.getUint8(2)).toBe(SNAPSHOT_VERSION);
      expect(view.getUint32(4, true)).toBe(120); // cols (LE)

      ws.close();
    }, 30_000);

    it('should stream output via WebSocket v3', async () => {
      const port = server?.port;
      if (!port) throw new Error('Server not started');
      const { ws } = await connectWsV3({ port });

      sendSubscribe({
        ws,
        sessionId,
        flags: WS_V3_FLAGS.Stdout,
      });

      const stdoutFrame = await waitForWsV3Frame(
        ws,
        (frame) => frame.type === WsV3MessageType.STDOUT && frame.sessionId === sessionId,
        8000
      );
      expect(stdoutFrame.payload.byteLength).toBeGreaterThan(0);

      ws.close();
    });

    it('should kill session', async () => {
      const response = await fetch(`http://localhost:${server?.port}/api/sessions/${sessionId}`, {
        method: 'DELETE',
      });

      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.success).toBe(true);

      // Terminated: it may still be in the list with 'exited' status, or be cleaned up already.
      // Both are valid outcomes; waited for, with a deadline.
      await vi.waitFor(async () => {
        const killedSession = await listedSession(server?.port, sessionId);
        if (killedSession) {
          expect(killedSession.status).toBe('exited');
        }
      }, UNDER_LOAD);
    });
  });

  describe('Error handling', () => {
    it('should return 404 for non-existent session', async () => {
      const response = await fetch(
        `http://localhost:${server?.port}/api/sessions/nonexistent/input`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: 'test' }),
        }
      );

      expect(response.status).toBe(404);
    });

    it('should handle invalid input data', async () => {
      // Create a session first
      const createResponse = await fetch(`http://localhost:${server?.port}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: ['cat'],
        }),
      });

      expect(createResponse.status).toBe(200);
      const result = await createResponse.json();
      expect(result).toHaveProperty('sessionId');
      const sessionId = result.sessionId;

      // Send invalid input (missing data field)
      const response = await fetch(
        `http://localhost:${server?.port}/api/sessions/${sessionId}/input`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        }
      );

      expect(response.status).toBe(400);
    });

    it('should handle invalid resize dimensions', async () => {
      // Create a session first
      const createResponse = await fetch(`http://localhost:${server?.port}/api/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: ['cat'],
        }),
      });

      expect(createResponse.status).toBe(200);
      const result = await createResponse.json();
      expect(result).toHaveProperty('sessionId');
      const sessionId = result.sessionId;

      // Send invalid resize (negative dimensions)
      const response = await fetch(
        `http://localhost:${server?.port}/api/sessions/${sessionId}/resize`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ cols: -1, rows: 40 }),
        }
      );

      expect(response.status).toBe(400);
    });
  });
});
