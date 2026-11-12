import { describe, expect, it } from 'vitest';
import { buildTaskPrompt } from './task-prompt.js';
import { validateTaskResult } from './task-result.js';

describe('the task brief', () => {
  const brief = buildTaskPrompt('Fix it', { branch: 'ut/fix-it', baseBranch: 'main' });

  it('tells the agent to put what is worth remembering in memoryNote, not in a memory folder (2026-11-03)', () => {
    expect(brief).toContain('Do not write any agent memory folder');
    expect(brief).toContain('add memoryNote to the result');
    // The shape it shows is one the result takes.
    const shown = brief.match(/add memoryNote to the result: (\{[^}]*\})/)?.[1];
    expect(shown).toBeDefined();
    const note = JSON.parse(shown as string);
    expect(
      validateTaskResult({
        outcome: 'no-change',
        files: [],
        tests: [],
        risks: [],
        followUps: [],
        memoryNote: note,
      }).ok
    ).toBe(true);
    // Generic: no one's home folder in it.
    expect(brief).not.toMatch(/\/Users\/|\/home\//);
  });

  it('asks for focused tests while working: the whole check is run by Untether, once (2026-11-11)', () => {
    const line = brief.split('\n').find((l) => l.startsWith('While you work,'));
    expect(line).toBeDefined();
    expect(line).toContain('only the tests focused on what you touch');
    expect(line).toContain("not the project's whole check or whole test suite");
    expect(line).toContain('Untether runs the whole check once when you report done');
    // Not forbidden: a whole run goes through a check slot and may be reused.
    expect(line).toContain('If you do need a whole run, make it once');
    expect(line).toContain('"check: reused"');
    // Before the report: it is about how to work, not about what to say at the end.
    expect(brief.indexOf('While you work,')).toBeLessThan(brief.indexOf('When you are done'));
  });

  it('carries compact instructions that keep failing output, diffs, paths and decisions (2026-11-03)', () => {
    const line = brief.split('\n').find((l) => l.startsWith('Compact instructions:'));
    expect(line).toBeDefined();
    for (const kept of ['failing tests', 'verbatim', 'diffs', 'paths', 'decisions']) {
      expect(line).toContain(kept);
    }
    // After the user's prompt, in the brief's suffix.
    expect(brief.indexOf('Fix it')).toBeLessThan(brief.indexOf('Compact instructions:'));
  });
});
