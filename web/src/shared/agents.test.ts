import { describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  AGENTS,
  agentForExecutable,
  agentsNotIn,
  commandAgent,
  commandModel,
  isTaskAgent,
  TASK_AGENTS,
  taskAskedModel,
  withRegisteredAgents,
} from './agents.js';

describe('agent registry', () => {
  it('owns executable identity, capabilities and task model defaults', () => {
    expect(new Set(AGENT_IDS.map((id) => AGENTS[id].executable)).size).toBe(AGENT_IDS.length);
    expect(TASK_AGENTS).toEqual(['claude', 'codex', 'qoder']);
    expect(AGENTS.qoder).toMatchObject({
      executable: 'qodercli',
      fastModel: 'efficient',
      capableModel: undefined,
    });
    expect(isTaskAgent('gemini')).toBe(false);
    expect(isTaskAgent('__proto__')).toBe(false);
    expect(agentForExecutable('/custom/bin/qodercli')).toBe('qoder');
  });
  it('recognizes launchers but never a name inside another agent’s prompt', () => {
    expect(commandAgent(['qodercli', '-m', 'efficient'])).toBe('qoder');
    expect(commandAgent(['env', 'QODER_CONFIG_DIR=/tmp/isolated', 'qodercli'])).toBe('qoder');
    expect(commandAgent(['zsh', '-ilc', 'exec qodercli "$@"', '--'])).toBe('qoder');
    expect(commandAgent(['claude', 'review qodercli'])).toBe('claude');
    expect(commandAgent(['echo', 'qodercli'])).toBeUndefined();
  });
  it("reads the model a command asks its agent for, and a task's own model first", () => {
    expect(commandModel(['claude', '--dangerously-skip-permissions', '--model', 'sonnet'])).toBe(
      'sonnet'
    );
    expect(commandModel(['/opt/bin/claude', '--model=opus'])).toBe('opus');
    expect(commandModel(['env', 'CLAUDE_CONFIG_DIR=/x', 'claude', '--model', 'haiku'])).toBe(
      'haiku'
    );
    expect(commandModel(['codex', '-m', 'gpt-5'])).toBe('gpt-5');
    // -m is not Claude's model flag; a shell wrapping the agent is not read.
    expect(commandModel(['claude', '-m', 'opus'])).toBeUndefined();
    expect(commandModel(['zsh', '-lc', 'claude --model opus'])).toBeUndefined();
    expect(commandModel(['claude'])).toBeUndefined();
    expect(commandModel(['claude', '--model'])).toBeUndefined();
    expect(commandModel(undefined)).toBeUndefined();
    expect(taskAskedModel({ model: 'opus', command: ['claude', '--model', 'sonnet'] })).toBe(
      'opus'
    );
    expect(taskAskedModel({ command: ['claude', '--model', 'sonnet'] })).toBe('sonnet');
    expect(taskAskedModel({ command: ['claude'] })).toBeUndefined();
  });
  it('adds the agents an installation lacks only when installed, keeping configured flags', () => {
    const mine = [
      { name: 'My Qoder', command: 'qodercli -m efficient' },
      { command: '/opt/bin/claude --model opus' },
    ];
    expect(agentsNotIn(mine)).toEqual(['codex', 'gemini']);
    expect(withRegisteredAgents(mine, { codex: true, gemini: false })).toEqual([
      ...mine,
      { name: 'Codex', command: 'codex' },
    ]);
    // Unknown (the check failed) adds nothing.
    expect(withRegisteredAgents(mine, {})).toEqual(mine);
  });
});
