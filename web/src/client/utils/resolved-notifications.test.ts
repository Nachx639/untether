import { describe, expect, it } from 'vitest';
import { pushIsResolved, type WaitingView } from './resolved-notifications';

const view: WaitingView = {
  sessions: [
    { id: 'asking', status: 'running', claudeStatus: { status: 'waiting' } },
    { id: 'working', status: 'running', claudeStatus: { status: 'busy' } },
    { id: 'unknown', status: 'running' },
    { id: 'over', status: 'exited' },
    { id: 'codex-asking', status: 'running', agentStatus: { agent: 'codex', status: 'waiting' } },
    { id: 'codex-working', status: 'running', agentStatus: { agent: 'codex', status: 'busy' } },
    { id: 'codex-unknown', status: 'running', codexActive: true },
  ] as WaitingView['sessions'],
  tasks: [
    { id: 'waits', state: 'needs_you' },
    { id: 'done', state: 'done' },
    { id: 'failed', state: 'failed' },
  ],
  confirmations: [{ id: 'open' }],
};

describe('pushIsResolved (2026-11-09)', () => {
  it.each([
    ['session answered', { type: 'claude-waiting', sessionId: 'working' }, true],
    ['session over', { type: 'claude-waiting', sessionId: 'over' }, true],
    ['session gone', { type: 'claude-waiting', sessionId: 'gone' }, true],
    ['session still asking', { type: 'claude-waiting', sessionId: 'asking' }, false],
    ['session without a status yet', { type: 'claude-waiting', sessionId: 'unknown' }, false],
    ['Codex answered', { type: 'codex-waiting', sessionId: 'codex-working' }, true],
    ['Codex still asking', { type: 'codex-waiting', sessionId: 'codex-asking' }, false],
    ['Codex without a state yet', { type: 'codex-waiting', sessionId: 'codex-unknown' }, false],
    ['Codex session gone', { type: 'codex-waiting', sessionId: 'gone' }, true],
    ['task closed', { type: 'task-needs-you', taskId: 'done' }, true],
    ['task failed since', { type: 'task-needs-you', taskId: 'failed' }, true],
    ['task gone', { type: 'task-needs-you', taskId: 'gone' }, true],
    ['task still asking', { type: 'task-needs-you', taskId: 'waits' }, false],
    ['OK answered', { type: 'task-confirm', confirmId: 'answered' }, true],
    ['OK still waiting', { type: 'task-confirm', confirmId: 'open' }, false],
    ['anything else', { type: 'claude-finished', sessionId: 'over' }, false],
    ['no data', null, false],
  ])('%s', (_name, data, resolved) => {
    expect(pushIsResolved(data, view)).toBe(resolved);
  });
});
