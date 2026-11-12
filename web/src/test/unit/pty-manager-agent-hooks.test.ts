import * as fs from 'fs';
import * as pty from 'node-pty';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyManager } from '../../server/pty/pty-manager';
import { withClaudeHooks } from '../../server/services/claude-hooks';
import { RM_TEST_DIR } from '../helpers/rm-test-dir.js';

// 2026-11-01: the Claude sessions Untether starts get its hooks (claude-hooks.ts) on the
// command it spawns, never on the command the session keeps (a resume reads that one and is
// rewritten again, so the flag is never doubled), and the session says it got them.
describe('PtyManager spawn rewrite (Claude hooks)', () => {
  let dir: string;
  let manager: PtyManager;
  let fakeClaude: string;
  const settings = '/u/.untether/agent-hooks/claude-settings.json';

  beforeAll(async () => {
    await PtyManager.initialize();
  });

  beforeEach(() => {
    dir = fs.mkdtempSync('/tmp/vth.');
    manager = new PtyManager(path.join(dir, 'control'));
    // A program named claude (node-pty is the test setup's fake: what it is asked to spawn).
    fakeClaude = path.join(dir, 'claude');
    fs.writeFileSync(fakeClaude, '', { mode: 0o755 });
    vi.mocked(pty.spawn).mockClear();
    manager.setSpawnRewriter((command) => withClaudeHooks(command, settings));
  });

  afterEach(async () => {
    await manager.shutdown();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  /** The words the session's program was spawned with. */
  const spawned = () => {
    const [file, args] = vi.mocked(pty.spawn).mock.calls.at(-1) ?? [];
    return [file, ...((args as string[]) ?? [])];
  };

  it('a Claude is spawned with them; its session keeps its own command and says it got them', async () => {
    const { sessionId, sessionInfo } = await manager.createSession(
      [fakeClaude, '--model', 'opus'],
      {
        sessionId: 'test-hooks-1',
        workingDir: dir,
      }
    );
    const info = manager.getSessionManager().loadSessionInfo(sessionId);
    expect(spawned()).toEqual([fakeClaude, '--settings', settings, '--model', 'opus']);
    expect(sessionInfo.command).toEqual([fakeClaude, '--model', 'opus']);
    expect(info?.command).toEqual([fakeClaude, '--model', 'opus']);
    expect(info?.agentHooks).toBe(true);
    await manager.killSession(sessionId);
  });

  // 2026-11-02: splitting pty-manager.ts into pty/pty-manager/ moved createSession one folder
  // deeper; its __dirname-relative default directory then pointed at src/server, not src.
  it('a session without a working directory starts in web/src, wherever createSession lives', async () => {
    const { sessionId } = await manager.createSession(['/bin/echo', 'where'], {
      sessionId: 'test-hooks-cwd',
    });
    const options = vi.mocked(pty.spawn).mock.calls.at(-1)?.[2] as { cwd?: string };
    expect(options.cwd).toBe(path.resolve(__dirname, '..', '..'));
    await manager.killSession(sessionId);
  });

  it('any other program is spawned as it is', async () => {
    const { sessionId } = await manager.createSession(['/bin/echo', 'plain'], {
      sessionId: 'test-hooks-2',
      workingDir: dir,
    });
    const info = manager.getSessionManager().loadSessionInfo(sessionId);
    expect(spawned()).toEqual(['/bin/echo', 'plain']);
    expect(info?.agentHooks).toBeUndefined();
    await manager.killSession(sessionId);
  });
});
