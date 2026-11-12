/**
 * Tasks of one project that change the same files (2026-11-11, task-scheduler-overlap.ts).
 * 10/11 Nov: two bakery tasks spent 1 h 28 min and 1 h 53 min on conflicts with their work
 * already done, and Untether's own tasks collided three times in a day; each learned what the
 * others had merged only at its own merge.
 *
 * - the git side with real repositories (worktreeTouched, syncWithBase): what a folder touches,
 *   and that bringing it up to date never touches uncommitted work;
 * - the scheduler with fakes: the overlap shown and told once per pair, the cheap looks, the
 *   merge of the base at a gap of the agent only, the conflict told once;
 * - the measurement: two tasks on one file with real git, conflict rounds at the merge with
 *   baseSync off (before) and on (after).
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../shared/projects.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { formatTaskDetail } from '../task-cli/format-task-detail.js';
import { formatTaskLine } from '../task-cli/format-task-line.js';
import { AgentStateTracker } from './agent-events.js';
import { TOOL_HOLD_FILE, TOOL_HOLD_MAX_MS } from './task-guard.js';
import { runGuardHook } from './task-guard-hook.js';
import { createTaskGuard } from './task-guard-setup.js';
import type { PipelineResult, PipelineTask } from './task-merge.js';
import {
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';
import {
  BASE_SYNC_CONFLICT_RETRY_MS,
  BASE_SYNC_RETRY_MS,
  OVERLAP_LOOK_MS,
} from './task-scheduler-overlap.js';
import {
  type BaseSyncResult,
  branchChanges,
  syncWithBase,
  worktreeTouched,
} from './task-worktree.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return childProcess
    .execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } })
    .toString()
    .trim();
}

const CONFIG = ['name = app', 'limit = 10', '', '# a', '# b', '# c', '# d', '', 'mode = fast', ''];

/** A repository on `main` with one commit, and a way to make task worktrees of it. */
function makeRepo(tmp: string) {
  const repo = path.join(tmp, 'app');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'config.txt'), CONFIG.join('\n'));
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  let n = 0;
  const worktree = () => {
    const branch = `ut/t${++n}`;
    const dir = path.join(tmp, `wt${n}`);
    git(repo, 'worktree', 'add', '-q', '-b', branch, dir, 'main');
    return { dir, branch };
  };
  return { repo, worktree };
}

const read = (dir: string, file = 'config.txt') => fs.readFileSync(path.join(dir, file), 'utf8');
const write = (dir: string, file: string, text: string) =>
  fs.writeFileSync(path.join(dir, file), text);
/** Rewrites the line that starts with `start` (as an agent editing what it sees would). */
const editLine = (dir: string, start: string, to: (line: string) => string) =>
  write(
    dir,
    'config.txt',
    read(dir)
      .split('\n')
      .map((line) => (line.startsWith(start) ? to(line) : line))
      .join('\n')
  );
const commit = (dir: string, message: string) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
};

function withGitEnv() {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    // run() inherits process.env: commits made by the module need an identity too.
    for (const [key, value] of Object.entries(GIT_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

describe('a task worktree against its base (git)', () => {
  let tmp: string;
  let repo: string;
  let worktree: () => { dir: string; branch: string };
  withGitEnv();

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-overlap-git-')));
    ({ repo, worktree } = makeRepo(tmp));
  });

  afterEach(() => {
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  /** Another task merged into main: `limit` changed there. */
  const mainMoves = (to = 'limit = 20') => {
    editLine(repo, 'limit =', () => to);
    commit(repo, 'another task');
    return git(repo, 'rev-parse', 'HEAD');
  };

  it('worktreeTouched: committed, uncommitted and new files; not what came with the base', async () => {
    const { dir } = worktree();
    expect(await worktreeTouched(dir, 'refs/heads/main')).toEqual([]);
    editLine(dir, 'mode =', () => 'mode = safe');
    commit(dir, 'mine');
    write(dir, 'other.txt', 'changed, not committed\n');
    write(dir, 'new.txt', 'not tracked yet\n');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    write(dir, 'node_modules/x.js', 'ignored');
    expect(await worktreeTouched(dir, 'refs/heads/main')).toEqual([
      'config.txt',
      'new.txt',
      'other.txt',
    ]);
    // The base moves and is merged in: its files are not this task's.
    write(repo, 'theirs.txt', 'theirs\n');
    commit(repo, 'another task');
    git(dir, 'checkout', '-q', '--', 'other.txt');
    git(dir, 'merge', '-q', '--no-edit', 'main');
    expect(await worktreeTouched(dir, 'refs/heads/main')).toEqual(['config.txt', 'new.txt']);
    // A rename counts as both paths: someone editing the old one meets it too.
    git(dir, 'mv', 'other.txt', 'renamed.txt');
    expect(await worktreeTouched(dir, 'refs/heads/main')).toEqual([
      'config.txt',
      'new.txt',
      'other.txt',
      'renamed.txt',
    ]);
    expect(await worktreeTouched(dir, 'refs/heads/nope')).toBeNull();
  });

  it('syncWithBase: nothing moved → current; a clean merge goes in, untracked files untouched', async () => {
    const { dir } = worktree();
    editLine(dir, 'mode =', () => 'mode = safe');
    commit(dir, 'mine');
    expect(await syncWithBase(dir, 'main')).toMatchObject({ kind: 'current' });
    const base = mainMoves();
    write(dir, 'new.txt', 'not tracked yet\n');
    const result = await syncWithBase(dir, 'main');
    expect(result).toMatchObject({ kind: 'merged', base, files: ['config.txt'] });
    expect(read(dir)).toContain('limit = 20');
    expect(read(dir)).toContain('mode = safe');
    expect(read(dir, 'new.txt')).toBe('not tracked yet\n');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Merge main into ut/t1');
    expect(git(dir, 'status', '--porcelain')).toBe('?? new.txt');
    expect(await syncWithBase(dir, 'main')).toMatchObject({ kind: 'current', base });
  });

  it('syncWithBase: uncommitted work is never touched (dirty), whatever file it is in', async () => {
    const { dir } = worktree();
    mainMoves();
    const head = git(dir, 'rev-parse', 'HEAD');
    // Not even in a file the merge does not change.
    write(dir, 'other.txt', 'work in progress\n');
    expect(await syncWithBase(dir, 'main')).toEqual({ kind: 'dirty', files: ['other.txt'] });
    git(dir, 'add', 'other.txt');
    expect(await syncWithBase(dir, 'main')).toEqual({ kind: 'dirty', files: ['other.txt'] });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(read(dir, 'other.txt')).toBe('work in progress\n');
    expect(read(dir)).toContain('limit = 10');
  });

  it('syncWithBase: a conflict changes nothing and names its files', async () => {
    const { dir } = worktree();
    editLine(dir, 'limit =', () => 'limit = 15');
    commit(dir, 'mine');
    const head = git(dir, 'rev-parse', 'HEAD');
    const base = mainMoves();
    expect(await syncWithBase(dir, 'main')).toEqual({
      kind: 'conflict',
      base,
      files: ['config.txt'],
    });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(read(dir)).toContain('limit = 15');
  });

  it('syncWithBase: the agent took up a tool again, or has a merge of its own going: nothing', async () => {
    const { dir } = worktree();
    editLine(dir, 'mode =', () => 'mode = safe');
    commit(dir, 'mine');
    mainMoves();
    const head = git(dir, 'rev-parse', 'HEAD');
    expect(await syncWithBase(dir, 'main', { stillFree: () => false })).toMatchObject({
      kind: 'busy',
    });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    // Its own merge, stopped on a conflict it is resolving.
    editLine(dir, 'limit =', () => 'limit = 15');
    commit(dir, 'mine too');
    expect(() => git(dir, 'merge', '--no-edit', 'main')).toThrow();
    const status = git(dir, 'status', '--porcelain');
    expect(await syncWithBase(dir, 'main')).toMatchObject({ kind: 'busy' });
    expect(git(dir, 'status', '--porcelain')).toBe(status);
  });

  // 2026-11-11: this task's own merge stopped on a stale index.lock in its worktree.
  it("the looks never write the agent's index (no index.lock taken, none left behind)", async () => {
    const { dir } = worktree();
    editLine(dir, 'limit =', () => 'limit = 15');
    commit(dir, 'mine');
    mainMoves();
    // Same content, newer time: a plain `git status` or `git diff` would refresh the index.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'config.txt'), later, later);
    fs.utimesSync(path.join(dir, 'other.txt'), later, later);
    const index = path.resolve(dir, git(dir, 'rev-parse', '--git-path', 'index'));
    const before = fs.readFileSync(index);
    expect(await worktreeTouched(dir, 'refs/heads/main')).toEqual(['config.txt']);
    expect(fs.readFileSync(index).equals(before), 'after worktreeTouched').toBe(true);
    expect(await syncWithBase(dir, 'main')).toMatchObject({ kind: 'conflict' });
    expect(fs.readFileSync(index).equals(before), 'after syncWithBase').toBe(true);
    // And they still answer while the agent's own git holds the lock.
    fs.writeFileSync(`${index}.lock`, '');
    expect(await worktreeTouched(dir, 'refs/heads/main')).toEqual(['config.txt']);
    expect(await syncWithBase(dir, 'main')).toMatchObject({ kind: 'conflict' });
    expect(fs.readFileSync(`${index}.lock`, 'utf8')).toBe('');
  });

  it('syncWithBase: a staged rename is dirty too, both its paths named whole', async () => {
    const { dir } = worktree();
    mainMoves();
    git(dir, 'mv', 'other.txt', 'o.txt');
    expect(await syncWithBase(dir, 'main')).toEqual({
      kind: 'dirty',
      files: ['o.txt', 'other.txt'],
    });
  });

  it("syncWithBase: the merge runs only while the agent's tool calls are held; no hold, no merge", async () => {
    const { dir } = worktree();
    editLine(dir, 'mode =', () => 'mode = safe');
    commit(dir, 'mine');
    mainMoves();
    const head = git(dir, 'rev-parse', 'HEAD');
    // An unguarded session: nothing would keep a tool call from starting mid-merge.
    expect(await syncWithBase(dir, 'main', { hold: () => null })).toMatchObject({ kind: 'busy' });
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    // Held: the gap and the folder are looked at again inside the hold, and it is lifted after.
    const order: string[] = [];
    const held = {
      hold: () => {
        order.push('hold');
        return () => order.push('release');
      },
      stillFree: () => {
        order.push(`free, head ${git(dir, 'rev-parse', 'HEAD') === head ? 'as it was' : 'moved'}`);
        return true;
      },
      settleMs: 0,
    };
    expect(await syncWithBase(dir, 'main', held)).toMatchObject({ kind: 'merged' });
    expect(order).toEqual(['hold', 'free, head as it was', 'release']);
    expect(read(dir)).toContain('limit = 20');
  });

  it('syncWithBase: an edit or a commit that lands before the hold took effect stops the merge, and the hold is lifted', async () => {
    const { dir } = worktree();
    mainMoves();
    const lifted: string[] = [];
    // The agent's call had passed its hook just before the hold: it wrote during the settle.
    const edits = {
      hold: () => {
        write(dir, 'config.txt', `${read(dir)}# being edited\n`);
        return () => lifted.push('edit');
      },
      settleMs: 0,
    };
    expect(await syncWithBase(dir, 'main', edits)).toEqual({
      kind: 'dirty',
      files: ['config.txt'],
    });
    expect(read(dir)).toContain('# being edited');
    expect(read(dir)).toContain('limit = 10');
    commit(dir, 'the edit');
    const commits = {
      hold: () => {
        write(dir, 'other.txt', 'more\n');
        commit(dir, 'committed meanwhile');
        return () => lifted.push('commit');
      },
      settleMs: 0,
    };
    expect(await syncWithBase(dir, 'main', commits)).toMatchObject({ kind: 'busy' });
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('committed meanwhile');
    expect(lifted).toEqual(['edit', 'commit']);
  });

  it('syncWithBase: an untracked file in the way of the merge is kept (git refuses, nothing half done)', async () => {
    const { dir } = worktree();
    write(repo, 'new.txt', 'theirs\n');
    commit(repo, 'another task adds new.txt');
    const head = git(dir, 'rev-parse', 'HEAD');
    write(dir, 'new.txt', 'mine, not tracked yet\n');
    expect(await syncWithBase(dir, 'main')).toMatchObject({ kind: 'busy' });
    expect(read(dir, 'new.txt')).toBe('mine, not tracked yet\n');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(dir, 'status', '--porcelain')).toBe('?? new.txt');
  });
});

describe("holding a task agent's tool calls (task guard)", () => {
  let dir: string;
  const holdFile = () => path.join(dir, 'agent-hooks', 'tasks', 'abc123', TOOL_HOLD_FILE);
  const guarded = () => {
    const guard = createTaskGuard({
      untetherDir: dir,
      home: '/Users/x',
      hook: ['/usr/bin/node', '/x/task-guard-hook.ts'],
    });
    const record = {
      id: 'abc123',
      name: 'x',
      prompt: 'p',
      workingDir: '/repo',
      command: ['claude'],
      agent: 'claude',
      isolation: 'worktree',
      repoPath: '/repo',
      baseBranch: 'main',
      branch: 'ut/x',
      worktreePath: '/wt/x',
      followUps: [],
      files: [],
    } as unknown as TaskRecord;
    return { guard, record };
  };
  const call = () =>
    runGuardHook(
      path.join(dir, 'agent-hooks', 'tasks', 'abc123', 'policy.json'),
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: '/wt/x' }),
      () => {},
      () => {}
    );

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-tool-hold-'));
  });

  afterEach(() => {
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('a guarded session: the hold is a file with its own end, lifted by its release', () => {
    const { guard, record } = guarded();
    // No guard files yet: no hook would wait.
    expect(guard.holdTools('abc123')).toBeNull();
    expect(guard.prepare(record, '/wt/x')).not.toBeNull();
    const before = Date.now();
    const release = guard.holdTools('abc123');
    expect(release).not.toBeNull();
    const { until } = JSON.parse(fs.readFileSync(holdFile(), 'utf8'));
    expect(until).toBeGreaterThan(before);
    expect(until).toBeLessThanOrEqual(Date.now() + TOOL_HOLD_MAX_MS);
    release?.();
    expect(fs.existsSync(holdFile())).toBe(false);
  });

  it('a session that runs without its guard cannot be held', () => {
    const { guard, record } = guarded();
    guard.prepare(record, '/wt/x');
    guard.unguarded(record, 'an old Codex');
    expect(guard.holdTools('abc123')).toBeNull();
    expect(fs.existsSync(holdFile())).toBe(false);
  });

  it("the hook makes a tool call wait while the hold lasts, and never past the hold's own end", () => {
    const { guard, record } = guarded();
    guard.prepare(record, '/wt/x');
    let started = Date.now();
    expect(call()).toBe(0);
    expect(Date.now() - started).toBeLessThan(200);
    // A hold nobody lifts (the server died mid-merge) ends by itself.
    fs.writeFileSync(holdFile(), JSON.stringify({ until: Date.now() + 400 }));
    started = Date.now();
    expect(call()).toBe(0);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(350);
    expect(waited).toBeLessThan(3_000);
    // One from long ago, or garbage: no wait.
    fs.writeFileSync(holdFile(), JSON.stringify({ until: Date.now() - 1 }));
    started = Date.now();
    expect(call()).toBe(0);
    fs.writeFileSync(holdFile(), 'not json');
    expect(call()).toBe(0);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

const T0 = new Date(2026, 10, 11, 10, 0).getTime();

describe('TaskScheduler: tasks that change the same files', () => {
  let dir: string;
  let deliver: ReturnType<typeof vi.fn>;
  let notice: ReturnType<typeof vi.fn>;
  let touchedFiles: ReturnType<typeof vi.fn>;
  let syncBase: ReturnType<typeof vi.fn>;
  let toolHold: ReturnType<typeof vi.fn>;
  const lifted = () => {};
  let pipeline: ReturnType<typeof vi.fn>;
  let tracker: AgentStateTracker;
  let settings: ProjectSettings;
  /** What each task's folder touches now, by worktree path. */
  let touched: Map<string, string[]>;
  let schedulers: TaskScheduler[];
  let call: number;

  const make = (extra: Partial<TaskSchedulerDeps> = {}) => {
    let n = 0;
    let w = 0;
    const scheduler = new TaskScheduler({
      storePath: path.join(dir, 'tasks.json'),
      random: () => 1,
      launch: vi.fn(async () => ({
        sessionId: `s${++n}`,
      })) as unknown as TaskSchedulerDeps['launch'],
      notify: () => {},
      sessionStatus: () => 'running',
      stopSession: async () => {},
      deliver: deliver as unknown as TaskSchedulerDeps['deliver'],
      worktrees: {
        create: vi.fn(async () => {
          w++;
          return {
            repoPath: '/repo',
            baseBranch: 'main',
            baseSha: 'b0',
            branch: `ut/t${w}`,
            worktreePath: `/wt/${w}`,
            clonedDirs: [],
          };
        }),
        remove: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true })),
        commitLeftovers: vi.fn(async () => false),
        changes: vi.fn(async (task: TaskRecord) => ({
          files: touched.get(task.worktreePath as string) ?? [],
          stats: { commits: 1, files: 1, insertions: 1, deletions: 0 },
        })),
        hasUnmergedWork: vi.fn(async () => false),
      } as unknown as TaskWorktrees,
      pipeline: pipeline as unknown as TaskSchedulerDeps['pipeline'],
      settings: { get: () => settings },
      agentState: (sessionId) => tracker.get(sessionId),
      worktreeActivity: async () => undefined,
      touchedFiles: touchedFiles as unknown as TaskSchedulerDeps['touchedFiles'],
      syncBase: syncBase as unknown as TaskSchedulerDeps['syncBase'],
      projectNotice: notice as unknown as TaskSchedulerDeps['projectNotice'],
      toolHold: toolHold as unknown as TaskSchedulerDeps['toolHold'],
      agentCommand: () => ['claude'],
      logDir: path.join(dir, 'logs'),
      inputWaitMs: 10,
      now: () => Date.now(),
      ...extra,
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  const newTask = (name: string, overrides: Partial<NewTask> = {}): NewTask => ({
    name,
    prompt: name,
    workingDir: '/repo',
    command: ['claude'],
    agent: 'claude',
    shielded: true,
    notify: true,
    isolation: 'worktree',
    ...overrides,
  });

  /** One finished tool call of the session's agent (real progress in its events). */
  const tool = (sessionId: string) => {
    const callId = `c${++call}`;
    for (const kind of ['tool-start', 'tool-end'] as const) {
      tracker.apply(sessionId, {
        at: Date.now(),
        source: 'claude-hook',
        kind,
        tool: 'Edit',
        callId,
        detail: 'src/a.ts',
      });
    }
  };
  /** A call the agent is still in (a test run, an edit). */
  const openTool = (sessionId: string) => {
    const callId = `c${++call}`;
    tracker.apply(sessionId, {
      at: Date.now(),
      source: 'claude-hook',
      kind: 'tool-start',
      tool: 'Bash',
      callId,
      detail: 'pnpm test',
    });
    return () =>
      tracker.apply(sessionId, {
        at: Date.now(),
        source: 'claude-hook',
        kind: 'tool-end',
        tool: 'Bash',
        callId,
      });
  };

  const check = async (scheduler: TaskScheduler, ms = 5_000) => {
    await vi.advanceTimersByTimeAsync(ms);
    await scheduler.checkExited();
    await scheduler.settled();
  };

  /** Two working tasks: the first's session is s1 (folder /wt/1), the second's s2 (/wt/2). */
  const two = async (scheduler: TaskScheduler, second: Partial<NewTask> = {}) => {
    await scheduler.start(0);
    const a = await scheduler.create(newTask('Lista más rápida'));
    await scheduler.settled();
    const b = await scheduler.create(newTask('Lista con filtros', second));
    await scheduler.settled();
    for (const session of ['s1', 's2']) {
      tracker.apply(session, { at: Date.now(), source: 'claude-hook', kind: 'turn-start' });
      tool(session);
    }
    expect(scheduler.get(a.id)?.state).toBe('working');
    expect(scheduler.get(b.id)?.state).toBe('working');
    return { a, b };
  };

  const get = (scheduler: TaskScheduler, task: TaskRecord) => scheduler.get(task.id) as TaskRecord;
  /** The first task's agent is done and its work merges. */
  const merges = async (scheduler: TaskScheduler, task: TaskRecord) => {
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.markDone(get(scheduler, task).sessionId as string, 'hecho');
    await scheduler.settled();
    expect(get(scheduler, task).state).toBe('merged');
  };
  const typed = (words: string) =>
    deliver.mock.calls.filter(([, text]) => String(text).includes(words));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-overlap-'));
    deliver = vi.fn(() => true);
    toolHold = vi.fn(() => lifted);
    notice = vi.fn(() => true);
    touched = new Map([
      ['/wt/1', ['web/a.ts', 'web/list.css']],
      ['/wt/2', ['web/b.ts', 'web/list.css']],
    ]);
    touchedFiles = vi.fn(async (worktreePath: string) => touched.get(worktreePath) ?? []);
    syncBase = vi.fn(
      async (): Promise<BaseSyncResult> => ({
        kind: 'merged',
        base: 'm1',
        head: 'h2',
        files: ['web/a.ts', 'web/list.css'],
      })
    );
    pipeline = vi.fn(
      async (task: PipelineTask): Promise<PipelineResult> => ({
        state: 'merged',
        mergedSha: 'm1',
        files: touched.get(task.worktreePath as string) ?? [],
      })
    );
    tracker = new AgentStateTracker();
    settings = { ...DEFAULT_PROJECT_SETTINGS };
    schedulers = [];
    call = 0;
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  describe('A. the overlap is seen while they work', () => {
    it('shown on both tasks, told to the orchestrator once per pair, kept in their metrics', async () => {
      const scheduler = make();
      const { a, b } = await two(scheduler);
      await check(scheduler);
      expect(get(scheduler, a).overlaps).toEqual([
        expect.objectContaining({ taskId: b.id, files: ['web/list.css'], count: 1 }),
      ]);
      expect(get(scheduler, b).overlaps).toEqual([
        expect.objectContaining({ taskId: a.id, files: ['web/list.css'], count: 1 }),
      ]);
      expect(notice).toHaveBeenCalledTimes(1);
      const [repo, text] = notice.mock.calls[0];
      expect(repo).toBe('/repo');
      expect(text).toContain(a.id.slice(0, 8));
      expect(text).toContain(b.id.slice(0, 8));
      expect(text).toContain('both change web/list.css');
      // `ut task list` and `ut task status` of both.
      expect(formatTaskLine(get(scheduler, a))).toContain(
        `touches too: ${b.id.slice(0, 8)} · web/list.css`
      );
      expect(formatTaskDetail(get(scheduler, b))).toContain(
        `overlap:  touches too: ${a.id.slice(0, 8)} «Lista más rápida»: web/list.css`
      );
      expect(get(scheduler, a).metrics?.conflicts).toMatchObject({
        overlaps: [{ taskId: b.id, files: 1 }],
        conflictRounds: 0,
      });

      // A second shared file later: the same pair, its files brought up to date, no new note.
      touched.set('/wt/2', ['web/a.ts', 'web/b.ts', 'web/list.css']);
      await vi.advanceTimersByTimeAsync(OVERLAP_LOOK_MS);
      tool('s2');
      for (let i = 0; i < 5; i++) await check(scheduler);
      expect(get(scheduler, a).overlaps).toEqual([
        expect.objectContaining({ taskId: b.id, files: ['web/a.ts', 'web/list.css'], count: 2 }),
      ]);
      expect(formatTaskLine(get(scheduler, b))).toContain(
        `touches too: ${a.id.slice(0, 8)} · web/a.ts (+1 more)`
      );
      expect(notice).toHaveBeenCalledTimes(1);
      expect(get(scheduler, a).metrics?.conflicts?.overlaps).toHaveLength(1);
      // On disk too (a restart, the CLI): the pair with its files as they are now, told.
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8'));
      const savedTasks: TaskRecord[] = Array.isArray(saved) ? saved : saved.tasks;
      expect(savedTasks.find((entry) => entry.id === a.id)?.overlaps).toEqual([
        expect.objectContaining({
          taskId: b.id,
          files: ['web/a.ts', 'web/list.css'],
          toldAt: expect.any(String),
        }),
      ]);
    });

    it('with no orchestrator running the pair is told when there is one, still once', async () => {
      notice.mockReturnValue(false);
      const scheduler = make();
      const { a } = await two(scheduler);
      await check(scheduler);
      await check(scheduler);
      expect(get(scheduler, a).overlaps?.[0].toldAt).toBeUndefined();
      notice.mockClear();
      notice.mockReturnValue(true);
      await check(scheduler);
      await check(scheduler);
      expect(notice).toHaveBeenCalledTimes(1);
      expect(get(scheduler, a).overlaps?.[0].toldAt).toBeDefined();
    });

    it('tasks that share no file are no pair', async () => {
      touched.set('/wt/2', ['web/b.ts']);
      const scheduler = make();
      const { a, b } = await two(scheduler);
      await check(scheduler);
      expect(get(scheduler, a).overlaps).toBeUndefined();
      expect(get(scheduler, b).overlaps).toBeUndefined();
      expect(notice).not.toHaveBeenCalled();
      expect(formatTaskLine(get(scheduler, a))).not.toContain('touches too');
    });

    it('a finished task is no longer an overlap of the other', async () => {
      const scheduler = make({ syncBase: vi.fn(async () => ({ kind: 'current', base: 'm1' })) });
      const { a, b } = await two(scheduler);
      await check(scheduler);
      expect(get(scheduler, b).overlaps).toHaveLength(1);
      await merges(scheduler, a);
      await check(scheduler);
      expect(get(scheduler, b).overlaps).toBeUndefined();
      expect(get(scheduler, a).overlaps).toBeUndefined();
      // What it shared stays in its metrics, to measure with later.
      expect(get(scheduler, a).metrics?.conflicts?.overlaps).toHaveLength(1);
    });

    it('cheap: one look per task every OVERLAP_LOOK_MS, and none while its agent did nothing', async () => {
      const scheduler = make();
      await two(scheduler);
      await check(scheduler);
      expect(touchedFiles).toHaveBeenCalledTimes(2);
      expect(touchedFiles).toHaveBeenCalledWith('/wt/1', 'refs/heads/main');
      // 20 ticks inside the window, with tool calls going on: no git.
      for (let i = 0; i < 20; i++) {
        tool('s1');
        tool('s2');
        await check(scheduler);
      }
      expect(touchedFiles).toHaveBeenCalledTimes(2);
      // Past the window: one look each.
      await check(scheduler, OVERLAP_LOOK_MS);
      expect(touchedFiles).toHaveBeenCalledTimes(4);
      // Past it again, but only the second one's agent did something since.
      await vi.advanceTimersByTimeAsync(OVERLAP_LOOK_MS);
      tool('s2');
      for (let i = 0; i < 5; i++) await check(scheduler);
      expect(touchedFiles).toHaveBeenCalledTimes(5);
      expect(touchedFiles).toHaveBeenLastCalledWith('/wt/2', 'refs/heads/main');
    });
  });

  describe('B. a working task is brought up to date when another merges', () => {
    it('merged at a gap of its agent, which is told once what changed under it', async () => {
      const scheduler = make();
      const { a, b } = await two(scheduler);
      await check(scheduler);
      expect(syncBase).not.toHaveBeenCalled();
      await merges(scheduler, a);
      await check(scheduler);
      expect(syncBase).toHaveBeenCalledTimes(1);
      expect(syncBase.mock.calls[0].slice(0, 2)).toEqual(['/wt/2', 'main']);
      // The merge is given the hold of that task's tool calls (the guard's).
      const release = syncBase.mock.calls[0][2].hold();
      expect(toolHold).toHaveBeenCalledWith(b.id);
      expect(release).toBe(lifted);
      const notes = typed('Untether merged main into your branch');
      expect(notes).toHaveLength(1);
      expect(notes[0][0]).toBe('s2');
      expect(notes[0][1]).toContain(`task ${a.id.slice(0, 8)} «Lista más rápida»`);
      expect(notes[0][1]).toContain('web/list.css');
      const after = get(scheduler, b);
      expect(after.state).toBe('working');
      expect(after.baseSync).toMatchObject({ merges: 1, through: 'm1' });
      expect(after.baseSync?.pending).toBeUndefined();
      expect(after.metrics?.conflicts).toMatchObject({ baseSyncs: 1, earlyConflicts: 0 });
      expect(formatTaskDetail(after)).toContain('base:     main merged into it 1× by Untether');
      // Up to date: nothing more is done or said.
      for (let i = 0; i < 10; i++) await check(scheduler, BASE_SYNC_RETRY_MS);
      expect(syncBase).toHaveBeenCalledTimes(1);
      expect(typed('Untether merged main')).toHaveLength(1);
    });

    it('never with a tool running: it waits for the gap', async () => {
      const scheduler = make();
      const { a, b } = await two(scheduler);
      await check(scheduler);
      const done = openTool('s2');
      await merges(scheduler, a);
      for (let i = 0; i < 10; i++) await check(scheduler, BASE_SYNC_RETRY_MS);
      expect(syncBase).not.toHaveBeenCalled();
      expect(get(scheduler, b).baseSync?.pending).toMatchObject({
        from: [a.id],
        files: ['web/list.css'],
      });
      expect(formatTaskDetail(get(scheduler, b))).toContain('main moved in files it touches');
      done();
      await check(scheduler);
      expect(syncBase).toHaveBeenCalledTimes(1);
    });

    it('the gap is asked again right before the merge: a tool taken up meanwhile stops it', async () => {
      const free: boolean[] = [];
      syncBase.mockImplementationOnce(async (_wt, _base, options) => {
        free.push(options.stillFree());
        openTool('s2');
        free.push(options.stillFree());
        return { kind: 'busy', why: 'its agent took up a tool again' };
      });
      const scheduler = make();
      const { a, b } = await two(scheduler);
      await check(scheduler);
      await merges(scheduler, a);
      await check(scheduler);
      expect(free).toEqual([true, false]);
      expect(get(scheduler, b).baseSync).toMatchObject({ waiting: 'busy' });
      expect(typed('[untether] main moved')).toHaveLength(0);
    });

    it('uncommitted work: nothing is done or said, and it is tried again at a later gap', async () => {
      syncBase.mockResolvedValueOnce({ kind: 'dirty', files: ['web/b.ts'] });
      const scheduler = make();
      const { a, b } = await two(scheduler);
      await check(scheduler);
      await merges(scheduler, a);
      await check(scheduler);
      expect(syncBase).toHaveBeenCalledTimes(1);
      expect(get(scheduler, b).baseSync).toMatchObject({ waiting: 'dirty' });
      expect(get(scheduler, b).baseSync?.pending).toBeDefined();
      expect(typed('[untether] main moved')).toHaveLength(0);
      expect(formatTaskDetail(get(scheduler, b))).toContain('nothing uncommitted');
      // Not hammered: once per BASE_SYNC_RETRY_MS.
      await check(scheduler);
      expect(syncBase).toHaveBeenCalledTimes(1);
      await check(scheduler, BASE_SYNC_RETRY_MS);
      expect(syncBase).toHaveBeenCalledTimes(2);
      expect(get(scheduler, b).baseSync).toMatchObject({ merges: 1 });
      expect(get(scheduler, b).baseSync?.waiting).toBeUndefined();
      expect(typed('Untether merged main into your branch')).toHaveLength(1);
    });

    it('a conflict: its agent is told the files once, nothing is merged, and its own merge settles it', async () => {
      const conflict: BaseSyncResult = { kind: 'conflict', base: 'm1', files: ['web/list.css'] };
      syncBase.mockResolvedValue(conflict);
      const scheduler = make();
      const { a, b } = await two(scheduler);
      await check(scheduler);
      await merges(scheduler, a);
      await check(scheduler);
      const told = typed('now conflicts in');
      expect(told).toHaveLength(1);
      expect(told[0][0]).toBe('s2');
      expect(told[0][1]).toContain('- web/list.css');
      expect(told[0][1]).toContain('git merge main');
      expect(get(scheduler, b).baseSync).toMatchObject({
        conflict: { base: 'm1', files: ['web/list.css'] },
      });
      expect(get(scheduler, b).metrics?.conflicts).toMatchObject({ earlyConflicts: 1 });
      expect(formatTaskDetail(get(scheduler, b))).toContain('it conflicts in web/list.css');
      // The same conflict, looked at again now and then: not told again.
      for (let i = 0; i < 4; i++) await check(scheduler, BASE_SYNC_CONFLICT_RETRY_MS);
      expect(syncBase.mock.calls.length).toBeGreaterThan(1);
      expect(typed('now conflicts in')).toHaveLength(1);
      expect(get(scheduler, b).metrics?.conflicts).toMatchObject({ earlyConflicts: 1 });
      // Its agent merged main itself.
      syncBase.mockResolvedValue({ kind: 'current', base: 'm1' });
      await check(scheduler, BASE_SYNC_CONFLICT_RETRY_MS);
      expect(get(scheduler, b).baseSync?.pending).toBeUndefined();
      expect(get(scheduler, b).baseSync?.conflict).toBeUndefined();
      expect(typed('Untether merged main')).toHaveLength(0);
    });

    it('a task that touches nothing of what merged is left alone', async () => {
      touched.set('/wt/2', ['web/b.ts']);
      const scheduler = make();
      const { a, b } = await two(scheduler);
      await check(scheduler);
      await merges(scheduler, a);
      for (let i = 0; i < 5; i++) await check(scheduler, BASE_SYNC_RETRY_MS);
      expect(syncBase).not.toHaveBeenCalled();
      expect(get(scheduler, b).baseSync).toBeUndefined();
      expect(deliver).not.toHaveBeenCalled();
    });

    it('a file it only starts to touch after the other merged counts too', async () => {
      touched.set('/wt/2', ['web/b.ts']);
      const scheduler = make();
      const { a } = await two(scheduler);
      await check(scheduler);
      await merges(scheduler, a);
      await check(scheduler);
      expect(syncBase).not.toHaveBeenCalled();
      touched.set('/wt/2', ['web/b.ts', 'web/list.css']);
      await vi.advanceTimersByTimeAsync(OVERLAP_LOOK_MS);
      tool('s2');
      for (let i = 0; i < 3; i++) await check(scheduler);
      expect(syncBase).toHaveBeenCalledTimes(1);
    });

    it("the project's baseSync=false: each task meets the others' work only at its merge", async () => {
      settings = { ...DEFAULT_PROJECT_SETTINGS, baseSync: false };
      const scheduler = make();
      const { a, b } = await two(scheduler);
      await check(scheduler);
      await merges(scheduler, a);
      for (let i = 0; i < 5; i++) await check(scheduler, BASE_SYNC_RETRY_MS);
      expect(syncBase).not.toHaveBeenCalled();
      expect(get(scheduler, b).baseSync).toBeUndefined();
      // The overlap itself is still shown.
      expect(notice).toHaveBeenCalledTimes(1);
    });

    it('without events of its agent there is never a gap', async () => {
      const scheduler = make({ agentState: () => undefined });
      const { a } = await two(scheduler);
      await check(scheduler);
      await merges(scheduler, a);
      for (let i = 0; i < 5; i++) await check(scheduler, BASE_SYNC_RETRY_MS);
      expect(syncBase).not.toHaveBeenCalled();
    });
  });
});

/**
 * The measurement (real git, real timers): two tasks of one project change config.txt. The
 * first raises `limit` and merges while the second still works; the second then edits that
 * same line as it finds it in its folder. Conflict rounds of the second at its merge, with
 * the project's baseSync off (how it was) and on.
 */
describe('measured: conflict rounds of two tasks on the same file', () => {
  let tmp: string;
  withGitEnv();

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ut-overlap-measure-')));
  });

  afterEach(() => {
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  const measure = async (baseSync: boolean) => {
    const root = path.join(tmp, baseSync ? 'on' : 'off');
    fs.mkdirSync(root);
    const { repo, worktree } = makeRepo(root);
    const tracker = new AgentStateTracker();
    const typedTexts: string[] = [];
    let sessions = 0;
    let scheduler: TaskScheduler;
    /** The agent of a task told to resolve a conflict with main: it does, and reports again. */
    const resolves: Promise<unknown>[] = [];
    const deliver = async (sessionId: string, text: string) => {
      typedTexts.push(text);
      if (!text.includes('conflicts in:') || !text.includes('ut task done')) return true;
      const task = scheduler.list().find((entry) => entry.sessionId === sessionId) as TaskRecord;
      const dir = task.worktreePath as string;
      expect(() => git(dir, 'merge', '--no-edit', 'main')).toThrow();
      write(
        dir,
        'config.txt',
        CONFIG.join('\n')
          .replace('limit = 10', 'limit = 20 # capped')
          .replace('mode = fast', 'mode = safe')
      );
      commit(dir, 'resolved');
      resolves.push(
        new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
          scheduler.markDone(sessionId, 'resuelto')
        )
      );
      return true;
    };
    const pipeline = async (task: PipelineTask): Promise<PipelineResult> => {
      const dir = task.worktreePath as string;
      const base = git(repo, 'rev-parse', 'main');
      try {
        git(dir, 'merge', '--no-edit', 'main');
      } catch {
        const files = git(dir, 'diff', '--name-only', '--diff-filter=U').split('\n');
        git(dir, 'merge', '--abort');
        return {
          state: 'needs_you',
          blocker: {
            kind: 'conflict',
            message: `Conflicts with main in ${files.length} file`,
            detail: files,
            base,
          },
        };
      }
      const changes = await branchChanges(dir, base);
      git(repo, 'merge', '-q', '--ff-only', task.branch as string);
      return {
        state: 'merged',
        mergedSha: git(repo, 'rev-parse', 'HEAD'),
        files: changes.files,
        stats: changes.stats,
      };
    };
    scheduler = new TaskScheduler({
      storePath: path.join(root, 'tasks.json'),
      random: () => 1,
      launch: (async () => ({ sessionId: `s${++sessions}` })) as TaskSchedulerDeps['launch'],
      notify: () => {},
      sessionStatus: () => 'running',
      stopSession: async () => {},
      deliver: deliver as TaskSchedulerDeps['deliver'],
      worktrees: {
        create: async () => {
          const made = worktree();
          return {
            repoPath: repo,
            baseBranch: 'main',
            baseSha: git(repo, 'rev-parse', 'main'),
            branch: made.branch,
            worktreePath: made.dir,
            clonedDirs: [],
          };
        },
        remove: async () => ({ worktreeRemoved: true, branchDeleted: true }),
        commitLeftovers: async () => false,
        changes: (task: TaskRecord) =>
          branchChanges(task.worktreePath as string, git(repo, 'rev-parse', 'main')),
        hasUnmergedWork: async () => false,
      } as unknown as TaskWorktrees,
      pipeline: pipeline as unknown as TaskSchedulerDeps['pipeline'],
      settings: { get: () => ({ ...DEFAULT_PROJECT_SETTINGS, baseSync }) },
      agentState: (sessionId) => tracker.get(sessionId),
      worktreeActivity: async () => undefined,
      toolHold: () => () => {},
      agentCommand: () => ['claude'],
      logDir: path.join(root, 'logs'),
      inputWaitMs: 10,
    });
    try {
      await scheduler.start(0);
      const newTask = (name: string): NewTask => ({
        name,
        prompt: name,
        workingDir: repo,
        command: ['claude'],
        agent: 'claude',
        shielded: true,
        notify: true,
        isolation: 'worktree',
      });
      const tick = async () => {
        await scheduler.checkExited();
        await scheduler.settled();
      };
      const first = await scheduler.create(newTask('Sube el límite'));
      await scheduler.settled();
      const second = await scheduler.create(newTask('Modo seguro y límite acotado'));
      await scheduler.settled();
      const of = (task: TaskRecord) => scheduler.get(task.id) as TaskRecord;
      for (const session of ['s1', 's2']) {
        tracker.apply(session, { at: Date.now(), source: 'claude-hook', kind: 'turn-start' });
      }
      // Both work on config.txt, each in its own part of it, and commit.
      editLine(of(first).worktreePath as string, 'limit =', () => 'limit = 20');
      commit(of(first).worktreePath as string, 'limit');
      editLine(of(second).worktreePath as string, 'mode =', () => 'mode = safe');
      commit(of(second).worktreePath as string, 'mode');
      await tick();
      expect(of(second).overlaps).toEqual([
        expect.objectContaining({ taskId: first.id, files: ['config.txt'] }),
      ]);
      // The first one is done and merges while the second still works.
      await scheduler.markDone('s1', 'hecho');
      await scheduler.settled();
      expect(of(first).state).toBe('merged');
      await tick();
      await tick();
      // The second goes on: it marks the limit as capped, on the line as its folder has it.
      editLine(of(second).worktreePath as string, 'limit =', (line) => `${line} # capped`);
      commit(of(second).worktreePath as string, 'capped');
      await scheduler.markDone('s2', 'hecho');
      await scheduler.settled();
      await Promise.all(resolves);
      await scheduler.settled();
      expect(of(second).state).toBe('merged');
      expect(read(repo)).toContain('limit = 20 # capped');
      expect(read(repo)).toContain('mode = safe');
      return {
        conflictRounds: of(second).metrics?.conflicts?.conflictRounds ?? 0,
        baseSyncs: of(second).metrics?.conflicts?.baseSyncs ?? 0,
        told: typedTexts.filter((text) => text.includes('Untether merged main')).length,
      };
    } finally {
      scheduler.stop();
    }
  };

  it('before (baseSync off): 1 conflict round at the merge; after (on): 0', async () => {
    const before = await measure(false);
    const after = await measure(true);
    // The numbers the task's report quotes.
    console.info(
      `conflict rounds at the merge, two tasks on config.txt: before ${before.conflictRounds}, after ${after.conflictRounds} (base merged in while working: ${after.baseSyncs})`
    );
    expect(before).toEqual({ conflictRounds: 1, baseSyncs: 0, told: 0 });
    expect(after).toEqual({ conflictRounds: 0, baseSyncs: 1, told: 1 });
  }, 60_000);
});
