/**
 * The task engine's side of the security sweep (2026-10-23): a sweep's search finishes
 * silently and never merges; a security task waits in needs_you for the user whatever the
 * project's policy, unless every gate holds: then «Se fusiona a las HH:MM», a countdown the
 * user can stop, and the merge.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, type ProjectSettings } from '../../shared/projects.js';
import type { TaskSecurity } from '../../shared/security.js';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { NotificationPayload } from './push-notification-service.js';
import type { PipelineOptions, PipelineResult } from './task-merge.js';
import {
  type NewTask,
  TaskScheduler,
  type TaskSchedulerDeps,
  type TaskWorktrees,
} from './task-scheduler.js';

const T0 = new Date('2026-10-23T10:00:00Z').getTime();

const newTask = (security: TaskSecurity, overrides: Partial<NewTask> = {}): NewTask => ({
  name: 'Security fix',
  prompt: 'Fix it',
  workingDir: '/repo',
  repoPath: '/repo',
  command: ['claude'],
  agent: 'claude',
  shielded: false,
  notify: true,
  isolation: 'worktree',
  origin: 'schedule',
  mergePolicy: 'ask',
  security,
  ...overrides,
});

const cleanReady = (files: string[]): PipelineResult => ({
  state: 'ready',
  headSha: 'h1',
  files,
  stats: { commits: 1, files: files.length, insertions: 2, deletions: 2 },
  verify: { command: 'pnpm test', cwd: '/wt', startedAt: 'x', exitCode: 0, headSha: 'h1' },
  risk: [],
  review: {
    verdict: 'ok',
    summary: 'bien',
    issues: [],
    at: 'x',
    model: 'sonnet',
    headSha: 'h1',
  },
});

describe('TaskScheduler and security tasks (2026-10-23)', () => {
  let dir: string;
  let notify: ReturnType<typeof vi.fn>;
  let pipeline: ReturnType<typeof vi.fn>;
  let launch: ReturnType<typeof vi.fn>;
  let settings: ProjectSettings;
  let files: string[];
  let schedulers: TaskScheduler[];

  let fixReview: ReturnType<typeof vi.fn>;
  let riskReview: ReturnType<typeof vi.fn>;
  /** The user's autoApprove setting (off unless a test turns it on). */
  let autoApprove: boolean;

  const make = () => {
    let w = 0;
    const worktrees: TaskWorktrees = {
      create: vi.fn(async () => {
        w++;
        const worktreePath = path.join(dir, `wt${w}`);
        fs.mkdirSync(worktreePath, { recursive: true });
        return {
          repoPath: '/repo',
          baseBranch: 'main',
          baseSha: 'b0',
          branch: `ut/t${w}`,
          worktreePath,
          clonedDirs: [],
        };
      }),
      remove: vi.fn(async () => ({ worktreeRemoved: true, branchDeleted: true })),
      commitLeftovers: vi.fn(async () => false),
      changes: vi.fn(async () => ({
        files,
        stats: { commits: 1, files: files.length, insertions: 1, deletions: 0 },
      })),
      hasUnmergedWork: vi.fn(async () => false),
    };
    const scheduler = new TaskScheduler({
      storePath: path.join(dir, 'tasks.json'),
      launch: launch as unknown as TaskSchedulerDeps['launch'],
      notify: notify as unknown as (p: NotificationPayload) => void,
      sessionStatus: () => 'running',
      stopSession: async () => {},
      deliver: async () => true,
      worktrees,
      pipeline: pipeline as unknown as TaskSchedulerDeps['pipeline'],
      settings: { get: () => settings },
      securityFixReview: fixReview as unknown as TaskSchedulerDeps['securityFixReview'],
      riskReview: riskReview as unknown as TaskSchedulerDeps['riskReview'],
      autoApprove: () => autoApprove,
      logDir: path.join(dir, 'logs'),
      inputWaitMs: 0,
      now: () => Date.now(),
    });
    schedulers.push(scheduler);
    return scheduler;
  };

  const runToEnd = async (scheduler: TaskScheduler, input: NewTask) => {
    const created = await scheduler.create(input);
    await scheduler.settled();
    const sessionId = scheduler.get(created.id)?.sessionId as string;
    await scheduler.markDone(sessionId, 'hecho');
    await scheduler.settled();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.settled();
    return scheduler.get(created.id) as TaskRecord;
  };

  const modes = () =>
    pipeline.mock.calls.map((call) => (call[1] as PipelineOptions).mode as string);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-security-'));
    notify = vi.fn();
    let n = 0;
    launch = vi.fn(async () => ({ sessionId: `s${++n}` }));
    settings = { ...DEFAULT_PROJECT_SETTINGS, mergePolicy: 'auto', securitySweep: true };
    files = ['src/a.ts'];
    schedulers = [];
    autoApprove = false;
    fixReview = vi.fn(async () => ({ verdict: 'confirmed', reason: 'cierra el fallo' }));
    riskReview = vi.fn(async () => ({ verdict: 'confirmed', reason: 'no debilita nada' }));
    pipeline = vi.fn(
      async (_task, options: PipelineOptions): Promise<PipelineResult> =>
        options.mode === 'merge' ? { state: 'merged', mergedSha: 'm1' } : cleanReady(files)
    );
  });

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    vi.useRealTimers();
    fs.rmSync(dir, RM_TEST_DIR);
  });

  it('a fix with no findings to check it against waits in needs_you, even with policy auto', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const done = await runToEnd(
      scheduler,
      newTask({ kind: 'fix', section: 'web', headline: 'High severity: SQL injection.' })
    );
    expect(done.state).toBe('needs_you');
    expect(done.blocker).toMatchObject({
      kind: 'security',
      message: 'High severity: SQL injection.',
    });
    expect(modes()).toEqual(['auto']);
    // One push: the task with the fix ready.
    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0][0] as NotificationPayload).type).toBe('task-needs-you');
    // «Fusionar» from the user merges it.
    expect(scheduler.merge(done.id)).toMatchObject({ ok: true });
    await scheduler.settled();
    expect(scheduler.get(done.id)?.state).toBe('merged');
  });

  const supply = (security: Partial<TaskSecurity> = {}): TaskSecurity => ({
    kind: 'supply',
    section: 'web/pnpm-lock.yaml',
    findings: [
      {
        file: 'web/pnpm-lock.yaml',
        severity: 'high',
        category: 'vulnerable-dependency',
        title: 'tar@6.2.0: path traversal',
        exploit: 'x',
        fix: 'Upgrade tar to 6.2.1',
        package: 'tar',
      },
    ],
    bumps: [{ ecosystem: 'npm', name: 'tar', from: '6.2.0', to: '6.2.1' }],
    ...security,
  });

  it('a patch bump of a dependency an advisory names merges on its own when all is clean', async () => {
    files = ['web/package.json', 'web/pnpm-lock.yaml'];
    const scheduler = make();
    await scheduler.start(0);
    const done = await runToEnd(scheduler, newTask(supply()));
    // The reviewer judged the upgrade safe; the countdown first, then the merge.
    expect(fixReview).toHaveBeenCalledTimes(1);
    expect(done.security?.fixReview).toMatchObject({ verdict: 'confirmed', headSha: 'h1' });
    expect(done.state).toBe('ready');
    expect(done.autoMergeAt).toBe(new Date(T0 + 10 * 60_000).toISOString());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await scheduler.settled();
    expect(modes()).toEqual(['auto', 'merge']);
    expect(pipeline.mock.calls[1][1]).toMatchObject({ mode: 'merge', byAgent: true });
    const merged = scheduler.get(done.id) as TaskRecord;
    expect(merged.state).toBe('merged');
    expect(merged.autoMerged).toBe(true);
  });

  describe('a confirmed fix that passes every gate (2026-10-23)', () => {
    const finding = {
      file: 'src/db.ts',
      line: 12,
      severity: 'high' as const,
      category: 'injection' as const,
      title: 'SQL armado a mano',
      exploit: 'x',
      fix: 'parámetros',
    };
    const fix = (overrides: Partial<TaskSecurity> = {}) =>
      newTask({
        kind: 'fix',
        section: 'src',
        findings: [finding],
        headline: '🔴 SQL armado a mano → parámetros',
        ...overrides,
      });

    beforeEach(() => {
      files = ['src/db.ts', 'src/db.test.ts'];
    });

    it('says when it merges, waits 10 minutes and merges, undoable', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, fix());
      expect(fixReview).toHaveBeenCalledTimes(1);
      expect(done).toMatchObject({
        state: 'ready',
        autoMergeAt: new Date(T0 + 10 * 60_000).toISOString(),
        security: { fixReview: { verdict: 'confirmed', headSha: 'h1' } },
      });
      expect(notify).toHaveBeenCalledTimes(1);
      const push = notify.mock.calls[0][0] as NotificationPayload;
      expect(push.type).toBe('task-ready');
      expect(push.body).toMatch(/^Merges on its own at \d\d:\d\d: 🔴 SQL armado a mano/);
      expect(push.data).toMatchObject({
        autoMergeAt: done.autoMergeAt,
        headline: '🔴 SQL armado a mano → parámetros',
      });
      // Not before its time.
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(modes()).toEqual(['auto']);
      await vi.advanceTimersByTimeAsync(60_000);
      await scheduler.settled();
      expect(modes()).toEqual(['auto', 'merge']);
      expect(pipeline.mock.calls[1][1]).toMatchObject({ mode: 'merge', byAgent: true });
      const merged = scheduler.get(done.id) as TaskRecord;
      expect(merged.state).toBe('merged');
      // Counted as a merge no human decided: an undo of it trips the circuit breaker.
      expect(merged.autoMerged).toBe(true);
    });

    it('«Parar» within the countdown: it waits in needs_you and never merges', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, fix());
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(scheduler.holdAutoMerge(done.id)).toMatchObject({ ok: true });
      const held = scheduler.get(done.id) as TaskRecord;
      expect(held.state).toBe('needs_you');
      expect(held.blocker).toMatchObject({
        kind: 'security',
        message: '🔴 SQL armado a mano → parámetros',
      });
      expect(held.autoMergeAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await scheduler.settled();
      expect(modes()).toEqual(['auto']);
      expect(scheduler.get(done.id)?.state).toBe('needs_you');
      // Nothing to stop any more.
      expect(scheduler.holdAutoMerge(done.id)).toMatchObject({ ok: false, code: 'not-open' });
    });

    it('a restart while the fix is being reviewed runs its pipeline and review again (2026-10-23)', async () => {
      let answer: (value: unknown) => void = () => {};
      fixReview.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const first = make();
      await first.start(0);
      const created = await first.create(fix());
      await first.settled();
      await first.markDone(first.get(created.id)?.sessionId as string, 'hecho');
      await vi.advanceTimersByTimeAsync(0);
      expect(fixReview).toHaveBeenCalledTimes(1);
      expect(first.get(created.id)).toMatchObject({ state: 'verifying', reviewing: true });
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8')).tasks[0];
      expect(saved.effects).toEqual([
        expect.objectContaining({ kind: 'pipeline', run: { mode: 'auto' } }),
      ]);
      // The server goes down; the old review's answer comes too late to matter.
      first.stop();
      fixReview.mockImplementation(async () => ({ verdict: 'confirmed', reason: 'ok' }));
      pipeline.mockClear();
      const second = make();
      await second.start(0);
      await second.settled();
      await vi.advanceTimersByTimeAsync(0);
      await second.settled();
      expect(modes()).toEqual(['auto']);
      expect(fixReview).toHaveBeenCalledTimes(2);
      expect(second.get(created.id)).toMatchObject({ state: 'ready' });
      expect(second.get(created.id)?.autoMergeAt).toBeDefined();
      answer({ verdict: 'confirmed', reason: 'tarde' });
    });

    it('a pause that starts during the countdown holds it at the end', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, fix());
      settings = { ...settings, autoMergePausedUntil: new Date(T0 + 24 * 3_600_000).toISOString() };
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await scheduler.settled();
      expect(modes()).toEqual(['auto']);
      expect(scheduler.get(done.id)).toMatchObject({
        state: 'needs_you',
        blocker: { kind: 'security' },
      });
    });

    it('any gate that fails leaves it in needs_you', async () => {
      const cases: Array<{
        name: string;
        settings?: Partial<ProjectSettings>;
        files?: string[];
        result?: Partial<PipelineResult>;
        review?: { verdict: string; reason: string };
        reviewed: boolean;
      }> = [
        {
          name: 'the adversarial reviewer rejects the fix',
          review: { verdict: 'dismissed', reason: 'otra ruta sigue abierta' },
          reviewed: true,
        },
        {
          name: 'the adversarial reviewer cannot answer',
          review: { verdict: 'unavailable', reason: 'x' },
          reviewed: true,
        },
        { name: 'auth config', files: ['src/db.ts', 'src/auth.ts'], reviewed: false },
        { name: 'CI', files: ['src/db.ts', '.github/workflows/ci.yml'], reviewed: false },
        { name: 'a lockfile', files: ['src/db.ts', 'pnpm-lock.yaml'], reviewed: false },
        { name: 'outside the section', files: ['src/db.ts', 'lib/db.ts'], reviewed: false },
        { name: 'a build script', files: ['src/db.ts', 'scripts/install.sh'], reviewed: false },
        {
          name: 'a big diff',
          result: { stats: { commits: 1, files: 2, insertions: 300, deletions: 10 } },
          reviewed: false,
        },
        {
          name: 'a risk finding',
          result: { risk: [{ rule: 'auth', file: 'src/db.ts' }] },
          reviewed: false,
        },
        { name: 'no check ran', result: { verify: undefined }, reviewed: false },
        {
          name: 'the AI review saw a problem',
          result: {
            review: {
              verdict: 'concerns',
              summary: 'x',
              issues: [{ file: 'src/db.ts', severity: 'medium', what: 'x' }],
              at: 'x',
              model: 'x',
            },
          },
          reviewed: false,
        },
        { name: 'turned off', settings: { securityAutoMerge: false }, reviewed: false },
        { name: 'policy ask', settings: { mergePolicy: 'ask' }, reviewed: false },
        {
          name: 'the circuit breaker paused merges',
          settings: { autoMergePausedUntil: 'in an hour' },
          reviewed: false,
        },
        { name: 'the sweep is paused', settings: { securitySweepPaused: true }, reviewed: false },
      ];
      for (const entry of cases) {
        pipeline.mockReset();
        fixReview.mockReset();
        fixReview.mockResolvedValue(entry.review ?? { verdict: 'confirmed', reason: 'ok' });
        settings = {
          ...DEFAULT_PROJECT_SETTINGS,
          mergePolicy: 'auto',
          securitySweep: true,
          ...entry.settings,
        };
        // Relative to now: the fake clock moves on with every case.
        if (settings.autoMergePausedUntil === 'in an hour') {
          settings.autoMergePausedUntil = new Date(Date.now() + 3_600_000).toISOString();
        }
        files = entry.files ?? ['src/db.ts', 'src/db.test.ts'];
        pipeline.mockImplementation(async (_task, options: PipelineOptions) =>
          options.mode === 'merge'
            ? { state: 'merged', mergedSha: 'm1' }
            : { ...cleanReady(files), ...entry.result }
        );
        const scheduler = make();
        await scheduler.start(0);
        const done = await runToEnd(scheduler, fix());
        await vi.advanceTimersByTimeAsync(15 * 60_000);
        await scheduler.settled();
        const after = scheduler.get(done.id) as TaskRecord;
        expect({
          name: entry.name,
          state: after.state,
          merges: modes().filter((mode) => mode === 'merge').length,
        }).toEqual({
          name: entry.name,
          state: 'needs_you',
          merges: 0,
        });
        expect(after.blocker?.kind).toBe('security');
        expect(fixReview.mock.calls.length > 0).toBe(entry.reviewed);
        if (entry.review?.verdict === 'dismissed') {
          expect(after.blocker?.detail).toEqual(['Fix review: otra ruta sigue abierta']);
        }
      }
    });
  });

  it('a bump the reviewer finds unsafe waits for the user, with its reason', async () => {
    files = ['web/pnpm-lock.yaml'];
    fixReview.mockResolvedValue({ verdict: 'dismissed', reason: 'la 6.2.1 quita una opción' });
    const scheduler = make();
    await scheduler.start(0);
    const done = await runToEnd(scheduler, newTask(supply()));
    expect(done.state).toBe('needs_you');
    expect(done.blocker).toMatchObject({
      kind: 'security',
      detail: ['Bump review: la 6.2.1 quita una opción'],
    });
    expect(modes()).toEqual(['auto']);
  });

  it('a removal of an unused dependency always waits for the user, even all clean', async () => {
    files = ['mac/package.json', 'mac/package-lock.json'];
    const scheduler = make();
    await scheduler.start(0);
    const done = await runToEnd(
      scheduler,
      newTask(
        supply({
          section: 'mac/package.json',
          bumps: undefined,
          removals: ['mac/package.json ws'],
          headline: '🟡 mac/package.json: ws unused (nothing imports it) → remove',
        })
      )
    );
    expect(done.state).toBe('needs_you');
    expect(done.autoMergeAt).toBeUndefined();
    expect(done.blocker).toMatchObject({
      kind: 'security',
      message: '🟡 mac/package.json: ws unused (nothing imports it) → remove',
    });
    expect(fixReview).not.toHaveBeenCalled();
    expect(modes()).toEqual(['auto']);
  });

  it('a major bump, a diff beyond the lockfiles or the setting off waits for the user', async () => {
    const cases: Array<{ bumps: TaskSecurity['bumps']; files: string[]; off?: boolean }> = [
      {
        bumps: [{ ecosystem: 'npm', name: 'tar', from: '6.2.0', to: '7.0.0' }],
        files: ['package.json'],
      },
      {
        bumps: [{ ecosystem: 'npm', name: 'tar', from: '6.2.0', to: '6.2.1' }],
        files: ['package.json', 'src/a.ts'],
      },
      {
        bumps: [{ ecosystem: 'npm', name: 'tar', from: '6.2.0', to: '6.2.1' }],
        files: ['package.json'],
        off: true,
      },
    ];
    for (const entry of cases) {
      pipeline.mockClear();
      files = entry.files;
      settings = { ...settings, securityAutoMergeBumps: entry.off ? false : undefined };
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, newTask(supply({ bumps: entry.bumps })));
      expect(done.state).toBe('needs_you');
      expect(done.blocker?.kind).toBe('security');
      expect(modes()).toEqual(['auto']);
    }
  });

  it('a bump whose check failed or whose review saw a problem does not merge', async () => {
    files = ['package.json'];
    pipeline.mockImplementation(
      async (): Promise<PipelineResult> => ({
        ...cleanReady(files),
        review: {
          verdict: 'concerns',
          summary: 'x',
          issues: [{ file: 'package.json', severity: 'medium', what: 'x' }],
          at: 'x',
          model: 'sonnet',
        },
      })
    );
    const scheduler = make();
    await scheduler.start(0);
    const done = await runToEnd(scheduler, newTask(supply()));
    expect(done.state).not.toBe('merged');
    expect(modes()).toEqual(['auto']);
  });

  it('a sweep finishes silently: no pipeline, no push, no worktree rules in its prompt', async () => {
    const scheduler = make();
    await scheduler.start(0);
    const done = await runToEnd(
      scheduler,
      newTask({ kind: 'sweep', section: 'web' }, { notify: false, prompt: 'Sweep web' })
    );
    expect(done.state).toBe('ready');
    expect(done.blocker).toBeUndefined();
    expect(pipeline).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    const prompt = launch.mock.calls[0][1] as string;
    expect(prompt).toBe('Sweep web');
    expect(prompt).not.toContain('Commit your work');
  });
  it('a security bump re-checked with `ut task verify` gets the countdown (2026-10-24)', async () => {
    files = ['web/package.json', 'web/pnpm-lock.yaml'];
    fixReview.mockResolvedValueOnce({ verdict: 'unavailable', reason: 'no answer from codex' });
    const scheduler = make();
    await scheduler.start(0);
    const done = await runToEnd(scheduler, newTask(supply()));
    expect(done.state).toBe('needs_you');
    expect(scheduler.verify(done.id)).toMatchObject({ ok: true });
    await scheduler.settled();
    expect(pipeline.mock.calls[1][1]).toMatchObject({ mode: 'verify', thenAuto: true });
    // The review that could not run is asked again; then the countdown, then the merge.
    expect(fixReview).toHaveBeenCalledTimes(2);
    const counting = scheduler.get(done.id) as TaskRecord;
    expect(counting).toMatchObject({
      state: 'ready',
      security: { fixReview: { verdict: 'confirmed' } },
    });
    expect(counting.autoMergeAt).toBeDefined();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await scheduler.settled();
    expect(modes()).toEqual(['auto', 'verify', 'merge']);
    expect(scheduler.get(done.id)?.state).toBe('merged');
  });

  describe('a risky task of a project that merges on its own (2026-10-24)', () => {
    const SESSIONS = 'web/src/server/routes/sessions.ts';
    const flagged = [
      { rule: 'auth', file: SESSIONS, detail: 'server-side authentication or permission code' },
    ];
    const plain = (overrides: Partial<NewTask> = {}): NewTask => ({
      ...newTask({ kind: 'fix' }),
      name: 'Rename the session list',
      prompt: 'Rename it',
      mergePolicy: undefined,
      security: undefined,
      ...overrides,
    });
    let head: string;

    beforeEach(() => {
      files = [SESSIONS, 'web/src/server/routes/sessions.test.ts'];
      head = 'h1';
      pipeline.mockImplementation(
        async (_task, options: PipelineOptions): Promise<PipelineResult> =>
          options.mode === 'merge'
            ? { state: 'merged', mergedSha: 'm1' }
            : options.riskReview
              ? {
                  ...cleanReady(files),
                  headSha: head,
                  verify: {
                    ...(cleanReady(files).verify as NonNullable<PipelineResult['verify']>),
                    headSha: head,
                  },
                  risk: flagged,
                  riskPending: true,
                }
              : { state: 'needs_you', blocker: { kind: 'risk', message: 'x' }, risk: flagged }
      );
    });

    it('merges after a confirmed second review and the countdown', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, plain());
      expect(pipeline.mock.calls[0][1]).toMatchObject({ mode: 'auto', riskReview: true });
      expect(riskReview).toHaveBeenCalledTimes(1);
      expect(done).toMatchObject({
        state: 'ready',
        autoMergeAt: new Date(T0 + 10 * 60_000).toISOString(),
        riskReview: {
          verdict: 'confirmed',
          headSha: 'h1',
          risk: [{ rule: 'auth', file: SESSIONS }],
        },
      });
      const push = notify.mock.calls[0][0] as NotificationPayload;
      expect(push.type).toBe('task-ready');
      expect(push.body).toMatch(
        /^Merges on its own at \d\d:\d\d: Rename the session list\. Flagged as risky \(web\/src\/server\/routes\/sessions\.ts\)/
      );
      expect(push.data).toMatchObject({ headline: 'Rename the session list', riskFiles: SESSIONS });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await scheduler.settled();
      expect(modes()).toEqual(['auto', 'merge']);
      // Only the findings the second review saw are accepted.
      expect(pipeline.mock.calls[1][1]).toMatchObject({
        mode: 'merge',
        byAgent: true,
        acceptRisk: true,
        acceptedRisk: [{ rule: 'auth', file: SESSIONS }],
      });
      const merged = scheduler.get(done.id) as TaskRecord;
      expect(merged.state).toBe('merged');
      expect(merged.autoMerged).toBe(true);
    });

    it('a second review that rejects it leaves it in needs_you with its reason', async () => {
      riskReview.mockResolvedValue({
        verdict: 'dismissed',
        reason: 'quita la comprobación del dueño de la sesión',
      });
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, plain());
      expect(done.state).toBe('needs_you');
      expect(done.autoMergeAt).toBeUndefined();
      expect(done.blocker).toMatchObject({
        kind: 'risk',
        message: `A risky change: auth in ${SESSIONS}`,
      });
      expect(done.blocker?.detail?.[0]).toBe(
        'Second review: quita la comprobación del dueño de la sesión'
      );
      const push = notify.mock.calls[0][0] as NotificationPayload;
      expect(push.type).toBe('task-needs-you');
      expect(push.body).toContain('Second review: quita la comprobación del dueño de la sesión');
      expect(push.data).toMatchObject({
        blocker: 'risk',
        riskReview: 'dismissed',
        riskReason: 'quita la comprobación del dueño de la sesión',
      });
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await scheduler.settled();
      expect(modes()).toEqual(['auto']);
      // «Fusionar» from the user still merges it.
      expect(scheduler.merge(done.id, { acceptRisk: true })).toMatchObject({ ok: true });
      await scheduler.settled();
      expect(scheduler.get(done.id)?.state).toBe('merged');
    });

    it('an unavailable second review waits for the user too', async () => {
      riskReview.mockResolvedValue({ verdict: 'unavailable', reason: 'no answer from codex' });
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, plain());
      expect(done.state).toBe('needs_you');
      expect(done.blocker?.detail?.[0]).toBe(
        'The second review could not run (no answer from codex)'
      );
      expect((notify.mock.calls[0][0] as NotificationPayload).data).toMatchObject({
        riskReview: 'unavailable',
      });
    });

    it('the same commit is not reviewed twice; a new commit is, and a re-check goes on to merge', async () => {
      riskReview.mockResolvedValueOnce({ verdict: 'dismissed', reason: 'no lo veo claro' });
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, plain());
      expect(done.state).toBe('needs_you');
      expect(riskReview).toHaveBeenCalledTimes(1);
      // Re-checked as it is: the verdict on h1 stands.
      expect(scheduler.verify(done.id)).toMatchObject({ ok: true });
      await scheduler.settled();
      expect(pipeline.mock.calls[1][1]).toMatchObject({
        mode: 'verify',
        thenAuto: true,
        riskReview: true,
      });
      expect(riskReview).toHaveBeenCalledTimes(1);
      expect(scheduler.get(done.id)?.state).toBe('needs_you');
      // A new commit: reviewed again, confirmed, counted down and merged without a tap.
      head = 'h2';
      expect(scheduler.verify(done.id)).toMatchObject({ ok: true });
      await scheduler.settled();
      expect(riskReview).toHaveBeenCalledTimes(2);
      expect(scheduler.get(done.id)).toMatchObject({
        state: 'ready',
        riskReview: { verdict: 'confirmed', headSha: 'h2' },
      });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await scheduler.settled();
      expect(scheduler.get(done.id)?.state).toBe('merged');
    });

    it('a file NEVER_UNATTENDED refuses keeps it in needs_you, unreviewed', async () => {
      files = [SESSIONS, '.github/workflows/ci.yml'];
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, plain());
      expect(done.state).toBe('needs_you');
      expect(done.blocker?.kind).toBe('risk');
      expect(riskReview).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await scheduler.settled();
      expect(modes()).toEqual(['auto']);
    });

    it('never past the second review: policy ask, paused merges, «Parar»', async () => {
      for (const entry of [
        { settings: { mergePolicy: 'ask' as const } },
        { task: { mergePolicy: 'ask' as const } },
        { settings: { autoMergePausedUntil: new Date(T0 + 48 * 3_600_000).toISOString() } },
      ]) {
        pipeline.mockClear();
        riskReview.mockClear();
        settings = { ...DEFAULT_PROJECT_SETTINGS, mergePolicy: 'auto', ...entry.settings };
        const scheduler = make();
        await scheduler.start(0);
        const done = await runToEnd(scheduler, plain(entry.task));
        expect(pipeline.mock.calls[0][1]).not.toHaveProperty('riskReview');
        expect(riskReview).not.toHaveBeenCalled();
        expect(done.state).toBe('needs_you');
      }
      settings = { ...DEFAULT_PROJECT_SETTINGS, mergePolicy: 'auto' };
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, plain());
      expect(done.autoMergeAt).toBeDefined();
      expect(scheduler.holdAutoMerge(done.id)).toMatchObject({ ok: true });
      expect(scheduler.get(done.id)).toMatchObject({
        state: 'needs_you',
        blocker: { kind: 'risk' },
      });
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await scheduler.settled();
      expect(scheduler.get(done.id)?.state).toBe('needs_you');
    });
  });

  describe('with the user’s autoApprove on (2026-10-24)', () => {
    const SESSIONS = 'web/src/server/routes/sessions.ts';
    const flagged = [{ rule: 'ci', file: '.github/workflows/ci.yml', detail: 'CI workflow' }];
    const plain = (overrides: Partial<NewTask> = {}): NewTask => ({
      ...newTask({ kind: 'fix' }),
      name: 'Rename the session list',
      prompt: 'Rename it',
      mergePolicy: undefined,
      security: undefined,
      ...overrides,
    });

    beforeEach(() => {
      autoApprove = true;
      files = [SESSIONS, '.github/workflows/ci.yml'];
      // Risky with a file no second review may pass: today it stops in needs_you.
      pipeline.mockImplementation(
        async (_task, options: PipelineOptions): Promise<PipelineResult> =>
          options.mode === 'merge'
            ? { state: 'merged', mergedSha: 'm1' }
            : {
                state: 'needs_you',
                headSha: 'h1',
                blocker: { kind: 'risk', message: 'Risky changes: CI workflow' },
                risk: flagged,
              }
      );
    });

    it('a risky task held for the OK gets the countdown, then merges as the user’s «Fusionar»', async () => {
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, plain());
      expect(riskReview).not.toHaveBeenCalled();
      expect(done).toMatchObject({
        state: 'ready',
        autoMergeAt: new Date(T0 + 10 * 60_000).toISOString(),
        autoApprovedMerge: { state: 'needs_you', blocker: { kind: 'risk' }, headSha: 'h1' },
      });
      expect(done.blocker).toBeUndefined();
      const push = notify.mock.calls.at(-1)?.[0] as NotificationPayload;
      expect(push.type).toBe('task-ready');
      expect(push.body).toMatch(/^Merges on its own at \d\d:\d\d \(autoApprove\)/);
      expect(push.data).toMatchObject({ autoApproved: true, headline: 'Rename the session list' });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await scheduler.settled();
      expect(modes()).toEqual(['auto', 'merge']);
      // What the user's tap would accept: these findings, as the user (no orchestrator gate).
      const options = pipeline.mock.calls[1][1] as PipelineOptions;
      expect(options).toMatchObject({
        mode: 'merge',
        acceptRisk: true,
        acceptedRisk: [{ rule: 'ci', file: '.github/workflows/ci.yml' }],
      });
      expect(options.byAgent).toBeUndefined();
      const merged = scheduler.get(done.id) as TaskRecord;
      expect(merged).toMatchObject({ state: 'merged', autoMerged: true });
      expect(merged.autoApprovedMerge).toBeUndefined();
    });

    it('a held security removal counts down too; «Parar» puts it back and it stays', async () => {
      files = ['mac/package.json', 'mac/package-lock.json'];
      pipeline.mockImplementation(
        async (_task, options: PipelineOptions): Promise<PipelineResult> =>
          options.mode === 'merge' ? { state: 'merged', mergedSha: 'm1' } : cleanReady(files)
      );
      const removal = newTask(
        supply({
          section: 'mac/package.json',
          bumps: undefined,
          removals: ['mac/package.json ws'],
          headline: '🟡 mac/package.json: ws unused (nothing imports it) → remove',
        })
      );
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, removal);
      expect(done).toMatchObject({
        state: 'ready',
        autoMergeAt: new Date(T0 + 10 * 60_000).toISOString(),
        autoApprovedMerge: { blocker: { kind: 'security' } },
      });
      expect(scheduler.holdAutoMerge(done.id)).toMatchObject({ ok: true });
      expect(scheduler.get(done.id)).toMatchObject({
        state: 'needs_you',
        blocker: { kind: 'security' },
      });
      // The same commit is not counted down again.
      expect(scheduler.verify(done.id)).toMatchObject({ ok: true });
      await scheduler.settled();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await scheduler.settled();
      expect(scheduler.get(done.id)).toMatchObject({ state: 'needs_you' });
      expect(modes()).not.toContain('merge');

      // Not held: merged at the end of its countdown as the user would.
      const second = await runToEnd(scheduler, removal);
      expect(second.autoMergeAt).toBeDefined();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await scheduler.settled();
      expect(scheduler.get(second.id)?.state).toBe('merged');
      expect((pipeline.mock.calls.at(-1) as [unknown, PipelineOptions])[1].byAgent).toBeUndefined();
    });

    it('no check counts down; turned off meanwhile, it waits for the user again', async () => {
      files = ['src/a.ts'];
      pipeline.mockImplementation(
        async (_task, options: PipelineOptions): Promise<PipelineResult> =>
          options.mode === 'merge'
            ? { state: 'merged', mergedSha: 'm1' }
            : {
                state: 'ready',
                headSha: 'h1',
                blocker: { kind: 'no-check', message: 'Not merged on its own: no check' },
              }
      );
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, plain());
      expect(done).toMatchObject({ state: 'ready', autoApprovedMerge: { state: 'ready' } });
      expect(done.autoMergeAt).toBeDefined();
      autoApprove = false;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await scheduler.settled();
      expect(scheduler.get(done.id)).toMatchObject({
        state: 'ready',
        blocker: { kind: 'no-check' },
      });
      expect(modes()).toEqual(['auto']);
    });

    it('a failed check still stops: a broken change is not a missing OK', async () => {
      files = ['src/a.ts'];
      pipeline.mockImplementation(
        async (): Promise<PipelineResult> => ({
          state: 'failed',
          headSha: 'h1',
          blocker: { kind: 'verify', message: 'The check failed', detail: ['1 failed'] },
        })
      );
      const scheduler = make();
      await scheduler.start(0);
      const created = await scheduler.create(plain());
      await scheduler.settled();
      // The agent's own fix rounds run out: it is the user's then, never counted down.
      for (let round = 0; round < 5; round++) {
        const task = scheduler.get(created.id) as TaskRecord;
        if (task.state === 'failed') break;
        await scheduler.markDone(task.sessionId as string, 'hecho');
        await scheduler.settled();
        await vi.advanceTimersByTimeAsync(0);
        await scheduler.settled();
      }
      const stopped = scheduler.get(created.id) as TaskRecord;
      expect(stopped).toMatchObject({ state: 'failed', blocker: { kind: 'verify' } });
      expect(stopped.autoMergeAt).toBeUndefined();
      expect(stopped.autoApprovedMerge).toBeUndefined();
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await scheduler.settled();
      expect(modes()).not.toContain('merge');
    });

    it('never in a project with policy ask or paused merges; off: today’s needs_you', async () => {
      for (const entry of [
        { settings: { mergePolicy: 'ask' as const } },
        { settings: { autoMergePausedUntil: new Date(T0 + 48 * 3_600_000).toISOString() } },
        { off: true },
      ]) {
        autoApprove = !entry.off;
        settings = { ...DEFAULT_PROJECT_SETTINGS, mergePolicy: 'auto', ...entry.settings };
        const scheduler = make();
        await scheduler.start(0);
        const done = await runToEnd(scheduler, plain());
        expect(done.state).toBe('needs_you');
        expect(done.autoMergeAt).toBeUndefined();
      }
    });

    it('turning it on starts the countdown of a task already waiting for the OK', async () => {
      autoApprove = false;
      const scheduler = make();
      await scheduler.start(0);
      const done = await runToEnd(scheduler, plain());
      expect(done.state).toBe('needs_you');
      autoApprove = true;
      scheduler.approveHeldMerges();
      expect(scheduler.get(done.id)).toMatchObject({
        state: 'ready',
        autoMergeAt: new Date(T0 + 10 * 60_000).toISOString(),
      });
    });
  });
});
