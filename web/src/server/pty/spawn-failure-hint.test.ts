import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { spawnFailureHint } from './pty-manager.js';

const helper = path.join(
  path.dirname(require.resolve('node-pty/package.json')),
  'build',
  'Release',
  'spawn-helper'
);

describe('spawnFailureHint (2026-10-20)', () => {
  it('says nothing for other errors, or when node-pty is whole', () => {
    expect(spawnFailureHint('ENOENT: no such file')).toBe('');
    if (fs.existsSync(helper)) expect(spawnFailureHint('posix_spawnp failed.')).toBe('');
  });

  it("names node-pty's missing spawn-helper when posix_spawnp fails", () => {
    const missing = (file: fs.PathLike) => file !== helper && fs.existsSync(file);
    expect(spawnFailureHint('posix_spawnp failed.', missing)).toContain('spawn-helper is missing');
  });
});
