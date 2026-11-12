import { describe, expect, it } from 'vitest';
import {
  inheritedTitles,
  isGeneratedSessionName,
  normalizeUserTitle,
  sessionTitle,
  USER_TITLE_MAX_LENGTH,
} from './session-title.js';

describe('sessionTitle', () => {
  it("puts the user's title over the live and kept conversation titles", () => {
    const session = {
      userTitle: 'Login work',
      claudeStatus: { title: 'Fix login' },
      claudeTitle: 'Old title',
    };
    expect(sessionTitle(session)).toBe('Login work');
    expect(sessionTitle({ ...session, userTitle: undefined })).toBe('Fix login');
    expect(sessionTitle({ claudeTitle: 'Old title' })).toBe('Old title');
    expect(sessionTitle({ codexTitle: 'Codex task' })).toBe('Codex task');
    expect(sessionTitle({ userTitle: '   ', geminiTitle: 'Gemini task' })).toBe('Gemini task');
    expect(sessionTitle({})).toBe('');
  });
});

describe('normalizeUserTitle', () => {
  it('trims and caps a title, clears on empty or null, rejects other values', () => {
    expect(normalizeUserTitle('  Login work ')).toBe('Login work');
    expect(normalizeUserTitle('x'.repeat(USER_TITLE_MAX_LENGTH + 10))).toHaveLength(
      USER_TITLE_MAX_LENGTH
    );
    expect(normalizeUserTitle('   ')).toBeNull();
    expect(normalizeUserTitle(null)).toBeNull();
    expect(normalizeUserTitle(42)).toBeUndefined();
    expect(normalizeUserTitle(undefined)).toBeUndefined();
  });
});

describe('isGeneratedSessionName', () => {
  it('tells the server-made "tool (folder)" names from ones a person gave', () => {
    expect(isGeneratedSessionName('claude (~/Projects/app)')).toBe(true);
    expect(isGeneratedSessionName('zsh (~)')).toBe(true);
    expect(isGeneratedSessionName('codex (…/web/app)', ['codex'])).toBe(true);
    expect(isGeneratedSessionName('zsh (~/x)', ['zsh', '-lic', 'claude --resume 1'])).toBe(true);
    expect(isGeneratedSessionName('claude (~/x)', ['zsh', '-lic', 'claude --resume 1'])).toBe(true);
    expect(isGeneratedSessionName('claude (~/x)', ['codex'])).toBe(false);
    expect(isGeneratedSessionName('qa · build')).toBe(false);
    expect(isGeneratedSessionName('Fix login (draft)')).toBe(false);
    expect(isGeneratedSessionName(undefined)).toBe(false);
  });
});

describe('inheritedTitles', () => {
  const sessions = [
    {
      id: 'a',
      startedAt: '2026-10-14T15:07:42Z',
      claudeSessionId: 'c1',
      userTitle: 'TRAVEL DESK',
      claudeTitle: 'Videos',
    },
    { id: 'b', startedAt: '2026-10-16T08:40:21Z', claudeSessionId: 'c2', userTitle: 'UNTETHER' },
    { id: 'c', startedAt: '2026-10-17T21:14:13Z', claudeSessionId: 'c1' },
    { id: 'd', startedAt: '2026-10-18T00:00:00Z', claudeSessionId: 'c3', userTitle: '  ' },
  ];

  it("takes the newest earlier session's user title and the newest conversation title", () => {
    expect(inheritedTitles(sessions, 'c2')).toEqual({ userTitle: 'UNTETHER' });
    // The newest session of c1 has no user title (cleared): none, but Claude's title stays.
    expect(inheritedTitles(sessions, 'c1')).toEqual({ claudeTitle: 'Videos' });
    expect(inheritedTitles(sessions, 'c1', { before: '2026-10-15T00:00:00Z' })).toEqual({
      userTitle: 'TRAVEL DESK',
      claudeTitle: 'Videos',
    });
    expect(inheritedTitles(sessions, 'c1', { excludeId: 'c' })).toEqual({
      userTitle: 'TRAVEL DESK',
      claudeTitle: 'Videos',
    });
    expect(inheritedTitles(sessions, 'c3')).toEqual({});
    expect(inheritedTitles(sessions, 'unknown')).toEqual({});
  });

  it('takes the group the user anchored the newest earlier session to (2026-11-04)', () => {
    const pin = { repoPath: '/Users/n/Projects/finanzas' };
    const anchored = [
      { id: 'a', startedAt: '2026-11-01T00:00:00Z', claudeSessionId: 'c1', groupPin: pin },
      { id: 'b', startedAt: '2026-11-02T00:00:00Z', claudeSessionId: 'c2', groupPin: pin },
      { id: 'c', startedAt: '2026-11-03T00:00:00Z', claudeSessionId: 'c2' },
    ];
    expect(inheritedTitles(anchored, 'c1')).toEqual({ groupPin: pin });
    // Let go in the newest session ("Quitar ancla"): it stays automatic.
    expect(inheritedTitles(anchored, 'c2')).toEqual({});
    expect(inheritedTitles(anchored, 'c2', { excludeId: 'c' })).toEqual({ groupPin: pin });
  });
});
