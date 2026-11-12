import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PtyManager } from '../../server/pty/pty-manager.js';

// Hoist mock declarations
const { mockExecFileAsync, mockExecFileSync } = vi.hoisted(() => {
  return {
    mockExecFileAsync: vi.fn(),
    mockExecFileSync: vi.fn(),
  };
});

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
}));

// Mock util.promisify to return our mock
vi.mock('util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('util')>()),
  promisify: vi.fn(() => mockExecFileAsync),
}));

// Import after mocks are set up
import { TMUX_FIELD_SEPARATOR, TmuxManager } from '../../server/services/tmux-manager.js';

// Mock PtyManager
const mockPtyManager = {
  createSession: vi.fn(),
} as unknown as PtyManager;

/** tmux's list output as these tests write it, "|" standing for the field separator. */
const tmuxOutput = (text: string) => text.replaceAll('|', TMUX_FIELD_SEPARATOR);

describe('TmuxManager', () => {
  let tmuxManager: TmuxManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton instance
    (TmuxManager as unknown as { instance?: TmuxManager }).instance = undefined;
    tmuxManager = TmuxManager.getInstance(mockPtyManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isAvailable', () => {
    it('should return true when tmux is installed', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '/usr/local/bin/tmux', stderr: '' });

      const result = await tmuxManager.isAvailable();
      expect(result).toBe(true);
      expect(mockExecFileAsync).toHaveBeenCalledWith('which', ['tmux']);
    });

    it('should return false when tmux is not installed', async () => {
      mockExecFileAsync.mockRejectedValue(new Error('tmux not found'));

      const result = await tmuxManager.isAvailable();
      expect(result).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('should parse tmux sessions correctly', async () => {
      const mockOutput = `main|1|Thu Jul 25 10:00:00 2024|attached||
dev|2|Thu Jul 25 11:00:00 2024|detached||
test|1|Thu Jul 25 12:00:00 2024|detached||`;

      mockExecFileAsync.mockResolvedValue({ stdout: tmuxOutput(mockOutput), stderr: '' });

      const sessions = await tmuxManager.listSessions();

      expect(sessions).toHaveLength(3);
      expect(sessions[0]).toEqual({
        name: 'main',
        windows: 1,
        created: 'Thu Jul 25 10:00:00 2024',
        attached: true,
        activity: '',
        current: false,
      });
      expect(sessions[1]).toEqual({
        name: 'dev',
        windows: 2,
        created: 'Thu Jul 25 11:00:00 2024',
        attached: false,
        activity: '',
        current: false,
      });
    });

    it("reads the pane's title, program and folder", async () => {
      const os = await import('os');
      const mockOutput = [
        tmuxOutput('0|1|1790000000|detached|1790000100||2.1.283|/Users/me/demo-app|') +
          '✳ Coin | simulator',
        tmuxOutput(`1|1|1790000000|detached|1790000100||zsh|/Users/me|${os.hostname()}`),
        // Made before macOS renamed the Mac (a name taken on the network): the old name.
        tmuxOutput('2|1|1790000000|detached|1790000100||zsh|/Users/me|My-Mac-0000-old.local'),
      ].join('\n');
      mockExecFileAsync.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const [claude, shell, olderShell] = await tmuxManager.listSessions();

      // Claude Code's versioned binary shows as claude, its status glyph dropped.
      expect(claude).toMatchObject({
        title: 'Coin | simulator',
        command: 'claude',
        path: '/Users/me/demo-app',
      });
      // tmux's default title is the host name: no title.
      expect(shell.title).toBeUndefined();
      expect(shell).toMatchObject({ command: 'zsh', path: '/Users/me' });
      // Also the name the Mac had when the pane was made.
      expect(olderShell.title).toBeUndefined();
    });

    it('should handle shell output pollution', async () => {
      const mockOutput = `stty: stdin isn't a terminal
main|1|Thu Jul 25 10:00:00 2024|attached||
/Users/test/.profile: line 10: command not found
dev|2|Thu Jul 25 11:00:00 2024|detached||`;

      mockExecFileAsync.mockResolvedValue({ stdout: tmuxOutput(mockOutput), stderr: '' });

      const sessions = await tmuxManager.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0].name).toBe('main');
      expect(sessions[1].name).toBe('dev');
    });

    it('should return empty array when no sessions exist', async () => {
      const error = new Error('no server running on /tmp/tmux-501/default');
      mockExecFileAsync.mockRejectedValue(error);

      const sessions = await tmuxManager.listSessions();
      expect(sessions).toEqual([]);
    });

    it('returns an empty list when the socket is gone or stale (tmux on macOS)', async () => {
      for (const reason of ['No such file or directory', 'Connection refused']) {
        const stderr = `error connecting to /private/tmp/tmux-501/default (${reason})\n`;
        const error = Object.assign(new Error(`Command failed: tmux list-sessions\n${stderr}`), {
          code: 1,
          stderr,
        });
        mockExecFileAsync.mockRejectedValue(error);
        expect(await tmuxManager.listSessions()).toEqual([]);
      }
    });

    it('still reports other failures', async () => {
      mockExecFileAsync.mockRejectedValue(new Error('tmux: invalid option -- F'));
      await expect(tmuxManager.listSessions()).rejects.toThrow('invalid option');
    });
  });

  describe('listWindows', () => {
    it('should parse tmux windows correctly', async () => {
      const mockOutput = `main|0|vim|active|1
main|1|shell||1
main|2|logs||2`;

      mockExecFileAsync.mockResolvedValue({ stdout: tmuxOutput(mockOutput), stderr: '' });

      const windows = await tmuxManager.listWindows('main');

      expect(windows).toHaveLength(3);
      expect(windows[0]).toEqual({
        session: 'main',
        index: 0,
        name: 'vim',
        active: true,
        panes: 1,
      });
      expect(windows[2]).toEqual({
        session: 'main',
        index: 2,
        name: 'logs',
        active: false,
        panes: 2,
      });
    });
  });

  describe('listPanes', () => {
    it('keeps a "|" in a pane title or a folder inside its field', async () => {
      // With "|" between fields, such a title shifted the pid, program and size after it.
      mockExecFileAsync.mockResolvedValue({
        stdout: [
          'main',
          '0',
          '0',
          'active',
          'build | watch',
          '1234',
          'node',
          '80',
          '24',
          '/Users/me/a|b',
        ].join(TMUX_FIELD_SEPARATOR),
        stderr: '',
      });
      const [pane] = await tmuxManager.listPanes('main');
      expect(pane).toMatchObject({
        title: 'build | watch',
        pid: 1234,
        command: 'node',
        width: 80,
        height: 24,
        currentPath: '/Users/me/a|b',
      });

      mockExecFileAsync.mockResolvedValue({
        stdout: [
          'dev',
          '1',
          '1790000000',
          'detached',
          '1790000100',
          '',
          'zsh',
          '/Users/me/a|b',
          'notes',
        ].join(TMUX_FIELD_SEPARATOR),
        stderr: '',
      });
      const [session] = await tmuxManager.listSessions();
      expect(session).toMatchObject({ name: 'dev', path: '/Users/me/a|b', title: 'notes' });
    });

    it('should parse tmux panes correctly', async () => {
      const mockOutput = `main|0|0|active|vim|1234|vim|80|24|/Users/test/project
main|0|1||zsh|5678|npm|80|24|/Users/test/project
main|1|0|active|zsh|9012|ls|80|24|/Users/test`;

      mockExecFileAsync.mockResolvedValue({ stdout: tmuxOutput(mockOutput), stderr: '' });

      const panes = await tmuxManager.listPanes('main');

      expect(panes).toHaveLength(3);
      expect(panes[0]).toEqual({
        session: 'main',
        window: 0,
        index: 0,
        active: true,
        title: 'vim',
        pid: 1234,
        command: 'vim',
        width: 80,
        height: 24,
        currentPath: '/Users/test/project',
      });
      expect(panes[1]).toEqual({
        session: 'main',
        window: 0,
        index: 1,
        active: false,
        title: 'zsh',
        pid: 5678,
        command: 'npm',
        width: 80,
        height: 24,
        currentPath: '/Users/test/project',
      });
    });

    it('should handle panes for specific window', async () => {
      const mockOutput = `main|1|0|active|zsh|1234|ls|80|24|/Users/test
main|1|1||vim|5678|vim|80|24|/Users/test/docs`;

      mockExecFileAsync.mockResolvedValue({ stdout: tmuxOutput(mockOutput), stderr: '' });

      const panes = await tmuxManager.listPanes('main', 1);

      expect(panes).toHaveLength(2);
      expect(panes[0].window).toBe(1);
      expect(panes[1].window).toBe(1);
    });
  });

  describe('createSession', () => {
    it('should create a new tmux session', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

      await tmuxManager.createSession('new-session');

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'tmux',
        ['new-session', '-d', '-s', 'new-session'],
        expect.anything()
      );
    });

    it('should create a session with initial command', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

      await tmuxManager.createSession('dev-session', ['npm', 'run', 'dev']);

      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'tmux',
        ['new-session', '-d', '-s', 'dev-session', 'npm', 'run', 'dev'],
        expect.anything()
      );
    });

    it('starts tmux with a session environment, without the server secrets', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      vi.stubEnv('UNTETHER_PASSWORD', 'hunter2');
      vi.stubEnv('JWT_SECRET', 'f00d');
      vi.stubEnv('CLAUDECODE', '1');
      try {
        await tmuxManager.createSession('dev-session');
      } finally {
        vi.unstubAllEnvs();
      }

      const options = mockExecFileAsync.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
      expect(options?.env).toBeDefined();
      expect(options.env?.PATH).toBe(process.env.PATH);
      expect(options.env).not.toHaveProperty('UNTETHER_PASSWORD');
      expect(options.env).not.toHaveProperty('JWT_SECRET');
      expect(options.env).not.toHaveProperty('CLAUDECODE');
    });
  });

  describe('killSession', () => {
    it('should kill a tmux session', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

      await tmuxManager.killSession('old-session');

      expect(mockExecFileAsync).toHaveBeenCalledWith('tmux', ['kill-session', '-t', 'old-session']);
    });
  });

  describe('attachToTmux', () => {
    it('should create a PTY session for tmux attach', async () => {
      const mockSession = { sessionId: 'ut-123' };
      vi.mocked(mockPtyManager.createSession).mockResolvedValue(mockSession as never);

      const sessionId = await tmuxManager.attachToTmux('main');

      expect(sessionId).toBe('ut-123');
      expect(mockPtyManager.createSession).toHaveBeenCalledWith(
        ['tmux', 'attach-session', '-t', 'main'],
        expect.objectContaining({
          name: 'tmux: main',
          workingDir: expect.any(String),
          cols: 80,
          rows: 24,
        })
      );
    });

    it('should attach to specific window', async () => {
      const mockSession = { sessionId: 'ut-456' };
      vi.mocked(mockPtyManager.createSession).mockResolvedValue(mockSession as never);

      const sessionId = await tmuxManager.attachToTmux('main', 2);

      expect(sessionId).toBe('ut-456');
      expect(mockPtyManager.createSession).toHaveBeenCalledWith(
        ['tmux', 'attach-session', '-t', 'main:2'],
        expect.any(Object)
      );
    });

    it('should attach to specific pane', async () => {
      const mockSession = { sessionId: 'ut-789' };
      vi.mocked(mockPtyManager.createSession).mockResolvedValue(mockSession as never);

      const sessionId = await tmuxManager.attachToTmux('main', 1, 2);

      expect(sessionId).toBe('ut-789');
      expect(mockPtyManager.createSession).toHaveBeenCalledWith(
        ['tmux', 'attach-session', '-t', 'main:1'],
        expect.any(Object)
      );
    });
  });

  describe('isInsideTmux', () => {
    it('should return true when inside tmux', () => {
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
      expect(tmuxManager.isInsideTmux()).toBe(true);
    });

    it('should return false when not inside tmux', () => {
      delete process.env.TMUX;
      expect(tmuxManager.isInsideTmux()).toBe(false);
    });
  });

  describe('getCurrentSession', () => {
    it('should return current session name when inside tmux', () => {
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
      process.env.TMUX_PANE = '%0';

      mockExecFileSync.mockReturnValue('main\n');

      const session = tmuxManager.getCurrentSession();
      expect(session).toBe('main');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['display-message', '-p', '#{session_name}'],
        expect.any(Object)
      );
    });

    it('should return null when not inside tmux', () => {
      delete process.env.TMUX;
      const session = tmuxManager.getCurrentSession();
      expect(session).toBeNull();
    });
  });
});
