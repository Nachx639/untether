import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  claudeMemoryDir,
  MEMORY_INDEX,
  memoryNoteFile,
  resolveMemoryDir,
  saveMemoryNote,
} from './task-memory-note.js';

describe('task memory notes', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-memory-'));
  });
  afterEach(() => {
    fs.rmSync(home, RM_TEST_DIR);
  });

  it("encodes the project's path the way Claude Code names its project folders", () => {
    expect(claudeMemoryDir('/Users/someone/Projects/my_app.web', '/home/x')).toBe(
      '/home/x/.claude/projects/-Users-someone-Projects-my-app-web/memory'
    );
  });

  it('is off unless the setting enables it; auto only when the folder exists', () => {
    const repo = '/work/demo';
    expect(resolveMemoryDir(undefined, repo, home)).toEqual({
      off: 'memoryDir is off for this project',
    });
    expect(resolveMemoryDir('', repo, home)).toMatchObject({ off: expect.any(String) });
    // Claude Code's folder exists, but the setting is unset: nothing is written there.
    const detected = claudeMemoryDir(repo, home);
    expect(resolveMemoryDir('auto', repo, home)).toMatchObject({
      off: expect.stringMatching(/no Claude Code memory folder/),
    });
    fs.mkdirSync(detected, { recursive: true });
    expect(resolveMemoryDir(undefined, repo, home)).toMatchObject({ off: expect.any(String) });
    expect(resolveMemoryDir('auto', repo, home)).toEqual({ dir: detected });
    expect(resolveMemoryDir(path.join(home, 'nope'), repo, home)).toMatchObject({
      off: expect.stringMatching(/does not exist/),
    });
    expect(resolveMemoryDir(home, repo, home)).toEqual({ dir: home });
  });

  it('writes the note with its frontmatter and a pointer in MEMORY.md, updating rather than duplicating', () => {
    fs.writeFileSync(path.join(home, MEMORY_INDEX), '- [Other](other.md) — something else\n');
    const first = saveMemoryNote(home, {
      name: 'flaky-check',
      description: 'checks flake under load: wait for markers',
      body: 'The check failed under load.\n\n**Why:** fixed sleeps.',
    });
    expect(first).toEqual({ saved: path.join(home, 'flaky-check.md'), updated: false });
    expect(fs.readFileSync(first.saved, 'utf8')).toBe(
      [
        '---',
        'name: flaky-check',
        'description: "checks flake under load: wait for markers"',
        'metadata:',
        '  type: project',
        '---',
        '',
        'The check failed under load.',
        '',
        '**Why:** fixed sleeps.',
        '',
      ].join('\n')
    );
    expect(fs.readFileSync(path.join(home, MEMORY_INDEX), 'utf8')).toBe(
      '- [Other](other.md) — something else\n- [Flaky check](flaky-check.md) — checks flake under load: wait for markers\n'
    );

    const again = saveMemoryNote(home, {
      name: 'flaky-check',
      description: 'checks flake under load',
      body: 'Newer text.',
    });
    expect(again.updated).toBe(true);
    expect(fs.readFileSync(again.saved, 'utf8')).toContain('Newer text.');
    expect(fs.readFileSync(again.saved, 'utf8')).not.toContain('fixed sleeps');
    expect(fs.readFileSync(path.join(home, MEMORY_INDEX), 'utf8')).toBe(
      '- [Other](other.md) — something else\n- [Flaky check](flaky-check.md) — checks flake under load\n'
    );
    expect(fs.readdirSync(home).sort()).toEqual([MEMORY_INDEX, 'flaky-check.md']);
  });

  it('starts MEMORY.md when there is none, and never writes a name that is no slug or through a link', () => {
    saveMemoryNote(home, { name: 'a-note', description: 'plain', body: 'x' });
    expect(fs.readFileSync(path.join(home, MEMORY_INDEX), 'utf8')).toBe(
      '- [A note](a-note.md) — plain\n'
    );
    expect(() => saveMemoryNote(home, { name: '../evil', description: 'd', body: 'b' })).toThrow(
      /invalid memory note name/
    );
    const outside = path.join(home, 'outside.md');
    fs.writeFileSync(outside, 'keep');
    fs.symlinkSync(outside, path.join(home, 'linked.md'));
    expect(() => saveMemoryNote(home, { name: 'linked', description: 'd', body: 'b' })).toThrow(
      /symbolic link/
    );
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
  });

  it('quotes a description YAML would misread', () => {
    expect(memoryNoteFile({ name: 'n', description: '- starts like a list', body: 'b' })).toContain(
      'description: "- starts like a list"'
    );
  });
});
