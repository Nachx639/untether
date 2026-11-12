import * as fs from 'fs';
import * as pty from 'node-pty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyManager } from '../../server/pty/pty-manager.js';
import { sameModes } from '../../server/utils/terminal-modes.js';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

// 2026-11-02: Claude Code hides and shows the cursor around every frame; each busy session
// rewrote session.json 4 times a second for a state that ended where it started.
describe('terminal modes in session.json', () => {
  let controlPath: string;
  let manager: PtyManager;
  const ids: string[] = [];

  beforeEach(async () => {
    await PtyManager.initialize();
    controlPath = fs.mkdtempSync('/tmp/vtm.');
    manager = new PtyManager(controlPath);
  });

  afterEach(async () => {
    vi.useRealTimers();
    // SIGKILL: this test is not about killing, and SIGTERM waits 500 ms before it checks the pid.
    for (const id of ids.splice(0)) await manager.killSession(id, 'SIGKILL').catch(() => {});
    fs.rmSync(controlPath, RM_TEST_DIR);
  });

  it('are saved when they change, not on every frame that hides and shows the cursor', async () => {
    const sessionManager = manager.getSessionManager();
    // What each save wrote, as it was then (the saved object is the live session's info).
    const written: Array<Record<string, boolean> | undefined> = [];
    const original = sessionManager.saveSessionInfo.bind(sessionManager);
    vi.spyOn(sessionManager, 'saveSessionInfo').mockImplementation((id, info) => {
      written.push(info.terminalModes ? { ...info.terminalModes } : undefined);
      original(id, info);
    });
    const { sessionId } = await manager.createSession(['sh', '-c', 'frames'], {
      sessionId: 'test-modes-1',
      name: 'modes',
      workingDir: controlPath,
    });
    ids.push(sessionId);
    // node-pty is the test setup's fake: its output is what this test hands to onData.
    const fake = vi.mocked(pty.spawn).mock.results.at(-1)?.value as {
      onData: { mock: { calls: Array<[(data: string) => void]> } };
    };
    const emit = (data: string) => {
      for (const [callback] of fake.onData.mock.calls) callback(data);
    };
    // 2026-11-02: the frames ran on the real clock (~1.9 s); the save is a 250 ms debounce timer,
    // so a fake clock plays the same 1.5 s of frames across the same six debounce windows.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const sleep = (ms: number) => vi.advanceTimersByTimeAsync(ms);
    emit('\x1b[?1000h');
    // ~1.5 s of frames: cursor hidden, drawn, shown again.
    for (let i = 0; i < 50; i++) {
      emit('\x1b[?25l.\x1b[?25h');
      await sleep(30);
    }
    await sleep(400);

    const modeSaves = written.filter((modes) => modes && Object.keys(modes).length > 0);
    // The first look sets mouse reporting and the cursor; the frames after it change nothing.
    expect(modeSaves.length).toBeGreaterThanOrEqual(1);
    expect(modeSaves.length).toBeLessThanOrEqual(2);
    expect(sessionManager.loadSessionInfo(sessionId)?.terminalModes).toEqual({
      '1000': true,
      '25': true,
    });
  }, 30_000);
});

describe('sameModes', () => {
  it('compares the tracked state, whatever the key order', () => {
    expect(sameModes({ '25': true, '1000': true }, { '1000': true, '25': true })).toBe(true);
    expect(sameModes(undefined, {})).toBe(true);
    expect(sameModes({ '25': true }, { '25': false })).toBe(false);
    expect(sameModes({ '25': true }, {})).toBe(false);
    expect(sameModes({}, { '25': true })).toBe(false);
  });
});
