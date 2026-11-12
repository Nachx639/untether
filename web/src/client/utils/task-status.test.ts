import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestSession, createTestTask as task } from '@/test/utils/test-factories';
import type { TaskRecord } from '../../shared/tasks.js';
import { setLocale } from '../i18n/index.js';
import {
  activeAutoFix,
  autoMergeTime,
  canRevertTask,
  confirmKindText,
  isBoardTask,
  isDoneTask,
  orchestratorErrorText,
  projectSettingsErrorText,
  revertState,
  reviewRetryLine,
  sortBoardTasks,
  taskActions,
  taskAgentLine,
  taskBucket,
  taskDetail,
  taskDisplayTitle,
  taskErrorText,
  taskGlanceLine,
  taskReason,
  taskStateWord,
  taskStatsLine,
  taskStatusLabel,
  taskTimingRounds,
  taskTimingsLine,
  taskUnits,
  taskWantsUser,
} from './task-status.js';

describe('task status (home board)', () => {
  beforeEach(async () => {
    await setLocale('es');
  });
  afterEach(async () => {
    // A test that fails before its own useRealTimers must not leave the next ones on a fake clock.
    vi.useRealTimers();
    await setLocale('en');
  });

  it('2026-11-08: a card says one line: the agent’s, else why it stopped, else its summary’s first', () => {
    expect(taskGlanceLine(task({ state: 'working' }), 'Ejecuta los tests de login')).toBe(
      'Ejecuta los tests de login'
    );
    expect(
      taskGlanceLine(task({ state: 'needs_you', blocker: { kind: 'verify', message: 'x' } }))
    ).toBe('no pasa la comprobación');
    const summary = `Hecho: ${'una explicación muy larga '.repeat(10)}\nVerificado: pnpm test`;
    const line = taskGlanceLine(task({ state: 'ready', summary }));
    expect([...line].length).toBeLessThanOrEqual(80);
    expect(line.startsWith('Hecho: una explicación')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    expect(taskGlanceLine(task({ state: 'working' }))).toBe('');
  });

  it('a task only paced by the drip does not read as the Mac being short (2026-11-08)', () => {
    const paced = task({
      state: 'queued',
      queued: {
        repoPath: '/r',
        since: '',
        order: 1,
        position: 2,
        of: 3,
        resources: {
          short: ['swap'],
          paced: true,
          detail: 'swap steady at 7.0 GB (no growth over 10 min)',
          at: '',
        },
      },
    });
    expect(taskStatusLabel(paced)).toBe('en cola · 2.ª de 3');
    expect(taskReason(paced)).toBe(
      'Entra una tarea cada cierto tiempo: arranca sola cuando le toque'
    );
    expect(taskDetail(paced)).toMatch(/swap steady at 7\.0 GB/);
  });

  it('a queued task (project task limit, 2026-11-01): its place, «Empezar ya», move, discard', () => {
    const queued = (position: number, of: number) =>
      task({
        state: 'queued',
        queued: {
          repoPath: '/repo',
          since: '',
          order: position,
          limit: 2,
          position,
          of,
          active: 2,
        },
      });
    expect(taskBucket(queued(1, 3))).toBe('scheduled');
    expect(taskStatusLabel(queued(2, 3))).toBe('en cola · 2.ª de 3');
    expect(taskStateWord(queued(2, 3))).toBe('en cola');
    expect(taskActions(queued(1, 3), { hasSession: false })).toEqual({
      primary: 'startNow',
      secondary: ['moveDown', 'discard'],
    });
    expect(taskActions(queued(2, 3), { hasSession: false }).secondary).toEqual([
      'moveUp',
      'moveDown',
      'discard',
    ]);
    expect(taskActions(queued(1, 1), { hasSession: false }).secondary).toEqual(['discard']);
    // Queued ones in the order they start, whenever they were queued.
    const second = { ...queued(2, 2), id: 'b', stateSince: '2026-11-01T10:00:00Z' };
    const first = { ...queued(1, 2), id: 'a', stateSince: '2026-11-01T11:00:00Z' };
    expect(sortBoardTasks([second, first]).map((each) => each.id)).toEqual(['a', 'b']);
  });

  it('a task waiting for room on the Mac (taskAdmission, 2026-11-01): what it waits for and the numbers', () => {
    const waiting = task({
      state: 'queued',
      queued: {
        repoPath: '/repo',
        since: '',
        order: 1,
        position: 1,
        of: 2,
        resources: {
          short: ['memory', 'cpu'],
          detail: 'memory 9 % free (min 20 %), load 40.0 (max 24)',
          at: '',
        },
      },
    });
    expect(taskStatusLabel(waiting)).toBe('esperando memoria, CPU · 1.ª de 2');
    expect(taskStateWord(waiting)).toBe('en cola');
    expect(taskReason(waiting)).toBe(
      'Esperando margen en el Mac (memoria, CPU): arranca sola cuando lo haya'
    );
    expect(taskDetail(waiting)).toBe('memory 9 % free (min 20 %), load 40.0 (max 24)');
    // Only settling (seconds): a plain place in line.
    const settling = task({
      state: 'queued',
      queued: {
        repoPath: '/repo',
        since: '',
        order: 1,
        position: 1,
        of: 1,
        resources: { short: [], settling: true, detail: '', at: '' },
      },
    });
    expect(taskStatusLabel(settling)).toBe('en cola · 1.ª de 1');
    expect(taskReason(settling)).toBe('');
  });

  it('a task started after others (--after, its zone) says which it waits for, and when one stopped', () => {
    const waiting = task({
      state: 'queued',
      queued: {
        repoPath: '/repo',
        since: '',
        order: 1,
        position: 1,
        of: 1,
        waitsFor: [
          { taskId: 'aaaaaaaa-1', name: 'Una', why: 'after', state: 'working' },
          { taskId: 'bbbbbbbb-2', name: 'Otra', why: 'zone', zone: 'core', state: 'ready' },
        ],
      },
    });
    expect(taskStatusLabel(waiting)).toBe('espera a aaaaaaaa, bbbbbbbb');
    expect(taskStateWord(waiting)).toBe('en cola');
    expect(taskReason(waiting)).toBe(
      'Arranca sola cuando aaaaaaaa, bbbbbbbb se fusione o se cierre'
    );
    const stopped = task({
      state: 'queued',
      queued: {
        repoPath: '/repo',
        since: '',
        order: 1,
        waitsFor: [
          { taskId: 'aaaaaaaa-1', name: 'Una', why: 'after', state: 'working' },
          { taskId: 'cccccccc-3', name: 'Rota', why: 'after', state: 'failed', stopped: true },
        ],
      },
    });
    expect(taskStatusLabel(stopped)).toBe('espera a aaaaaaaa, cccccccc');
    expect(taskReason(stopped)).toBe(
      'cccccccc se descartó o falló: no arranca sola. Empiézala ya o descártala'
    );
  });

  it('a paused task (agent cut short, 2026-11-01): when it goes on, the error, «Reintentar»', () => {
    const now = new Date(2026, 10, 1, 1, 0).getTime();
    const paused = task({
      state: 'paused',
      worktreePath: '/wt/1',
      blocker: { kind: 'halted', message: 'Codex hit its usage limit' },
      halt: {
        kind: 'usage-limit',
        message: 'You’ve hit your usage limit. Try again at 4:25 AM.',
        since: new Date(now).toISOString(),
        attempts: 0,
        nextTryAt: new Date(2026, 10, 1, 4, 27).toISOString(),
      },
    });
    expect(taskBucket(paused)).toBe('working');
    expect(taskStatusLabel(paused)).toBe('en pausa');
    expect(taskReason(paused)).toBe('agente cortado');
    vi.setSystemTime(now);
    expect(taskDetail(paused)).toBe(
      'Sigue sola a las 04:27 · You’ve hit your usage limit. Try again at 4:25 AM.'
    );
    vi.useRealTimers();
    expect(taskActions(paused)).toEqual({ primary: 'retry', secondary: ['changes', 'discard'] });
    const out = { ...paused, halt: { ...paused.halt!, nextTryAt: undefined } } as TaskRecord;
    expect(taskDetail(out)).toMatch(/^En pausa: reanúdala o descártala · /);
  });

  it('the card says who runs it: model level and each change of agent (2026-11-01)', () => {
    expect(taskAgentLine(task({ agent: 'claude' }))).toBe('');
    expect(
      taskAgentLine(
        task({
          agent: 'claude',
          model: 'sonnet',
          modelChoice: { tier: 'fast', by: 'router', reason: 'a rename' },
        })
      )
    ).toBe('Claude (sonnet) · rápido');
    const changed = task({
      agent: 'claude',
      modelChoice: { tier: 'capable', by: 'default', reason: 'unsure' },
      agentChanges: [
        {
          at: '2026-11-01T00:00:00.000Z',
          from: { agent: 'codex', runner: 'codex', model: 'o4' },
          to: { agent: 'claude', runner: 'claude' },
          reason: 'usage limit',
          by: 'auto',
        },
      ],
    });
    expect(taskAgentLine(changed)).toBe('Claude · capaz · Codex (o4) → Claude');
    // 2026-11-08: the model it really runs with, read from its transcript.
    const lastModel = { model: 'claude-opus-4-8', at: '2026-11-08T10:00:00.000Z' };
    const usage = {
      input: 1,
      cacheWrite: 0,
      cacheRead: 0,
      output: 1,
      turns: 1,
      maxContext: 1,
      compactions: 0,
      lastModel,
    };
    const metrics = { savings: { on: {} }, quality: { autoFixRounds: 0, riskRules: [] }, usage };
    expect(taskAgentLine(task({ agent: 'claude', metrics }))).toBe(
      'Claude · modelo: claude-opus-4-8'
    );
    // A paused task offered another agent: «Seguir con el otro agente».
    const offered = task({
      state: 'paused',
      worktreePath: '/wt/1',
      halt: {
        kind: 'usage-limit',
        message: 'limit',
        since: '2026-11-01T00:00:00.000Z',
        attempts: 0,
        offer: { agent: 'claude', runner: 'claude' },
      },
    });
    expect(taskActions(offered)).toEqual({
      primary: 'retry',
      secondary: ['switchAgent', 'changes', 'discard'],
    });
  });

  it('puts every state in its bucket', () => {
    expect(taskBucket({ state: 'preparing' })).toBe('working');
    expect(taskBucket({ state: 'working' })).toBe('working');
    expect(taskBucket({ state: 'verifying' })).toBe('working');
    expect(taskBucket({ state: 'merging' })).toBe('working');
    expect(taskBucket({ state: 'needs_you' })).toBe('needs');
    expect(taskBucket({ state: 'ready' })).toBe('ready');
    expect(taskBucket({ state: 'failed' })).toBe('failed');
    expect(taskBucket({ state: 'merged' })).toBe('merged');
    expect(taskBucket({ state: 'discarded' })).toBe('discarded');
    expect(taskBucket({ state: 'scheduled' })).toBe('scheduled');
  });

  it('shows only worktree tasks on the board; plain tasks stay session rows', () => {
    expect(isBoardTask(task())).toBe(true);
    expect(isBoardTask(task({ isolation: 'none' }))).toBe(false);
    expect(isBoardTask(task({ state: 'missed' }))).toBe(false);
    expect(isDoneTask(task({ state: 'merged' }))).toBe(true);
    expect(isDoneTask(task({ state: 'discarded' }))).toBe(true);
    expect(isDoneTask(task({ state: 'ready' }))).toBe(false);
  });

  it('labels the pill in Spanish, the queued check included', () => {
    expect(taskStatusLabel(task())).toBe('trabajando');
    expect(taskStateWord(task())).toBe('trabajando');
    expect(taskStatusLabel(task({ state: 'needs_you' }))).toBe('te necesita');
    expect(taskStatusLabel(task({ state: 'ready' }))).toBe('lista');
    expect(taskStatusLabel(task({ state: 'merged' }))).toBe('fusionada');
    expect(taskStatusLabel(task({ state: 'failed' }))).toBe('falló');
    expect(
      taskStatusLabel(
        task({
          state: 'verifying',
          verify: { command: 'pnpm test', cwd: '/x', startedAt: '', queued: true },
        })
      )
    ).toBe('comprobando (en cola)');
    // 2026-11-01: behind another task in its project's merge queue.
    const queued = task({
      state: 'verifying',
      repoPath: '/Users/x/Projects/bakery',
      mergeQueue: { position: 2, of: 3, since: '2026-11-01T10:00:00.000Z' },
    });
    expect(taskStatusLabel(queued)).toBe('2.ª en la cola de fusión de bakery');
    // At its turn it is checking like any other.
    expect(taskStatusLabel({ ...queued, mergeQueue: { position: 1, of: 3, since: '' } })).toBe(
      'comprobando'
    );
  });

  it('says why it stopped, with the base branch where it matters', () => {
    expect(
      taskReason(task({ state: 'needs_you', blocker: { kind: 'conflict', message: 'x' } }))
    ).toBe('choca con cambios de main');
    expect(taskReason(task({ state: 'failed', blocker: { kind: 'verify', message: 'x' } }))).toBe(
      'no pasa la comprobación'
    );
    expect(taskReason(task())).toBe('');
    // Merged: whatever stopped it once is history.
    expect(taskReason(task({ state: 'merged', blocker: { kind: 'verify', message: 'x' } }))).toBe(
      ''
    );
  });

  it('shows the failing check line, the risky files, the question, else the summary', () => {
    expect(
      taskDetail(
        task({
          state: 'failed',
          blocker: { kind: 'verify', message: 'check failed' },
          verify: { command: 'x', cwd: '/', startedAt: '', tail: 'ok\nFAIL src/a.test.ts\n\n' },
        })
      )
    ).toBe('FAIL src/a.test.ts');
    expect(
      taskDetail(
        task({
          state: 'needs_you',
          blocker: { kind: 'risk', message: 'risky' },
          risk: [
            { rule: 'secret-file', file: '.env' },
            { rule: 'conflict-marker', file: 'src/a.ts' },
            { rule: 'some-new-rule', file: 'b.ts' },
          ],
        })
      )
    ).toBe(
      '.env (archivo de claves), src/a.ts (marcas de conflicto sin resolver), b.ts (some-new-rule)'
    );
    expect(
      taskDetail(
        task({ state: 'needs_you', blocker: { kind: 'question', message: '¿Qué proveedor?' } })
      )
    ).toBe('¿Qué proveedor?');
    expect(taskDetail(task({ state: 'ready', summary: 'Añadido el botón' }))).toBe(
      'Añadido el botón'
    );
  });

  it("a risky task: the second review's reason, or why it merges on its own soon (2026-10-24)", () => {
    const risk = [{ rule: 'auth', file: 'web/src/server/routes/sessions.ts' }];
    const held = task({
      state: 'needs_you',
      headSha: 'h1',
      blocker: { kind: 'risk', message: 'risky' },
      risk,
      riskReview: { verdict: 'dismissed', reason: 'quita una comprobación', headSha: 'h1' },
    });
    expect(taskDetail(held)).toMatch(
      /^web\/src\/server\/routes\/sessions\.ts \(.+\) · segunda revisión: quita una comprobación$/
    );
    expect(
      taskDetail({ ...held, riskReview: { verdict: 'unavailable', reason: 'x', headSha: 'h1' } })
    ).toMatch(/· la segunda revisión no pudo hacerse$/);
    // A verdict on another commit says nothing about this one.
    expect(taskDetail({ ...held, headSha: 'h2' })).not.toContain('segunda revisión');
    const soon = task({
      state: 'ready',
      risk,
      autoMergeAt: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(taskDetail(soon)).toBe(
      'marcado como delicado (web/src/server/routes/sessions.ts); una segunda revisión no vio nada debilitado'
    );
  });

  it("says Untether's own blockers in the user's words, never its orchestrator text (2026-10-23)", () => {
    const noCheck = task({
      state: 'ready',
      blocker: {
        kind: 'no-check',
        message: "Not merged on its own … Set the project's check with `ut project set --repo /r`",
      },
    });
    expect(taskDetail(noCheck)).toBe(
      'Ninguna comprobación cubre estos cambios, así que no se fusiona sola. Revísalos y fusiónala tú, o pon una comprobación en los ajustes del proyecto.'
    );
    expect(
      taskDetail(
        task({
          state: 'needs_you',
          blocker: {
            kind: 'conflict',
            message: 'Conflicts',
            detail: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
          },
        })
      )
    ).toBe('Archivos que chocan: a.ts, b.ts, c.ts, …');
    for (const kind of [
      'dirty-base',
      'no-changes',
      'setup',
      'session-exit',
      'merge-error',
    ] as const) {
      const detail = taskDetail(
        task({ state: 'needs_you', blocker: { kind, message: 'English text' } })
      );
      expect(detail).not.toBe('English text');
      expect(detail).not.toMatch(/board\.|`ut /);
    }
  });

  it('lists each round of a task in the order its phases ran (2026-10-31)', () => {
    const at = (min: number, sec = 0) =>
      new Date(Date.UTC(2026, 9, 31, 13, min, sec)).toISOString();
    const record = task({
      timings: [
        { phase: 'review', startedAt: at(0), finishedAt: at(0, 30), round: 1 },
        { phase: 'verify', startedAt: at(0), finishedAt: at(1), round: 1, outcome: 'cancelled' },
        { phase: 'fix', startedAt: at(1), round: 1 },
      ],
    });
    expect(taskTimingRounds(record, Date.parse(at(5)))).toEqual([
      'Ronda 1: revisión IA 30s, check 1m (check parado), arreglo del agente 4m',
    ]);
    expect(taskTimingsLine(task({}))).toBeNull();
  });

  it('counts what changed', () => {
    expect(taskStatsLine(task())).toBe('');
    expect(
      taskStatsLine(task({ stats: { commits: 2, files: 4, insertions: 120, deletions: 3 } }))
    ).toBe('4 archivos · +120 −3');
  });

  it('sorts te necesita > falló > lista > trabajando, the longest waiting first', () => {
    const at = (min: number) => new Date(Date.UTC(2026, 9, 18, 10, min)).toISOString();
    const order = sortBoardTasks([
      task({ id: 'w', state: 'working', stateSince: at(1) }),
      task({ id: 'r', state: 'ready', stateSince: at(2) }),
      task({ id: 'n2', state: 'needs_you', stateSince: at(5) }),
      task({ id: 'f', state: 'failed', stateSince: at(3) }),
      task({ id: 'n1', state: 'needs_you', stateSince: at(4) }),
    ]).map((entry) => entry.id);
    expect(order).toEqual(['n1', 'n2', 'f', 'r', 'w']);
  });

  it('titles a row like a session row: the user title, else the task name', () => {
    const session = createTestSession({ id: 's' });
    expect(taskDisplayTitle(task(), session)).toBe('Login con Google');
    expect(taskDisplayTitle(task(), { ...session, userTitle: 'LOGIN' })).toBe('LOGIN');
    expect(taskDisplayTitle(task({ name: '' }), { ...session, claudeTitle: 'Google auth' })).toBe(
      'Google auth'
    );
  });

  describe('buttons', () => {
    const withSession = { hasSession: true };

    it('a working task: a tap opens its session; only Descartar stops it (2026-10-18)', () => {
      expect(taskActions(task(), withSession)).toEqual({ primary: null, secondary: ['discard'] });
      expect(taskActions(task({ state: 'merging' }), withSession)).toEqual({
        primary: null,
        secondary: [],
      });
    });

    it('preparing offers its setup log and Descartar; verifying its check log and Urgente (2026-10-20, 2026-11-01)', () => {
      expect(taskActions(task({ state: 'preparing' }), withSession)).toEqual({
        primary: null,
        secondary: ['log', 'discard'],
      });
      // Waiting for a check slot or its merge turn: it can take the fast lane.
      expect(taskActions(task({ state: 'verifying' }), withSession)).toEqual({
        primary: null,
        secondary: ['log', 'urgent'],
      });
      // Marked urgent (here, or by `ut task priority`): it can be unmarked while open.
      expect(taskActions(task({ state: 'verifying', urgent: true }), withSession)).toEqual({
        primary: null,
        secondary: ['log', 'notUrgent'],
      });
      expect(taskActions(task({ state: 'working', urgent: true }), withSession).secondary).toEqual([
        'discard',
        'notUrgent',
      ]);
      expect(taskActions(task({ state: 'merged', urgent: true }), withSession).secondary).toEqual(
        []
      );
    });

    it('ready: Fusionar, then Ver cambios and Descartar; Quedarme con este in a group', () => {
      expect(taskActions(task({ state: 'ready' }), withSession)).toEqual({
        primary: 'merge',
        secondary: ['changes', 'discard'],
      });
      expect(taskActions(task({ state: 'ready' }), { hasSession: true, attempts: 2 }).primary).toBe(
        'keep'
      );
    });

    it('a security fix about to merge on its own: Parar first, Fusionar merges it now (2026-10-23)', () => {
      const soon = task({
        state: 'ready',
        autoMergeAt: '2026-10-23T14:32:00.000Z',
        security: { kind: 'fix', headline: '🔴 SQL armado a mano → parámetros' },
      });
      expect(taskActions(soon, withSession)).toEqual({
        primary: 'hold',
        secondary: ['merge', 'changes', 'discard'],
      });
      expect(autoMergeTime(soon)).toMatch(/\d{1,2}[:.]\d{2}/);
      expect(taskReason(soon)).toContain(autoMergeTime(soon));
      expect(taskDetail(soon)).toBe('🔴 SQL armado a mano → parámetros');
      // Stopped (needs_you): nothing counts down any more.
      expect(autoMergeTime({ ...soon, state: 'needs_you' })).toBe('');
    });

    it('a confirmed security fix: one tap on Fusionar closes it (2026-10-23)', () => {
      const fix = task({
        state: 'needs_you',
        blocker: { kind: 'security', message: 'High severity: SQL injection' },
      });
      expect(taskActions(fix, withSession)).toEqual({
        primary: 'merge',
        secondary: ['changes', 'discard'],
      });
    });

    it('nothing changed (a question): Abrir to read the answer, then Descartar (2026-10-18)', () => {
      const ready = task({ state: 'ready', blocker: { kind: 'no-changes', message: '' } });
      expect(taskActions(ready, withSession)).toEqual({ primary: 'open', secondary: ['discard'] });
      expect(taskActions(ready, { hasSession: false })).toEqual({
        primary: 'discard',
        secondary: [],
      });
    });

    it('a failing check or a conflict: Que lo arregle', () => {
      for (const kind of ['verify', 'conflict', 'merge-error'] as const) {
        expect(
          taskActions(task({ state: 'needs_you', blocker: { kind, message: '' } }), withSession)
            .primary
        ).toBe('fix');
      }
      expect(
        taskActions(
          task({ state: 'failed', blocker: { kind: 'verify', message: '' } }),
          withSession
        ).primary
      ).toBe('fix');
    });

    it('a risky change: look first, then Fusionar (asks) or Descartar', () => {
      expect(
        taskActions(
          task({ state: 'needs_you', blocker: { kind: 'risk', message: '' } }),
          withSession
        )
      ).toEqual({ primary: 'changes', secondary: ['mergeRisk', 'discard'] });
    });

    it('an AI review: Que lo arregle, Fusionar igualmente (asks) or Descartar', () => {
      const reviewed = task({
        state: 'needs_you',
        blocker: { kind: 'review', message: 'Divide entre n-1' },
      });
      expect(taskActions(reviewed, withSession)).toEqual({
        primary: 'fix',
        secondary: ['mergeReview', 'changes', 'discard'],
      });
      // Its session gone, a Claude task's conversation is reopened; a Codex one can't be.
      expect(taskActions(reviewed, { hasSession: false }).primary).toBe('fix');
      expect(taskActions({ ...reviewed, agent: 'codex' }, { hasSession: false })).toEqual({
        primary: 'changes',
        secondary: ['mergeReview', 'discard'],
      });
      expect(taskReason(reviewed)).toBe('la revisión IA ve problemas');
      expect(taskDetail(reviewed)).toBe('Divide entre n-1');
      expect(taskStatusLabel(task({ state: 'verifying', reviewing: true }))).toBe('revisando');
    });

    it('a question or a permission: Abrir', () => {
      expect(
        taskActions(
          task({ state: 'needs_you', blocker: { kind: 'question', message: '?' } }),
          withSession
        ).primary
      ).toBe('open');
    });

    it('a failed task: Reintentar after a setup or a cut-off session, with its log (2026-10-18)', () => {
      const failed = task({ state: 'failed', blocker: { kind: 'setup', message: 'pnpm failed' } });
      expect(taskActions(failed, { hasSession: false })).toEqual({
        primary: 'retry',
        secondary: ['log', 'changes', 'discard'],
      });
      const cut = task({ state: 'failed', blocker: { kind: 'session-exit', message: '' } });
      expect(taskActions(cut, { hasSession: false }).primary).toBe('retry');
      // A failed check: Que lo arregle (Claude) or Descartar (a Codex task without its session).
      const verify = task({ state: 'failed', blocker: { kind: 'verify', message: '' } });
      expect(taskActions(verify, { hasSession: false })).toEqual({
        primary: 'fix',
        secondary: ['log', 'changes', 'discard'],
      });
      expect(taskActions({ ...verify, agent: 'codex' }, { hasSession: false }).primary).toBe(
        'discard'
      );
    });

    it('a scheduled task can be cancelled', () => {
      expect(taskActions(task({ state: 'scheduled' }), withSession)).toEqual({
        primary: null,
        secondary: ['cancel'],
      });
    });
  });

  it("puts a parallel group's open attempts together, where its first one sorts", () => {
    const units = taskUnits([
      task({ id: 'solo-needs', state: 'needs_you' }),
      task({ id: 'b', groupId: 'g', groupIndex: 1, state: 'ready' }),
      task({ id: 'x' }),
      task({ id: 'a', groupId: 'g', groupIndex: 0 }),
      task({ id: 'lone', groupId: 'h', groupIndex: 1 }),
    ]);
    expect(
      units.map((unit) =>
        unit.kind === 'task' ? unit.task.id : `${unit.groupId}:${unit.tasks.map((t) => t.id)}`
      )
    ).toEqual(['solo-needs', 'g:a,b', 'x', 'lone']);
  });
  it('a task fixing itself is in progress until its attempts run out', () => {
    const fix = { attempts: 1, max: 3, reason: 'conflict' as const, at: '' };
    const fixing = {
      ...task({ state: 'needs_you', blocker: { kind: 'conflict', message: 'x' } }),
      autoFix: fix,
    };
    expect(activeAutoFix(fixing)).toEqual(fix);
    expect(taskBucket(fixing)).toBe('working');
    expect(taskWantsUser(fixing)).toBe(false);
    expect(taskStatusLabel(fixing)).toBe('arreglándose sola');
    expect(taskReason(fixing)).toBe('intento 1 de 3 · chocaba con cambios de main');
    expect(taskActions(fixing, { hasSession: true }).primary).toBeNull();
    // Out of attempts and back with the user: the blocker as usual.
    const spent = { ...fixing, autoFix: { ...fix, attempts: 3 } };
    expect(activeAutoFix(spent)).toBeUndefined();
    expect(taskWantsUser(spent)).toBe(true);
    expect(taskActions(spent, { hasSession: true }).primary).toBe('fix');
    // A finished task never shows it; a malformed one is ignored.
    expect(activeAutoFix({ ...fixing, state: 'merged' })).toBeUndefined();
    expect(activeAutoFix({ ...fixing, autoFix: { attempts: '1' } as never })).toBeUndefined();
  });

  it('a task fixing itself that stops on a permission or a question is the user’s (2026-10-20)', () => {
    const fix = { attempts: 1, max: 2, reason: 'review' as const, at: '' };
    for (const kind of ['permission', 'question'] as const) {
      const asking = {
        ...task({ state: 'needs_you', blocker: { kind, message: '¿Puedo borrar dist/?' } }),
        autoFix: fix,
      };
      expect(activeAutoFix(asking)).toBeUndefined();
      expect(taskBucket(asking)).toBe('needs');
      expect(taskWantsUser(asking)).toBe(true);
      expect(taskStatusLabel(asking)).toBe('te necesita');
      expect(taskActions(asking, { hasSession: true }).primary).toBe('open');
    }
    // Busy (the agent at work, the check or the review running): still fixing itself.
    for (const state of ['working', 'verifying', 'merging'] as const) {
      expect(activeAutoFix({ ...task({ state }), autoFix: fix })).toEqual(fix);
    }
    expect(
      activeAutoFix({ ...task({ state: 'verifying' }), reviewing: true, autoFix: fix })
    ).toEqual(fix);
    // Its session ended with the autoFix left over: Reintentar, as any cut-off task.
    const cut = {
      ...task({ state: 'failed', blocker: { kind: 'session-exit', message: 'ended' } }),
      autoFix: fix,
    };
    expect(activeAutoFix(cut)).toBeUndefined();
    expect(taskWantsUser(cut)).toBe(true);
    expect(taskActions(cut, { hasSession: false }).primary).toBe('retry');
  });

  it('a retry time says tomorrow or the weekday, and «en breve» once past', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 20, 23, 0));
      const pending = (at?: string) => ({
        ...task({
          state: 'ready',
          blocker: { kind: 'review-unavailable' as 'review', message: '' },
        }),
        reviewRetryAt: at,
      });
      expect(reviewRetryLine(pending(new Date(2026, 9, 20, 23, 30).toISOString()))).toBe(
        'Se reintenta sola a las 23:30'
      );
      expect(reviewRetryLine(pending(new Date(2026, 9, 21, 0, 5).toISOString()))).toBe(
        'Se reintenta sola mañana a las 00:05'
      );
      expect(reviewRetryLine(pending(new Date(2026, 9, 23, 9, 0).toISOString()))).toBe(
        'Se reintenta sola el viernes a las 09:00'
      );
      expect(reviewRetryLine(pending(new Date(2026, 9, 20, 22, 0).toISOString()))).toBe(
        'Se reintenta sola en breve'
      );
      expect(reviewRetryLine(pending('nonsense'))).toBe('Se reintenta sola en breve');
    } finally {
      vi.useRealTimers();
    }
  });

  it('times use the app’s language, 24-hour in Spanish', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 9, 20, 9, 0));
      const scheduled = task({
        state: 'scheduled',
        runAt: new Date(2026, 9, 20, 13, 41).toISOString(),
      });
      expect(taskStatusLabel(scheduled)).toBe('programada · 13:41');
      const tomorrow = task({
        state: 'scheduled',
        runAt: new Date(2026, 9, 21, 1, 41).toISOString(),
      });
      expect(taskStatusLabel(tomorrow)).toBe('programada · mañana a las 01:41');
    } finally {
      vi.useRealTimers();
    }
  });

  it('not-fixable is worded for the button that got it', () => {
    const refused = { ok: false, status: 409, error: 'not-fixable', message: 'x' };
    expect(taskErrorText(refused, 'retry')).toBe(
      'tiene trabajo propio: pide a su agente que lo arregle o descártala'
    );
    expect(taskErrorText(refused, 'revert')).toBe(
      'no consta qué se fusionó: no se puede deshacer automáticamente'
    );
    expect(taskErrorText(refused, 'fix')).toBe('no hay nada que el agente pueda arreglar');
    expect(taskErrorText(refused)).toBe('no hay nada que el agente pueda arreglar');
  });

  it('a confirmation kind without words reads as the generic text, never its key', () => {
    expect(confirmKindText('revert')).toBe('Deshacer esta tarea fusionada');
    expect(confirmKindText('brand-new-kind')).not.toContain('notify.');
    expect(confirmKindText('brand-new-kind')).toBe(
      confirmKindText('brand-new-kind', 'notify.taskConfirmBody')
    );
  });

  it('orchestrator and settings errors are worded; the server text is kept for details', () => {
    const conflict = orchestratorErrorText({
      ok: false,
      status: 409,
      error: 'That session already orchestrates skylark',
    });
    expect(conflict.text).toBe('esa sesión ya orquesta otro proyecto');
    expect(conflict.raw).toBe('That session already orchestrates skylark');
    expect(orchestratorErrorText({ ok: false, status: 0, error: 'Failed to fetch' }).text).toBe(
      'no hay conexión con el ordenador'
    );
    expect(orchestratorErrorText({ ok: false, status: 500, error: 'boom' }).text).toBe(
      'algo ha fallado; vuelve a intentarlo'
    );
    expect(
      projectSettingsErrorText({ ok: false, status: 400, error: 'mergePolicy: Invalid option' })
        .text
    ).toBe('algún valor no es válido');
    expect(
      projectSettingsErrorText({
        ok: false,
        status: 409,
        error: 'busy',
        message: 'The task is busy',
      }).text
    ).not.toContain('busy');
    expect(projectSettingsErrorText({ ok: false, status: 500, error: 'x' }).text).toBe(
      'algo ha fallado; vuelve a intentarlo'
    );
  });

  it('a review that could not run is waited out, Fusionar igualmente only as a second choice', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 20, 12, 0));
    const pending = {
      ...task({ state: 'ready', blocker: { kind: 'review-unavailable' as 'review', message: '' } }),
      reviewRetryAt: new Date(2026, 9, 20, 14, 5).toISOString(),
    };
    expect(taskBucket(pending)).toBe('working');
    expect(taskStatusLabel(pending)).toBe('revisión pendiente');
    expect(taskReason(pending)).toBe('');
    expect(taskDetail(pending)).toMatch(/^Se reintenta sola a las /);
    expect(taskActions(pending, { hasSession: true })).toEqual({
      primary: null,
      secondary: ['mergeReview', 'changes', 'discard'],
    });
    expect(taskDetail({ ...pending, reviewRetryAt: undefined })).toBe('Se reintenta sola en breve');
    vi.useRealTimers();
  });

  it('2026-10-24: a task waiting for a dirty base asks nothing: «esperando a main»', () => {
    const blocker = { kind: 'dirty-base' as const, message: '/repo has changes not committed' };
    const waiting = task({
      state: 'ready',
      baseBranch: 'main',
      worktreePath: '/wt/1',
      blocker,
      baseWait: {
        since: '2026-10-24T10:00:00Z',
        nextAt: '2026-10-24T10:01:00Z',
        run: { mode: 'auto' },
      },
    });
    expect(taskBucket(waiting)).toBe('working');
    expect(taskWantsUser(waiting)).toBe(false);
    expect(taskStatusLabel(waiting)).toBe('esperando a main');
    expect(taskReason(waiting)).toBe('');
    expect(taskDetail(waiting)).toBe(
      'main tiene cambios sin guardar. Se fusiona sola en cuanto main esté limpia; no tienes que hacer nada.'
    );
    expect(taskActions(waiting, { hasSession: true })).toEqual({
      primary: null,
      secondary: ['changes', 'discard'],
    });
    // It waited a day: the user's now, as before.
    const handedOver = task({
      state: 'needs_you',
      baseBranch: 'main',
      worktreePath: '/wt/1',
      blocker,
    });
    expect(taskBucket(handedOver)).toBe('needs');
    expect(taskStatusLabel(handedOver)).toBe('te necesita');
  });

  it('offers Deshacer on a task merged in the last week, with what it merged on record', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const merged = (at: string, extra: Partial<TaskRecord> = {}) =>
      task({ state: 'merged', finishedAt: at, mergedSha: 'b2', mergedOnto: 'a1', ...extra });
    expect(canRevertTask(merged('2026-10-19T12:00:00Z'), [], now)).toBe(true);
    expect(canRevertTask(merged('2026-10-01T12:00:00Z'), [], now)).toBe(false);
    expect(canRevertTask(task({ state: 'ready' }), [], now)).toBe(false);
    // Without its commit range the server cannot undo it: no button that can only fail.
    expect(canRevertTask(merged('2026-10-19T12:00:00Z', { mergedOnto: undefined }), [], now)).toBe(
      false
    );
    expect(canRevertTask(merged('2026-10-19T12:00:00Z', { mergedSha: undefined }), [], now)).toBe(
      false
    );
    expect(taskActions(merged(new Date().toISOString())).secondary).toEqual(['revert']);
  });

  it('a merged task being undone hides Deshacer; once undone it reads «deshecha»', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    const original = task({
      id: 'orig',
      state: 'merged',
      finishedAt: '2026-10-19T12:00:00Z',
      mergedSha: 'b2',
      mergedOnto: 'a1',
      revertedBy: 'undo',
    });
    const undo = (state: TaskRecord['state']) => [task({ id: 'undo', state })];
    expect(revertState(original, undo('working'))).toBe('pending');
    expect(canRevertTask(original, undo('working'), now)).toBe(false);
    expect(revertState(original, undo('merged'))).toBe('done');
    expect(canRevertTask(original, undo('merged'), now)).toBe(false);
    expect(taskStatusLabel(original, { tasks: undo('merged') })).toBe('deshecha');
    expect(taskStatusLabel(original, { tasks: undo('working') })).toBe('fusionada');
    // Its undo task thrown away (or no longer listed): it can be undone again, as the server allows.
    expect(revertState(original, undo('discarded'))).toBe('none');
    expect(canRevertTask(original, undo('discarded'), now)).toBe(true);
    expect(canRevertTask(original, [], now)).toBe(true);
  });

  it('an undo task reads «Deshacer: <name>», not the server’s English', () => {
    const undo = task({
      name: 'Undo: Login con Google',
      revertOf: { taskId: 'orig', from: 'a1', to: 'b2' },
    });
    expect(taskDisplayTitle(undo)).toBe('Deshacer: Login con Google');
    // A name the user gave its session wins, as for any task.
    expect(
      taskDisplayTitle(undo, { ...createTestSession({ id: 's' }), userTitle: 'Revertir login' })
    ).toBe('Revertir login');
    // Not an undo task: its name as it is.
    expect(taskDisplayTitle(task({ name: 'Undo: algo' }))).toBe('Undo: algo');
  });
});
