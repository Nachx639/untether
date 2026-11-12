import { describe, expect, it } from 'vitest';
import {
  ATTENTION_SEEN_MS,
  type AttentionView,
  attentionKeys,
  decideAttention,
  isUrgentPush,
} from './agent-attention-policy.js';

function view(over: Partial<AttentionView> = {}): AttentionView {
  return {
    isSessionViewed: () => false,
    wasSeenSince: () => false,
    isAnyClientActive: () => false,
    ...over,
  };
}

describe('agent attention policy', () => {
  it('knows the important pushes', () => {
    for (const type of ['task-needs-you', 'task-confirm', 'untether-doctor']) {
      expect(isUrgentPush(type), type).toBe(true);
    }
    for (const type of ['task-ready', 'claude-finished', 'bell', 'task-needs-you-ish']) {
      expect(isUrgentPush(type), type).toBe(false);
    }
  });

  it('names what a client can show of a push', () => {
    expect(attentionKeys({ type: 'task-confirm', data: { confirmId: 'c1' } })).toEqual([
      'confirm:c1',
    ]);
    expect(attentionKeys({ type: 'task-needs-you', data: { taskId: 't1' } })).toEqual([
      'needs-you:t1',
    ]);
    expect(attentionKeys({ type: 'untether-doctor' })).toEqual([]);
  });

  it('skips an ordinary push about a session on screen, sends it otherwise', () => {
    const shown = view({ isSessionViewed: (id) => id === 's1' });
    const push = (sessionId: string) => ({ type: 'claude-finished', data: { sessionId } });
    expect(decideAttention(push('s1'), shown).action).toBe('skip');
    expect(decideAttention(push('s2'), shown).action).toBe('send');
    // Session start/exit are never held back.
    expect(decideAttention({ type: 'session-exit', data: { sessionId: 's1' } }, shown).action).toBe(
      'send'
    );
  });

  it('holds an important push only while someone may be looking', () => {
    const push = { type: 'task-needs-you', data: { sessionId: 's1', taskId: 't1' } };
    expect(decideAttention(push, view())).toEqual({ action: 'send' });
    expect(decideAttention(push, view({ isSessionViewed: (id) => id === 's1' }))).toEqual({
      action: 'hold',
      ms: ATTENTION_SEEN_MS,
    });
    expect(decideAttention(push, view({ isAnyClientActive: () => true })).action).toBe('hold');
    // Nothing of the doctor's shows in a client: no reason to wait.
    expect(
      decideAttention({ type: 'untether-doctor' }, view({ isAnyClientActive: () => true }))
    ).toEqual({ action: 'send' });
  });

  it('after the hold: dropped when seen, sent when not', () => {
    const push = { type: 'task-needs-you', data: { sessionId: 's1', taskId: 't1' } };
    const heldSince = 1_000;
    expect(
      decideAttention(
        push,
        view({ wasSeenSince: (key, since) => key === 'needs-you:t1' && since === heldSince }),
        heldSince
      ).action
    ).toBe('skip');
    expect(decideAttention(push, view({ isSessionViewed: () => true }), heldSince).action).toBe(
      'skip'
    );
    expect(decideAttention(push, view({ isAnyClientActive: () => true }), heldSince).action).toBe(
      'send'
    );
  });
});
