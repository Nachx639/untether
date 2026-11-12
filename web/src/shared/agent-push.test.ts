import { describe, expect, it } from 'vitest';
import { agentPush, agentPushTag, isAgentPushTag, namedForAgent } from './agent-push.js';

describe('agent pushes', () => {
  it('tells whose push a type is and what it says', () => {
    expect(agentPush('claude-waiting')).toEqual({ agent: 'claude', kind: 'waiting' });
    expect(agentPush('codex-finished')).toEqual({ agent: 'codex', kind: 'finished' });
    expect(agentPush('claude-replied')).toEqual({ agent: 'claude', kind: 'replied' });
    for (const other of ['task-needs-you', 'bell', 'codex-', 'gemini-finished', undefined, 7]) {
      expect(agentPush(other)).toBeUndefined();
    }
  });

  it('tags one notification per session and agent, told apart from the other pushes', () => {
    expect(agentPushTag('codex', 's1')).toBe('untether-codex-s1');
    expect(isAgentPushTag(agentPushTag('claude', 's1'))).toBe(true);
    expect(isAgentPushTag(agentPushTag('codex', 's1'))).toBe(true);
    expect(isAgentPushTag('untether-bell-s1')).toBe(false);
    expect(isAgentPushTag(undefined)).toBe(false);
  });

  it('names the agent in a text written about Claude, once', () => {
    expect(namedForAgent('⏳ Claude needs you · {where}', 'codex')).toBe(
      '⏳ Codex needs you · {where}'
    );
    expect(namedForAgent('⏳ Claude needs you · {where}', 'claude')).toBe(
      '⏳ Claude needs you · {where}'
    );
    expect(namedForAgent('Claude finished · Claude notes', 'codex')).toBe(
      'Codex finished · Claude notes'
    );
  });
});
