/**
 * Factory functions for creating test data with sensible defaults
 * This helps reduce duplication and makes tests more maintainable
 */

import type { TaskRecord } from '@/shared/tasks';
import type { Session } from '@/shared/types';

interface CreateSessionOptions {
  id?: string;
  name?: string;
  command?: string[];
  workingDir?: string;
  /** A session status, or 'stopped' (an exited session). */
  status?: Session['status'] | 'stopped';
  exitCode?: number;
  startedAt?: string;
  pid?: number;
  lastModified?: string;
  active?: boolean;
  source?: 'local' | 'remote';
  remoteId?: string;
  remoteName?: string;
  remoteUrl?: string;
  // Git-related properties
  gitBranch?: string;
  gitAheadCount?: number;
  gitBehindCount?: number;
  gitHasChanges?: boolean;
  gitIsWorktree?: boolean;
}

interface CreateAuthConfigOptions {
  enableSSHKeys?: boolean;
  disallowUserPassword?: boolean;
  noAuth?: boolean;
  passwordAuthMode?: 'system' | 'configured';
}

interface CreateAuthResultOptions {
  success?: boolean;
  error?: string;
  userId?: string;
  authMethod?: string;
  token?: string;
}

let sessionCounter = 1;

/**
 * Creates a test session with sensible defaults
 */
/**
 * Recent, and the same for every session. 2026-11-09: each took the time it was made, and two made
 * across a millisecond boundary (a loaded Mac) stopped being tied in tests that order by activity.
 */
const SESSION_TIME = new Date().toISOString();

export function createTestSession(options: CreateSessionOptions = {}): Session {
  const id = options.id || `test-session-${sessionCounter++}`;

  return {
    id,
    name: options.name || `Test Session ${id}`,
    command: options.command || ['/bin/bash', '-l'],
    workingDir: options.workingDir || '/home/test',
    status: options.status === 'stopped' ? 'exited' : options.status || 'running',
    exitCode: options.exitCode,
    startedAt: options.startedAt || SESSION_TIME,
    pid: options.pid || 12345 + sessionCounter,
    lastModified: options.lastModified || SESSION_TIME,
    active: options.active !== undefined ? options.active : true,
    source: options.source || 'local',
    remoteId: options.remoteId,
    remoteName: options.remoteName,
    remoteUrl: options.remoteUrl,
    // Git-related properties
    gitBranch: options.gitBranch,
    gitAheadCount: options.gitAheadCount,
    gitBehindCount: options.gitBehindCount,
    gitHasChanges: options.gitHasChanges,
    gitIsWorktree: options.gitIsWorktree,
  };
}

/**
 * Creates multiple test sessions
 */
export function createTestSessions(count: number, options: CreateSessionOptions = {}): Session[] {
  return Array.from({ length: count }, (_, i) =>
    createTestSession({
      ...options,
      id: options.id ? `${options.id}-${i + 1}` : undefined,
      name: options.name ? `${options.name} ${i + 1}` : undefined,
    })
  );
}

/**
 * Creates auth configuration for testing
 */
export function createAuthConfig(options: CreateAuthConfigOptions = {}): CreateAuthConfigOptions {
  return {
    enableSSHKeys: options.enableSSHKeys !== undefined ? options.enableSSHKeys : false,
    disallowUserPassword:
      options.disallowUserPassword !== undefined ? options.disallowUserPassword : false,
    noAuth: options.noAuth !== undefined ? options.noAuth : false,
    passwordAuthMode: options.passwordAuthMode || 'system',
  };
}

/**
 * Creates auth result for testing
 */
export function createAuthResult(options: CreateAuthResultOptions = {}): CreateAuthResultOptions {
  return {
    success: options.success !== undefined ? options.success : true,
    error: options.error,
    userId: options.userId || 'testuser',
    authMethod: options.authMethod || 'password',
    token: options.token || `test-token-${Math.random().toString(36).substr(2, 9)}`,
  };
}

/**
 * Creates localStorage data for untether
 */
export function createLocalStorageData(commands: string[] = []): Record<string, string> {
  const defaultCommands =
    commands.length > 0 ? commands : ['npm run dev', 'git status', 'pnpm test'];

  return {
    'untether-commands': JSON.stringify(defaultCommands),
    'untether-token': 'test-auth-token',
    'untether-user': 'testuser',
  };
}

/**
 * Creates WebSocket mock data
 */
export function createWebSocketMessage(type: string, data: unknown = {}): string {
  return JSON.stringify({ type, data });
}

/**
 * Reset factory counters (useful for test isolation)
 */
export function resetFactoryCounters(): void {
  sessionCounter = 1;
}

/**
 * A worktree task as GET /api/tasks lists it (shared/tasks.ts), working in its own branch of
 * /repos/app unless overridden.
 */
export function createTestTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  const id = overrides.id ?? `task-${sessionCounter++}`;
  return {
    id,
    name: 'Login con Google',
    prompt: 'Añade login con Google',
    workingDir: '/repos/app',
    command: ['claude'],
    agent: 'claude',
    shielded: false,
    notify: true,
    runAt: now,
    createdAt: now,
    state: 'working',
    stateSince: now,
    isolation: 'worktree',
    origin: 'user',
    repoPath: '/repos/app',
    baseBranch: 'main',
    branch: 'ut/login-google',
    worktreePath: '/repos/.untether-worktrees/app/login-google',
    followUps: [],
    files: [],
    ...overrides,
  };
}
