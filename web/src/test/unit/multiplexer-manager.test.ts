import { afterEach, beforeEach, describe, expect, it, type Mocked, vi } from 'vitest';
import type { PtyManager } from '../../server/pty/pty-manager.js';
import type { SessionCreationResult } from '../../server/pty/types.js';
import { MultiplexerManager } from '../../server/services/multiplexer-manager.js';
import { ScreenManager } from '../../server/services/screen-manager.js';
import { TmuxManager } from '../../server/services/tmux-manager.js';
import { ZellijManager } from '../../server/services/zellij-manager.js';
import type { MultiplexerType, TmuxPane, TmuxWindow } from '../../shared/multiplexer-types.js';
import { TitleMode } from '../../shared/types.js';

// Mock the managers
vi.mock('../../server/services/tmux-manager.js');
vi.mock('../../server/services/zellij-manager.js');
vi.mock('../../server/services/screen-manager.js');

// Mock PtyManager: MultiplexerManager only reads the new session's id
type CreateSessionFake = (
  ...args: Parameters<PtyManager['createSession']>
) => Promise<Pick<SessionCreationResult, 'sessionId'>>;
const mockCreateSession = vi.fn<CreateSessionFake>();
const mockPtyManager = {
  createSession: mockCreateSession,
} as unknown as PtyManager;

// The methods MultiplexerManager calls on each multiplexer
type TmuxFake = Mocked<
  Pick<
    TmuxManager,
    | 'isAvailable'
    | 'listSessions'
    | 'listWindows'
    | 'listPanes'
    | 'createSession'
    | 'attachToTmux'
    | 'killSession'
    | 'isInsideTmux'
    | 'getCurrentSession'
  >
>;
type ZellijFake = Mocked<
  Pick<
    ZellijManager,
    | 'isAvailable'
    | 'listSessions'
    | 'createSession'
    | 'attachToZellij'
    | 'killSession'
    | 'isInsideZellij'
    | 'getCurrentSession'
  >
>;
type ScreenFake = Mocked<
  Pick<
    ScreenManager,
    | 'isAvailable'
    | 'listSessions'
    | 'createSession'
    | 'attachToSession'
    | 'killSession'
    | 'isInsideScreen'
    | 'getCurrentSession'
  >
>;

describe('MultiplexerManager', () => {
  let multiplexerManager: MultiplexerManager;
  let mockTmuxManager: TmuxFake;
  let mockZellijManager: ZellijFake;
  let mockScreenManager: ScreenFake;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset singleton instance
    (MultiplexerManager as unknown as { instance?: MultiplexerManager }).instance = undefined;

    // Setup mock instances
    mockTmuxManager = {
      isAvailable: vi.fn(),
      listSessions: vi.fn(),
      listWindows: vi.fn(),
      listPanes: vi.fn(),
      createSession: vi.fn(),
      attachToTmux: vi.fn(),
      killSession: vi.fn(),
      isInsideTmux: vi.fn(),
      getCurrentSession: vi.fn(),
    };

    mockZellijManager = {
      isAvailable: vi.fn(),
      listSessions: vi.fn(),
      createSession: vi.fn(),
      attachToZellij: vi.fn(),
      killSession: vi.fn(),
      isInsideZellij: vi.fn(),
      getCurrentSession: vi.fn(),
    };

    mockScreenManager = {
      isAvailable: vi.fn(),
      listSessions: vi.fn(),
      createSession: vi.fn(),
      attachToSession: vi.fn(),
      killSession: vi.fn(),
      isInsideScreen: vi.fn(),
      getCurrentSession: vi.fn(),
    };

    // Mock getInstance methods (the fakes cover only the methods used)
    vi.mocked(TmuxManager.getInstance).mockReturnValue(mockTmuxManager as unknown as TmuxManager);
    vi.mocked(ZellijManager.getInstance).mockReturnValue(
      mockZellijManager as unknown as ZellijManager
    );
    vi.mocked(ScreenManager.getInstance).mockReturnValue(
      mockScreenManager as unknown as ScreenManager
    );

    multiplexerManager = MultiplexerManager.getInstance(mockPtyManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getAvailableMultiplexers', () => {
    it('should return status for all multiplexers', async () => {
      mockTmuxManager.isAvailable.mockResolvedValue(true);
      mockZellijManager.isAvailable.mockResolvedValue(false);
      mockScreenManager.isAvailable.mockResolvedValue(false);
      mockTmuxManager.listSessions.mockResolvedValue([
        { name: 'main', windows: 2, created: '1h ago', attached: true },
        { name: 'dev', windows: 1, created: '2h ago', attached: false },
      ]);

      const result = await multiplexerManager.getAvailableMultiplexers();

      expect(result).toEqual({
        tmux: {
          available: true,
          type: 'tmux',
          sessions: [
            { name: 'main', windows: 2, created: '1h ago', attached: true, type: 'tmux' },
            { name: 'dev', windows: 1, created: '2h ago', attached: false, type: 'tmux' },
          ],
        },
        zellij: {
          available: false,
          type: 'zellij',
          sessions: [],
        },
        screen: {
          available: false,
          type: 'screen',
          sessions: [],
        },
      });
    });

    it('should handle errors when listing sessions', async () => {
      mockTmuxManager.isAvailable.mockResolvedValue(true);
      mockZellijManager.isAvailable.mockResolvedValue(true);
      mockScreenManager.isAvailable.mockResolvedValue(false);
      mockTmuxManager.listSessions.mockRejectedValue(new Error('tmux error'));
      mockZellijManager.listSessions.mockResolvedValue([
        { name: 'main', created: '1h ago', exited: false },
      ]);

      const result = await multiplexerManager.getAvailableMultiplexers();

      expect(result.tmux.sessions).toEqual([]);
      expect(result.zellij.sessions).toEqual([
        { name: 'main', created: '1h ago', exited: false, type: 'zellij' },
      ]);
      expect(result.screen.sessions).toEqual([]);
    });
  });

  describe('getTmuxWindows', () => {
    it('should return windows for tmux session', async () => {
      const mockWindows: TmuxWindow[] = [
        { session: 'main', index: 0, name: 'vim', panes: 1, active: true },
        { session: 'main', index: 1, name: 'shell', panes: 2, active: false },
      ];
      mockTmuxManager.listWindows.mockResolvedValue(mockWindows);

      const windows = await multiplexerManager.getTmuxWindows('main');

      expect(windows).toEqual(mockWindows);
      expect(mockTmuxManager.listWindows).toHaveBeenCalledWith('main');
    });
  });

  describe('getTmuxPanes', () => {
    it('should return panes for tmux session', async () => {
      const mockPanes: TmuxPane[] = [
        { session: 'main', window: 0, index: 0, active: true, width: 80, height: 24 },
        { session: 'main', window: 0, index: 1, active: false, width: 80, height: 24 },
      ];
      mockTmuxManager.listPanes.mockResolvedValue(mockPanes);

      const panes = await multiplexerManager.getTmuxPanes('main');

      expect(panes).toEqual(mockPanes);
      expect(mockTmuxManager.listPanes).toHaveBeenCalledWith('main', undefined);
    });

    it('should return panes for specific window', async () => {
      const mockPanes: TmuxPane[] = [
        { session: 'main', window: 1, index: 0, active: true, width: 80, height: 24 },
      ];
      mockTmuxManager.listPanes.mockResolvedValue(mockPanes);

      const panes = await multiplexerManager.getTmuxPanes('main', 1);

      expect(panes).toEqual(mockPanes);
      expect(mockTmuxManager.listPanes).toHaveBeenCalledWith('main', 1);
    });
  });

  describe('createSession', () => {
    it('should create tmux session', async () => {
      await multiplexerManager.createSession('tmux', 'new-session', { command: ['vim'] });

      expect(mockTmuxManager.createSession).toHaveBeenCalledWith('new-session', ['vim']);
      expect(mockZellijManager.createSession).not.toHaveBeenCalled();
    });

    it('should create zellij session', async () => {
      await multiplexerManager.createSession('zellij', 'new-session', { layout: 'compact' });

      expect(mockZellijManager.createSession).toHaveBeenCalledWith('new-session', 'compact');
      expect(mockTmuxManager.createSession).not.toHaveBeenCalled();
    });

    it('should create screen session', async () => {
      await multiplexerManager.createSession('screen', 'new-session');

      expect(mockScreenManager.createSession).toHaveBeenCalledWith('new-session', undefined);
      expect(mockTmuxManager.createSession).not.toHaveBeenCalled();
      expect(mockZellijManager.createSession).not.toHaveBeenCalled();
    });

    it('should throw error for unknown multiplexer type', async () => {
      await expect(
        multiplexerManager.createSession('unknown' as unknown as MultiplexerType, 'new-session')
      ).rejects.toThrow('Unknown multiplexer type: unknown');
    });
  });

  describe('attachToSession', () => {
    it('should attach to tmux session', async () => {
      mockTmuxManager.attachToTmux.mockResolvedValue('ut-123');

      const sessionId = await multiplexerManager.attachToSession('tmux', 'main');

      expect(sessionId).toBe('ut-123');
      expect(mockTmuxManager.attachToTmux).toHaveBeenCalledWith(
        'main',
        undefined,
        undefined,
        undefined
      );
    });

    it('should attach to tmux window and pane', async () => {
      mockTmuxManager.attachToTmux.mockResolvedValue('ut-456');

      const sessionId = await multiplexerManager.attachToSession('tmux', 'main', {
        windowIndex: 1,
        paneIndex: 2,
      });

      expect(sessionId).toBe('ut-456');
      expect(mockTmuxManager.attachToTmux).toHaveBeenCalledWith('main', 1, 2, {
        windowIndex: 1,
        paneIndex: 2,
      });
    });

    it('should attach to zellij session', async () => {
      mockZellijManager.attachToZellij.mockResolvedValue('ut-789');

      const sessionId = await multiplexerManager.attachToSession('zellij', 'main');

      expect(sessionId).toBe('ut-789');
      expect(mockZellijManager.attachToZellij).toHaveBeenCalledWith('main', undefined);
    });

    it('should attach to screen session', async () => {
      mockScreenManager.attachToSession.mockResolvedValue(['screen', '-r', 'main']);
      mockCreateSession.mockResolvedValue({ sessionId: 'ut-999' });

      const sessionId = await multiplexerManager.attachToSession('screen', 'main');

      expect(sessionId).toBe('ut-999');
      expect(mockScreenManager.attachToSession).toHaveBeenCalledWith('main');
      expect(mockPtyManager.createSession).toHaveBeenCalledWith(
        ['screen', '-r', 'main'],
        expect.objectContaining({ titleMode: TitleMode.STATIC })
      );
    });

    it('should throw error for unknown multiplexer type', async () => {
      await expect(
        multiplexerManager.attachToSession('unknown' as unknown as MultiplexerType, 'main')
      ).rejects.toThrow('Unknown multiplexer type: unknown');
    });
  });

  describe('killSession', () => {
    it('should kill tmux session', async () => {
      await multiplexerManager.killSession('tmux', 'old-session');

      expect(mockTmuxManager.killSession).toHaveBeenCalledWith('old-session');
      expect(mockZellijManager.killSession).not.toHaveBeenCalled();
    });

    it('should kill zellij session', async () => {
      await multiplexerManager.killSession('zellij', 'old-session');

      expect(mockZellijManager.killSession).toHaveBeenCalledWith('old-session');
      expect(mockTmuxManager.killSession).not.toHaveBeenCalled();
    });

    it('should kill screen session', async () => {
      await multiplexerManager.killSession('screen', 'old-session');

      expect(mockScreenManager.killSession).toHaveBeenCalledWith('old-session');
      expect(mockTmuxManager.killSession).not.toHaveBeenCalled();
      expect(mockZellijManager.killSession).not.toHaveBeenCalled();
    });

    it('should throw error for unknown multiplexer type', async () => {
      await expect(
        multiplexerManager.killSession('unknown' as unknown as MultiplexerType, 'old-session')
      ).rejects.toThrow('Unknown multiplexer type: unknown');
    });
  });

  describe('getCurrentMultiplexer', () => {
    it('should return tmux when inside tmux', () => {
      mockTmuxManager.isInsideTmux.mockReturnValue(true);
      mockTmuxManager.getCurrentSession.mockReturnValue('main');
      mockZellijManager.isInsideZellij.mockReturnValue(false);

      const result = multiplexerManager.getCurrentMultiplexer();

      expect(result).toEqual({ type: 'tmux', session: 'main' });
    });

    it('should return zellij when inside zellij', () => {
      mockTmuxManager.isInsideTmux.mockReturnValue(false);
      mockZellijManager.isInsideZellij.mockReturnValue(true);
      mockZellijManager.getCurrentSession.mockReturnValue('dev');
      mockScreenManager.isInsideScreen.mockReturnValue(false);

      const result = multiplexerManager.getCurrentMultiplexer();

      expect(result).toEqual({ type: 'zellij', session: 'dev' });
    });

    it('should return screen when inside screen', () => {
      mockTmuxManager.isInsideTmux.mockReturnValue(false);
      mockZellijManager.isInsideZellij.mockReturnValue(false);
      mockScreenManager.isInsideScreen.mockReturnValue(true);
      mockScreenManager.getCurrentSession.mockReturnValue('myscreen');

      const result = multiplexerManager.getCurrentMultiplexer();

      expect(result).toEqual({ type: 'screen', session: 'myscreen' });
    });

    it('should return null when not inside any multiplexer', () => {
      mockTmuxManager.isInsideTmux.mockReturnValue(false);
      mockZellijManager.isInsideZellij.mockReturnValue(false);
      mockScreenManager.isInsideScreen.mockReturnValue(false);

      const result = multiplexerManager.getCurrentMultiplexer();

      expect(result).toBeNull();
    });

    it('should return null when inside tmux but no session', () => {
      mockTmuxManager.isInsideTmux.mockReturnValue(true);
      mockTmuxManager.getCurrentSession.mockReturnValue(null);

      const result = multiplexerManager.getCurrentMultiplexer();

      expect(result).toBeNull();
    });
  });
});
