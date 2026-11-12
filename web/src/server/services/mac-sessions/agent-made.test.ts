import { describe, expect, it } from 'vitest';
import {
  type AgentMadeFacts,
  agentScratchRoots,
  hasAgentToolMark,
  isAgentMade,
  isAgentScratchFolder,
} from './agent-made.js';

const SCRATCH = '/private/tmp/claude-501/-Users-me-project/1234/scratchpad';
const roots = agentScratchRoots(501, {});

const facts = (overrides: Partial<AgentMadeFacts> = {}): AgentMadeFacts => ({
  inAppTerminal: false,
  serverMarked: false,
  defaultServer: false,
  folders: ['/Users/me/project'],
  ...overrides,
});

describe('agentScratchRoots', () => {
  it('names the per-user temporary folder in both spellings, also under TMPDIR', () => {
    expect(roots).toEqual(expect.arrayContaining(['/tmp/claude-501', '/private/tmp/claude-501']));
    expect(agentScratchRoots(501, { TMPDIR: '/var/folders/xy/T/' })).toEqual(
      expect.arrayContaining([
        '/var/folders/xy/T/claude-501',
        '/private/var/folders/xy/T/claude-501',
      ])
    );
  });

  it('does not take a neighbour for the folder, or another user’s', () => {
    expect(isAgentScratchFolder(SCRATCH, roots)).toBe(true);
    expect(isAgentScratchFolder('/private/tmp/claude-501', roots)).toBe(true);
    expect(isAgentScratchFolder('/private/tmp/claude-5011/x', roots)).toBe(false);
    expect(isAgentScratchFolder('/private/tmp/claude-502/x', roots)).toBe(false);
    expect(isAgentScratchFolder('/private/tmp/mine', roots)).toBe(false);
    expect(isAgentScratchFolder(undefined, roots)).toBe(false);
  });
});

describe('hasAgentToolMark', () => {
  it.each(['UNTETHER_TASK_ID', 'UNTETHER_TEST_RUN_DIR', 'CLAUDECODE', 'CODEX_THREAD_ID'])(
    'takes %s as a mark',
    (name) => {
      expect(hasAgentToolMark(new Map([[name, '1']]))).toBe(true);
    }
  );

  it('takes neither an Untether shell nor a set-but-empty variable as a mark', () => {
    expect(hasAgentToolMark(new Map([['UNTETHER_SESSION_ID', 'web-1']]))).toBe(false);
    expect(hasAgentToolMark(new Map([['CLAUDECODE', '']]))).toBe(false);
  });
});

describe('isAgentMade', () => {
  it('leaves an ordinary session alone', () => {
    expect(isAgentMade(facts(), roots)).toBe(false);
  });

  it('takes every session of a marked server on its own socket', () => {
    expect(isAgentMade(facts({ serverMarked: true }), roots)).toBe(true);
  });

  it('never goes by the mark on the default socket: the user’s sessions live there too', () => {
    expect(isAgentMade(facts({ serverMarked: true, defaultServer: true }), roots)).toBe(false);
  });

  it('takes a session only when all its panes are in a scratch folder', () => {
    expect(isAgentMade(facts({ folders: [SCRATCH, `${SCRATCH}/sub`] }), roots)).toBe(true);
    expect(isAgentMade(facts({ folders: [SCRATCH, '/Users/me/project'] }), roots)).toBe(false);
    expect(isAgentMade(facts({ folders: [SCRATCH, undefined] }), roots)).toBe(false);
    expect(isAgentMade(facts({ folders: [] }), roots)).toBe(false);
  });

  it('never takes what an app’s terminal shows', () => {
    expect(
      isAgentMade(facts({ inAppTerminal: true, serverMarked: true, folders: [SCRATCH] }), roots)
    ).toBe(false);
  });
});
