import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countReview, reviewBlocks, type TaskReview } from '../../shared/tasks.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  CODEX_REVIEW_EFFORT,
  CODEX_REVIEW_TIMEOUT_MS,
  capDiff,
  collectReviewInput,
  createTaskReviewer,
  diffFiles,
  LOW_NOTES_MAX,
  parseReviewReply,
  pickReviewer,
  REVIEW_DIFF_MAX,
  REVIEW_FILE_MAX,
  REVIEW_MODEL,
  REVIEW_SYSTEM_PROMPT,
  REVIEW_TIMEOUT_MS,
  ReviewDiffMismatchError,
  type ReviewRequest,
  reviewQuestion,
  reviewRound,
  splitDiff,
} from './task-review.js';
import type { RouteChild, RouteSpawner } from './task-router-llm.js';

class FakeChild extends EventEmitter implements RouteChild {
  stdout = new PassThrough();
  killed: string | undefined;
  kill(signal?: NodeJS.Signals) {
    this.killed = signal ?? 'SIGTERM';
    return true;
  }
}

const request: ReviewRequest = {
  title: 'Dividir facturas',
  prompt: 'Añade una función que reparta el total entre N personas',
  summary: 'Añadí split() en src/split.ts',
  commits: ['abc1234 add split'],
  diff: 'diff --git a/src/split.ts b/src/split.ts\n+export const split = (t, n) => t / (n - 1);\n',
  omitted: [],
  truncated: false,
  headSha: 'f00d',
};

function fileDiff(file: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+line ${i} of ${file}`).join('\n');
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1,${lines} @@\n${body}\n`;
}

describe('task-review', () => {
  let tmp: string;
  let tokenFile: string;
  let calls: Array<{ bin: string; args: string[]; cwd?: string }>;
  let child: FakeChild;

  const spawner =
    (script: (child: FakeChild) => void): RouteSpawner =>
    (bin, args, { cwd }) => {
      calls.push({ bin, args, cwd });
      child = new FakeChild();
      const current = child;
      setImmediate(() => script(current));
      return current;
    };
  const reply = (text: string) => (current: FakeChild) => {
    current.stdout.write(`${JSON.stringify({ type: 'result', result: text })}\n`);
    current.stdout.end();
    setImmediate(() => current.emit('close'));
  };
  const reviewer = (script: (child: FakeChild) => void) =>
    createTaskReviewer({
      claudeBin: '/bin/claude',
      tokenFile,
      spawn: spawner(script),
      now: () => Date.parse('2026-10-18T12:00:00Z'),
    });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-review-'));
    tokenFile = path.join(tmp, 'oauth-token');
    fs.writeFileSync(tokenFile, 'tok-123\n');
    calls = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmp, RM_TEST_DIR);
  });

  it('asks Sonnet with no tools, from a harmless folder, and takes an ok verdict', async () => {
    const review = await reviewer(reply('{"verdict":"ok","summary":"Todo correcto","issues":[]}'))(
      request
    );
    expect(review).toEqual({
      verdict: 'ok',
      summary: 'Todo correcto',
      issues: [],
      at: '2026-10-18T12:00:00.000Z',
      model: 'sonnet',
      agent: 'claude',
      headSha: 'f00d',
    });
    const [{ bin, args, cwd }] = calls;
    expect(bin).toBe('/bin/claude');
    expect(args.slice(0, 7)).toEqual([
      '-p',
      '--model',
      REVIEW_MODEL,
      '--tools',
      '',
      '--setting-sources',
      '',
    ]);
    expect(REVIEW_MODEL).toBe('sonnet');
    expect(args).toContain(REVIEW_SYSTEM_PROMPT);
    expect(args[args.length - 1]).toBe(reviewQuestion(request));
    expect(cwd).toBeDefined();
    expect(fs.readdirSync(cwd as string)).toEqual([]);
    expect(reviewBlocks(review)).toBe(false);
  });

  it('takes concerns with their issues (fenced JSON too); medium or high blocks, low does not', async () => {
    const review = await reviewer(
      reply(
        '```json\n{"verdict":"concerns","summary":"División por n-1","issues":[{"file":"src/split.ts","line":1,"severity":"high","what":"Divide entre n-1"},{"file":"src/split.ts","severity":"low","what":"Sin tipos"},{"severity":"weird","what":"x"}]}\n```'
      )
    )(request);
    expect(review.verdict).toBe('concerns');
    expect(review.summary).toBe('División por n-1');
    expect(review.issues).toEqual([
      {
        file: 'src/split.ts',
        line: 1,
        severity: 'high',
        category: 'bug',
        what: 'Divide entre n-1',
      },
      { file: 'src/split.ts', severity: 'low', category: 'bug', what: 'Sin tipos' },
    ]);
    expect(reviewBlocks(review)).toBe(true);
    expect(
      reviewBlocks({ verdict: 'concerns', issues: [{ file: 'a', severity: 'low', what: 'x' }] })
    ).toBe(false);
  });

  it('2026-10-20: the verdict follows the findings, nits never block, notes are capped, repeats are one', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      file: `f${i}.ts`,
      severity: 'low',
      category: 'nit',
      what: `estilo ${i}`,
    }));
    const parsed = parseReviewReply(
      JSON.stringify({
        verdict: 'ok',
        summary: 's',
        issues: [
          ...many,
          { file: 'a.ts', severity: 'high', category: 'nit', what: 'nombre feo' },
          { file: 'b.ts', severity: 'medium', category: 'security', what: 'inyección' },
          { file: 'b.ts', severity: 'medium', category: 'security', what: 'inyección' },
        ],
      })
    );
    expect(parsed?.verdict).toBe('concerns');
    expect(parsed?.issues[0]).toMatchObject({ category: 'security', severity: 'medium' });
    expect(parsed?.issues.filter((issue) => issue.what === 'inyección')).toHaveLength(1);
    // The "high" nit is a low note; at most LOW_NOTES_MAX notes stay.
    expect(parsed?.issues).toHaveLength(1 + LOW_NOTES_MAX);
    const onlyNits = parseReviewReply(
      JSON.stringify({ verdict: 'concerns', summary: 's', issues: many.slice(0, 2) })
    );
    expect(onlyNits?.verdict).toBe('ok');
    expect(reviewBlocks({ verdict: 'ok', issues: parsed?.issues ?? [] })).toBe(true);
  });

  it('2026-10-20: the question carries the guidelines and the previous findings; the prompt scopes the review', () => {
    const question = reviewQuestion({
      ...request,
      guidelines: '## REVIEW.md\nMoney in cents.',
      previous: {
        headSha: 'abc123def456',
        summary: 'Antes',
        issues: [{ file: 'a.ts', line: 3, severity: 'high', category: 'bug', what: 'n-1' }],
      },
      incremental: true,
    });
    expect(question).toContain('PROJECT GUIDELINES');
    expect(question).toContain('Money in cents.');
    expect(question).toContain('PREVIOUS REVIEW (of abc123def456)');
    expect(question).toContain('- high bug a.ts:3: n-1');
    expect(question).toContain('only what changed since the previous review');
    expect(REVIEW_SYSTEM_PROMPT).toContain('review only the lines this diff adds or changes');
    expect(REVIEW_SYSTEM_PROMPT).toContain('SECURITY PASS');
    expect(REVIEW_SYSTEM_PROMPT).toContain('ONE finding for the whole class');
  });

  it("2026-11-01: the question carries the agent's structured result, to compare with the diff", () => {
    const question = reviewQuestion({
      ...request,
      result: {
        outcome: 'partial',
        files: [{ path: 'split.ts', why: 'reparte el total' }],
        tests: [{ command: 'pnpm test', result: 'failed', detail: '1 failed' }],
        risks: ['n = 0'],
        followUps: ['falta redondear'],
      },
      resultMismatch: "The diff changes files the agent's result does not name: b.ts",
    });
    expect(question).toContain("THE AGENT'S STRUCTURED RESULT");
    expect(question).toContain('check each against the diff');
    expect(question).toContain('outcome: partial');
    expect(question).toContain('file split.ts: reparte el total');
    expect(question).toContain('test pnpm test: failed (1 failed)');
    expect(question).toContain('risk: n = 0');
    expect(question).toContain('follow-up: falta redondear');
    expect(question).toContain(
      "UNTETHER NOTICED: The diff changes files the agent's result does not name: b.ts"
    );
    expect(reviewQuestion(request)).not.toContain('STRUCTURED RESULT');
  });

  it('2026-10-23: the question carries what was sent after the prompt, later ones winning', () => {
    const question = reviewQuestion({
      ...request,
      followUps: ['Que fusionar también sea automático, con cuenta atrás.'],
    });
    expect(question).toContain('SENT TO THE TASK AFTER ITS PROMPT');
    expect(question).toContain('the later message is what is asked now');
    expect(question).toContain('- Que fusionar también sea automático, con cuenta atrás.');
    expect(reviewQuestion(request)).not.toContain('SENT TO THE TASK AFTER ITS PROMPT');
  });

  it('2026-11-02: the question lists what the command guard blocked, latest first', () => {
    const entry = (what: string, rule = 'git-push') => ({
      at: '2026-11-02T00:00:00Z',
      rule,
      tool: 'Bash',
      what,
      reason: 'r',
    });
    const question = reviewQuestion({
      ...request,
      guardBlocks: {
        count: 3,
        recent: [
          entry('git push origin HEAD'),
          entry('', 'guard-error'),
          entry('rm -rf ~/x', 'delete-outside'),
        ],
      },
    });
    expect(question).toContain("BLOCKED BY UNTETHER'S COMMAND GUARD (3 tool call(s)");
    expect(question.indexOf('[delete-outside] Bash: rm -rf ~/x')).toBeLessThan(
      question.indexOf('[git-push] Bash: git push origin HEAD')
    );
    expect(question).not.toContain('guard-error');
    expect(reviewQuestion(request)).not.toContain('COMMAND GUARD');
  });

  it('is unavailable without claude, without a token, on a timeout or a bad answer', async () => {
    const spawn = vi.fn();
    const noClaude = createTaskReviewer({ claudeBin: null, tokenFile, spawn });
    await expect(noClaude(request)).resolves.toMatchObject({
      verdict: 'unavailable',
      issues: [],
      headSha: 'f00d',
    });
    const noToken = createTaskReviewer({
      claudeBin: '/bin/claude',
      tokenFile: path.join(tmp, 'missing'),
      spawn,
    });
    await expect(noToken(request)).resolves.toMatchObject({ verdict: 'unavailable' });
    expect(spawn).not.toHaveBeenCalled();

    const prose = await reviewer(reply('Looks fine to me.'))(request);
    expect(prose.verdict).toBe('unavailable');
    expect(prose.reason).toContain('not the JSON');
    const wrong = await reviewer(reply('{"verdict":"maybe","summary":"?"}'))(request);
    expect(wrong.verdict).toBe('unavailable');

    vi.useFakeTimers();
    const pending = reviewer(() => {})(request);
    await vi.advanceTimersByTimeAsync(REVIEW_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({ verdict: 'unavailable' });
    expect(child.killed).toBe('SIGKILL');
  });

  it('reads an answer with text after it, and asks again when one is cut (2026-10-25)', async () => {
    // Task 2408ebef: an "ok" review followed by more text came back as "not the JSON asked for".
    const answer =
      '{"verdict":"ok","summary":"El arreglo es coherente","issues":[{"file":"desktop/src/p.ts","severity":"low","category":"nit","what":"Sobra un \\"log\\""}]}';
    const trailing = await reviewer(reply(`${answer}\n\nNada más que añadir {fin}.`))(request);
    expect(trailing).toMatchObject({ verdict: 'ok', summary: 'El arreglo es coherente' });
    expect(calls).toHaveLength(1);

    const replyDir = path.join(tmp, 'ai-replies');
    const replies = [answer.slice(0, 120), answer];
    calls = [];
    const retried = await createTaskReviewer({
      claudeBin: '/bin/claude',
      tokenFile,
      replyDir,
      spawn: spawner((current) => reply(replies.shift() ?? '')(current)),
    })(request);
    expect(retried).toMatchObject({ verdict: 'ok', issues: [{ what: 'Sobra un "log"' }] });
    expect(calls).toHaveLength(2);
    expect(calls[1].args.at(-1)).toContain('It was cut off: summary under 200 characters');
    expect(fs.readdirSync(replyDir)).toHaveLength(1);
  });

  it('parses only the object asked for', () => {
    expect(parseReviewReply('nothing')).toBeNull();
    expect(parseReviewReply('{"verdict":"ok"}')).toBeNull();
    expect(parseReviewReply('{"verdict":"ok","summary":"s","issues":"none"}')).toBeNull();
    expect(parseReviewReply('{"verdict":"ok","summary":" s "}')).toEqual({
      verdict: 'ok',
      summary: 's',
      issues: [],
    });
  });

  it('leaves a diff that fits alone; cuts a big one to the stat and the biggest files', () => {
    expect(capDiff('small', 'stat')).toEqual({ diff: 'small', truncated: false, omitted: [] });
    const files = [
      fileDiff('huge.ts', 6000),
      ...Array.from({ length: 40 }, (_, i) => fileDiff(`f${i}.ts`, 200)),
    ];
    const diff = files.join('');
    expect(Buffer.byteLength(diff)).toBeGreaterThan(REVIEW_DIFF_MAX);
    expect(splitDiff(diff).map((f) => f.file)).toContain('huge.ts');
    const capped = capDiff(diff, ' huge.ts | 6000 +\n 41 files changed');
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.diff)).toBeLessThanOrEqual(REVIEW_DIFF_MAX);
    expect(capped.diff.startsWith('--stat:\n huge.ts | 6000 +')).toBe(true);
    // The biggest file comes first, cut to REVIEW_FILE_MAX.
    expect(capped.diff.indexOf('diff --git a/huge.ts')).toBeLessThan(
      capped.diff.indexOf('diff --git a/f0.ts')
    );
    expect(capped.diff).toMatch(/more lines of this file not shown/);
    const hugePart = capped.diff.slice(capped.diff.indexOf('diff --git a/huge.ts'));
    expect(hugePart.indexOf('not shown')).toBeLessThan(REVIEW_FILE_MAX + 100);
    expect(capped.omitted.length).toBeGreaterThan(0);
    const question = reviewQuestion({ ...request, ...capped });
    expect(question).toContain('too big to show whole');
    expect(question).toContain(`Files not shown: ${capped.omitted[0]}`);
  });
});

/** A diff to review (not "unchanged"). */
function diffInput(input: Awaited<ReturnType<typeof collectReviewInput>>) {
  if ('unchanged' in input) throw new Error('expected a diff, got unchanged');
  return input;
}

describe('parseReviewReply diffMismatch (2026-11-01)', () => {
  it('keeps the flag only when it is true', () => {
    const reply = (extra: object) =>
      parseReviewReply(JSON.stringify({ verdict: 'concerns', summary: 's', issues: [], ...extra }));
    expect(reply({ diffMismatch: true })?.diffMismatch).toBe(true);
    expect(reply({ diffMismatch: 'yes' })).not.toHaveProperty('diffMismatch');
    expect(reply({})).not.toHaveProperty('diffMismatch');
  });
});

describe('collectReviewInput (real git)', () => {
  it("an incremental re-review reads only the task's own commits, not the base merged in (2026-10-20)", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-review-input-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      })
        .toString()
        .trim();
    const commit = (file: string, text: string, message: string) => {
      fs.writeFileSync(path.join(repo, file), text);
      git('add', file);
      git('commit', '-q', '-m', message);
    };
    try {
      git('init', '-q', '-b', 'main');
      commit('base.txt', 'base\n', 'init');
      git('checkout', '-q', '-b', 'task');
      commit('mine.txt', 'mine\n', 'task: first');
      const reviewed = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      commit('someone-else.txt', 'other\n', 'other work on main');
      const baseNow = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'task');
      git('merge', '-q', '--no-edit', 'main');
      commit('mine.txt', 'mine fixed\n', 'task: fix');
      const head = git('rev-parse', 'HEAD');
      const input = diffInput(await collectReviewInput(repo, baseNow, head, reviewed));
      expect(input.incremental).toBe(true);
      expect(input.commits).toEqual([expect.stringContaining('task: fix')]);
      expect(input.diff).toContain('mine fixed');
      expect(input.diff).not.toContain('someone-else.txt');
    } finally {
      fs.rmSync(repo, RM_TEST_DIR);
    }
  });

  // 2026-10-31: these two got a full review, with new nits on lines read before.
  describe('stays incremental when a fix round', () => {
    let repo: string;
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        stdio: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      })
        .toString()
        .trim();
    const write = (file: string, text: string) => fs.writeFileSync(path.join(repo, file), text);
    const commit = (file: string, text: string, message: string) => {
      write(file, text);
      git('add', file);
      git('commit', '-q', '-m', message);
    };
    beforeEach(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-review-input-'));
      git('init', '-q', '-b', 'main');
      commit('shared.txt', 'one\ntwo\n', 'init');
      git('checkout', '-q', '-b', 'task');
    });
    afterEach(() => fs.rmSync(repo, RM_TEST_DIR));

    it('only resolved a conflict (a merge commit, nothing else): the resolution is reviewed', async () => {
      commit('shared.txt', 'ONE mine\ntwo\n', 'task: first');
      commit('mine.txt', 'mine\n', 'task: more');
      const reviewed = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      commit('shared.txt', 'one theirs\ntwo\n', 'their edit');
      commit('other.txt', 'other\n', 'other work on main');
      const baseNow = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'task');
      try {
        git('merge', '-q', '--no-edit', 'main');
      } catch {
        // The conflict, resolved by hand below.
      }
      write('shared.txt', 'ONE mine and theirs\ntwo\n');
      git('add', 'shared.txt');
      git('commit', '-q', '--no-edit');
      const head = git('rev-parse', 'HEAD');
      const input = diffInput(await collectReviewInput(repo, baseNow, head, reviewed));
      expect(input.incremental).toBe(true);
      expect(input.diff).toContain('ONE mine and theirs');
      // The base's own files are not the task's.
      expect(input.diff).not.toContain('other.txt');
      expect(input.diff).not.toContain('mine.txt');
      expect(input.commits).toHaveLength(1);
    });

    it('rewrote its commits (amend): compared with the tree that was reviewed', async () => {
      commit('mine.txt', 'mine\n', 'task: first');
      commit('also.txt', 'also\n', 'task: second');
      const reviewed = git('rev-parse', 'HEAD');
      write('also.txt', 'also fixed\n');
      git('add', 'also.txt');
      git('commit', '-q', '--amend', '--no-edit');
      const head = git('rev-parse', 'HEAD');
      const base = git('rev-parse', 'main');
      const input = diffInput(await collectReviewInput(repo, base, head, reviewed));
      expect(input.incremental).toBe(true);
      expect(input.diff).toContain('also fixed');
      expect(input.diff).not.toContain('mine.txt');
    });

    // 2026-11-01 (bakery e15c0fae): a clean merge of main that changed a file the task also
    // changed was taken as the task's resolution, and main's lines were reviewed as its own.
    it("main merged in cleanly on a file both changed: none of main's lines are reviewed", async () => {
      const lines = (first: string, last: string) =>
        `${first}\n${Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n')}\n${last}\n`;
      git('checkout', '-q', 'main');
      commit('shared.txt', lines('one', 'end'), 'longer shared');
      git('checkout', '-q', 'task');
      git('merge', '-q', '--no-edit', 'main');
      commit('shared.txt', lines('ONE mine', 'end'), 'task: shared');
      commit('mine.txt', 'mine\n', 'task: mine');
      const reviewed = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      commit('shared.txt', lines('one', 'END theirs'), 'other task: shared');
      commit('welcome.txt', 'welcomeCard\n', 'other task: welcome');
      const baseNow = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'task');
      git('merge', '-q', '--no-edit', '-m', 'Merge main into task', 'main');
      const merged = git('rev-parse', 'HEAD');
      // Nothing of the task's own since the review: the earlier verdict stands.
      expect(await collectReviewInput(repo, baseNow, merged, reviewed)).toEqual({
        unchanged: true,
      });
      commit('mine.txt', 'mine fixed\n', 'task: fix');
      const head = git('rev-parse', 'HEAD');
      const input = diffInput(await collectReviewInput(repo, baseNow, head, reviewed));
      expect(input.incremental).toBe(true);
      expect(input.diff).toContain('mine fixed');
      expect(input.diff).not.toContain('END theirs');
      expect(input.diff).not.toContain('welcome');
      expect(input.diff).not.toContain('shared.txt');
      // The whole diff (no review before) is the task's files only, as its changes say.
      const whole = diffInput(
        await collectReviewInput(repo, baseNow, head, undefined, ['mine.txt', 'shared.txt'])
      );
      expect(whole.diff).toContain('ONE mine');
      expect(whole.diff).toContain('mine fixed');
      expect(whole.diff).not.toContain('END theirs');
      expect(whole.diff).not.toContain('welcome');
      // The guard: changes that differ from the diff's files stop the review.
      await expect(
        collectReviewInput(repo, baseNow, head, undefined, ['mine.txt'])
      ).rejects.toBeInstanceOf(ReviewDiffMismatchError);
    });

    it('a reviewed commit that is gone: the whole diff', async () => {
      commit('mine.txt', 'mine\n', 'task: first');
      const head = git('rev-parse', 'HEAD');
      const base = git('rev-parse', 'main');
      const input = diffInput(await collectReviewInput(repo, base, head, 'f'.repeat(40)));
      expect(input.incremental).toBeUndefined();
      expect(input.diff).toContain('mine.txt');
    });
  });
});

describe('cross review (2026-11-01)', () => {
  const OK = '{"verdict":"ok","summary":"Bien","issues":[]}';
  const CONCERNS =
    '{"verdict":"concerns","summary":"Divide mal","issues":[{"file":"src/split.ts","line":1,"severity":"high","category":"bug","what":"n - 1 divide de más"}]}';
  let tmp: string;
  let tokenFile: string;
  let claudeCalls: number;
  let codexPrompts: Array<{ prompt: string; effort: string; timeoutMs: number; cwd: string }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-cross-review-'));
    tokenFile = path.join(tmp, 'oauth-token');
    fs.writeFileSync(tokenFile, 'tok-123\n');
    claudeCalls = 0;
    codexPrompts = [];
  });
  afterEach(() => fs.rmSync(tmp, RM_TEST_DIR));

  const claudeSays =
    (text: string): RouteSpawner =>
    () => {
      claudeCalls++;
      const current = new FakeChild();
      setImmediate(() => {
        current.stdout.write(`${JSON.stringify({ type: 'result', result: text })}\n`);
        current.stdout.end();
        setImmediate(() => current.emit('close'));
      });
      return current;
    };
  const make = (
    codexReply: string | null,
    claudeReply = OK,
    available?: (agent: 'claude' | 'codex') => Promise<boolean>
  ) =>
    createTaskReviewer({
      claudeBin: '/bin/claude',
      tokenFile,
      replyDir: path.join(tmp, 'ai-replies'),
      spawn: claudeSays(claudeReply),
      now: () => Date.parse('2026-11-01T12:00:00Z'),
      codex: async (prompt, options) => {
        codexPrompts.push({ prompt, ...options });
        return codexReply;
      },
      ...(available ? { available } : {}),
    });

  it('picks the other family with cross review, Claude without it', () => {
    expect(pickReviewer('claude', true)).toBe('codex');
    expect(pickReviewer('codex', true)).toBe('claude');
    expect(pickReviewer(undefined, true)).toBe('codex');
    expect(pickReviewer('claude', false)).toBe('claude');
    expect(pickReviewer('codex', false)).toBe('claude');
  });

  it('has Codex review a Claude task with the same prompt and the same verdict format', async () => {
    const review = await make(CONCERNS)({ ...request, agent: 'claude', crossReview: true });
    expect(claudeCalls).toBe(0);
    expect(codexPrompts).toHaveLength(1);
    expect(codexPrompts[0]).toMatchObject({
      effort: CODEX_REVIEW_EFFORT,
      timeoutMs: CODEX_REVIEW_TIMEOUT_MS,
    });
    expect(codexPrompts[0].prompt.startsWith(REVIEW_SYSTEM_PROMPT)).toBe(true);
    expect(codexPrompts[0].prompt).toContain(reviewQuestion(request));
    expect(review).toEqual({
      verdict: 'concerns',
      summary: 'Divide mal',
      issues: [
        {
          file: 'src/split.ts',
          line: 1,
          severity: 'high',
          category: 'bug',
          what: 'n - 1 divide de más',
        },
      ],
      at: '2026-11-01T12:00:00.000Z',
      model: `codex (${CODEX_REVIEW_EFFORT})`,
      agent: 'codex',
      crossReview: true,
      headSha: 'f00d',
    });
    expect(reviewBlocks(review)).toBe(true);
  });

  it('has Claude review a Codex task, and Claude review anything without cross review', async () => {
    const forCodex = await make(OK)({ ...request, agent: 'codex', crossReview: true });
    expect(forCodex).toMatchObject({ agent: 'claude', model: REVIEW_MODEL, crossReview: true });
    expect(forCodex.fallback).toBeUndefined();
    const off = await make(OK)({ ...request, agent: 'claude', crossReview: false });
    expect(off).toMatchObject({ agent: 'claude', model: REVIEW_MODEL });
    expect(off.crossReview).toBeUndefined();
    expect(codexPrompts).toHaveLength(0);
    expect(claudeCalls).toBe(2);
  });

  it('falls back to Claude without blocking when Codex gives no answer, and says why', async () => {
    const review = await make(null, CONCERNS)({ ...request, agent: 'claude', crossReview: true });
    expect(codexPrompts).toHaveLength(1);
    expect(claudeCalls).toBe(1);
    expect(review).toMatchObject({ verdict: 'concerns', agent: 'claude', model: REVIEW_MODEL });
    expect(review.crossReview).toBeUndefined();
    expect(review.fallback).toMatch(/^codex: no answer from codex \(not installed, not logged in/);
  });

  it('falls back when Codex answers twice with something that is not the verdict', async () => {
    const review = await make('Looks fine to me.')({
      ...request,
      agent: 'claude',
      crossReview: true,
    });
    expect(codexPrompts).toHaveLength(2);
    expect(review).toMatchObject({ verdict: 'ok', agent: 'claude' });
    expect(review.fallback).toContain('codex: ');
  });

  it('does not ask a Codex that is not installed', async () => {
    const review = await make(
      OK,
      OK,
      async (agent) => agent !== 'codex'
    )({
      ...request,
      agent: 'claude',
      crossReview: true,
    });
    expect(codexPrompts).toHaveLength(0);
    expect(review).toMatchObject({ agent: 'claude', fallback: 'codex is not installed' });
  });

  it('is unavailable only when the fallback cannot answer either', async () => {
    const review = await make(null, 'nope')({ ...request, agent: 'claude', crossReview: true });
    expect(review.verdict).toBe('unavailable');
    expect(review.fallback).toMatch(/^codex: /);
  });
});

describe('review numbers (2026-11-01)', () => {
  const issue = (file: string, severity: 'high' | 'medium' | 'low' = 'high') => ({
    file,
    severity,
    category: 'bug' as const,
    what: `fallo en ${file}`,
  });

  it('counts new findings and what became of the previous ones', () => {
    const previous = {
      agent: 'codex' as const,
      issues: [issue('a.ts'), issue('b.ts'), issue('c.ts'), issue('d.ts', 'low')],
    };
    // a.ts raised again; b.ts touched since and gone (fixed); c.ts untouched and gone (rejected).
    const round = reviewRound({ issues: [issue('a.ts'), issue('e.ts')] }, previous, [
      'a.ts',
      'b.ts',
    ]);
    expect(round).toEqual({
      findings: 1,
      previous: { agent: 'codex', fixed: 1, rejected: 1, reraised: 1 },
    });
    expect(reviewRound({ issues: [issue('a.ts'), issue('x.ts', 'low')] }, undefined, null)).toEqual(
      {
        findings: 1,
      }
    );
    // Files since unknown: a finding no longer raised counts as fixed.
    expect(reviewRound({ issues: [] }, { issues: [issue('c.ts')] }, null)).toEqual({
      findings: 0,
      previous: { agent: 'claude', fixed: 1, rejected: 0, reraised: 0 },
    });
  });

  it('names the files of a shown diff', () => {
    expect(
      diffFiles({ diff: fileDiff('a.ts', 1) + fileDiff('b.ts', 2), omitted: ['c.ts'] })
    ).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('sums rounds per reviewer once each, crediting fixes to the reviewer that raised them', () => {
    const base = { verdict: 'concerns' as const, summary: '', issues: [], model: 'm' };
    const first: TaskReview = { ...base, at: 't1', agent: 'codex', round: { findings: 2 } };
    const second: TaskReview = {
      ...base,
      verdict: 'ok',
      at: 't2',
      agent: 'claude',
      fallback: 'codex: no answer',
      round: { findings: 0, previous: { agent: 'codex', fixed: 1, rejected: 1, reraised: 0 } },
    };
    let stats = countReview(undefined, first);
    expect(countReview(stats, first)).toBe(stats);
    stats = countReview(stats, second);
    expect(stats).toEqual({
      rounds: 2,
      lastAt: 't2',
      byAgent: {
        codex: { rounds: 1, findings: 2, fixed: 1, rejected: 1, reraised: 0, fallbacks: 0 },
        claude: { rounds: 1, findings: 0, fixed: 0, rejected: 0, reraised: 0, fallbacks: 1 },
      },
    });
    // A kept verdict (no round) and an unavailable one add nothing.
    expect(countReview(stats, { ...base, at: 't3' })).toBe(stats);
    expect(
      countReview(stats, { ...base, verdict: 'unavailable', at: 't4', round: { findings: 1 } })
    ).toBe(stats);
  });
});
