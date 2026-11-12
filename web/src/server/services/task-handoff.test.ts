import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  buildHandoffPrompt,
  gitProgress,
  HANDOFF_DIFF_MAX,
  HANDOFF_SCREEN_MAX,
} from './task-handoff.js';

describe('task handoff to another agent (2026-11-01)', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-handoff-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'base');
  });

  afterEach(() => fs.rmSync(repo, RM_TEST_DIR));

  it('reads the commits since the base, what is uncommitted and the whole diff', async () => {
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    git('commit', '-qam', 'change a');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
    const progress = await gitProgress(repo, base);
    expect(progress.commits).toHaveLength(1);
    expect(progress.commits[0]).toMatch(/change a$/);
    expect(progress.status).toEqual(expect.arrayContaining([' M a.txt', '?? b.txt']));
    // Committed and uncommitted together, against the base.
    expect(progress.diff).toContain('-one');
    expect(progress.diff).toContain('+three');
  });

  it('a folder that is not a repository gives an empty progress, never a throw', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-handoff-none-'));
    try {
      await expect(gitProgress(empty, 'abc')).resolves.toEqual({
        commits: [],
        status: [],
        diff: '',
      });
    } finally {
      fs.rmSync(empty, RM_TEST_DIR);
    }
  });

  it('the prompt holds the task, what was done, the diff and the last rows, each clipped', () => {
    const prompt = buildHandoffPrompt({
      brief: 'Arregla el login\n\nBranch ut/login',
      from: { agent: 'codex', model: 'o4' },
      reason: 'You’ve hit your usage limit',
      progress: {
        commits: ['abc1234 wip'],
        status: [' M src/login.ts'],
        diff: `+${'x'.repeat(HANDOFF_DIFF_MAX * 2)}`,
      },
      screen: `${'old row\n'.repeat(2000)}■ You’ve hit your usage limit`,
      followUps: ['uno', 'dos', 'tres', 'cuatro'],
      pending: `Automatic fix 1 of 2: ${'hallazgo '.repeat(200)}FIN`,
      lastReply: 'Voy por la mitad',
    });
    // What it was at when it stopped, whole.
    expect(prompt).toContain('carry this on now');
    expect(prompt).toContain('FIN');
    expect(prompt).toMatch(/^\[untether\] You take over a task another agent \(Codex \(o4\)\)/);
    expect(prompt).toContain('Do not start over');
    expect(prompt).toContain('Arregla el login\n\nBranch ut/login');
    expect(prompt).toContain('abc1234 wip');
    expect(prompt).toContain(' M src/login.ts');
    expect(prompt).toContain('Voy por la mitad');
    // The latest follow-ups only.
    expect(prompt).not.toContain('- uno');
    expect(prompt).toContain('- cuatro');
    // The diff is cut, the screen keeps its end.
    expect(prompt).toContain('more characters');
    expect(prompt).toContain('■ You’ve hit your usage limit');
    expect(prompt.length).toBeLessThan(HANDOFF_DIFF_MAX + HANDOFF_SCREEN_MAX + 4000);
  });
});
