// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockSession } from '@/test/utils/lit-test-utils';
import { createTestTask } from '@/test/utils/test-factories';
import type { Session } from '../../shared/types';
import { setLocale } from '../i18n/index';
import { FOLDED_OTHERS, foldKey, foldSummary, isFolded, withFolded } from './group-fold';

function waiting(id: string, since: number): Session {
  return {
    ...createMockSession({ id, name: id, status: 'running', command: ['claude'] }),
    claudeStatus: { status: 'waiting', waitingFor: 'permission prompt', since },
  };
}

// 2026-11-10, user request: fold the projects so they do not all show open.
describe('folded groups', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');

  beforeAll(async () => {
    await setLocale('es');
  });
  afterAll(async () => {
    await setLocale('en');
  });

  it('folds and unfolds one group, "Otras" too, leaving the others as they are', () => {
    expect(foldKey('/p/a')).toBe('/p/a');
    expect(foldKey(null)).toBe(FOLDED_OTHERS);
    const folded = withFolded(['/p/a'], '/p/b', true);
    expect(folded).toEqual(['/p/a', '/p/b']);
    // Folding twice keeps it once.
    expect(withFolded(folded, '/p/b', true)).toEqual(['/p/a', '/p/b']);
    expect(withFolded(folded, null, true)).toEqual(['/p/a', '/p/b', FOLDED_OTHERS]);
    expect(isFolded(folded, '/p/a')).toBe(true);
    expect(isFolded(folded, null)).toBe(false);
    expect(isFolded([FOLDED_OTHERS], null)).toBe(true);
    expect(withFolded(folded, '/p/a', false)).toEqual(['/p/b']);
    // Unfolding what is open changes nothing.
    expect(withFolded(folded, '/p/c', false)).toEqual(folded);
  });

  it('counts what a folded group holds: sessions, tasks, what waits for the user, the queue', () => {
    const idle = createMockSession({ id: 'idle', status: 'running' });
    const asks = waiting('asks', now - 60_000);
    const summary = foldSummary({
      now,
      sessions: [idle, asks],
      tasks: [
        createTestTask({ id: 'q1', state: 'queued' }),
        createTestTask({ id: 'q2', state: 'queued' }),
        createTestTask({ id: 'working', state: 'working' }),
        createTestTask({
          id: 'failed',
          state: 'failed',
          blocker: { kind: 'setup', message: 'x' },
        }),
      ],
      sessionsById: new Map([
        ['idle', idle],
        ['asks', asks],
      ]),
    });
    expect(summary).toEqual({ sessions: 2, tasks: 4, needsYou: 2, queued: 2 });
  });

  // The folded project must say what the «Te necesita» section says: a working task whose
  // agent asks on its session waits for the user, once (the session is the task's).
  it('counts a task whose session asks once, though its session has no row in the group', () => {
    const taskSession = waiting('ts', now - 60_000);
    const summary = foldSummary({
      now,
      sessions: [],
      tasks: [createTestTask({ id: 't1', sessionId: 'ts', state: 'working' })],
      sessionsById: new Map([['ts', taskSession]]),
    });
    expect(summary).toEqual({ sessions: 0, tasks: 1, needsYou: 1, queued: 0 });
  });

  it('counts nothing as waiting in a group where all goes on by itself', () => {
    const idle = createMockSession({ id: 'idle', status: 'running' });
    const done = createTestTask({ id: 'done', sessionId: 'ended', state: 'merged' });
    const summary = foldSummary({
      now,
      sessions: [idle, waiting('ended', now - 60_000)],
      tasks: [createTestTask({ id: 'working', state: 'working' })],
      sessionsById: new Map([['idle', idle]]),
      // A finished task's session still asking waits for nobody.
      closed: [done],
    });
    expect(summary.needsYou).toBe(0);
  });
});
