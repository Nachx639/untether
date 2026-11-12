import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseScreenChoices } from '../../shared/claude-screen';
import { readClaudeStatuses } from '../services/claude-chat';
import type { SessionAccess } from '../services/copilot/session-access';
import { createSessionRoutes } from './sessions';

vi.mock('../websocket/control-unix-handler', () => ({
  controlUnixHandler: { isMacAppConnected: vi.fn() },
}));
vi.mock('../utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../services/claude-chat', async () => {
  const actual =
    await vi.importActual<typeof import('../services/claude-chat')>('../services/claude-chat');
  return { ...actual, readClaudeStatuses: vi.fn() };
});

const screen = readFileSync(
  path.join(__dirname, '../services/__fixtures__/claude-waiting/permission-bash.txt'),
  'utf8'
);

/** The copilot's access, built by the session routes over a session waiting on a Bash prompt. */
function setup(session: object = {}) {
  vi.mocked(readClaudeStatuses).mockImplementation(
    async () => new Map([[42, { status: 'waiting', waitingFor: 'permission to run Bash' }]])
  );
  // An Enter answers the prompt: it leaves the screen.
  let shown = screen;
  const sendInput = vi.fn((_id: string, input: { key?: string }) => {
    if (input.key === 'enter') shown = '⏺ Done';
  });
  let access: SessionAccess | null = null;
  createSessionRoutes({
    ptyManager: {
      getSession: vi.fn(() => ({ id: 's1', pid: 42, status: 'running', ...session })),
      programRootPid: vi.fn(() => 42),
      listSessions: vi.fn(() => []),
      sendInput,
    } as never,
    terminalManager: {
      getBufferSnapshot: vi.fn(async () => ({
        cells: screen.split('\n').map((line) => [...line].map((char) => ({ char }))),
        cols: 80,
        rows: 24,
      })),
      getRecentText: vi.fn(async () => ({ text: shown, rows: shown.split('\n').length })),
    } as never,
    remoteRegistry: null,
    isHQMode: false,
    exposeSessionAccess: (a) => {
      access = a;
    },
  });
  if (!access) throw new Error('no access exposed');
  return { access: access as SessionAccess, sendInput };
}

describe('the copilot acts through the session routes', () => {
  it('reads the prompt waiting right now', async () => {
    const { access } = setup();
    const r = await access.prompt('s1');
    expect(r.status).toBe(200);
    expect(r.body.waiting).toBe(true);
    expect((r.body.choices as { key?: string }).key).toBe(parseScreenChoices(screen)?.key);
  });

  it('answers only the menu it read, like the phone', async () => {
    const { access, sendInput } = setup();
    const choices = parseScreenChoices(screen);
    const stale = await access.answer('s1', {
      option: 1,
      question: choices?.question ?? '',
      options: choices?.options ?? [],
      key: 'another menu',
    });
    expect(stale).toEqual({ status: 409, body: { error: 'The prompt changed' } });
    expect(sendInput).not.toHaveBeenCalled();
    const ok = await access.answer('s1', {
      option: 1,
      question: choices?.question ?? '',
      options: choices?.options ?? [],
      key: choices?.key,
    });
    expect(ok.status).toBe(200);
    expect(sendInput).toHaveBeenCalled();
  });

  it('refuses a session tmux only lets it watch', async () => {
    const { access } = setup({ multiplexer: { mode: 'watch' } });
    const r = await access.answer('s1', { option: 1, question: 'q', options: [] });
    expect(r).toEqual({ status: 409, body: { error: 'read-only' } });
  });

  it('types into a running session and refuses a missing one', async () => {
    const { access, sendInput } = setup();
    expect((await access.input('s1', { key: 'escape' })).status).toBe(200);
    expect(sendInput).toHaveBeenCalledWith('s1', { key: 'escape' });
    const gone = setup({ status: 'exited' });
    expect((await gone.access.input('s1', { text: 'hola' })).status).toBe(400);
  });
});
