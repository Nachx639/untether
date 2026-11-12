import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PtyManager } from '../../server/pty/pty-manager.js';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

describe('cleaning up a running session', () => {
  let ptyManager: PtyManager;
  let controlPath: string;

  beforeEach(async () => {
    await PtyManager.initialize();
    controlPath = path.join(os.tmpdir(), `ut-${Math.random().toString(36).substring(2, 8)}`);
    await fs.mkdir(controlPath, { recursive: true });
    ptyManager = new PtyManager(controlPath);
  });

  afterEach(async () => {
    await fs.rm(controlPath, RM_TEST_DIR);
  });

  it('still finishes the exit (event, in-memory state) once its files are gone', async () => {
    const sessionId = `c-${Math.random().toString(36).substring(2, 8)}`;
    await ptyManager.createSession(['sleep', '30'], {
      sessionId,
      name: 'cleanup-running',
      workingDir: process.cwd(),
    });
    const exited = new Promise<string>((resolve) => {
      ptyManager.on('sessionExited', (id: string) => {
        if (id === sessionId) resolve(id);
      });
    });

    // DELETE /api/sessions/:id/cleanup: kill (async) and remove the files right away.
    ptyManager.cleanupSession(sessionId);

    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]);
    expect(result).toBe(sessionId);
    expect(ptyManager.getInternalSession(sessionId)).toBeUndefined();
    expect(ptyManager.listSessions().some((session) => session.id === sessionId)).toBe(false);
  });
});
