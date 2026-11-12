import { describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types.js';
import { waitingAgent, waitingChoices, waitingFor, waitingSince } from './session-waiting.js';

const menu = { question: 'Proceed?', options: ['Yes', 'No'] };

describe('what a session waits on, whoever its agent is', () => {
  it('reads Claude’s while Claude says it waits', () => {
    const claude = {
      claudeStatus: { status: 'waiting', waitingFor: 'permission prompt', since: 5, choices: menu },
    } as Partial<Session>;
    expect(waitingChoices(claude)).toBe(menu);
    expect(waitingFor(claude)).toBe('permission prompt');
    expect(waitingSince(claude)).toBe(5);
    expect(waitingAgent(claude)).toBe('claude');
    // Choices left on a status that moved on are no longer what it waits on.
    expect(waitingChoices({ claudeStatus: { status: 'busy', choices: menu } })).toBeUndefined();
  });

  it('reads Codex’s menu the same way, and Claude’s first where both are there', () => {
    const codex = {
      agentStatus: { agent: 'codex', status: 'waiting', since: 9, choices: menu },
    } as Partial<Session>;
    expect(waitingChoices(codex)).toBe(menu);
    expect(waitingSince(codex)).toBe(9);
    expect(waitingFor(codex)).toBeUndefined();
    expect(waitingAgent(codex)).toBe('codex');
    expect(
      waitingChoices({ agentStatus: { agent: 'codex', status: 'busy', choices: menu } })
    ).toBeUndefined();
    const both = { ...codex, claudeStatus: { status: 'idle' } } as Partial<Session>;
    expect(waitingChoices(both)).toBeUndefined();
    expect(waitingAgent(both)).toBe('claude');
  });

  it('says nothing of a shell', () => {
    expect(waitingChoices({})).toBeUndefined();
    expect(waitingAgent({})).toBeUndefined();
  });
});
