import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  askCodexOnce,
  createSecurityReviewer,
  parseSecurityRuling,
  type SecurityReviewRequest,
} from './security-review.js';

const request: SecurityReviewRequest = {
  finding: {
    file: 'src/auth.ts',
    line: 3,
    severity: 'high',
    category: 'auth',
    title: 'Token sin verificar',
    exploit: 'x',
    fix: 'y',
  } as SecurityReviewRequest['finding'],
  section: 'auth',
  context: 'code',
  agent: 'codex',
  effort: 'low',
};

describe('security-review', () => {
  let replyDir: string;
  beforeEach(() => {
    replyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-sec-review-'));
  });
  afterEach(() => {
    fs.rmSync(replyDir, RM_TEST_DIR);
  });

  it('a Codex that exits without reading a large prompt is a null reply, not a broken pipe (2026-11-10)', async () => {
    const bin = path.join(replyDir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const before = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${before}`;
    try {
      const reply = await askCodexOnce('x'.repeat(300_000), {
        effort: 'low',
        timeoutMs: 10_000,
        cwd: replyDir,
      });
      expect(reply).toBeNull();
      // The EPIPE comes after the exit: give it the time to surface (an unhandled 'error'
      // event fails the run).
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.env.PATH = before;
    }
  });

  it('reads the ruling with text after it; two different rulings are not one (2026-10-25)', () => {
    expect(
      parseSecurityRuling('{"verdict":"dismissed","reason":"No es explotable"}\nFin {nota}.')
    ).toEqual({ verdict: 'dismissed', reason: 'No es explotable' });
    expect(
      parseSecurityRuling(
        '{"verdict":"dismissed","reason":"a"} {"verdict":"confirmed","reason":"b"}'
      )
    ).toBeNull();
  });

  it('asks again when the ruling is unreadable, then says why and keeps the replies', async () => {
    const replies = ['{"verdict":"confirmed","reason":"El token', '{"verdict":"confirmed"}'];
    const asked: string[] = [];
    const review = createSecurityReviewer({
      replyDir,
      codex: async (prompt) => {
        asked.push(prompt);
        return replies.shift() ?? null;
      },
    });
    await expect(review(request)).resolves.toEqual({ verdict: 'confirmed', reason: '' });
    expect(asked[1]).toContain('YOUR PREVIOUS REPLY COULD NOT BE READ');

    const prose = createSecurityReviewer({ replyDir, codex: async () => 'Parece bien.' });
    const ruling = await prose(request);
    expect(ruling.verdict).toBe('unavailable');
    expect(ruling.reason).toContain('asked twice');
    expect(fs.readdirSync(replyDir)).toHaveLength(3);

    const silent = createSecurityReviewer({ replyDir, codex: async () => null });
    await expect(silent(request)).resolves.toEqual({
      verdict: 'unavailable',
      reason: 'no answer from codex',
    });
  });
});
