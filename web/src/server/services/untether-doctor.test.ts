import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRecord } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { builtForwarder } from '../../test/utils/built-forwarder.js';
import { turnEndSeen } from './claude-chat.js';
import {
  agentEventsCheck,
  bigCastsCheck,
  claudeStatusCheck,
  claudeVersionCheck,
  compactCastsWithForwarder,
  envNamesFromPs,
  finishedTaskSessionsCheck,
  forwarderBuildCheck,
  forwarderSourceHash,
  HOOKS_SILENT_AFTER_MS,
  logErrorsCheck,
  movedProjectsCheck,
  nativePtyCheck,
  newestForwarderSource,
  orchestratorsCheck,
  probeClaudeCompat,
  processEnvNames,
  readForwarderSourceHash,
  replacedSessionsCheck,
  rustToolchainFound,
  sessionEnvCheck,
  stuckTasksCheck,
  taskOrphansCheck,
  typicalCheckMs,
} from './doctor-checks.js';
import { unknownClaudeFlags } from './mac-sessions/relaunch-command.js';
import type { AdmissionVerdict } from './resource-monitor.js';
import { diskBytes } from './session-recordings.js';
import { type DoctorFinding, UntetherDoctor } from './untether-doctor.js';

describe("Untether's doctor (2026-10-20)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-doctor-'));
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  const finding = (key: string, severity: DoctorFinding['severity'] = 'warning') => ({
    key,
    check: 'test',
    severity,
    problem: `problem ${key}`,
  });

  it('tells a problem once, again only after it cleared, and keeps it across restarts', async () => {
    let current: DoctorFinding[] = [finding('a')];
    const told: string[] = [];
    const make = () =>
      new UntetherDoctor({
        statePath: path.join(dir, 'doctor.json'),
        checks: [{ id: 'test', run: () => current }],
        tellOrchestrator: (text) => {
          told.push(text);
          return true;
        },
        push: vi.fn(),
        log: vi.fn(),
      });
    const doctor = make();
    await doctor.runOnce();
    await doctor.runOnce();
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("Untether's doctor");
    expect(told[0]).toContain('problem a');
    // A restart does not tell it again.
    await make().runOnce();
    expect(told).toHaveLength(1);
    // Cleared, then back: told again.
    current = [];
    await doctor.runOnce();
    current = [finding('a')];
    await doctor.runOnce();
    expect(told).toHaveLength(2);
    expect(fs.statSync(path.join(dir, 'doctor.json')).mode & 0o777).toBe(0o600);
  });

  it('with no orchestrator to take it, only a critical problem reaches the phone', async () => {
    const push = vi.fn();
    const doctor = new UntetherDoctor({
      checks: [{ id: 'test', run: () => [finding('w'), finding('c', 'critical')] }],
      tellOrchestrator: () => false,
      push,
      log: vi.fn(),
    });
    await doctor.runOnce();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][1]).toBe('problem c');
  });

  it('a check that fails once keeps its open findings: not cleared, not told again (2026-11-10)', async () => {
    let fail = false;
    const told: string[] = [];
    const doctor = new UntetherDoctor({
      checks: [
        {
          id: 'test',
          run: () => {
            if (fail) throw new Error('ps took too long');
            return [finding('stray')];
          },
        },
      ],
      statePath: path.join(dir, 'doctor.json'),
      tellOrchestrator: (text) => {
        told.push(text);
        return true;
      },
      push: vi.fn(),
      log: vi.fn(),
    });
    await doctor.runOnce();
    fail = true;
    await doctor.runOnce();
    fail = false;
    await doctor.runOnce();
    expect(told.filter((text) => text.includes('problem stray'))).toHaveLength(1);
  });

  it('a check that throws is a finding, and the others still run', async () => {
    const doctor = new UntetherDoctor({
      checks: [
        {
          id: 'broken',
          run: () => {
            throw new Error('boom');
          },
        },
        { id: 'test', run: () => [finding('ok')] },
      ],
      tellOrchestrator: () => true,
      push: vi.fn(),
      log: vi.fn(),
    });
    const report = await doctor.runOnce();
    expect(report.failedChecks).toEqual(['broken']);
    expect(report.findings.map((entry) => entry.key)).toEqual(['doctor-check-failed:broken', 'ok']);
  });

  describe('checks', () => {
    it('native-pty rebuilds a missing spawn-helper and says it healed', async () => {
      let present = false;
      const rebuild = vi.fn(async () => {
        present = true;
      });
      const check = nativePtyCheck({
        helperPath: () => '/x/spawn-helper',
        rebuild,
        exists: () => present,
      });
      expect(await check.run()).toMatchObject([
        { severity: 'critical', healed: 'node-pty rebuilt' },
      ]);
      expect(await check.run()).toEqual([]);
      expect(rebuild).toHaveBeenCalledTimes(1);
    });

    it('stuck-tasks sees states held too long, a message never typed, a missed start', () => {
      const now = Date.parse('2026-10-20T20:00:00Z');
      const task = (over: Partial<TaskRecord>) =>
        ({
          id: 'abcdef123456',
          name: 'T',
          state: 'working',
          stateSince: '2026-10-20T19:59:00Z',
          runAt: '2026-10-20T19:00:00Z',
          ...over,
        }) as TaskRecord;
      const check = stuckTasksCheck({
        now: () => now,
        tasks: () => [
          task({
            id: 'a1',
            state: 'verifying',
            stateSince: '2026-10-20T18:30:00Z',
            verify: { startedAt: '2026-10-20T18:45:00Z' } as TaskRecord['verify'],
          }),
          task({ id: 'a2', pendingInput: [{ text: 'x', at: '2026-10-20T19:00:00Z' }] }),
          task({ id: 'a3', state: 'scheduled', runAt: '2026-10-20T19:30:00Z' }),
          task({ id: 'a4' }),
          // 2026-11-01: 90 min checking, 80 of them in the merge queue, its check 10 min old.
          task({
            id: 'a5',
            state: 'verifying',
            stateSince: '2026-10-20T18:30:00Z',
            verify: { startedAt: '2026-10-20T19:50:00Z' } as TaskRecord['verify'],
          }),
          // Still waiting for its check after 90 min: the line moves, not stuck yet.
          task({ id: 'a6', state: 'verifying', stateSince: '2026-10-20T18:30:00Z' }),
          // Waiting 3.5 h: a line that does not move.
          task({ id: 'a7', state: 'verifying', stateSince: '2026-10-20T16:30:00Z' }),
        ],
      });
      expect((check.run() as DoctorFinding[]).map((entry) => entry.key)).toEqual([
        'stuck-task:a1:verifying',
        'stuck-input:a2',
        'stuck-scheduled:a3',
        'stuck-task:a7:verifying',
      ]);
    });

    describe("stuck-tasks: first in line follows the scheduler's admission (2026-11-11)", () => {
      let now = Date.parse('2026-11-11T01:00:00Z');
      const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
      const first = (sinceMin: number) =>
        ({
          id: '5f28548a1111',
          name: 'T',
          state: 'queued',
          stateSince: at(sinceMin),
          runAt: at(sinceMin),
          queued: {
            repoPath: '/repo',
            since: at(sinceMin),
            order: 1,
            position: 1,
            active: 2,
            limit: 3,
          },
        }) as TaskRecord;
      const keys = (
        task: TaskRecord,
        admission: () => AdmissionVerdict,
        check = undefined as ReturnType<typeof stuckTasksCheck> | undefined
      ) =>
        (
          (
            check ?? stuckTasksCheck({ now: () => now, tasks: () => [task], admission })
          ).run() as DoctorFinding[]
        ).map((entry) => entry.problem);
      const loaded: AdmissionVerdict = {
        ok: false,
        short: ['cpu'],
        detail: 'load 170 (max 24)',
      };
      const open: AdmissionVerdict = { ok: true, short: [], detail: 'room' };

      it('a high load does not warn, however it was queued (no resources note on the task)', () => {
        expect(keys(first(40), () => loaded)).toEqual([]);
      });

      it('a wait of hours by load is told with the real reason', () => {
        const [problem] = keys(first(200), () => loaded);
        expect(problem).toContain('waiting 200 min by cpu of the Mac (load 170 (max 24))');
      });

      it('with a slot and the admission free it warns only after the margin of looks', () => {
        const task = first(40);
        const check = stuckTasksCheck({
          now: () => now,
          tasks: () => [task],
          admission: () => open,
        });
        expect(keys(task, () => open, check)).toEqual([]);
        now += 11 * 60_000;
        const [problem] = keys(task, () => open, check);
        expect(problem).toContain('admission open for 11 min, but has not started');
      });
    });

    describe('stuck-tasks timed by the phase a checking or merging task is in (2026-11-08)', () => {
      const now = Date.parse('2026-11-08T15:40:00Z');
      const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
      const repo = { repoPath: '/repo', baseBranch: 'untether' };
      const task = (over: Partial<TaskRecord>) =>
        ({
          name: 'T',
          state: 'merging',
          stateSince: at(1),
          runAt: at(120),
          ...repo,
          ...over,
        }) as TaskRecord;
      // Passed whole checks of this repo: 10, 12 and 14 min (median 12, expected 24); the
      // batch run stamped on both of its cars counts once.
      const history = task({
        id: 'h1',
        state: 'merged',
        stateSince: at(400),
        timings: [10, 12, 14].map((m, i) => ({
          phase: 'verify' as const,
          startedAt: at(300 + i * 60),
          finishedAt: at(300 + i * 60 - m),
          round: 1,
          outcome: 'passed',
          level: 'batch' as const,
        })),
      });
      const historyCopy = task({
        id: 'h2',
        state: 'merged',
        stateSince: at(400),
        timings: history.timings,
      });
      const verify = (over: Partial<NonNullable<TaskRecord['verify']>>) =>
        ({ command: 'pnpm run check', cwd: '/wt', ...over }) as TaskRecord['verify'];
      const run = (
        tasks: TaskRecord[],
        written: Record<string, number>,
        options: { batch?: string[]; alive?: string[] } = {}
      ) =>
        (
          stuckTasksCheck({
            now: () => now,
            tasks: () => [history, historyCopy, ...tasks],
            writtenAt: (file) => (file in written ? now - written[file] * 60_000 : undefined),
            batchOf: () => options.batch ?? [],
            checkAlive: (log) => (options.alive?.includes(log) ? true : undefined),
          }).run() as DoctorFinding[]
        ).map((entry) => `${entry.key} ${entry.problem}`);

      it('the 0b76eb3a false alarm: merging 23 min behind its batch check that moves', () => {
        expect(typicalCheckMs([history, historyCopy], '/repo', 'whole')).toBe(12 * 60_000);
        const tasks = [
          task({
            id: '0b76eb3a1111',
            stateSince: at(23),
            verify: verify({
              logPath: '/l/0b/verify.log',
              startedAt: at(30),
              finishedAt: at(24),
              level: 'related',
            }),
          }),
          task({
            id: '430451b11111',
            state: 'verifying',
            stateSince: at(13),
            verify: verify({
              logPath: '/l/43/verify-batch.log',
              startedAt: at(13),
              level: 'batch',
            }),
          }),
        ];
        const batch = ['0b76eb3a1111', '430451b11111'];
        expect(run(tasks, { '/l/43/verify-batch.log': 0.5 }, { batch })).toEqual([]);
        // Without any history the old limits stand, and they do not trip either.
        expect(
          stuckTasksCheck({
            now: () => now,
            tasks: () => tasks,
            writtenAt: () => now,
            batchOf: () => batch,
          }).run() as DoctorFinding[]
        ).toEqual([]);
      });

      it('a batch check with no progress (log still, no live process) is told, with the car behind it', () => {
        const tasks = [
          task({ id: 'car1aaaaaaaa', stateSince: at(20) }),
          task({
            id: 'car2bbbbbbbb',
            name: 'Lote',
            state: 'verifying',
            stateSince: at(18),
            verify: verify({
              logPath: '/l/c2/verify-batch.log',
              startedAt: at(18),
              level: 'batch',
            }),
          }),
        ];
        const batch = ['car1aaaaaaaa', 'car2bbbbbbbb'];
        expect(run(tasks, { '/l/c2/verify-batch.log': 16 }, { batch })).toEqual([
          'stuck-task:car1aaaaaaaa:merging task car1aaaa "T" has been merging for 20 min (in a merge batch, behind car2bbbb "Lote"\'s merge batch check for 18 min, no progress for 16 min)',
          'stuck-task:car2bbbbbbbb:verifying task car2bbbb "Lote" has been verifying for 18 min (its merge batch check for 18 min, no progress for 16 min)',
        ]);
        // The same silence with the check's process alive, within what it takes: no warning.
        expect(
          run(tasks, { '/l/c2/verify-batch.log': 16 }, { batch, alive: ['/l/c2/verify-batch.log'] })
        ).toEqual([]);
      });

      it('a check far past the median is told even while its log grows and its process lives', () => {
        const findings = run(
          [
            task({
              id: 'slowcccccccc',
              state: 'verifying',
              stateSince: at(40),
              verify: verify({ logPath: '/l/s/verify.log', startedAt: at(30), level: 'full' }),
            }),
          ],
          { '/l/s/verify.log': 0 },
          { alive: ['/l/s/verify.log'] }
        );
        expect(findings).toEqual([
          'stuck-task:slowcccccccc:verifying task slowcccc "T" has been verifying for 40 min (its whole check for 30 min, past the 24 min expected (typical check 12 min))',
        ]);
      });

      it('another check in the same repository does not hide a merge that hangs', () => {
        const other = task({
          id: 'otherddddddd',
          state: 'verifying',
          stateSince: at(5),
          verify: verify({ logPath: '/l/o/verify.log', startedAt: at(5), finishedAt: undefined }),
        });
        const finished = task({
          id: 'finisheeeeee',
          state: 'verifying',
          verify: verify({ startedAt: at(40), finishedAt: at(2) }),
        });
        // Not on board any batch: timed from its own merging, whatever else runs or ended.
        expect(
          run([task({ id: 'hungffffffff', stateSince: at(45) }), other, finished], {
            '/l/o/verify.log': 0,
          })
        ).toEqual([
          'stuck-task:hungffffffff:merging task hungffff "T" has been merging for 45 min (merging for 45 min)',
        ]);
        // On board, with its batch's last check just ended: the batch is moving the base.
        expect(
          run(
            [task({ id: 'hungffffffff', stateSince: at(45) }), finished],
            {},
            {
              batch: ['hungffffffff', 'finisheeeeee'],
            }
          )
        ).toEqual([]);
      });

      it('a merge queue that moves is no stuck task, near its head too; one that does not is', () => {
        const head = (startedMinAgo: number) =>
          task({
            id: 'headdddddddd',
            name: 'Cabeza',
            state: 'verifying',
            stateSince: at(300),
            mergeQueue: { position: 1, of: 3, since: at(300) },
            verify: verify({
              logPath: '/l/h/verify.log',
              startedAt: at(startedMinAgo),
              level: 'full',
            }),
          });
        const second = task({
          id: 'wait2eeeeeee',
          state: 'verifying',
          stateSince: at(240),
          mergeQueue: { position: 2, of: 3, since: at(240) },
        });
        // 4 h in line, now second: the head's check started 5 min ago (the line moved).
        expect(run([head(5), second], { '/l/h/verify.log': 0 })).toEqual([]);
        // The line has not moved for 3 h 20 min: told, with what it waits behind.
        expect(
          run([head(200), second], { '/l/h/verify.log': 0 }, { alive: ['/l/h/verify.log'] })
        ).toEqual([
          'stuck-task:headdddddddd:verifying task headdddd "Cabeza" has been verifying for 300 min (its whole check for 200 min, past the 24 min expected (typical check 12 min))',
          'stuck-task:wait2eeeeeee:verifying task wait2eee "T" has been verifying for 240 min (waiting in the merge queue (2 of 3), behind headdddd "Cabeza" for 200 min)',
        ]);
      });
    });

    it('finished-task-sessions stops what lingers and says so (2026-10-24)', async () => {
      const lingering = [
        { id: 'b5b3d787aaaa', name: 'Diagnóstico', state: 'done', sessionId: 'sess-1234567' },
        { id: 'c79bbb25aaaa', name: 'NODE_ENV', state: 'done', sessionId: 'sess-7654321' },
      ] as TaskRecord[];
      const outcomes = {
        b5b3d787aaaa: 'stopped',
        c79bbb25aaaa: 'failed',
        e57448a5aaaa: 'not-needed',
      } as const;
      lingering.push({ id: 'e57448a5aaaa', name: 'Reabierta', state: 'done' } as TaskRecord);
      const stop = vi.fn(async (id: string) => outcomes[id as keyof typeof outcomes]);
      const check = finishedTaskSessionsCheck({ lingering: () => lingering, stop });
      const findings = await check.run();
      expect(stop.mock.calls.map(([id]) => id)).toEqual([
        'b5b3d787aaaa',
        'c79bbb25aaaa',
        'e57448a5aaaa',
      ]);
      // One that ended or became the user's meanwhile is no finding (no false warning).
      expect(findings).toMatchObject([
        { key: 'finished-task-session:b5b3d787aaaa', healed: 'session stopped' },
        { key: 'finished-task-session:c79bbb25aaaa', severity: 'warning' },
      ]);
      expect(findings[1].healed).toBeUndefined();
      expect(findings[1].problem).toContain('stopping it failed');
      expect(await finishedTaskSessionsCheck({ lingering: () => [], stop }).run()).toEqual([]);
    });

    it('task-orphans sweeps and tells what closed tasks left running, once (2026-11-02)', async () => {
      const kills: Array<{
        at: string;
        taskId: string;
        taskName?: string;
        pid: number;
        command: string;
        signal: 'TERM' | 'KILL';
      }> = [];
      const reap = vi.fn(async () => {
        if (kills.length) return [];
        const at = new Date().toISOString();
        kills.push(
          {
            at,
            taskId: 'b58f8cadaaaa',
            taskName: 'Carga',
            pid: 700,
            command: 'yes',
            signal: 'TERM',
          },
          {
            at,
            taskId: 'b58f8cadaaaa',
            taskName: 'Carga',
            pid: 701,
            command: 'yes',
            signal: 'TERM',
          },
          {
            at,
            taskId: 'b58f8cadaaaa',
            taskName: 'Carga',
            pid: 701,
            command: 'yes',
            signal: 'KILL',
          }
        );
        return kills;
      });
      const check = taskOrphansCheck({ reap, recent: () => kills });
      const findings = await check.run();
      expect(reap).toHaveBeenCalledTimes(1);
      expect(findings).toEqual([
        {
          key: 'task-orphans:b58f8cadaaaa',
          check: 'task-orphans',
          severity: 'warning',
          problem:
            'task b58f8cad "Carga" had closed but left 2 processes running (yes; pids 700, 701)',
          healed: 'ended (TERM, 1 needed KILL)',
        },
      ]);
      // Told once: the next run, with nothing new, finds nothing.
      expect(await check.run()).toEqual([]);
    });

    it('task-orphans only tells of hidden-environment processes in a closed task’s folder (AI review)', async () => {
      const reap = vi.fn(async () => []);
      const check = taskOrphansCheck({
        reap,
        recent: () => [],
        suspects: () => [
          { taskId: 'b58f8cadaaaa', taskName: 'Carga', pid: 702, command: 'yes', cwd: '/w/b58f' },
          { taskId: 'b58f8cadaaaa', taskName: 'Carga', pid: 703, command: 'yes', cwd: '/w/b58f' },
        ],
      });
      const findings = await check.run();
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        key: 'task-orphans-suspect:b58f8cadaaaa',
        check: 'task-orphans',
        severity: 'warning',
      });
      expect(findings[0].problem).toContain('pids 702, 703');
      expect(findings[0].problem).toContain('left alone');
      expect(findings[0]).not.toHaveProperty('healed');
    });

    it('moved-projects heals stores still on an old folder and says which (2026-10-25)', async () => {
      const replay = vi.fn(async () => [{ name: 'orchestrators', changed: 1 }]);
      expect(await movedProjectsCheck({ replay }).run()).toEqual([
        {
          key: 'moved-projects:orchestrators',
          check: 'moved-projects',
          severity: 'warning',
          problem: 'orchestrators: 1 entry still on the old folder of a moved project',
          healed: 'moved to the current folder',
        },
      ]);
      expect(await movedProjectsCheck({ replay: async () => [] }).run()).toEqual([]);
    });

    it('replaced-sessions follows ids of an ended session whose conversation runs on (2026-10-25)', async () => {
      const follow = vi.fn(async (from: string) =>
        from === 'fwd_1_2'
          ? [
              { name: 'tasks', moved: 2 },
              { name: 'orchestrators', moved: 1 },
            ]
          : []
      );
      const sessions = [
        { id: 'fwd_1_2', status: 'exited', claudeSessionId: 'conv-1' },
        { id: 'new-1', status: 'running', claudeSessionId: 'conv-1' },
        { id: 'gone-1', status: 'exited', claudeSessionId: 'conv-2' },
        { id: 'twice-old', status: 'exited', claudeSessionId: 'conv-3' },
        { id: 'twice-a', status: 'running', claudeSessionId: 'conv-3' },
        { id: 'twice-b', status: 'running', claudeSessionId: 'conv-3' },
        { id: 'live', status: 'running', claudeSessionId: 'conv-4' },
      ];
      const check = replacedSessionsCheck({
        sessions: () => sessions,
        referenced: () => ['fwd_1_2', 'fwd_1_2', 'gone-1', 'twice-old', 'live', 'unknown'],
        follow,
      });
      expect(await check.run()).toEqual([
        {
          key: 'replaced-sessions:fwd_1_2',
          check: 'replaced-sessions',
          severity: 'warning',
          problem:
            'session fwd_1_2 ended but its conversation runs in new-1; still pointing at fwd_1_2: tasks (2), orchestrators (1)',
          healed: 'followed to new-1',
        },
      ]);
      expect(follow).toHaveBeenCalledTimes(1);
      expect(follow).toHaveBeenCalledWith('fwd_1_2', 'new-1');

      // 2026-10-25: a store that keeps the id but moves nothing (merged tasks) is no finding;
      // it was "healed" every 5 minutes.
      const nothing = replacedSessionsCheck({
        sessions: () => sessions,
        referenced: () => ['fwd_1_2'],
        follow: async () => [],
      });
      expect(await nothing.run()).toEqual([]);
    });

    it('orchestrators: a registry naming a gone session, a brief pending across two looks', () => {
      let pending = true;
      const check = orchestratorsCheck({
        registered: () => [{ repoPath: '/p/atlas', sessionId: 'gone-1' }],
        running: () => [{ repoPath: '/p/inkwell', sessionId: 'o1', pending }],
        sessionStatus: (id) => (id === 'o1' ? 'running' : 'exited'),
      });
      expect((check.run() as DoctorFinding[]).map((entry) => entry.key)).toEqual([
        'orchestrator-gone:/p/atlas:gone-1',
      ]);
      expect((check.run() as DoctorFinding[]).map((entry) => entry.key)).toContain(
        'orchestrator-brief:o1'
      );
      pending = false;
      expect((check.run() as DoctorFinding[]).map((entry) => entry.key)).not.toContain(
        'orchestrator-brief:o1'
      );
    });

    it('agent-events: hook files written again, a hooked Claude at work with no event, screen decisions told', () => {
      const now = 10 * HOOKS_SILENT_AFTER_MS;
      let writable = true;
      const check = agentEventsCheck({
        ensureHookFiles: () => writable,
        sessions: () => [
          // Hooks working: events right after it went busy.
          {
            sessionId: 'ok',
            busySeenAt: now - 3 * HOOKS_SILENT_AFTER_MS,
            lastEventAt: now - 3 * HOOKS_SILENT_AFTER_MS + 500,
          },
          // Never seen at work since the server started: nothing to say.
          { sessionId: 'idle' },
          // Just went busy: give its hooks a moment.
          { sessionId: 'new', busySeenAt: now - 1000 },
          // At work for minutes, no event since well before: silent.
          {
            sessionId: 'mute',
            busySeenAt: now - 3 * HOOKS_SILENT_AFTER_MS,
            lastEventAt: now - 9 * HOOKS_SILENT_AFTER_MS,
          },
          { sessionId: 'never', busySeenAt: now - 3 * HOOKS_SILENT_AFTER_MS },
        ],
        screenShare: () => ({ screen: 2, total: 9 }),
        now: () => now,
      });
      expect(
        (check.run() as DoctorFinding[]).map((finding) => [finding.key, finding.severity])
      ).toEqual([
        ['agent-events:silent:mute', 'warning'],
        ['agent-events:silent:never', 'warning'],
        ['agent-events:screen-decisions', 'info'],
      ]);
      writable = false;
      expect((check.run() as DoctorFinding[])[0]).toMatchObject({
        key: 'agent-events:hook-files',
        severity: 'warning',
      });
    });

    it('claude-status and claude-version', async () => {
      expect(claudeStatusCheck({ unknown: () => ['thinking'] }).run()).toMatchObject([
        { key: 'claude-status:thinking' },
      ]);
      let version = '2.1.0 (Claude Code)';
      const check = claudeVersionCheck({
        statePath: path.join(dir, 'claude-version'),
        version: async () => version,
      });
      expect(await check.run()).toEqual([]);
      expect(await check.run()).toEqual([]);
      version = '2.2.0 (Claude Code)';
      expect(await check.run()).toMatchObject([{ key: 'claude-version:2.2.0 (Claude Code)' }]);
    });

    it('a Claude Code update runs the compatibility probe and reports what no longer reads (2026-10-20)', async () => {
      const help = [
        'Options:',
        '  -r, --resume [value]                  Resume a conversation',
        '  --model <model>                       Model for the session',
        '  --brand-new-flag <x>                  Something new',
        '                                        see also --not-a-flag-line',
      ].join('\n');
      expect(unknownClaudeFlags(help)).toEqual(['--brand-new-flag']);
      const reply = (stop: string) =>
        JSON.stringify({ type: 'assistant', message: { stop_reason: stop, content: [] } });
      const readable = [reply('tool_use'), reply('tool_use'), reply('end_turn')];
      // An agent still mid-turn: only tool calls so far.
      const midTurn = [reply('tool_use'), reply('tool_use'), reply('tool_use')];
      const unreadable = [reply('tool_use'), reply('tool_use'), reply('new_kind_of_end')];
      const probe = (transcripts: string[][]) =>
        probeClaudeCompat({
          help: async () => help,
          unknownFlags: unknownClaudeFlags,
          recentTranscriptLines: () => transcripts,
          turnEndSeen,
        });
      // One readable transcript is enough: the others may be mid-turn (2026-10-20 false alarm).
      expect(await probe([readable, midTurn])).toEqual([
        'claude --help lists flags the relaunch table does not know: --brand-new-flag (mac-sessions/relaunch-command.ts CLAUDE_FLAGS)',
      ]);
      expect((await probe([midTurn, unreadable])).at(-1)).toBe(
        'none of 2 recent transcripts with replies has a turn end Untether can read (claude-chat.ts turnAfter)'
      );

      let version = '2.1.304 (Claude Code)';
      const check = claudeVersionCheck({
        statePath: path.join(dir, 'claude-version-probe'),
        version: async () => version,
        probe: async () => ['something broke'],
      });
      expect(await check.run()).toEqual([]);
      version = '2.1.305 (Claude Code)';
      expect(await check.run()).toMatchObject([
        { severity: 'info' },
        {
          severity: 'warning',
          problem: 'after the Claude Code 2.1.305 (Claude Code) update: something broke',
        },
      ]);
    });

    it('log-errors counts the same error shape within the window only', () => {
      const now = Date.parse('2026-10-20T20:00:00.000Z');
      const log = path.join(dir, 'log.txt');
      const lines = [
        ...Array.from(
          { length: 31 },
          (_, i) =>
            `2026-10-20T19:55:${String(i % 60).padStart(2, '0')}.000Z ERROR [[SRV] pty] spawn failed for 1234abcd-0000-0000-0000-000000000000 port ${i}`
        ),
        '2026-10-20T18:00:00.000Z ERROR [[SRV] old] long ago',
      ];
      fs.writeFileSync(log, `${lines.join('\n')}\n`);
      const found = logErrorsCheck({ logPath: () => log, now: () => now }).run() as DoctorFinding[];
      expect(found).toHaveLength(1);
      expect(found[0].problem).toContain('31 errors');
    });

    describe('big-casts (2026-10-22: a 1.6 GB recording, 3.3 GB of casts)', () => {
      const MB = 1024 * 1024;
      const header = `${JSON.stringify({ version: 2, width: 80, height: 24 })}\n`;

      function writeCast(id: string, events: number, sparseBytes = 0): string {
        fs.mkdirSync(path.join(dir, id), { recursive: true });
        const file = path.join(dir, id, 'stdout');
        const lines = Array.from(
          { length: events },
          (_, n) => `${JSON.stringify([n, 'o', `event ${n} ${'x'.repeat(200)}`])}\n`
        );
        fs.writeFileSync(file, header);
        if (sparseBytes) fs.truncateSync(file, sparseBytes);
        fs.appendFileSync(file, lines.join(''));
        return file;
      }

      it('measures real disk use: a big sparse cast is not compacted', async () => {
        writeCast('sparse', 100, 600 * MB);
        const compact = vi.fn();
        const check = bigCastsCheck({
          controlDir: dir,
          compact,
          limits: () => ({ rotateBytes: MB, keepBytes: MB }),
        });
        expect(await check.run()).toEqual([]);
        expect(compact).not.toHaveBeenCalled();
      });

      it('compacts a cast over the cap, logs it and finds nothing', async () => {
        const file = writeCast('11111111-big', 10_000);
        const log = vi.fn();
        const compact = vi.fn(async (files: string[]) => {
          // Stands in for the forwarder: the disk under the cast is freed.
          for (const name of files) fs.writeFileSync(name, header);
          return new Map(files.map((name) => [name, {}]));
        });
        const check = bigCastsCheck({
          controlDir: dir,
          compact,
          limits: () => ({ rotateBytes: MB, keepBytes: 1234 }),
          log,
        });
        expect(await check.run()).toEqual([]);
        // Asked to keep from the block the tail starts in (session-recordings.ts planRotation).
        const [[files, cap, keep]] = compact.mock.calls as unknown as [string[], number, number][];
        expect(files).toEqual([file]);
        expect(cap).toBe(MB);
        expect(keep).toBeGreaterThanOrEqual(1234);
        expect(keep).toBeLessThan(1234 + 64 * 1024);
        expect(log.mock.calls.at(-1)?.[0]).toContain(
          'rotated the recording of session 11111111-big'
        );
      });

      it('reports a cast it could not shrink, with the reason', async () => {
        writeCast('22222222-big', 10_000);
        writeCast('33333333-small', 10);
        const check = bigCastsCheck({
          controlDir: dir,
          limits: () => ({ rotateBytes: MB, keepBytes: MB / 2 }),
          compact: async () => {
            throw new Error('no forwarder knows --compact-cast');
          },
        });
        const found = await check.run();
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ key: 'big-cast:22222222-big', severity: 'warning' });
        expect(found[0].problem).toContain('could not be shrunk');
        expect(found[0].problem).toContain('no forwarder knows --compact-cast');
      });

      it('tries the next forwarder when one rejects --compact-cast', async () => {
        const old = path.join(dir, 'old-fwd');
        fs.writeFileSync(old, '#!/bin/sh\necho "untether-fwd: invalid arguments" >&2\nexit 1\n', {
          mode: 0o755,
        });
        const current = path.join(dir, 'new-fwd');
        fs.writeFileSync(
          current,
          `#!/bin/sh\nshift 3\nfor f in "$@"; do echo "{\\"path\\":\\"$f\\",\\"error\\":\\"nope\\"}"; done\n`,
          { mode: 0o755 }
        );
        const compact = compactCastsWithForwarder(() => [path.join(dir, 'missing'), old, current]);
        expect(await compact(['/a/stdout', '/b/stdout'], 1, 1)).toEqual(
          new Map([
            ['/a/stdout', { error: 'nope' }],
            ['/b/stdout', { error: 'nope' }],
          ])
        );
        await expect(compactCastsWithForwarder(() => [old])([], 1, 1)).rejects.toThrow(
          /no forwarder knows --compact-cast.*invalid arguments/
        );
      });

      // The real forwarder, when this checkout built it from its current sources.
      const forwarder = builtForwarder();
      it.skipIf(!forwarder)(
        'shrinks a real cast with the forwarder, keeping header, tail and size',
        async () => {
          const file = writeCast('44444444-real', 20_000); // about 4.5 MB
          const before = fs.readFileSync(file);
          const check = bigCastsCheck({
            controlDir: dir,
            limits: () => ({ rotateBytes: 2 * MB, keepBytes: MB }),
            compact: compactCastsWithForwarder(() => [forwarder as string]),
          });
          expect(await check.run()).toEqual([]);
          const after = fs.readFileSync(file);
          expect(after.length).toBe(before.length);
          expect(diskBytes(file)).toBeLessThanOrEqual(2 * MB);
          expect(after.subarray(0, header.length).toString()).toBe(header);
          expect(after.subarray(-MB).equals(before.subarray(-MB))).toBe(true);
        }
      );
    });
  });
});

describe('sessionEnvCheck (2026-10-24)', () => {
  it("heals the shield tmux server and tells sessions running with the server's runtime", async () => {
    const check = sessionEnvCheck({
      cleanShieldEnvironment: async () => ['NODE_ENV', 'npm_lifecycle_script'],
      sessions: () => [
        { id: 'aaaaaaaa-1', name: 'base de la app', pid: 11 },
        { id: 'bbbbbbbb-2', name: 'clean', pid: 22 },
        { id: 'cccccccc-3', name: 'no pid' },
      ],
      envNames: async (pid) =>
        pid === 11 ? ['HOME', 'NODE_ENV', 'npm_lifecycle_event'] : ['HOME', 'PATH'],
    });
    const findings = await check.run();
    expect(findings.map((finding) => finding.key)).toEqual([
      'session-env:shield-tmux',
      'session-env:aaaaaaaa-1',
    ]);
    expect(findings[0].healed).toBeTruthy();
    expect(findings[1].problem).toContain('NODE_ENV, npm_lifecycle_event');
    expect(findings[1].healed).toBeUndefined();
  });

  it('finds nothing when everything is clean', async () => {
    const check = sessionEnvCheck({
      cleanShieldEnvironment: async () => [],
      sessions: () => [{ id: 'a', pid: 1 }],
      envNames: async () => null,
    });
    expect(await check.run()).toEqual([]);
  });

  it('reads the environment names `ps -E` prints after the command', async () => {
    expect(
      envNamesFromPs('/bin/zsh -l HOME=/Users/me NODE_ENV=development LANG=es_ES.UTF-8\n')
    ).toEqual(['HOME', 'NODE_ENV', 'LANG']);
    if (process.platform !== 'darwin') return;
    // This test process itself: vitest sets NODE_ENV.
    expect(await processEnvNames(process.pid)).toContain('NODE_ENV');
  });
});

describe('forwarderBuildCheck (2026-11-02)', () => {
  let dir: string;
  let source: string;
  let web: string;
  let target: string;
  let mirror: string;
  let cargo: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-fwd-build-'));
    source = path.join(dir, 'native', 'ut-fwd');
    web = path.join(dir, 'web', 'native');
    target = path.join(web, 'untether-fwd');
    mirror = path.join(dir, 'web', 'bin', 'untether-fwd');
    cargo = path.join(source, 'target', 'release', 'untether-fwd');
    fs.mkdirSync(path.join(source, 'src', 'cast'), { recursive: true });
    fs.mkdirSync(web, { recursive: true });
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    for (const file of ['Cargo.toml', 'Cargo.lock', 'src/main.rs', 'src/cast/compact.rs']) {
      fs.writeFileSync(path.join(source, file), 'x');
    }
  });
  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  const at = (file: string, seconds: number) => {
    const time = new Date(Date.now() - 86_400_000 + seconds * 1000);
    fs.utimesSync(file, time, time);
  };
  const ageSources = (seconds: number) => {
    for (const file of ['Cargo.toml', 'Cargo.lock', 'src/main.rs', 'src/cast/compact.rs']) {
      at(path.join(source, file), seconds);
    }
  };
  const writeBinary = (file: string, seconds: number, body = 'old') => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    at(file, seconds);
  };
  /** Lets a background rebuild that already resolved finish its rename. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  /** A rebuild the test ends by hand. */
  const deferredRebuild = (body = 'new') => {
    let finish!: (error?: Error) => void;
    const rebuild = vi.fn(
      (output: string) =>
        new Promise<void>((resolve, reject) => {
          finish = (error) => {
            if (error) {
              fs.writeFileSync(output, 'partial');
              reject(error);
            } else {
              fs.writeFileSync(output, body);
              resolve();
            }
          };
        })
    );
    return { rebuild, finish: (error?: Error) => finish(error) };
  };
  const check = (extra: Partial<Parameters<typeof forwarderBuildCheck>[0]> = {}) =>
    forwarderBuildCheck({
      forwarders: () => [path.join(dir, 'env-fwd'), target, cargo, path.join(dir, 'app-fwd')],
      sourceDirs: () => [path.join(dir, 'missing'), source],
      rebuildCommand: 'cd web && node scripts/build-fwd-rust.js',
      rebuildTarget: target,
      ...extra,
    });

  it('finds the newest file among src/**, Cargo.toml and Cargo.lock', () => {
    ageSources(0);
    at(path.join(source, 'src', 'cast', 'compact.rs'), 50);
    expect(newestForwarderSource(source)?.file).toBe(
      path.join(source, 'src', 'cast', 'compact.rs')
    );
    at(path.join(source, 'Cargo.lock'), 60);
    expect(newestForwarderSource(source)?.file).toBe(path.join(source, 'Cargo.lock'));
  });

  it('hashes contents of src/**, Cargo.toml and Cargo.lock, not mtimes nor other files', () => {
    const first = forwarderSourceHash(source);
    ageSources(500);
    fs.writeFileSync(path.join(source, 'README.md'), 'not a source');
    fs.mkdirSync(path.join(source, 'target'), { recursive: true });
    fs.writeFileSync(path.join(source, 'target', 'junk'), 'build output');
    expect(forwarderSourceHash(source)).toBe(first);
    fs.writeFileSync(path.join(source, 'src', 'cast', 'compact.rs'), 'y');
    expect(forwarderSourceHash(source)).not.toBe(first);
    fs.writeFileSync(path.join(source, 'src', 'cast', 'compact.rs'), 'x');
    fs.renameSync(path.join(source, 'src', 'main.rs'), path.join(source, 'src', 'lib.rs'));
    expect(forwarderSourceHash(source)).not.toBe(first);
  });

  it('hashes like scripts/fwd-source-hash.js, which the build script writes with', () => {
    const require = createRequire(import.meta.url);
    const script = require('../../../scripts/fwd-source-hash.js') as {
      forwarderSourceHash: (dir: string) => string;
      readSourceHash: (binary: string) => string | undefined;
      writeSourceHash: (binary: string, hash: string) => void;
    };
    fs.writeFileSync(path.join(source, 'src', 'cast', 'ñ.rs'), Buffer.from([0, 1, 2, 255]));
    expect(script.forwarderSourceHash(source)).toBe(forwarderSourceHash(source));
    script.writeSourceHash(target, 'abc');
    expect(readForwarderSourceHash(target)).toBe('abc');
    expect(fs.readdirSync(web)).toEqual(['untether-fwd.source-hash']);
  });

  it('warns with the rebuild command when the binary the server uses is older than a source', async () => {
    ageSources(0);
    writeBinary(target, 10);
    expect(await check().run()).toEqual([]);
    at(path.join(source, 'src', 'cast', 'compact.rs'), 20);
    const [finding] = await check().run();
    expect(finding.key).toBe(`forwarder-build:${target}`);
    expect(finding.severity).toBe('warning');
    expect(finding.problem).toContain('compact.rs');
    expect(finding.problem).toContain('cd web && node scripts/build-fwd-rust.js');
    expect(finding.healed).toBeUndefined();
  });

  it('judges by the recorded source hash once there is one: a checkout touching mtimes is no change', async () => {
    writeBinary(target, 10);
    fs.writeFileSync(`${target}.source-hash`, `${forwarderSourceHash(source)}\n`);
    // A checkout or merge rewrote every source: newer mtimes, same contents.
    ageSources(500);
    const rebuild = vi.fn(async (output: string) => fs.writeFileSync(output, 'new'));
    expect(await check({ rebuild }).run()).toEqual([]);
    expect(rebuild).not.toHaveBeenCalled();
    // A real change, even with the binary newer than every source, is stale.
    fs.writeFileSync(path.join(source, 'src', 'main.rs'), 'changed');
    ageSources(0);
    const [finding] = await check().run();
    expect(finding.key).toBe(`forwarder-build:${target}`);
    expect(finding.problem).toContain('built from other sources');
    expect(finding.problem).toContain(forwarderSourceHash(source).slice(0, 12));
  });

  it('judges the binary the server would pick: the first candidate that exists', async () => {
    ageSources(20);
    writeBinary(cargo, 10);
    writeBinary(target, 30);
    expect(await check().run()).toEqual([]);
    fs.rmSync(target);
    const [finding] = await check().run();
    expect(finding.key).toBe(`forwarder-build:${cargo}`);
  });

  it('stays quiet without a source tree (packaged app)', async () => {
    writeBinary(target, 0);
    const packaged = check({ sourceDirs: () => [path.join(dir, 'missing')] });
    expect(await packaged.run()).toEqual([]);
  });

  it('rebuilds in the background: "rebuilding" at once, the result on the next run', async () => {
    ageSources(20);
    writeBinary(target, 10);
    writeBinary(mirror, 10);
    const before = fs.statSync(target).ino;
    const { rebuild, finish } = deferredRebuild();
    const healing = check({ rebuild, canRebuild: () => true, mirrors: [mirror] });
    const [started] = await healing.run();
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(path.dirname(rebuild.mock.calls[0][0])).toBe(web);
    expect(rebuild.mock.calls[0][0]).not.toBe(target);
    expect(started.severity).toBe('info');
    expect(started.key).toBe(`forwarder-build-rebuilding:${target}`);
    expect(started.problem).toContain('rebuilding');
    expect(started.healed).toBeUndefined();
    // Still building: told again, never a second build.
    const [still] = await healing.run();
    expect(still.key).toBe(`forwarder-build-rebuilding:${target}`);
    expect(rebuild).toHaveBeenCalledTimes(1);
    finish();
    await settle();
    // Built aside and renamed over: a running forwarder keeps its inode; the hash goes next to it.
    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.statSync(target).ino).not.toBe(before);
    expect(readForwarderSourceHash(target)).toBe(forwarderSourceHash(source));
    // web/bin/untether-fwd follows, with the same hash.
    expect(fs.readFileSync(mirror, 'utf8')).toBe('new');
    expect(readForwarderSourceHash(mirror)).toBe(forwarderSourceHash(source));
    expect(fs.readdirSync(web).sort()).toEqual(['untether-fwd', 'untether-fwd.source-hash']);
    const [done] = await healing.run();
    expect(done.key).toBe(`forwarder-build:${target}`);
    expect(done.healed).toContain(target);
    expect(await healing.run()).toEqual([]);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('a doctor run does not wait for the build', async () => {
    ageSources(20);
    writeBinary(target, 10);
    const rebuild = vi.fn(() => new Promise<void>(() => {}));
    const [finding] = await check({ rebuild }).run();
    expect(finding.severity).toBe('info');
  });

  const claims = () => fs.readdirSync(web).filter((name) => name.includes('.rebuild.'));

  it('never two rebuilds at once, across processes: a live claim builds, a dead one is cleared', async () => {
    ageSources(20);
    writeBinary(target, 10);
    const other = path.join(web, '.untether-fwd.rebuild.424242.abcdef');
    fs.writeFileSync(other, '424242');
    const rebuild = vi.fn(async (output: string) => fs.writeFileSync(output, 'new'));
    const [held] = await check({ rebuild, pidAlive: () => true }).run();
    expect(rebuild).not.toHaveBeenCalled();
    expect(held.problem).toContain('by process 424242');
    expect(claims()).toEqual(['.untether-fwd.rebuild.424242.abcdef']);
    // The holder died (a restarted server): its claim and leftovers go, this one builds.
    fs.writeFileSync(path.join(web, '.untether-fwd.424242.tmp'), 'half');
    const fresh = check({ rebuild, pidAlive: () => false });
    const [started] = await fresh.run();
    expect(started.key).toBe(`forwarder-build-rebuilding:${target}`);
    expect(rebuild).toHaveBeenCalledTimes(1);
    await settle();
    expect(fs.readdirSync(web).sort()).toEqual(['untether-fwd', 'untether-fwd.source-hash']);
  });

  it('a claim holds while its rebuild runs, for any other checker (this process too)', async () => {
    ageSources(20);
    writeBinary(target, 10);
    const { rebuild, finish } = deferredRebuild();
    await check({ rebuild }).run();
    expect(claims()).toHaveLength(1);
    expect(fs.readFileSync(path.join(web, claims()[0]), 'utf8')).toBe(String(process.pid));
    const other = vi.fn(async () => {});
    const [held] = await check({ rebuild: other, pidAlive: () => false }).run();
    expect(held.key).toBe(`forwarder-build-rebuilding:${target}`);
    expect(held.problem).toContain(`by process ${process.pid}`);
    expect(other).not.toHaveBeenCalled();
    finish();
    await settle();
    expect(claims()).toEqual([]);
  });

  it('two checkers claiming at the same time never both build; a live claim is never removed', async () => {
    ageSources(20);
    writeBinary(target, 10);
    // A dead process's claim is there. While this checker looks at it (and clears it), another
    // process claims: the race the review found with one shared lock file, where a cleaner moved
    // a live lock aside and a third process built too. Here the dead claim and the new one are
    // different files: only the dead one goes, and this checker, listing after its own claim,
    // sees the live one and withdraws.
    fs.writeFileSync(path.join(web, '.untether-fwd.rebuild.999.dead00'), '999');
    const late = path.join(web, '.untether-fwd.rebuild.515151.0a0b0c');
    const pidAlive = (pid: number) => {
      if (pid === 999 && !fs.existsSync(late)) fs.writeFileSync(late, '515151');
      return pid === 515151;
    };
    const rebuild = vi.fn(async () => {});
    const [finding] = await check({ rebuild, pidAlive }).run();
    expect(rebuild).not.toHaveBeenCalled();
    expect(finding.problem).toContain('by process 515151');
    expect(claims()).toEqual(['.untether-fwd.rebuild.515151.0a0b0c']);
  });

  it('builds the target when the server falls back to a later candidate (cargo, app)', async () => {
    ageSources(20);
    writeBinary(path.join(dir, 'app-fwd'), 10);
    const rebuild = vi.fn(async (output: string) => fs.writeFileSync(output, 'new'));
    const healing = check({ rebuild });
    await healing.run();
    await settle();
    const [finding] = await healing.run();
    expect(finding.healed).toBeTruthy();
    expect(fs.existsSync(target)).toBe(true);
  });

  it('never rebuilds over a binary that is not the build target (env override), nor without cargo', async () => {
    ageSources(20);
    writeBinary(path.join(dir, 'env-fwd'), 10);
    const rebuild = vi.fn(async (output: string) => fs.writeFileSync(output, 'new'));
    const [overridden] = await check({ rebuild }).run();
    expect(overridden.healed).toBeUndefined();
    expect(rebuild).not.toHaveBeenCalled();
    fs.rmSync(path.join(dir, 'env-fwd'));
    writeBinary(target, 10);
    const [noCargo] = await check({ rebuild, canRebuild: () => false }).run();
    expect(noCargo.healed).toBeUndefined();
    expect(noCargo.severity).toBe('warning');
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('a failed rebuild is told on the next run with its reason and not retried until the sources change', async () => {
    ageSources(20);
    writeBinary(target, 10);
    const { rebuild, finish } = deferredRebuild();
    const healing = check({ rebuild });
    const [started] = await healing.run();
    expect(started.severity).toBe('info');
    finish(
      Object.assign(new Error('Command failed'), {
        stderr: 'error[E0425]: cannot find value\nERROR: cargo build failed.',
      })
    );
    await settle();
    expect(fs.readFileSync(target, 'utf8')).toBe('old');
    expect(fs.readdirSync(web)).toEqual(['untether-fwd']);
    const [first] = await healing.run();
    expect(first.key).toBe(`forwarder-build:${target}`);
    expect(first.severity).toBe('warning');
    expect(first.healed).toBeUndefined();
    expect(first.problem).toContain('ERROR: cargo build failed.');
    const [second] = await healing.run();
    expect(second.problem).toContain('the automatic rebuild failed');
    expect(rebuild).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(source, 'src', 'main.rs'), 'fixed');
    await healing.run();
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it('keeps web/bin/untether-fwd equal to the target when the target is current', async () => {
    ageSources(0);
    writeBinary(target, 10, 'current');
    fs.writeFileSync(`${target}.source-hash`, `${forwarderSourceHash(source)}\n`);
    writeBinary(mirror, 5, 'stale');
    const synced = check({ mirrors: [mirror] });
    const [finding] = await synced.run();
    expect(finding.key).toBe(`forwarder-build-copy:${mirror}`);
    expect(finding.healed).toContain(target);
    expect(fs.readFileSync(mirror, 'utf8')).toBe('current');
    expect(readForwarderSourceHash(mirror)).toBe(forwarderSourceHash(source));
    expect(fs.readdirSync(path.dirname(mirror)).sort()).toEqual([
      'untether-fwd',
      'untether-fwd.source-hash',
    ]);
    expect(await synced.run()).toEqual([]);
    // A stale target is not copied over the mirror: the rebuild comes first.
    fs.writeFileSync(path.join(source, 'src', 'main.rs'), 'changed');
    fs.writeFileSync(mirror, 'other');
    const [stale] = await check({ mirrors: [mirror] }).run();
    expect(stale.key).toBe(`forwarder-build:${target}`);
    expect(fs.readFileSync(mirror, 'utf8')).toBe('other');
  });

  it('finds cargo or rustup where the build script looks', () => {
    const bin = path.join(dir, 'home', '.cargo', 'bin');
    expect(rustToolchainFound({ PATH: path.join(dir, 'none'), HOME: path.join(dir, 'home') })).toBe(
      false
    );
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'cargo'), '#!/bin/sh\n', { mode: 0o755 });
    expect(rustToolchainFound({ PATH: path.join(dir, 'none'), HOME: path.join(dir, 'home') })).toBe(
      true
    );
  });
});
