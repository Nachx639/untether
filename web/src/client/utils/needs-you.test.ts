// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockSession } from '@/test/utils/lit-test-utils';
import { createTestTask } from '@/test/utils/test-factories';
import type { TaskConfirmation } from '../../shared/task-confirmations';
import type { Session } from '../../shared/types';
import { setLocale } from '../i18n/index';
import { needsYouItems, sessionNeedsLine, taskNeedsLine } from './needs-you';

const at = (minutesAgo: number, now: number) => new Date(now - minutesAgo * 60_000).toISOString();

function waiting(id: string, since: number, extra: Partial<Session['claudeStatus']> = {}): Session {
  return {
    ...createMockSession({ id, name: id, status: 'running', command: ['claude'] }),
    claudeStatus: { status: 'waiting', waitingFor: 'permission prompt', since, ...extra },
  };
}

function confirmation(id: string, createdAt: string): TaskConfirmation {
  return {
    id,
    kind: 'discard',
    createdAt,
    expiresAt: createdAt,
    where: 'Login',
    summary: 'Discard: Login',
    detail: [],
    requestedBy: {},
  };
}

describe('needsYouItems (2026-11-08)', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');

  beforeAll(async () => {
    await setLocale('es');
  });
  afterAll(async () => {
    await setLocale('en');
  });

  it('puts what blocks work first, then failures, ready and paused; oldest first in each', () => {
    const items = needsYouItems({
      now,
      sessions: [
        waiting('asks-new', now - 60_000),
        waiting('asks-old', now - 30 * 60_000),
        createMockSession({ id: 'idle', status: 'running' }),
      ],
      tasks: [
        createTestTask({ id: 'paused', state: 'paused', stateSince: at(90, now) }),
        createTestTask({ id: 'ready-new', state: 'ready', stateSince: at(1, now) }),
        createTestTask({ id: 'ready-old', state: 'ready', stateSince: at(50, now) }),
        createTestTask({
          id: 'failed',
          state: 'failed',
          stateSince: at(120, now),
          blocker: { kind: 'setup', message: 'x' },
        }),
        createTestTask({
          id: 'verify',
          state: 'needs_you',
          stateSince: at(5, now),
          blocker: { kind: 'verify', message: 'x' },
        }),
        createTestTask({
          id: 'question',
          state: 'needs_you',
          stateSince: at(10, now),
          blocker: { kind: 'question', message: '¿Borro la tabla?' },
        }),
        createTestTask({ id: 'working', state: 'working' }),
      ],
      confirmations: [confirmation('ok', at(20, now))],
    });
    expect(items.map((item) => item.key)).toEqual([
      'session:asks-old',
      'confirm:ok',
      'task:question',
      'session:asks-new',
      'task:failed',
      'task:verify',
      'task:ready-old',
      'task:ready-new',
      'task:paused',
    ]);
    expect(items.map((item) => item.tier)).toEqual([
      'asks',
      'asks',
      'asks',
      'asks',
      'failed',
      'failed',
      'ready',
      'ready',
      'paused',
    ]);
  });

  it("a task's session is its item, never a second one; the task is answered there", () => {
    const session = waiting('ts', now - 60_000);
    const task = createTestTask({
      id: 't1',
      sessionId: 'ts',
      state: 'needs_you',
      blocker: { kind: 'conflict', message: 'x' },
    });
    const items = needsYouItems({ now, sessions: [session], tasks: [task] });
    expect(items.map((item) => [item.key, item.tier, item.action])).toEqual([
      ['task:t1', 'asks', 'answer'],
    ]);
  });

  it("a working or ready task whose session asks is first and keeps its session's place", () => {
    const items = needsYouItems({
      now,
      sessions: [waiting('w', now - 1000), waiting('r', now - 2000)],
      tasks: [
        createTestTask({ id: 'working', sessionId: 'w', state: 'working', stateSince: at(1, now) }),
        createTestTask({ id: 'ready', sessionId: 'r', state: 'ready', stateSince: at(2, now) }),
        createTestTask({
          id: 'failed',
          state: 'failed',
          stateSince: at(300, now),
          blocker: { kind: 'setup', message: 'x' },
        }),
      ],
    });
    expect(items.map((item) => [item.key, item.tier, item.action])).toEqual([
      ['task:ready', 'asks', 'answer'],
      ['task:working', 'asks', 'answer'],
      ['task:failed', 'failed', 'open'],
    ]);
  });

  it('leaves out ready tasks Untether handles alone (auto-merge, retried review, base wait)', () => {
    const items = needsYouItems({
      now,
      sessions: [],
      tasks: [
        createTestTask({ id: 'auto', state: 'ready', autoMergeAt: at(-5, now) }),
        createTestTask({
          id: 'retry',
          state: 'ready',
          blocker: { kind: 'review-unavailable', message: 'x' },
        }),
        createTestTask({ id: 'mine', state: 'ready' }),
      ],
    });
    expect(items.map((item) => item.key)).toEqual(['task:mine']);
  });

  it('gives each its one button: Responder, Fusionar or Abrir', () => {
    const items = needsYouItems({
      now,
      sessions: [waiting('s', now)],
      tasks: [
        createTestTask({ id: 'ready', state: 'ready', stateSince: at(3, now) }),
        createTestTask({
          id: 'nothing',
          state: 'ready',
          stateSince: at(2, now),
          blocker: { kind: 'no-changes', message: 'x' },
        }),
        createTestTask({
          id: 'dirty',
          state: 'needs_you',
          stateSince: at(1, now),
          blocker: { kind: 'dirty-base', message: 'x' },
        }),
      ],
      confirmations: [confirmation('c', at(1, now))],
    });
    const action = Object.fromEntries(items.map((item) => [item.key, item.action]));
    expect(action).toEqual({
      'session:s': 'answer',
      'confirm:c': 'confirm',
      'task:dirty': 'merge',
      'task:ready': 'merge',
      'task:nothing': 'open',
    });
  });

  it('lists a Codex that waits on its own menu, with what it asks and Responder (2026-11-10)', () => {
    // createMockSession keeps the fields it knows: the agent's state goes on top.
    const codex: Session = {
      ...createMockSession({ id: 'codex', status: 'running', command: ['codex'] }),
      codexActive: true,
      agentStatus: {
        agent: 'codex',
        status: 'waiting',
        since: now - 30_000,
        choices: {
          question: 'Would you like to run the following command?',
          options: ['Yes, proceed (y)', 'No, and tell Codex what to do differently (esc)'],
          detail: ['touch nuevo.txt', 'Necesito crear el archivo'],
        },
      },
    };
    const trust: Session = {
      ...createMockSession({ id: 'trust', status: 'running', command: ['zsh'] }),
      codexActive: true,
      agentStatus: {
        agent: 'codex',
        status: 'waiting',
        since: now - 5_000,
        choices: { question: 'Trust this folder?', options: ['Trust and continue', 'Back'] },
      },
    };
    const working: Session = {
      ...createMockSession({ id: 'working', status: 'running', command: ['codex'] }),
      agentStatus: { agent: 'codex', status: 'busy', since: now },
    };
    const items = needsYouItems({ sessions: [working, trust, codex], tasks: [], now });
    // The one waiting longest first; a Codex at work is not there.
    expect(items.map((item) => [item.key, item.tier, item.action, item.since])).toEqual([
      ['session:codex', 'asks', 'answer', now - 30_000],
      ['session:trust', 'asks', 'answer', now - 5_000],
    ]);
    expect(items[0].line).toBe('Te necesita · Necesito crear el archivo');
    expect(items[1].line).toBe('Te necesita · Trust this folder?');
  });

  it('says why in one short line', () => {
    expect(
      sessionNeedsLine(
        waiting('s', now, {
          choices: {
            question: '¿Ejecutar?',
            options: ['Sí', 'No'],
            detail: ['Bash', 'rm -rf build'],
          },
        })
      )
    ).toBe('Petición de permiso · rm -rf build');
    expect(
      taskNeedsLine(
        createTestTask({
          state: 'needs_you',
          blocker: { kind: 'review', message: 'x' },
          review: {
            verdict: 'concerns',
            summary: 's',
            issues: [
              { file: 'a.ts', what: 'x', severity: 'high' },
              { file: 'b.ts', what: 'y', severity: 'medium' },
            ],
          } as never,
        }),
        now
      )
    ).toBe('revisión: 2 problemas');
    expect(
      taskNeedsLine(
        createTestTask({
          state: 'needs_you',
          blocker: { kind: 'permission', message: 'Bash: rm -rf dist\nmás' },
        }),
        now
      )
    ).toBe('pide permiso · Bash: rm -rf dist');
    expect(
      taskNeedsLine(
        createTestTask({
          state: 'paused',
          blocker: { kind: 'halted', message: 'x' },
          halt: { kind: 'usage-limit', message: 'limit', since: at(5, now), attempts: 0 },
        }),
        now
      )
    ).toMatch(/^sin saldo del proveedor · /);
  });

  it('shows nothing of a task that ended, its session still asking included (2026-11-09)', () => {
    const session = waiting('s1', now - 60_000);
    const done = createTestTask({
      id: 't1',
      state: 'done',
      sessionId: 's1',
      blocker: { kind: 'question', message: 'Old' },
    });
    expect(needsYouItems({ now, sessions: [session], tasks: [done], closed: [done] })).toEqual([]);
    expect(needsYouItems({ now, sessions: [], tasks: [done] })).toEqual([]);
  });

  it('a question answered in the terminal goes as soon as the state says so', () => {
    const asked = createTestTask({
      id: 't1',
      state: 'needs_you',
      sessionId: 's1',
      blocker: { kind: 'question', message: '¿Lo hago?' },
    });
    const answered = { ...asked, state: 'working' as const, blocker: undefined };
    const session = createMockSession({ id: 's1', status: 'running', command: ['claude'] });
    expect(needsYouItems({ now, sessions: [session], tasks: [asked] })).toHaveLength(1);
    expect(needsYouItems({ now, sessions: [session], tasks: [answered] })).toEqual([]);
  });

  it('a question asked again under another id leaves one item, the new one', () => {
    const task = (id: string) =>
      createTestTask({
        id,
        state: 'needs_you',
        blocker: { kind: 'question', message: 'Otra vez' },
      });
    const items = needsYouItems({ now, sessions: [], tasks: [task('new')] });
    expect(items.map((item) => item.key)).toEqual(['task:new']);
  });

  it('a failed task whose session keeps a menu shows its failure, not a question (2026-11-09)', () => {
    const failed = createTestTask({
      id: 't1',
      state: 'failed',
      sessionId: 's1',
      blocker: { kind: 'question', message: 'Old' },
    });
    const items = needsYouItems({ now, sessions: [waiting('s1', now - 60_000)], tasks: [failed] });
    expect(items.map((item) => [item.key, item.tier])).toEqual([['task:t1', 'failed']]);
    expect(items[0]?.action).not.toBe('answer');
  });

  it("keeps a failed task's OKs: retrying or discarding it is what they are for", () => {
    const failed = createTestTask({ id: 't1', state: 'failed' });
    const retry = { ...confirmation('c1', at(1, now)), kind: 'retry' as const, taskId: 't1' };
    const items = needsYouItems({ now, sessions: [], tasks: [failed], confirmations: [retry] });
    expect(items.map((item) => item.key)).toContain('confirm:c1');
  });
});
