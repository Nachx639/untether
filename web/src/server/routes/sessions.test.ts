import { execFileSync } from 'child_process';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { readClaudeStatuses } from '../services/claude-chat';
import { MacWindowApps } from '../services/mac-sessions/window-apps';
import { tailscaleServeService } from '../services/tailscale-serve-service';
import { claudeConfigDir } from '../utils/claude-dir';
import { detectGitInfo } from '../utils/git-info';
import { controlUnixHandler } from '../websocket/control-unix-handler';
import { createSessionRoutes, requestTerminalSpawn } from './sessions';

// Mock dependencies
vi.mock('../websocket/control-unix-handler', () => ({
  controlUnixHandler: {
    isMacAppConnected: vi.fn(),
  },
}));

vi.mock('../utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../utils/git-info');

vi.mock('../services/claude-chat', async () => {
  const actual =
    await vi.importActual<typeof import('../services/claude-chat')>('../services/claude-chat');
  return { ...actual, readClaudeStatuses: vi.fn(actual.readClaudeStatuses) };
});

// Mock the sessions module but only override requestTerminalSpawn
vi.mock('./sessions', async () => {
  const actual = await vi.importActual('./sessions');
  return {
    ...actual,
    requestTerminalSpawn: vi.fn().mockResolvedValue({ success: false }),
  };
});

describe('sessions routes', () => {
  let mockPtyManager: {
    getSessions: Mock;
    listSessions: Mock;
    createSession: Mock;
    programRootPid: Mock;
  };
  let mockTerminalManager: {
    getTerminal: Mock;
    getRecentText: Mock;
  };

  type SessionRoutesConfig = Parameters<typeof createSessionRoutes>[0];

  /** The routes over the partial fakes above, which stand in for the real managers. */
  function sessionRoutes(
    config: Omit<SessionRoutesConfig, 'ptyManager' | 'terminalManager' | 'remoteRegistry'> & {
      remoteRegistry: object | null;
    }
  ) {
    return createSessionRoutes({
      ...config,
      ptyManager: mockPtyManager as unknown as SessionRoutesConfig['ptyManager'],
      terminalManager: mockTerminalManager as unknown as SessionRoutesConfig['terminalManager'],
      remoteRegistry: config.remoteRegistry as SessionRoutesConfig['remoteRegistry'],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();

    // Set default mock return value for detectGitInfo - mock it to return test values
    vi.mocked(detectGitInfo).mockImplementation(async (dir: string) => {
      // Return different values based on the directory to make tests more predictable
      if (dir.includes('/test/repo')) {
        return {
          gitRepoPath: '/test/repo',
          gitBranch: 'main',
          gitAheadCount: 2,
          gitBehindCount: 1,
          gitHasChanges: true,
          gitIsWorktree: false,
          gitMainRepoPath: undefined,
        };
      } else if (dir.includes('/test/worktree')) {
        return {
          gitRepoPath: '/test/worktree',
          gitBranch: 'feature-branch',
          gitAheadCount: 0,
          gitBehindCount: 0,
          gitHasChanges: false,
          gitIsWorktree: true,
          gitMainRepoPath: '/test/main-repo',
        };
      }
      // Default response for other directories
      return {
        gitRepoPath: undefined,
        gitBranch: undefined,
        gitAheadCount: 0,
        gitBehindCount: 0,
        gitHasChanges: false,
        gitIsWorktree: false,
        gitMainRepoPath: undefined,
      };
    });

    // Create minimal mocks for required services
    mockPtyManager = {
      getSessions: vi.fn(() => []),
      listSessions: vi.fn(() => []),
      programRootPid: vi.fn((session: { pid?: number }) => session.pid),
      createSession: vi.fn().mockResolvedValue({
        id: 'test-session-id',
        command: ['bash'],
        cwd: '/test/dir',
      }),
    };

    mockTerminalManager = {
      getTerminal: vi.fn(),
      // Where menus are read from (an empty screen: none).
      getRecentText: vi.fn(async () => ({ text: '', rows: 24, cols: 80, wrappedRows: [] })),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('GET /server/status', () => {
    it('should return server status with Mac app connection state', async () => {
      // Mock Mac app as connected
      vi.mocked(controlUnixHandler.isMacAppConnected).mockReturnValue(true);

      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
      });

      // Find the /server/status route handler
      const routes = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { get?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const statusRoute = routes.find(
        (r) => r.route && r.route.path === '/server/status' && r.route.methods.get
      );

      expect(statusRoute).toBeTruthy();

      // Create mock request and response
      const mockReq = {} as Request;
      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      // Call the route handler
      if (!statusRoute?.route) throw new Error('Could not find GET /server/status route handler');
      await statusRoute.route.stack[0].handle(mockReq, mockRes);

      // Verify response
      expect(mockRes.json).toHaveBeenCalledWith({
        macAppConnected: true,
        isHQMode: false,
        version: 'unknown', // Since VERSION env var is not set in tests
      });
    });

    it('should return Mac app disconnected when not connected', async () => {
      // Mock Mac app as disconnected
      vi.mocked(controlUnixHandler.isMacAppConnected).mockReturnValue(false);

      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: true,
      });

      // Find the /server/status route handler
      const routes = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { get?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const statusRoute = routes.find(
        (r) => r.route && r.route.path === '/server/status' && r.route.methods.get
      );

      const mockReq = {} as Request;
      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (!statusRoute?.route) throw new Error('Could not find GET /server/status route handler');
      await statusRoute.route.stack[0].handle(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({
        macAppConnected: false,
        isHQMode: true,
        version: 'unknown',
      });
    });

    it('should preserve mode discovery when the Mac app connection check fails', async () => {
      // Mock an error in isMacAppConnected
      vi.mocked(controlUnixHandler.isMacAppConnected).mockImplementation(() => {
        throw new Error('Connection check failed');
      });

      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: true,
      });

      const routes = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { get?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const statusRoute = routes.find(
        (r) => r.route && r.route.path === '/server/status' && r.route.methods.get
      );

      const mockReq = {} as Request;
      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (!statusRoute?.route) throw new Error('Could not find GET /server/status route handler');
      await statusRoute.route.stack[0].handle(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({
        macAppConnected: false,
        isHQMode: true,
        version: 'unknown',
      });
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });

  describe('GET /sessions/tailscale/test', () => {
    it('returns diagnostics when Tailscale is not installed', async () => {
      vi.spyOn(tailscaleServeService, 'getExecutablePath').mockRejectedValue(
        new Error('Tailscale command not found')
      );
      vi.spyOn(tailscaleServeService, 'getStatus').mockResolvedValue({
        isRunning: false,
        lastError: 'Tailscale command not found',
      });

      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
      });
      const routes = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { get?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const testRoute = routes.find(
        (route) =>
          route.route && route.route.path === '/sessions/tailscale/test' && route.route.methods.get
      );
      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      await testRoute?.route?.stack[0].handle({} as Request, mockRes);

      expect(mockRes.status).not.toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          tailscale: {
            installed: false,
            status: 'Tailscale command not found',
          },
          tailscaleServe: expect.objectContaining({
            configured: false,
            error: 'Tailscale command not found',
          }),
        })
      );
    });
  });

  describe('POST /sessions - shielded by default', () => {
    // A deploy restarted the server and killed the user's own Claude session (2026-10-03):
    // web/phone sessions are shielded unless the user says otherwise.
    async function create(
      body: Record<string, unknown>,
      opts: { setting?: boolean; tmux?: boolean } = {}
    ) {
      mockPtyManager.createSession = vi.fn(() => ({
        sessionId: 's-1',
        sessionInfo: { id: 's-1', pid: 1, name: 'x', command: ['zsh'], workingDir: '/test/repo' },
      }));
      (mockPtyManager as unknown as { isShieldAvailable: () => boolean }).isShieldAvailable = () =>
        opts.tmux ?? true;
      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
        shieldNewSessionsByDefault: () => opts.setting ?? true,
      });
      const layer = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.post);
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response;
      await layer?.route?.stack[0].handle(
        {
          body: { command: ['zsh'], workingDir: '/test/repo', spawn_terminal: false, ...body },
        } as Request,
        res
      );
      const options = (mockPtyManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      return options?.shielded === true;
    }

    it.each([
      ['no choice, setting on, tmux there', {}, {}, true],
      ['explicit shielded: false', { shielded: false }, {}, false],
      [
        'explicit shielded: true with the setting off',
        { shielded: true },
        { setting: false },
        true,
      ],
      ['no choice, setting off', {}, { setting: false }, false],
      ['no choice, no tmux on this Mac', {}, { tmux: false }, false],
    ])('%s', async (_label, body, opts, expected) => {
      expect(await create(body, opts)).toBe(expected);
    });
  });

  describe('POST /sessions - a chosen git branch', () => {
    // 2026-10-20: gitBranch was ignored; the session ran on whatever the folder had out.
    let root: string;
    let repo: string;
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-session-branch-')));
      repo = path.join(root, 'app');
      fs.mkdirSync(repo);
      git(repo, 'init', '-q', '-b', 'main');
      git(
        repo,
        '-c',
        'user.email=t@e',
        '-c',
        'user.name=T',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'i'
      );
      git(repo, 'branch', 'feature');
    });
    afterEach(() => fs.rmSync(root, RM_TEST_DIR));

    async function create(body: Record<string, unknown>) {
      mockPtyManager.createSession = vi.fn(() => ({
        sessionId: 's-b',
        sessionInfo: { id: 's-b', pid: 1, name: 'x', command: ['zsh'], workingDir: repo },
      }));
      (mockPtyManager as unknown as { isShieldAvailable: () => boolean }).isShieldAvailable = () =>
        false;
      const router = sessionRoutes({ remoteRegistry: null, isHQMode: false });
      const layer = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.post);
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      await layer?.route?.stack[0].handle(
        { body: { command: ['zsh'], workingDir: repo, spawn_terminal: false, ...body } } as Request,
        res as unknown as Response
      );
      return res;
    }

    it("starts in the branch's worktree and says where", async () => {
      const res = await create({ gitBranch: 'feature' });
      const worktree = `${repo}-feature`;
      expect(mockPtyManager.createSession.mock.calls[0][1].workingDir).toBe(worktree);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ workingDir: worktree }));
      expect(git(repo, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    });

    it('the current branch changes nothing', async () => {
      const res = await create({ gitBranch: 'main' });
      expect(mockPtyManager.createSession.mock.calls[0][1].workingDir).toBe(repo);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ workingDir: repo }));
    });

    it('an unknown branch is refused, nothing created', async () => {
      const res = await create({ gitBranch: 'missing' });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'branch-not-found' }));
      expect(mockPtyManager.createSession).not.toHaveBeenCalled();
    });
  });

  describe('POST /sessions - a conversation running outside Untether', () => {
    const live = { where: 'terminal' as const, app: 'Terminal', chatId: 'a-530-1759395600' };

    async function create(command: string[], workingDir = process.cwd()) {
      const liveClaudeConversations = vi.fn(async () => new Map([['conv-live', live]]));
      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
        liveClaudeConversations,
      });
      const layer = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.post);
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response & {
        json: ReturnType<typeof vi.fn>;
        status: ReturnType<typeof vi.fn>;
      };
      await layer?.route?.stack[0].handle(
        { body: { command, workingDir, spawn_terminal: false } } as Request,
        res
      );
      return { res, liveClaudeConversations };
    }

    it.each([
      [['claude', '--resume', 'conv-live', '--dangerously-skip-permissions']],
      [['/opt/homebrew/bin/claude', '-r', 'conv-live']],
      [['claude', '--resume=conv-live']],
    ])('is never resumed here: %j', async (command) => {
      const { res } = await create(command);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: 'live-elsewhere',
        details: 'This conversation is running outside Untether right now',
        live,
      });
      expect(mockPtyManager.createSession).not.toHaveBeenCalled();
    });

    it.each([
      [['claude', '--resume', 'conv-done']],
      [['claude']],
      [['codex', 'resume', 'conv-live']],
      [['zsh', '-c', 'echo --resume conv-live']],
    ])('starts anything else: %j', async (command) => {
      const { res } = await create(command);
      expect(res.status).not.toHaveBeenCalledWith(409);
      expect(mockPtyManager.createSession).toHaveBeenCalledTimes(1);
    });

    it('a conversation running in another Untether session opens that one (2026-10-18)', async () => {
      mockPtyManager.listSessions = vi.fn(() => [
        { id: 'already', status: 'running', claudeSessionId: 'conv-done' },
      ]);
      const { res } = await create(['claude', '--resume', 'conv-done']);
      expect(res.json).toHaveBeenCalledWith({ sessionId: 'already', existing: true });
      expect(mockPtyManager.createSession).not.toHaveBeenCalled();
    });

    it('a session still starting with the conversation is the answer (2026-10-20)', async () => {
      mockPtyManager.listSessions = vi.fn(() => [
        {
          id: 'starting-one',
          status: 'starting',
          startedAt: new Date().toISOString(),
          claudeSessionId: 'conv-done',
        },
      ]);
      const { res } = await create(['claude', '--resume', 'conv-done']);
      expect(res.json).toHaveBeenCalledWith({ sessionId: 'starting-one', existing: true });
      expect(mockPtyManager.createSession).not.toHaveBeenCalled();
    });

    it('a session stuck in starting long ago (crash mid-create) is not live', async () => {
      mockPtyManager.listSessions = vi.fn(() => [
        {
          id: 'stuck',
          status: 'starting',
          startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          claudeSessionId: 'conv-done',
        },
      ]);
      await create(['claude', '--resume', 'conv-done']);
      expect(mockPtyManager.createSession).toHaveBeenCalledTimes(1);
    });

    it('a double tap on Resume starts the conversation once (2026-10-20)', async () => {
      let finish: (value: unknown) => void = () => {};
      mockPtyManager.createSession = vi.fn(
        (_command: string[], options: { sessionId?: string }) =>
          new Promise((resolve) => {
            finish = () => resolve({ sessionId: options.sessionId, sessionInfo: {} });
          })
      );
      const router = sessionRoutes({ remoteRegistry: null, isHQMode: false });
      const layer = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.post);
      const tap = () => {
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response & {
          json: ReturnType<typeof vi.fn>;
        };
        const done = layer?.route?.stack[0].handle(
          {
            body: {
              command: ['claude', '--resume', 'conv-twice'],
              workingDir: process.cwd(),
              spawn_terminal: false,
            },
          } as Request,
          res
        );
        return { res, done };
      };
      const first = tap();
      await vi.waitFor(() => expect(mockPtyManager.createSession).toHaveBeenCalledTimes(1));
      const second = tap();
      finish(undefined);
      await Promise.all([first.done, second.done]);
      expect(mockPtyManager.createSession).toHaveBeenCalledTimes(1);
      const firstId = first.res.json.mock.calls[0][0].sessionId;
      expect(firstId).toBeTruthy();
      expect(second.res.json).toHaveBeenCalledWith({ sessionId: firstId, existing: true });
    });

    it('never resumes a conversation outside its folder, once that folder is gone', async () => {
      // A merged task's worktree: resuming its session in the server's folder (2026-10-18).
      const { res } = await create(['claude', '--resume', 'conv-done'], '/test/removed-worktree');
      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockPtyManager.createSession).not.toHaveBeenCalled();
    });
  });

  describe('POST /sessions - Git detection', () => {
    beforeEach(async () => {
      // Update mockPtyManager to handle createSession
      mockPtyManager.createSession = vi.fn(() => ({
        sessionId: 'test-session-123',
        sessionInfo: {
          id: 'test-session-123',
          pid: 12345,
          name: 'Test Session',
          command: ['bash'],
          workingDir: '/test/repo',
        },
      }));
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should detect Git repository information for regular repository', async () => {
      // The mock is already set up to return regular repository info for /test/repo
      // based on our implementation in beforeEach

      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
      });

      // Find the POST /sessions route handler
      interface RouteLayer {
        route?: {
          path: string;
          methods: { post?: boolean };
          stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
        };
      }
      const routes = (router as { stack: RouteLayer[] }).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['bash'],
          workingDir: '/test/repo',
          name: 'Test Session',
          spawn_terminal: false,
        },
      } as Request;

      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      // Verify Git detection was called
      expect(vi.mocked(detectGitInfo)).toHaveBeenCalled();

      // Verify session was created
      expect(mockPtyManager.createSession).toHaveBeenCalled();
    });

    it('should detect Git worktree information', async () => {
      // Mock detectGitInfo to return worktree info
      vi.mocked(detectGitInfo).mockResolvedValueOnce({
        gitRepoPath: '/test/worktree',
        gitBranch: 'feature/new-feature',
        gitAheadCount: 0,
        gitBehindCount: 0,
        gitHasChanges: false,
        gitIsWorktree: true,
        gitMainRepoPath: '/test/main-repo',
      });

      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
      });

      interface RouteLayer {
        route?: {
          path: string;
          methods: { post?: boolean };
          stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
        };
      }
      const routes = (router as { stack: RouteLayer[] }).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['vim'],
          workingDir: '/test/worktree',
        },
      } as Request;

      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      // Verify worktree detection
      expect(mockPtyManager.createSession).toHaveBeenCalledWith(
        ['vim'],
        expect.objectContaining({
          gitRepoPath: '/test/worktree',
          gitBranch: 'feature/new-feature',
          gitIsWorktree: true,
          gitMainRepoPath: '/test/main-repo',
        })
      );
    });

    it('should handle non-Git directories gracefully', async () => {
      // Mock detectGitInfo to return no Git info
      vi.mocked(detectGitInfo).mockResolvedValueOnce({
        gitRepoPath: undefined,
        gitBranch: undefined,
        gitAheadCount: 0,
        gitBehindCount: 0,
        gitHasChanges: false,
        gitIsWorktree: false,
        gitMainRepoPath: undefined,
      });

      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
      });

      interface RouteLayer {
        route?: {
          path: string;
          methods: { post?: boolean };
          stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
        };
      }
      const routes = (router as { stack: RouteLayer[] }).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['ls'],
          workingDir: '/tmp',
        },
      } as Request;

      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      // Verify session was created
      expect(mockPtyManager.createSession).toHaveBeenCalled();

      // Should still create the session successfully with both sessionId and createdAt
      expect(mockRes.json).toHaveBeenCalledWith({
        sessionId: 'test-session-123',
        createdAt: expect.any(String),
        workingDir: expect.any(String),
      });
    });

    it('should handle detached HEAD state', async () => {
      // Mock detectGitInfo to return detached HEAD state
      vi.mocked(detectGitInfo).mockResolvedValueOnce({
        gitRepoPath: '/test/repo',
        gitBranch: undefined, // No branch in detached HEAD
        gitAheadCount: 0,
        gitBehindCount: 0,
        gitHasChanges: false,
        gitIsWorktree: false,
        gitMainRepoPath: undefined,
      });

      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
      });

      interface RouteLayer {
        route?: {
          path: string;
          methods: { post?: boolean };
          stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
        };
      }
      const routes = (router as { stack: RouteLayer[] }).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['git', 'log'],
          workingDir: '/test/repo',
        },
      } as Request;

      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      // Should still have repo path but no branch
      expect(mockPtyManager.createSession).toHaveBeenCalledWith(
        ['git', 'log'],
        expect.objectContaining({
          gitRepoPath: '/test/repo',
          gitBranch: undefined,
        })
      );
    });

    it.skip('should pass Git info to terminal spawn request', async () => {
      // The mock is already set up based on our implementation

      // Mock requestTerminalSpawn to simulate successful terminal spawn
      vi.mocked(requestTerminalSpawn).mockResolvedValueOnce({
        success: true,
      });

      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
      });

      interface RouteLayer {
        route?: {
          path: string;
          methods: { post?: boolean };
          stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
        };
      }
      const routes = (router as { stack: RouteLayer[] }).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['zsh'],
          workingDir: '/test/repo',
          spawn_terminal: true, // Request terminal spawn
        },
      } as Request;

      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      // Verify terminal spawn was called
      expect(requestTerminalSpawn).toHaveBeenCalled();
    });
  });

  describe('POST /sessions - Response Format Validation', () => {
    beforeEach(() => {
      // Reset requestTerminalSpawn mock to default (failed spawn)
      vi.mocked(requestTerminalSpawn).mockResolvedValue({
        success: false,
        error: 'Terminal spawn failed in test',
      });

      // Setup mock to return session data
      mockPtyManager.createSession = vi.fn(() => ({
        sessionId: 'session-abc-123',
        sessionInfo: {
          id: 'session-abc-123',
          pid: 12345,
          name: 'Test Session',
          command: ['bash'],
          workingDir: '/test/dir',
        },
      }));
    });

    it('should return CreateSessionResponse format with sessionId and createdAt for web sessions', async () => {
      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
      });

      const routes = (
        router as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['bash'],
          workingDir: '/test/dir',
          spawn_terminal: false,
        },
      } as Request;

      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      // Verify response matches Mac app's CreateSessionResponse expectation
      expect(mockRes.json).toHaveBeenCalledWith({
        sessionId: 'session-abc-123',
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/), // ISO string format
        workingDir: expect.any(String),
      });
    });

    it('types initialInput into the new session once Claude is idle', async () => {
      vi.useFakeTimers();
      try {
        let claudeStatus = 'busy';
        vi.mocked(readClaudeStatuses).mockImplementation(
          async () => new Map([[12345, { status: claudeStatus }]])
        );
        const sendInput = vi.fn();
        const ptyManager = {
          ...mockPtyManager,
          getSession: vi.fn(() => ({ id: 'session-abc-123', pid: 12345, status: 'running' })),
          sendInput,
        };
        const terminalManager = {
          ...mockTerminalManager,
          getBufferSnapshot: vi.fn(async () => ({ cells: [], cols: 80, rows: 24 })),
        };
        const router = createSessionRoutes({
          ptyManager: ptyManager as never,
          terminalManager: terminalManager as never,
          remoteRegistry: null,
          isHQMode: false,
        });
        const createRoute = (
          router as unknown as {
            stack: Array<{
              route?: {
                path: string;
                methods: { post?: boolean };
                stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
              };
            }>;
          }
        ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.post);
        const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response;
        await createRoute?.route?.stack[0].handle(
          {
            body: {
              command: ['claude'],
              workingDir: '/test/dir',
              initialInput: 'fix the tests',
            },
          } as Request,
          mockRes
        );
        expect(mockRes.json).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: 'session-abc-123' })
        );

        // Claude is still starting: nothing is typed yet.
        await vi.advanceTimersByTimeAsync(3000);
        expect(sendInput).not.toHaveBeenCalled();

        claudeStatus = 'idle';
        await vi.advanceTimersByTimeAsync(3000);
        expect(sendInput.mock.calls).toEqual([
          ['session-abc-123', { text: 'fix the tests' }],
          ['session-abc-123', { key: 'enter' }],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects a non-string initialInput', async () => {
      const router = createSessionRoutes({
        ptyManager: mockPtyManager as never,
        terminalManager: mockTerminalManager as never,
        remoteRegistry: null,
        isHQMode: false,
      });
      const createRoute = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.post);
      const mockRes = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response;
      await createRoute?.route?.stack[0].handle(
        { body: { command: ['claude'], initialInput: ['rm -rf'] } } as Request,
        mockRes
      );
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockPtyManager.createSession).not.toHaveBeenCalled();
    });

    it('should ensure terminal spawn requests still return CreateSessionResponse format', async () => {
      // Note: Terminal spawn integration is complex and tested elsewhere.
      // This test ensures the fallback path returns the correct response format.

      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
      });

      const routes = (
        router as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['zsh'],
          workingDir: '/test/dir',
          spawn_terminal: true,
          titleMode: 'static',
        },
      } as Request;

      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      // Even when terminal spawn falls back to web session,
      // response must include CreateSessionResponse format
      expect(mockRes.json).toHaveBeenCalledWith({
        sessionId: 'session-abc-123',
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        workingDir: expect.any(String),
      });
    });

    it('should fallback to web session with correct format when terminal spawn fails', async () => {
      // Mock terminal spawn to fail
      vi.mocked(requestTerminalSpawn).mockResolvedValueOnce({
        success: false,
        error: 'Terminal spawn failed',
      });

      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
      });

      const routes = (
        router as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['zsh'],
          workingDir: '/test/dir',
          spawn_terminal: true,
        },
      } as Request;

      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      // Should fallback to web session with correct format
      expect(mockRes.json).toHaveBeenCalledWith({
        sessionId: 'session-abc-123',
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        workingDir: expect.any(String),
      });
    });

    it('should validate createdAt is a valid ISO string', async () => {
      const router = sessionRoutes({
        remoteRegistry: null,
        isHQMode: false,
      });

      const routes = (
        router as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['bash'],
          workingDir: '/test/dir',
        },
      } as Request;

      let capturedResponse: { sessionId: string; createdAt: string } | undefined;
      const mockRes = {
        json: vi.fn((data) => {
          capturedResponse = data;
        }),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      // Verify createdAt can be parsed as a valid Date
      expect(capturedResponse).toBeDefined();
      if (!capturedResponse) throw new Error('No response was sent');
      expect(capturedResponse.createdAt).toBeDefined();
      const parsedDate = new Date(capturedResponse.createdAt);
      expect(parsedDate.toISOString()).toBe(capturedResponse.createdAt);
      expect(parsedDate.getTime()).toBeCloseTo(Date.now(), -2); // Within ~100ms
    });
  });

  describe('POST /sessions - Remote Server Communication', () => {
    // `Response` in this file is Express's; fetch answers the global one.
    type FetchResponse = Awaited<ReturnType<typeof fetch>>;
    let mockRemoteRegistry: {
      getRemote: Mock;
      addSessionToRemote: Mock;
      getRemotes?: Mock;
    };

    beforeEach(() => {
      mockRemoteRegistry = {
        getRemote: vi.fn(),
        addSessionToRemote: vi.fn(),
      };

      // Mock fetch for remote server communication
      global.fetch = vi.fn();
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    it('should handle remote session creation with new response format (sessionId + createdAt)', async () => {
      // Mock remote registry to return a remote server
      mockRemoteRegistry.getRemote.mockReturnValue({
        id: 'remote-1',
        name: 'Remote Server',
        url: 'https://remote.example.com',
        token: 'test-token',
      });

      // Mock fetch to return new response format
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          sessionId: 'remote-session-123',
          createdAt: '2023-01-01T12:00:00.000Z',
        }),
      } as unknown as FetchResponse);

      const router = sessionRoutes({
        remoteRegistry: mockRemoteRegistry,
        isHQMode: true,
      });

      const routes = (
        router as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['bash'],
          workingDir: '/test/dir',
          remoteId: 'remote-1',
        },
      } as Request;

      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      // Verify remote server was called with correct payload
      expect(fetch).toHaveBeenCalledWith(
        'https://remote.example.com/api/sessions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          }),
          body: JSON.stringify({
            command: ['bash'],
            workingDir: '/test/dir',
            // remoteId should NOT be forwarded to avoid recursion
          }),
        })
      );

      // Verify response forwards the complete remote response
      expect(mockRes.json).toHaveBeenCalledWith({
        sessionId: 'remote-session-123',
        createdAt: '2023-01-01T12:00:00.000Z',
      });

      // Verify session was tracked in registry
      expect(mockRemoteRegistry.addSessionToRemote).toHaveBeenCalledWith(
        'remote-1',
        'remote-session-123'
      );
    });

    it('should handle remote session creation with legacy response format (sessionId only)', async () => {
      // Mock remote registry to return a remote server
      mockRemoteRegistry.getRemote.mockReturnValue({
        id: 'remote-1',
        name: 'Legacy Remote Server',
        url: 'https://legacy-remote.example.com',
        token: 'test-token',
      });

      // Mock fetch to return legacy response format (sessionId only)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          sessionId: 'legacy-session-456',
          // No createdAt field (legacy format)
        }),
      } as unknown as FetchResponse);

      const router = sessionRoutes({
        remoteRegistry: mockRemoteRegistry,
        isHQMode: true,
      });

      const routes = (
        router as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['bash'],
          workingDir: '/test/dir',
          remoteId: 'remote-1',
        },
      } as Request;

      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      // Verify response forwards legacy response as-is
      expect(mockRes.json).toHaveBeenCalledWith({
        sessionId: 'legacy-session-456',
        // createdAt will be undefined, which is fine for backward compatibility
      });

      // Verify session was still tracked
      expect(mockRemoteRegistry.addSessionToRemote).toHaveBeenCalledWith(
        'remote-1',
        'legacy-session-456'
      );
    });

    it('should not forward remoteId to prevent recursion', async () => {
      mockRemoteRegistry.getRemote.mockReturnValue({
        id: 'remote-1',
        name: 'Remote Server',
        url: 'https://remote.example.com',
        token: 'test-token',
      });

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ sessionId: 'test-session' }),
      } as unknown as FetchResponse);

      const router = sessionRoutes({
        remoteRegistry: mockRemoteRegistry,
        isHQMode: true,
      });

      const routes = (
        router as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['bash'],
          workingDir: '/test/dir',
          remoteId: 'remote-1',
          spawn_terminal: true,
          cols: 80,
          rows: 24,
          titleMode: 'static',
        },
      } as Request;

      const mockRes = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      // Verify that remoteId is NOT included in the forwarded request
      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1]?.body as string);

      expect(requestBody).toEqual({
        command: ['bash'],
        workingDir: '/test/dir',
        spawn_terminal: true,
        cols: 80,
        rows: 24,
        titleMode: 'static',
        // remoteId should be excluded to prevent recursion
      });
      expect(requestBody.remoteId).toBeUndefined();
    });

    it('should refuse to spawn locally in HQ mode when no remoteId is given (remotes registered)', async () => {
      // One remote is registered, but the request omits remoteId. HQ must never
      // spawn locally — reject with 400 and create nothing.
      mockRemoteRegistry.getRemotes = vi.fn().mockReturnValue([{ id: 'remote-1', name: 'my-mac' }]);

      const router = sessionRoutes({
        remoteRegistry: mockRemoteRegistry,
        isHQMode: true,
      });

      const routes = (
        router as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['bash'],
          workingDir: '/test/dir',
          // no remoteId
        },
      } as Request;

      let statusCode = 0;
      const mockRes = {
        json: vi.fn(),
        status: vi.fn((code: number) => {
          statusCode = code;
          return mockRes;
        }),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      expect(statusCode).toBe(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'A target machine (remoteId) is required in HQ mode.',
      });
      // Crucially, no local session was spawned.
      expect(mockPtyManager.createSession).not.toHaveBeenCalled();
      // And nothing was forwarded to a remote either.
      expect(fetch).not.toHaveBeenCalled();
    });

    it('should explain there are no machines when HQ has zero remotes and no remoteId', async () => {
      // Zero remotes registered: the error guides the user to start Untether
      // on a machine first, and still creates nothing.
      mockRemoteRegistry.getRemotes = vi.fn().mockReturnValue([]);

      const router = sessionRoutes({
        remoteRegistry: mockRemoteRegistry,
        isHQMode: true,
      });

      const routes = (
        router as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack;
      const createRoute = routes.find(
        (r) => r.route && r.route.path === '/sessions' && r.route.methods.post
      );

      const mockReq = {
        body: {
          command: ['bash'],
          workingDir: '/test/dir',
        },
      } as Request;

      let statusCode = 0;
      const mockRes = {
        json: vi.fn(),
        status: vi.fn((code: number) => {
          statusCode = code;
          return mockRes;
        }),
      } as unknown as Response;

      if (createRoute?.route?.stack?.[0]) {
        await createRoute.route.stack[0].handle(mockReq, mockRes);
      } else {
        throw new Error('Could not find POST /sessions route handler');
      }

      expect(statusCode).toBe(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error:
          'No machines are registered with this HQ, so no session can be created. Start Untether on a machine first.',
      });
      expect(mockPtyManager.createSession).not.toHaveBeenCalled();
    });
  });

  describe('POST /sessions/:sessionId/shield', () => {
    it('refuses a session opened with ut in a terminal window, never closing it there', async () => {
      // Shielding reopens a session in tmux and first kills the old one: for a ut session that
      // is the program in the user's terminal window (2026-10-03). Only a Claude conversation
      // moves to Untether since 2026-10-25 (sessions-move-to-untether.test.ts); anything else
      // would start over, so it stays refused.
      const killSession = vi.fn();
      const createSession = vi.fn();
      const router = createSessionRoutes({
        ptyManager: {
          ...mockPtyManager,
          getSession: vi.fn(() => ({
            id: 'fwd_1791050240624_6805',
            status: 'running',
            command: ['htop'],
            workingDir: '/tmp',
          })),
          isShieldAvailable: vi.fn(() => true),
          killSession,
          createSession,
        },
        terminalManager: mockTerminalManager,
        remoteRegistry: null,
        isHQMode: false,
      } as unknown as Parameters<typeof createSessionRoutes>[0]);
      const layer = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions/:sessionId/shield' && r.route.methods.post);
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response & {
        status: ReturnType<typeof vi.fn>;
      };
      await layer?.route?.stack[0].handle(
        { params: { sessionId: 'fwd_1791050240624_6805' }, body: {} } as unknown as Request,
        res
      );
      expect(res.status).toHaveBeenCalledWith(409);
      expect(killSession).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    // 2026-10-18: "Blindar" opened the shielded session with only the generated name.
    it.each([
      ['a Claude session', ['claude', '--dangerously-skip-permissions'], 'conv-1'],
      ['a shell', ['zsh'], undefined],
    ])('keeps the titles of %s it reopens shielded', async (_label, command, claudeSessionId) => {
      const createSession = vi.fn(async () => ({ sessionId: 'new-1' }));
      const router = createSessionRoutes({
        ptyManager: {
          ...mockPtyManager,
          getSession: vi.fn(() => ({
            id: 's-1',
            name: 'claude (~/Projects)',
            status: 'running',
            command,
            claudeSessionId,
            userTitle: 'TELEVISIÓN',
            claudeTitle: 'Repositorio morluto/rea',
            workingDir: '/tmp',
          })),
          isShieldAvailable: vi.fn(() => true),
          killSession: vi.fn(),
          createSession,
        },
        terminalManager: mockTerminalManager,
        remoteRegistry: null,
        isHQMode: false,
      } as unknown as Parameters<typeof createSessionRoutes>[0]);
      const layer = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions/:sessionId/shield' && r.route.methods.post);
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response;
      await layer?.route?.stack[0].handle(
        { params: { sessionId: 's-1' }, body: {} } as unknown as Request,
        res
      );
      expect(createSession).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          shielded: true,
          userTitle: 'TELEVISIÓN',
          claudeTitle: 'Repositorio morluto/rea',
        })
      );
    });
  });

  describe('POST /sessions/:sessionId/shield - one Claude per conversation (2026-10-20)', () => {
    type Layer = {
      route?: {
        path: string;
        methods: { post?: boolean };
        stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
      };
    };
    const exited = {
      id: 'old-1',
      name: 'claude',
      status: 'exited',
      command: ['claude', '--resume', 'conv-shield'],
      claudeSessionId: 'conv-shield',
      workingDir: process.cwd(),
    };
    function routes(
      overrides: Record<string, unknown>,
      liveClaudeConversations?: () => Promise<Map<string, unknown>>
    ) {
      const router = createSessionRoutes({
        ptyManager: {
          ...mockPtyManager,
          getSession: vi.fn(() => exited),
          isShieldAvailable: vi.fn(() => true),
          killSession: vi.fn(),
          ...overrides,
        },
        terminalManager: mockTerminalManager,
        remoteRegistry: null,
        isHQMode: false,
        liveClaudeConversations,
      } as unknown as Parameters<typeof createSessionRoutes>[0]);
      const stack = (router as unknown as { stack: Layer[] }).stack;
      const handle = (path: string) => {
        const layer = stack.find((r) => r.route?.path === path && r.route.methods.post);
        return (req: unknown) => {
          const res = {
            json: vi.fn(),
            status: vi.fn().mockReturnThis(),
          } as unknown as Response & {
            json: ReturnType<typeof vi.fn>;
            status: ReturnType<typeof vi.fn>;
          };
          const done = layer?.route?.stack[0].handle(req as Request, res);
          return { res, done };
        };
      };
      return {
        shield: handle('/sessions/:sessionId/shield'),
        create: handle('/sessions'),
      };
    }

    it('opens the session that already runs the conversation instead of a second one', async () => {
      const createSession = vi.fn();
      const { shield } = routes({
        createSession,
        listSessions: vi.fn(() => [
          exited,
          { id: 'live-1', status: 'running', claudeSessionId: 'conv-shield' },
        ]),
      });
      const { res, done } = shield({ params: { sessionId: 'old-1' }, body: {} });
      await done;
      expect(res.json).toHaveBeenCalledWith({
        sessionId: 'live-1',
        replaced: false,
        existing: true,
      });
      expect(createSession).not.toHaveBeenCalled();
    });

    it('refuses an exited session whose conversation runs outside Untether', async () => {
      const createSession = vi.fn();
      const live = { where: 'terminal', app: 'Terminal' };
      const { shield } = routes(
        { createSession, listSessions: vi.fn(() => [exited]) },
        async () => new Map([['conv-shield', live]])
      );
      const { res, done } = shield({ params: { sessionId: 'old-1' }, body: {} });
      await done;
      expect(res.status).toHaveBeenCalledWith(409);
      expect(createSession).not.toHaveBeenCalled();
    });

    it('waits for a resume of the conversation already on its way', async () => {
      let finish: () => void = () => {};
      const createSession = vi.fn(
        (_command: string[], options: { sessionId?: string }) =>
          new Promise((resolve) => {
            finish = () => resolve({ sessionId: options.sessionId, sessionInfo: {} });
          })
      );
      const { shield, create } = routes({
        createSession,
        listSessions: vi.fn(() => [exited]),
      });
      const resume = create({
        body: {
          command: ['claude', '--resume', 'conv-shield'],
          workingDir: process.cwd(),
          spawn_terminal: false,
        },
      });
      await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      const blindar = shield({ params: { sessionId: 'old-1' }, body: {} });
      finish();
      await Promise.all([resume.done, blindar.done]);
      expect(createSession).toHaveBeenCalledTimes(1);
      const resumedId = resume.res.json.mock.calls[0][0].sessionId;
      expect(blindar.res.json).toHaveBeenCalledWith({
        sessionId: resumedId,
        replaced: false,
        existing: true,
      });
    });

    it('a resume asked while the shield reopens it gets the shielded session', async () => {
      let finish: () => void = () => {};
      const createSession = vi.fn(
        (_command: string[], options: { sessionId?: string }) =>
          new Promise((resolve) => {
            finish = () => resolve({ sessionId: options.sessionId, sessionInfo: {} });
          })
      );
      const { shield, create } = routes({
        createSession,
        listSessions: vi.fn(() => [exited]),
      });
      const blindar = shield({ params: { sessionId: 'old-1' }, body: {} });
      await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      const resume = create({
        body: {
          command: ['claude', '--resume', 'conv-shield'],
          workingDir: process.cwd(),
          spawn_terminal: false,
        },
      });
      finish();
      await Promise.all([resume.done, blindar.done]);
      expect(createSession).toHaveBeenCalledTimes(1);
      const shieldedId = blindar.res.json.mock.calls[0][0].sessionId;
      expect(resume.res.json).toHaveBeenCalledWith({ sessionId: shieldedId, existing: true });
    });
  });

  describe('POST /sessions/:sessionId/mute', () => {
    function muteHandler(ptyManager: unknown) {
      const router = createSessionRoutes({
        ptyManager,
        terminalManager: mockTerminalManager,
        remoteRegistry: null,
        isHQMode: false,
      } as unknown as Parameters<typeof createSessionRoutes>[0]);
      const layer = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions/:sessionId/mute' && r.route.methods.post);
      expect(layer).toBeTruthy();
      return layer?.route?.stack[0].handle as (req: Request, res: Response) => unknown;
    }

    function mockRes() {
      return { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response & {
        json: ReturnType<typeof vi.fn>;
        status: ReturnType<typeof vi.fn>;
      };
    }

    it('stores the mute flag on the session', async () => {
      const setSessionMuted = vi.fn(() => true);
      const handle = muteHandler({ ...mockPtyManager, setSessionMuted });
      const res = mockRes();
      await handle(
        { params: { sessionId: 's1' }, body: { muted: true } } as unknown as Request,
        res
      );
      expect(setSessionMuted).toHaveBeenCalledWith('s1', true);
      expect(res.json).toHaveBeenCalledWith({ success: true, muted: true });
    });

    it('rejects a non-boolean value and unknown sessions', async () => {
      const setSessionMuted = vi.fn(() => false);
      const handle = muteHandler({ ...mockPtyManager, setSessionMuted });
      const bad = mockRes();
      await handle(
        { params: { sessionId: 's1' }, body: { muted: 'yes' } } as unknown as Request,
        bad
      );
      expect(bad.status).toHaveBeenCalledWith(400);
      expect(setSessionMuted).not.toHaveBeenCalled();

      const missing = mockRes();
      await handle(
        { params: { sessionId: 'gone' }, body: { muted: false } } as unknown as Request,
        missing
      );
      expect(missing.status).toHaveBeenCalledWith(404);
    });
  });

  // 2026-11-04: the user anchors a session to a group of the home from its menu.
  describe('POST /sessions/:sessionId/group-pin', () => {
    function pinHandler(ptyManager: unknown) {
      const router = createSessionRoutes({
        ptyManager,
        terminalManager: mockTerminalManager,
        remoteRegistry: null,
        isHQMode: false,
      } as unknown as Parameters<typeof createSessionRoutes>[0]);
      const layer = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { post?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
            };
          }>;
        }
      ).stack.find(
        (r) => r.route?.path === '/sessions/:sessionId/group-pin' && r.route.methods.post
      );
      expect(layer).toBeTruthy();
      return layer?.route?.stack[0].handle as (req: Request, res: Response) => unknown;
    }

    function mockRes() {
      return { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response & {
        json: ReturnType<typeof vi.fn>;
        status: ReturnType<typeof vi.fn>;
      };
    }

    const call = async (
      handle: ReturnType<typeof pinHandler>,
      sessionId: string,
      body: unknown
    ) => {
      const res = mockRes();
      await handle({ params: { sessionId }, body } as unknown as Request, res);
      return res;
    };

    it('stores a project (its main checkout), "Otras", or back to automatic; nothing else', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-pin-'));
      try {
        const setGroupPin = vi.fn((id: string) => id !== 'gone');
        // Only session.json changes: nothing that touches the running program is called.
        const killSession = vi.fn();
        const sendInput = vi.fn();
        const handle = pinHandler({ ...mockPtyManager, setGroupPin, killSession, sendInput });

        // A worktree anchors to its main checkout.
        vi.mocked(detectGitInfo).mockResolvedValueOnce({
          gitRepoPath: dir,
          gitMainRepoPath: '/Users/n/Projects/bakery',
        } as Awaited<ReturnType<typeof detectGitInfo>>);
        let res = await call(handle, 's1', { groupPin: { repoPath: dir } });
        expect(setGroupPin).toHaveBeenLastCalledWith('s1', {
          repoPath: '/Users/n/Projects/bakery',
          git: true,
        });
        expect(res.json).toHaveBeenCalledWith({
          success: true,
          groupPin: { repoPath: '/Users/n/Projects/bakery', git: true },
        });

        // A folder outside git.
        vi.mocked(detectGitInfo).mockResolvedValueOnce(
          {} as Awaited<ReturnType<typeof detectGitInfo>>
        );
        await call(handle, 's1', { groupPin: { repoPath: dir } });
        expect(setGroupPin).toHaveBeenLastCalledWith('s1', { repoPath: dir });

        await call(handle, 's1', { groupPin: { repoPath: null } });
        expect(setGroupPin).toHaveBeenLastCalledWith('s1', { repoPath: null });
        await call(handle, 's1', { groupPin: null });
        expect(setGroupPin).toHaveBeenLastCalledWith('s1', null);
        expect(setGroupPin).toHaveBeenCalledTimes(4);

        for (const body of [
          { groupPin: { repoPath: 'relative/dir' } },
          { groupPin: { repoPath: path.join(dir, 'missing') } },
          { groupPin: 'bakery' },
          {},
        ]) {
          res = await call(handle, 's1', body);
          expect(res.status).toHaveBeenCalledWith(400);
        }
        expect(setGroupPin).toHaveBeenCalledTimes(4);

        res = await call(handle, 'gone', { groupPin: null });
        expect(res.status).toHaveBeenCalledWith(404);
        expect(killSession).not.toHaveBeenCalled();
        expect(sendInput).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(dir, RM_TEST_DIR);
      }
    });
  });

  describe('PATCH /sessions/:sessionId', () => {
    function patchHandler(ptyManager: unknown) {
      const router = createSessionRoutes({
        ptyManager,
        terminalManager: mockTerminalManager,
        remoteRegistry: null,
        isHQMode: false,
      } as unknown as Parameters<typeof createSessionRoutes>[0]);
      const layer = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { patch?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => unknown }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions/:sessionId' && r.route.methods.patch);
      expect(layer).toBeTruthy();
      return layer?.route?.stack[0].handle as (req: Request, res: Response) => unknown;
    }

    function mockRes() {
      return { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response & {
        json: ReturnType<typeof vi.fn>;
        status: ReturnType<typeof vi.fn>;
      };
    }

    function fakes() {
      return {
        ...mockPtyManager,
        getSession: vi.fn((id: string) => (id === 's1' ? { id } : null)),
        updateSessionName: vi.fn((_id: string, name: string) => name),
        setUserTitle: vi.fn(() => true),
      };
    }

    const patch = (body: unknown, sessionId = 's1') =>
      ({ params: { sessionId }, body }) as unknown as Request;

    it("sets the user's title without touching the generated name", async () => {
      const pty = fakes();
      const res = mockRes();
      await patchHandler(pty)(patch({ userTitle: '  Login work ' }), res);
      expect(pty.setUserTitle).toHaveBeenCalledWith('s1', 'Login work');
      expect(pty.updateSessionName).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true, userTitle: 'Login work' });
    });

    it("clears it with null or '' (back to Claude's title)", async () => {
      const pty = fakes();
      await patchHandler(pty)(patch({ userTitle: null }), mockRes());
      await patchHandler(pty)(patch({ userTitle: '' }), mockRes());
      expect(pty.setUserTitle.mock.calls).toEqual([
        ['s1', null],
        ['s1', null],
      ]);
    });

    it('still renames by name alone, as older clients do', async () => {
      const pty = fakes();
      const res = mockRes();
      await patchHandler(pty)(patch({ name: 'build' }), res);
      expect(pty.updateSessionName).toHaveBeenCalledWith('s1', 'build');
      expect(pty.setUserTitle).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ success: true, name: 'build' });
    });

    it('rejects a body with neither, a bad title, and unknown sessions', async () => {
      const pty = fakes();
      for (const body of [{}, { name: '' }, { userTitle: 42 }]) {
        const res = mockRes();
        await patchHandler(pty)(patch(body), res);
        expect(res.status).toHaveBeenCalledWith(400);
      }
      const missing = mockRes();
      await patchHandler(pty)(patch({ userTitle: 'x' }, 'gone'), missing);
      expect(missing.status).toHaveBeenCalledWith(404);
      expect(pty.setUserTitle).not.toHaveBeenCalled();
    });
  });

  describe('GET /sessions last line', () => {
    it('adds the last output line to running non-Claude sessions only', async () => {
      vi.mocked(readClaudeStatuses).mockResolvedValueOnce(new Map([[2, { status: 'idle' }]]));
      const row = (text: string) => [...text].map((char) => ({ char }));
      const ptyManager = {
        ...mockPtyManager,
        listSessions: vi.fn(() => [
          { id: 'shell', pid: 1, status: 'running', command: ['zsh'] },
          { id: 'claude', pid: 2, status: 'running', command: ['claude'] },
          { id: 'done', pid: 3, status: 'exited', command: ['zsh'] },
        ]),
      };
      const terminalManager = {
        canSnapshotCheaply: vi.fn(() => true),
        getChangeCount: vi.fn(() => 1),
        getBufferSnapshot: vi.fn(async () => ({
          cells: [row('npm test'), row('✓ 12 passed'), row('mac ~/src % ')],
          cols: 80,
          rows: 3,
        })),
      };
      const router = createSessionRoutes({
        ptyManager: ptyManager as never,
        terminalManager: terminalManager as never,
        remoteRegistry: null,
        isHQMode: false,
      });
      const listRoute = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { get?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.get);
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response & {
        json: ReturnType<typeof vi.fn>;
      };
      await listRoute?.route?.stack[0].handle({} as Request, res);

      const sessions = res.json.mock.calls[0][0] as Array<{ id: string; lastLine?: string }>;
      expect(Object.fromEntries(sessions.map((s) => [s.id, s.lastLine]))).toEqual({
        shell: '✓ 12 passed',
        claude: undefined,
        done: undefined,
      });
      expect(terminalManager.getBufferSnapshot).toHaveBeenCalledTimes(1);
    });

    it('2026-11-08: a Claude session gets its card line in the asked language, from the cache', async () => {
      const busy = new Map([[2, { status: 'busy' }]]);
      vi.mocked(readClaudeStatuses).mockResolvedValueOnce(busy).mockResolvedValueOnce(busy);
      const ptyManager = {
        ...mockPtyManager,
        listSessions: vi.fn(() => [
          { id: 'shell', pid: 1, status: 'running', command: ['zsh'] },
          { id: 'claude', pid: 2, status: 'running', command: ['claude'] },
        ]),
        programRootPid: vi.fn((session: { pid: number }) => session.pid),
        getSession: vi.fn(() => undefined),
      };
      const ask = vi.fn(async (_system: string, _question: string) => 'Ejecuta los tests');
      const router = createSessionRoutes({
        ptyManager: ptyManager as never,
        terminalManager: {
          canSnapshotCheaply: vi.fn(() => false),
          getChangeCount: vi.fn(() => 0),
        } as never,
        remoteRegistry: null,
        isHQMode: false,
        agentExplain: { ask, enabled: () => true },
      });
      const listRoute = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { get?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.get);
      const list = async () => {
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response & {
          json: ReturnType<typeof vi.fn>;
        };
        await listRoute?.route?.stack[0].handle(
          { query: { lang: 'es' } } as unknown as Request,
          res
        );
        return res.json.mock.calls[0][0] as Array<{ id: string; explain?: { text: string } }>;
      };
      // The list never waits for the model: the first answer has no line yet.
      expect((await list()).find((s) => s.id === 'claude')?.explain).toBeUndefined();
      await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
      expect(ask.mock.calls[0][1]).toContain('Language: Spanish');
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = await list();
      expect(second.find((s) => s.id === 'claude')?.explain?.text).toBe('Ejecuta los tests');
      // A shell has no agent to explain; nothing changed, so no second call.
      expect(second.find((s) => s.id === 'shell')?.explain).toBeUndefined();
      expect(ask).toHaveBeenCalledTimes(1);
    });

    it("builds a long waiting session's terminal off the list request, for its quick answers", async () => {
      // A 19 MB recording was too big to replay inside a list poll, and nothing else built the
      // terminal: after a restart that Claude had no quick answers until opened (2026-10-03).
      const waiting = new Map([[2, { status: 'waiting', waitingFor: 'permission' }]]);
      vi.mocked(readClaudeStatuses).mockResolvedValueOnce(waiting).mockResolvedValueOnce(waiting);
      let built = false;
      const row = (text: string) => [...text].map((char) => ({ char }));
      const terminalManager = {
        // Not cheap at the poll's 2 MB, fine for a one-off replay, cheap once built.
        canSnapshotCheaply: vi.fn(
          (_id: string, max = 2 * 1024 * 1024) => built || max > 2 * 1024 * 1024
        ),
        getChangeCount: vi.fn(() => 1),
        getBufferSnapshot: vi.fn(async () => {
          built = true;
          return {
            cells: [row(' Do you want to proceed?'), row(' ❯ 1. Yes'), row('   2. No')],
            cols: 80,
            rows: 3,
          };
        }),
        // Its menu, read once the terminal is built.
        getRecentText: vi.fn(async () => ({
          text: [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n'),
          rows: 3,
          cols: 80,
          wrappedRows: [false, false, false],
        })),
      };
      const router = createSessionRoutes({
        ptyManager: {
          ...mockPtyManager,
          listSessions: vi.fn(() => [
            { id: 'claude', pid: 2, status: 'running', command: ['claude'] },
          ]),
        } as never,
        terminalManager: terminalManager as never,
        remoteRegistry: null,
        isHQMode: false,
      });
      const listRoute = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { get?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.get);
      const list = async () => {
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response & {
          json: ReturnType<typeof vi.fn>;
        };
        await listRoute?.route?.stack[0].handle({} as Request, res);
        return res.json.mock.calls[0][0] as Array<{ claudeStatus?: { choices?: unknown } }>;
      };

      expect((await list())[0].claudeStatus?.choices).toBeUndefined();
      await vi.waitFor(() => expect(built).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 2100)); // past the 2 s choices cache
      expect((await list())[0].claudeStatus?.choices).toMatchObject({
        question: 'Do you want to proceed?',
      });
    });

    it('warms long waiting sessions one at a time, never several replays at once', async () => {
      // Each replay blocks the server; three warmed in one tick added up (review of 2026-10-03).
      const waiting = new Map([
        [1, { status: 'waiting' }],
        [2, { status: 'waiting' }],
        [3, { status: 'waiting' }],
      ]);
      vi.mocked(readClaudeStatuses).mockResolvedValueOnce(waiting);
      let running = 0;
      let overlapped = false;
      const done: string[] = [];
      const terminalManager = {
        canSnapshotCheaply: vi.fn((_id: string, max = 2 * 1024 * 1024) => max > 2 * 1024 * 1024),
        getChangeCount: vi.fn(() => 1),
        getBufferSnapshot: vi.fn(async (id: string) => {
          running++;
          if (running > 1) overlapped = true;
          await new Promise((resolve) => setTimeout(resolve, 30));
          running--;
          done.push(id);
          return { cells: [], cols: 80, rows: 0 };
        }),
      };
      const router = createSessionRoutes({
        ptyManager: {
          ...mockPtyManager,
          listSessions: vi.fn(() =>
            [1, 2, 3].map((pid) => ({ id: `s${pid}`, pid, status: 'running', command: ['claude'] }))
          ),
        } as never,
        terminalManager: terminalManager as never,
        remoteRegistry: null,
        isHQMode: false,
      });
      const listRoute = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { get?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.get);
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response;
      await listRoute?.route?.stack[0].handle({} as Request, res);
      await vi.waitFor(() => expect(done).toHaveLength(3), { timeout: 3000 });
      expect(overlapped).toBe(false);
    });

    it('finds Claude inside a shielded session under the program in tmux, not the client', async () => {
      // pid 50 is the tmux attach client; Claude runs under the pane program, pid 77.
      vi.mocked(readClaudeStatuses).mockResolvedValueOnce(
        new Map([[77, { status: 'idle', sessionId: 'conv-9' }]])
      );
      const setClaudeSessionId = vi.fn(() => ({ userTitle: 'ATLAS' }));
      const ptyManager = {
        ...mockPtyManager,
        listSessions: vi.fn(() => [
          { id: 'sh', pid: 50, status: 'running', command: ['claude'], shielded: true },
        ]),
        programRootPid: vi.fn((session: { shielded?: boolean; pid?: number }) =>
          session.shielded ? 77 : session.pid
        ),
        setClaudeSessionId,
      };
      const router = createSessionRoutes({
        ptyManager: ptyManager as never,
        terminalManager: mockTerminalManager as never,
        remoteRegistry: null,
        isHQMode: false,
      });
      const listRoute = (
        router as unknown as {
          stack: Array<{
            route?: {
              path: string;
              methods: { get?: boolean };
              stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === '/sessions' && r.route.methods.get);
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response & {
        json: ReturnType<typeof vi.fn>;
      };
      await listRoute?.route?.stack[0].handle({} as Request, res);

      expect(vi.mocked(readClaudeStatuses)).toHaveBeenLastCalledWith([77]);
      expect(setClaudeSessionId).toHaveBeenCalledWith('sh', 'conv-9');
      // The conversation's earlier session had a title from the user: the list shows it now.
      expect((res.json.mock.calls[0][0] as Array<{ userTitle?: string }>)[0].userTitle).toBe(
        'ATLAS'
      );
      const sessions = res.json.mock.calls[0][0] as Array<{ claudeStatus?: { status: string } }>;
      expect(sessions[0].claudeStatus?.status).toBe('idle');
    });
  });

  describe('GET /sessions/:sessionId/claude-chat', () => {
    it('serves a Codex session from its rollout, in the chat shape, with agent "codex"', async () => {
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-route-test-'));
      const previous = process.env.CODEX_HOME;
      process.env.CODEX_HOME = codexHome;
      try {
        const started = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const dayDir = path.join(
          codexHome,
          'sessions',
          String(started.getFullYear()),
          pad(started.getMonth() + 1),
          pad(started.getDate())
        );
        fs.mkdirSync(dayDir, { recursive: true });
        const stamp = started.toISOString();
        fs.writeFileSync(
          path.join(dayDir, 'rollout-test.jsonl'),
          `${[
            { type: 'session_meta', payload: { id: 'x', timestamp: stamp, cwd: '/test/codex' } },
            {
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hi' }],
              },
            },
          ]
            .map((entry) => JSON.stringify({ timestamp: stamp, ...entry }))
            .join('\n')}\n`
        );
        const router = createSessionRoutes({
          ptyManager: {
            ...mockPtyManager,
            getSession: vi.fn(() => ({
              id: 'codex-route-1',
              pid: 4242,
              status: 'running',
              command: ['codex'],
              workingDir: '/test/codex',
              startedAt: stamp,
            })),
          } as never,
          terminalManager: mockTerminalManager as never,
          remoteRegistry: null,
          isHQMode: false,
        });
        const route = (
          router as unknown as {
            stack: Array<{
              route?: {
                path: string;
                methods: { get?: boolean };
                stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
              };
            }>;
          }
        ).stack.find((r) => r.route?.path === '/sessions/:sessionId/claude-chat');
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response;
        await route?.route?.stack[0].handle(
          { params: { sessionId: 'codex-route-1' } } as unknown as Request,
          res
        );
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            available: true,
            agent: 'codex',
            title: 'hi',
            messages: [expect.objectContaining({ role: 'user', text: 'hi' })],
            messagesVersion: expect.any(String),
          })
        );

        // The phone sends back the fingerprint it has: the unchanged list is left out.
        const { messagesVersion } = vi.mocked(res.json).mock.calls[0][0] as {
          messagesVersion: string;
        };
        const again = { json: vi.fn(), status: vi.fn().mockReturnThis() } as unknown as Response;
        await route?.route?.stack[0].handle(
          {
            params: { sessionId: 'codex-route-1' },
            query: { have: messagesVersion },
          } as unknown as Request,
          again
        );
        const answer = vi.mocked(again.json).mock.calls[0][0] as Record<string, unknown>;
        expect(answer).toMatchObject({ available: true, agent: 'codex', messagesUnchanged: true });
        expect(answer.messages).toBeUndefined();
      } finally {
        if (previous === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous;
        fs.rmSync(codexHome, RM_TEST_DIR);
      }
    });
  });

  describe('sessions attached to a tmux session', () => {
    type Handler = (req: Request, res: Response) => Promise<void>;
    const handlerOf = (router: unknown, method: 'get' | 'post' | 'delete', path: string) => {
      const layer = (
        router as {
          stack: Array<{
            route?: {
              path: string;
              methods: Record<string, boolean>;
              stack: Array<{ handle: Handler }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === path && r.route.methods[method]);
      if (!layer?.route) throw new Error(`no route ${method} ${path}`);
      return layer.route.stack[0].handle;
    };
    const mockRes = () =>
      ({ json: vi.fn(), status: vi.fn().mockReturnThis() }) as unknown as Response & {
        json: ReturnType<typeof vi.fn>;
        status: ReturnType<typeof vi.fn>;
      };
    // Opened from "On this Mac": named after the tmux session, never "tmux: …" on purpose here.
    const attached = {
      id: 'attached-1',
      name: 'work',
      status: 'running',
      pid: 600,
      command: ['/usr/bin/tmux', '-u', '-N', '-S', '/tmp/tmux-501/default', 'attach-session'],
      workingDir: '/test/attached',
      multiplexer: {
        type: 'tmux',
        socketPath: '/tmp/tmux-501/default',
        serverPid: 90,
        serverStartedAt: 1_790_000_000,
        sessionId: '$0',
        sessionName: 'work',
        mode: 'control',
        sizing: 'others',
        source: 'mac-sessions',
      },
    };
    const routes = (ptyManager: object) =>
      createSessionRoutes({
        ptyManager: { ...mockPtyManager, ...ptyManager } as never,
        terminalManager: mockTerminalManager as never,
        remoteRegistry: null,
        isHQMode: false,
      });

    it('detaches when closed: the tmux session keeps running', async () => {
      const killSession = vi.fn(async () => {});
      const router = routes({ getSession: vi.fn(() => attached), killSession });
      const res = mockRes();
      await handlerOf(
        router,
        'delete',
        '/sessions/:sessionId'
      )({ params: { sessionId: attached.id } } as unknown as Request, res);
      expect(killSession).toHaveBeenCalledWith(attached.id, 'SIGTERM');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Detached from tmux session',
      });
    });

    it('is never shielded, running or exited', async () => {
      for (const status of ['running', 'exited']) {
        const killSession = vi.fn();
        const createSession = vi.fn();
        const router = routes({
          getSession: vi.fn(() => ({ ...attached, status, claudeSessionId: 'conv-1' })),
          isShieldAvailable: vi.fn(() => true),
          killSession,
          createSession,
        });
        const res = mockRes();
        await handlerOf(
          router,
          'post',
          '/sessions/:sessionId/shield'
        )({ params: { sessionId: attached.id }, body: {} } as unknown as Request, res);
        expect(res.status).toHaveBeenCalledWith(409);
        expect(killSession).not.toHaveBeenCalled();
        expect(createSession).not.toHaveBeenCalled();
      }
    });

    it('is never resumable once exited: its Claude still runs in tmux', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const os = await import('os');
      const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-resumable-')));
      // The conversations exist, as Claude Code keeps them.
      const projectDir = path.join(
        claudeConfigDir(),
        'projects',
        folder.replace(/[^A-Za-z0-9]/g, '-')
      );
      fs.mkdirSync(projectDir, { recursive: true });
      for (const id of ['conv-attached', 'conv-plain', 'conv-gone']) {
        fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), '');
      }
      try {
        const router = routes({
          listSessions: vi.fn(() => [
            { ...attached, status: 'exited', claudeSessionId: 'conv-attached' },
            {
              id: 'plain',
              status: 'exited',
              command: ['claude'],
              workingDir: folder,
              claudeSessionId: 'conv-plain',
            },
            // A merged task's session: its worktree was removed.
            {
              id: 'gone',
              status: 'exited',
              command: ['claude'],
              workingDir: path.join(folder, 'removed-worktree'),
              claudeSessionId: 'conv-gone',
            },
          ]),
        });
        const res = mockRes();
        await handlerOf(router, 'get', '/sessions')({} as Request, res);
        const sessions = res.json.mock.calls[0][0] as Array<{
          id: string;
          claudeResumable?: boolean;
        }>;
        expect(Object.fromEntries(sessions.map((s) => [s.id, s.claudeResumable]))).toEqual({
          'attached-1': false,
          plain: true,
          gone: false,
        });
      } finally {
        fs.rmSync(projectDir, RM_TEST_DIR);
        fs.rmSync(folder, RM_TEST_DIR);
      }
    });
  });

  describe('sessions opened with ut in a terminal window', () => {
    type Handler = (req: Request, res: Response) => Promise<void>;
    const handlerOf = (router: unknown, path: string) => {
      const layer = (
        router as {
          stack: Array<{
            route?: {
              path: string;
              methods: Record<string, boolean>;
              stack: Array<{ handle: Handler }>;
            };
          }>;
        }
      ).stack.find((r) => r.route?.path === path && r.route.methods.get);
      if (!layer?.route) throw new Error(`no route get ${path}`);
      return layer.route.stack[0].handle;
    };
    const mockRes = () =>
      ({ json: vi.fn(), status: vi.fn().mockReturnThis() }) as unknown as Response & {
        json: ReturnType<typeof vi.fn>;
      };
    // pids no process on this machine has: nothing real is looked at.
    const inWindow = {
      id: 'fwd_1759500000000_4000005',
      name: 'claude',
      status: 'running',
      pid: 4_000_010,
      command: ['claude'],
      workingDir: '/test/fwd',
    };
    const web = { ...inWindow, id: 'web-1', pid: 4_000_020 };

    it('says which app the window belongs to, without waiting for it', async () => {
      let found: (app: string | null) => void = () => {};
      const hostApp = vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            found = resolve;
          })
      );
      const macWindows = new MacWindowApps(hostApp);
      const router = createSessionRoutes({
        ptyManager: {
          ...mockPtyManager,
          listSessions: vi.fn(() => [inWindow, web]),
          getSession: vi.fn((id: string) => [inWindow, web].find((s) => s.id === id) ?? null),
        } as never,
        terminalManager: mockTerminalManager as never,
        remoteRegistry: null,
        isHQMode: false,
        macWindows,
      });
      const list = async () => {
        const res = mockRes();
        await handlerOf(router, '/sessions')({} as Request, res);
        const sessions = res.json.mock.calls[0][0] as Array<{
          id: string;
          macWindow?: { app: string | null };
        }>;
        return Object.fromEntries(sessions.map((s) => [s.id, s.macWindow]));
      };
      const one = async (sessionId: string) => {
        const res = mockRes();
        await handlerOf(router, '/sessions/:sessionId')(
          { params: { sessionId } } as unknown as Request,
          res
        );
        return (res.json.mock.calls[0][0] as { macWindow?: { app: string | null } }).macWindow;
      };

      // The lookup hasn't answered: the list doesn't wait for it.
      expect(await list()).toEqual({ [inWindow.id]: { app: null }, 'web-1': undefined });
      expect(hostApp).toHaveBeenCalledWith(inWindow.pid);

      found('Terminal');
      await macWindows.settled();
      expect(await list()).toEqual({ [inWindow.id]: { app: 'Terminal' }, 'web-1': undefined });
      expect(await one(inWindow.id)).toEqual({ app: 'Terminal' });
      expect(await one('web-1')).toBeUndefined();
    });
  });

  describe('POST /cleanup-exited in HQ mode', () => {
    type Handler = (req: Request, res: Response) => Promise<void>;
    const handlerOf = (router: unknown, path: string): Handler => {
      const layer = (
        router as { stack: Array<{ route?: { path: string; stack: Array<{ handle: Handler }> } }> }
      ).stack.find((r) => r.route?.path === path);
      if (!layer?.route) throw new Error(`no route ${path}`);
      return layer.route.stack[0].handle;
    };

    it('says how many exited sessions were kept and why', async () => {
      const router = createSessionRoutes({
        ptyManager: {
          cleanupExitedSessions: vi.fn(
            (options: { onKept?: (session: unknown, reason: string) => void }) => {
              options.onKept?.({ id: 'a' }, 'claude');
              options.onKept?.({ id: 'b' }, 'claude');
              options.onKept?.({ id: 'c' }, 'task');
              return ['gone'];
            }
          ),
        } as never,
        terminalManager: mockTerminalManager as never,
        remoteRegistry: null,
        isHQMode: false,
        keepOnExitedCleanup: () => false,
      });
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      await handlerOf(router, '/cleanup-exited')({ query: {} } as never, res as never);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          cleanedSessions: ['gone'],
          kept: 3,
          keptReasons: { claude: 2, codex: 0, task: 1, shielded: 0 },
        })
      );
    });

    it('forgets the sessions each remote removed', async () => {
      // The remote is another Untether server running this same route.
      const remoteRouter = createSessionRoutes({
        ptyManager: { cleanupExitedSessions: vi.fn(() => ['r-1', 'r-2']) } as never,
        terminalManager: mockTerminalManager as never,
        remoteRegistry: null,
        isHQMode: false,
      });
      const remoteRes = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      await handlerOf(remoteRouter, '/cleanup-exited')({} as Request, remoteRes as never);
      const remoteBody = remoteRes.json.mock.calls[0][0];

      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => remoteBody }));
      vi.stubGlobal('fetch', fetchMock);
      try {
        const remoteRegistry = {
          getRemotes: vi.fn(() => [
            { id: 'remote-1', name: 'mini', url: 'http://mini', token: 't' },
          ]),
          removeSessionFromRemote: vi.fn(),
        };
        const hqRouter = createSessionRoutes({
          ptyManager: { cleanupExitedSessions: vi.fn(() => []) } as never,
          terminalManager: mockTerminalManager as never,
          remoteRegistry: remoteRegistry as never,
          isHQMode: true,
        });
        const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
        await handlerOf(hqRouter, '/cleanup-exited')({} as Request, res as never);

        // Only as sessions of the remote that reported them.
        expect(remoteRegistry.removeSessionFromRemote).toHaveBeenCalledWith('r-1', 'remote-1');
        expect(remoteRegistry.removeSessionFromRemote).toHaveBeenCalledWith('r-2', 'remote-1');
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ remoteResults: [{ remoteName: 'mini', cleaned: 2 }] })
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
