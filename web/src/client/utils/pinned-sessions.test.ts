import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPinned, pinnedFirst, prunePinned, setPinned } from './pinned-sessions.js';

describe('pinned sessions', () => {
  // The global localStorage mock stores nothing; give these tests a real one.
  const store = new Map<string, string>();
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key) => store.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      store.set(key, value);
    });
  });
  afterEach(() => {
    store.clear();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
  });

  it('puts pinned sessions first and keeps the existing order within each group', () => {
    const rows = ['waiting', 'busy', 'idle-new', 'idle-old'].map((id) => ({ id }));
    const ordered = pinnedFirst(rows, new Set(['idle-old', 'busy']));
    expect(ordered.map((row) => row.id)).toEqual(['busy', 'idle-old', 'waiting', 'idle-new']);
  });

  it('remembers pins and forgets sessions that are gone', () => {
    setPinned('a', true);
    setPinned('b', true);
    setPinned('a', false);
    setPinned('c', true);
    expect([...loadPinned()]).toEqual(['b', 'c']);
    prunePinned(['c', 'other']);
    expect([...loadPinned()]).toEqual(['c']);
  });

  it('survives unreadable storage', () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadPinned().size).toBe(0);
  });
  it('hands a pin to the resumed copy of its session (same Claude conversation)', () => {
    setPinned('old', true);
    // The pinned session is seen running with its conversation.
    expect(prunePinned([{ id: 'old', status: 'running', claudeSessionId: 'conv-1' }])).toBe(false);
    // It exits and a resume of it starts with a new id.
    const changed = prunePinned([
      { id: 'old', status: 'exited', claudeSessionId: 'conv-1' },
      { id: 'new', status: 'running', command: ['claude', '--resume', 'conv-1'] },
    ]);
    expect(changed).toBe(true);
    expect([...loadPinned()]).toEqual(['new']);
  });

  it('follows the pin even when the old session is already gone from the list', () => {
    setPinned('old', true);
    prunePinned([{ id: 'old', status: 'running', claudeSessionId: 'conv-2' }]);
    prunePinned([{ id: 'copy', status: 'running', claudeSessionId: 'conv-2' }]);
    expect([...loadPinned()]).toEqual(['copy']);
  });

  it('keeps a pin on a running session and honours replacedBy / resumedFrom', () => {
    setPinned('a', true);
    setPinned('b', true);
    prunePinned([
      { id: 'a', status: 'running', claudeSessionId: 'c' },
      { id: 'a2', status: 'running', claudeSessionId: 'c' },
      { id: 'b', status: 'exited', replacedBy: 'b2' },
      { id: 'b2', status: 'running' },
    ]);
    expect([...loadPinned()].sort()).toEqual(['a', 'b2']);
  });
});
