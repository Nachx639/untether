/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../shared/types.js';
import { isUnread, markSeen, pruneSeen } from './unread-tracker.js';

const session = (claudeStatus: Session['claudeStatus']) =>
  ({ id: 's1', status: 'running', claudeStatus }) as Session;

describe('unread tracker', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('flags a new answer or a new question until the session is looked at', () => {
    // First seen while Claude works: that is the baseline, and the answer that follows is news.
    const working = session({ status: 'busy', preview: { role: 'user', text: 'otra' } });
    expect(isUnread(working)).toBe(false);

    const answered = session({ status: 'idle', preview: { role: 'assistant', text: 'listo' } });
    expect(isUnread(answered)).toBe(true);
    markSeen(answered);
    expect(isUnread(answered)).toBe(false);

    const firstPrompt = session({ status: 'waiting', waitingFor: 'permission', since: 1 });
    expect(isUnread(firstPrompt)).toBe(true);
    markSeen(firstPrompt);
    // The same kind of prompt again later is new.
    expect(isUnread(session({ status: 'waiting', waitingFor: 'permission', since: 2 }))).toBe(true);
  });

  it('keeps what is unread through an empty list (a server that just restarted)', () => {
    const working = session({ status: 'busy', preview: { role: 'user', text: 'otra' } });
    expect(isUnread(working)).toBe(false);
    const answered = session({ status: 'idle', preview: { role: 'assistant', text: 'listo' } });
    expect(isUnread(answered)).toBe(true);

    pruneSeen([]);
    expect(isUnread(answered)).toBe(true);

    // A session that is gone while others remain is forgotten: seen again, it starts over.
    pruneSeen([{ ...answered, id: 's2' }]);
    expect(isUnread(answered)).toBe(false);
  });
});
