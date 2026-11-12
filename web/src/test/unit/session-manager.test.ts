import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../server/pty/session-manager';
import type { SessionInfo } from '../../shared/types';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  let testDir: string;

  beforeAll(() => {
    // Create a test directory for control files
    testDir = path.join(os.tmpdir(), 'session-manager-test', Date.now().toString());
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterAll(() => {
    // Clean up test directory
    try {
      fs.rmSync(testDir, RM_TEST_DIR);
    } catch (e) {
      console.error('Failed to clean test directory:', e);
    }
  });

  beforeEach(() => {
    sessionManager = new SessionManager(testDir);
  });

  afterEach(() => {
    // Clean up any created session directories
    const entries = fs.readdirSync(testDir);
    for (const entry of entries) {
      const entryPath = path.join(testDir, entry);
      if (fs.statSync(entryPath).isDirectory()) {
        fs.rmSync(entryPath, RM_TEST_DIR);
      }
    }
  });

  describe('Session Persistence', () => {
    it('should save session info to file', () => {
      const sessionId = 'test123';
      const sessionInfo: SessionInfo = {
        id: sessionId,
        command: ['echo', 'test'],
        name: 'Test Session',
        workingDir: testDir,
        pid: 12345,
        status: 'running',
        startedAt: new Date().toISOString(),
      };

      // Create session directory first
      sessionManager.createSessionDirectory(sessionId);

      // Save session info
      sessionManager.saveSessionInfo(sessionId, sessionInfo);

      // Verify file was created
      const sessionPath = path.join(testDir, sessionId, 'session.json');
      expect(fs.existsSync(sessionPath)).toBe(true);

      // Verify content
      const content = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
      expect(content).toMatchObject(sessionInfo);
    });

    it('should load session info from file', () => {
      const sessionId = 'test456';
      const sessionInfo: SessionInfo = {
        id: sessionId,
        command: ['bash', '-l'],
        name: 'Bash Session',
        workingDir: '/home/user',
        pid: 54321,
        status: 'running',
        startedAt: new Date().toISOString(),
      };

      // Create session directory and save info
      sessionManager.createSessionDirectory(sessionId);
      sessionManager.saveSessionInfo(sessionId, sessionInfo);

      // Read it back
      const readInfo = sessionManager.loadSessionInfo(sessionId);
      expect(readInfo).toMatchObject(sessionInfo);
    });

    it('should return null for non-existent session', () => {
      const info = sessionManager.loadSessionInfo('nonexistent');
      expect(info).toBeNull();
    });

    it('should update existing session status', () => {
      const sessionId = 'test789';
      const initialInfo: SessionInfo = {
        id: sessionId,
        command: ['vim'],
        name: 'Editor',
        workingDir: testDir,
        pid: 11111,
        status: 'running',
        startedAt: new Date().toISOString(),
      };

      // Create session directory and save initial info
      sessionManager.createSessionDirectory(sessionId);
      sessionManager.saveSessionInfo(sessionId, initialInfo);

      // Update session status
      sessionManager.updateSessionStatus(sessionId, 'exited', undefined, 0);

      // Verify update
      const readInfo = sessionManager.loadSessionInfo(sessionId);
      expect(readInfo?.status).toBe('exited');
      expect(readInfo?.exitCode).toBe(0);
    });
  });

  describe('Session Discovery', () => {
    it('should list all sessions', () => {
      // Create multiple sessions
      const sessions = [
        { id: 'session1', name: 'Session 1', status: 'running' as const, pid: 999999 }, // Non-existent PID
        { id: 'session2', name: 'Session 2', status: 'running' as const, pid: 999998 }, // Non-existent PID
        { id: 'session3', name: 'Session 3', status: 'exited' as const, exitCode: 0, pid: 999997 },
      ];

      for (const session of sessions) {
        const sessionInfo: SessionInfo = {
          id: session.id,
          command: ['echo', session.name],
          name: session.name,
          workingDir: testDir,
          pid: session.pid,
          status: session.status,
          exitCode: session.exitCode,
          startedAt: new Date().toISOString(),
        };
        sessionManager.createSessionDirectory(session.id);
        sessionManager.saveSessionInfo(session.id, sessionInfo);
      }

      // List sessions
      const listedSessions = sessionManager.listSessions();

      expect(listedSessions).toHaveLength(3);
      expect(listedSessions.map((s) => s.id).sort()).toEqual(['session1', 'session2', 'session3']);

      // Verify session data - sessions with non-existent PIDs should be marked as exited
      const session1 = listedSessions.find((s) => s.id === 'session1');
      expect(session1?.name).toBe('Session 1');
      expect(session1?.status).toBe('exited'); // Process is not actually running

      const session2 = listedSessions.find((s) => s.id === 'session2');
      expect(session2?.status).toBe('exited'); // Process is not actually running

      const session3 = listedSessions.find((s) => s.id === 'session3');
      expect(session3?.status).toBe('exited'); // Already marked as exited
    });

    it('should handle empty directory', () => {
      const sessions = sessionManager.listSessions();
      expect(sessions).toEqual([]);
    });

    it('should ignore files that are not directories', () => {
      // Create a file in the control directory
      fs.writeFileSync(path.join(testDir, 'not-a-session.txt'), 'test');

      // Create a valid session
      sessionManager.createSessionDirectory('validsession');
      sessionManager.saveSessionInfo('validsession', {
        id: 'validsession',
        command: ['ls'],
        name: 'Valid',
        workingDir: testDir,
        pid: 12345,
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      const sessions = sessionManager.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe('validsession');
    });

    it('should handle corrupted session files gracefully', () => {
      const sessionId = 'corrupted';
      const sessionDir = path.join(testDir, sessionId);
      fs.mkdirSync(sessionDir);

      // Write corrupted JSON
      fs.writeFileSync(path.join(sessionDir, 'session.json'), '{invalid json');

      const sessions = sessionManager.listSessions();
      expect(sessions).toHaveLength(0);
    });
  });

  describe('Listing cache', () => {
    const info = (id: string, name: string, pid?: number): SessionInfo => ({
      id,
      command: ['sleep', '1'],
      name,
      workingDir: testDir,
      pid,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    it('sees session.json changes made by anyone, including other processes', () => {
      sessionManager.createSessionDirectory('cached');
      sessionManager.saveSessionInfo('cached', info('cached', 'First', process.pid));
      expect(sessionManager.listSessions().find((s) => s.id === 'cached')?.name).toBe('First');

      sessionManager.saveSessionInfo('cached', info('cached', 'Second', process.pid));
      expect(sessionManager.listSessions().find((s) => s.id === 'cached')?.name).toBe('Second');

      // An external writer (ut fwd) rewriting the file in place
      const file = path.join(testDir, 'cached', 'session.json');
      const external = info('cached', 'Third, longer name', process.pid);
      fs.writeFileSync(file, JSON.stringify(external));
      expect(sessionManager.listSessions().find((s) => s.id === 'cached')?.name).toBe(
        'Third, longer name'
      );

      fs.rmSync(path.join(testDir, 'cached'), RM_TEST_DIR);
      expect(sessionManager.listSessions().find((s) => s.id === 'cached')).toBeUndefined();
    });

    it('reports sessions whose process died exactly once', () => {
      sessionManager.createSessionDirectory('dead');
      sessionManager.saveSessionInfo('dead', info('dead', 'Dead', 99999));

      expect(sessionManager.listSessionsAndZombies().zombies).toEqual(['dead']);
      const again = sessionManager.listSessionsAndZombies();
      expect(again.zombies).toEqual([]);
      expect(again.sessions.find((s) => s.id === 'dead')?.status).toBe('exited');
    });
  });

  describe('Zombie Detection', () => {
    it('should identify zombie sessions', () => {
      // Create sessions with different PIDs
      const runningPid = process.pid; // Current process PID (exists)
      const zombiePid = 99999; // Non-existent PID

      sessionManager.createSessionDirectory('running');
      sessionManager.saveSessionInfo('running', {
        id: 'running',
        command: ['node'],
        name: 'Running',
        workingDir: testDir,
        pid: runningPid,
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      sessionManager.createSessionDirectory('zombie');
      sessionManager.saveSessionInfo('zombie', {
        id: 'zombie',
        command: ['ghost'],
        name: 'Zombie',
        workingDir: testDir,
        pid: zombiePid,
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      sessionManager.createSessionDirectory('exited');
      sessionManager.saveSessionInfo('exited', {
        id: 'exited',
        command: ['done'],
        name: 'Exited',
        workingDir: testDir,
        pid: 12345,
        status: 'exited',
        exitCode: 0,
        startedAt: new Date().toISOString(),
      });

      // Update zombie sessions
      sessionManager.updateZombieSessions();

      // Check results
      const sessions = sessionManager.listSessions();

      const runningSession = sessions.find((s) => s.id === 'running');
      expect(runningSession?.status).toBe('running');

      const zombieSession = sessions.find((s) => s.id === 'zombie');
      expect(zombieSession?.status).toBe('exited');
      expect(zombieSession?.exitCode).toBe(1);

      const exitedSession = sessions.find((s) => s.id === 'exited');
      expect(exitedSession?.status).toBe('exited');
      expect(exitedSession?.exitCode).toBe(0);
    });

    it('should handle sessions without PID', () => {
      sessionManager.createSessionDirectory('no-pid');
      sessionManager.saveSessionInfo('no-pid', {
        id: 'no-pid',
        command: ['test'],
        name: 'No PID',
        workingDir: testDir,
        status: 'running',
        startedAt: new Date().toISOString(),
      }); // Intentionally missing pid

      sessionManager.updateZombieSessions();

      const sessions = sessionManager.listSessions();
      const session = sessions.find((s) => s.id === 'no-pid');
      expect(session?.status).toBe('running'); // Should not be marked as zombie
    });
  });

  describe('Session Cleanup', () => {
    it('should cleanup session directory', () => {
      const sessionId = 'to-delete';
      sessionManager.createSessionDirectory(sessionId);
      sessionManager.saveSessionInfo(sessionId, {
        id: sessionId,
        command: ['rm', '-rf'],
        name: 'Clean Me',
        workingDir: testDir,
        pid: 12345,
        status: 'exited',
        exitCode: 0,
        startedAt: new Date().toISOString(),
      });

      const sessionDir = path.join(testDir, sessionId);
      expect(fs.existsSync(sessionDir)).toBe(true);

      sessionManager.cleanupSession(sessionId);

      expect(fs.existsSync(sessionDir)).toBe(false);
    });

    it('never removes anything outside a session directory', () => {
      // DELETE /api/sessions/%2E%2E/cleanup decodes to "..": it removed the control dir's parent.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-cleanup-'));
      const control = path.join(root, 'control');
      fs.mkdirSync(path.join(control, 'uploads'), { recursive: true });
      fs.writeFileSync(path.join(control, 'uploads', 'photo.png'), 'x');
      fs.writeFileSync(path.join(root, 'config.json'), '{}');
      const manager = new SessionManager(control);
      try {
        expect(() => manager.cleanupSession('..')).toThrow(/Invalid session ID/);
        expect(fs.existsSync(path.join(root, 'config.json'))).toBe(true);
        manager.cleanupSession('uploads');
        expect(fs.existsSync(path.join(control, 'uploads', 'photo.png'))).toBe(true);
      } finally {
        fs.rmSync(root, RM_TEST_DIR);
      }
    });

    it('skips a directory with an invalid session id instead of aborting the batch', () => {
      for (const id of ['a.b', 'good1']) {
        fs.mkdirSync(path.join(testDir, id));
        fs.writeFileSync(
          path.join(testDir, id, 'session.json'),
          JSON.stringify({ id, name: id, command: ['true'], workingDir: testDir, status: 'exited' })
        );
      }

      expect(sessionManager.cleanupExitedSessions()).toEqual(['good1']);
      expect(fs.existsSync(path.join(testDir, 'good1'))).toBe(false);
      expect(fs.existsSync(path.join(testDir, 'a.b'))).toBe(true);
    });

    it('should handle non-existent session cleanup gracefully', () => {
      // Should not throw
      expect(() => sessionManager.cleanupSession('nonexistent')).not.toThrow();
    });
  });

  describe('Control Files', () => {
    it('should create control files via createSessionDirectory', () => {
      const sessionId = 'control-test';

      const paths = sessionManager.createSessionDirectory(sessionId);

      expect(fs.existsSync(paths.controlDir)).toBe(true);
      // 2026-11-10: a `stdin` FIFO was made here (a synchronous mkfifo per session) and by the
      // forwarder; nothing ever read or wrote it. Input goes through ipc.sock.
      expect(fs.readdirSync(paths.controlDir)).toEqual([]);
      // stdout and control files are created by the PTY process, not by createSessionDirectory
    });

    it('should check if session exists', () => {
      const sessionId = 'exists-test';

      // Session doesn't exist yet
      expect(sessionManager.sessionExists(sessionId)).toBe(false);

      // Create session
      sessionManager.createSessionDirectory(sessionId);
      sessionManager.saveSessionInfo(sessionId, {
        id: sessionId,
        command: ['test'],
        name: 'Test',
        workingDir: testDir,
        pid: 12345,
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      // Now it exists
      expect(sessionManager.sessionExists(sessionId)).toBe(true);
    });
  });
});
