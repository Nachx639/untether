// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types.js';
import { resetTitleLabel, visibleSessionTitle } from './session-title.js';

const session = (fields: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    name: 'claude (~/Projects)',
    command: ['claude'],
    status: 'running',
    claudeStatus: { status: 'idle', title: 'Untether mejora local' },
    ...fields,
  }) as Session;

describe('renaming the visible session title', () => {
  it('shows the user title, else the conversation title, else the name', () => {
    expect(visibleSessionTitle(session({ userTitle: 'Mi tarea' }))).toBe('Mi tarea');
    expect(visibleSessionTitle(session())).toBe('Untether mejora local');
    expect(visibleSessionTitle(session({ claudeStatus: undefined }))).toBe('claude (~/Projects)');
  });

  it('names the reset after the agent whose title comes back', () => {
    expect(resetTitleLabel(session({ userTitle: 'x' }))).toBe("Use Claude's title");
    expect(
      resetTitleLabel(session({ userTitle: 'x', claudeStatus: undefined, codexTitle: 'c' }))
    ).toBe("Use Codex's title");
    expect(resetTitleLabel(session({ userTitle: 'x', claudeStatus: undefined }))).toBe(
      'Use the automatic name'
    );
  });
});
