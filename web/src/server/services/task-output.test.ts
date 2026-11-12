import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { runGuardHook } from './task-guard-hook.js';
import { createTaskGuard } from './task-guard-setup.js';
import {
  cleanLines,
  kindOfCommand,
  LOGS_KEPT,
  logFileName,
  parseBun,
  parseCargo,
  parseGo,
  parseJest,
  parsePytest,
  parseTsc,
  parseVitest,
  parseXcodebuild,
  pruneLogs,
  rewriteForSummary,
  SUMMARY_LIMITS,
  summarizedCommand,
  summarizeKind,
  summarizeMain,
  summarizeOutput,
} from './task-output.js';

// Real outputs (bun 1.4, go, cargo, tsc, vitest 4, xcodebuild with XCTest), paths made neutral;
// jest's and pytest's written in their formats.
const FIXTURES = path.join(__dirname, '__fixtures__', 'task-output');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8');
const lines = (name: string) => cleanLines(fixture(name));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-output-'));
});

afterEach(() => {
  fs.rmSync(dir, RM_TEST_DIR);
});

describe('the parsers', () => {
  it('vitest: the summary and each failure with its diff and code frame', () => {
    const parsed = parseVitest(lines('vitest'));
    expect(parsed?.summary).toEqual([
      'Test Files  1 failed | 1 passed (2)',
      'Tests  3 failed | 24 passed (27)',
      expect.stringMatching(/^Duration {2}1\.22s/),
    ]);
    expect(parsed?.failures).toHaveLength(3);
    const [first, second, third] = parsed?.failures ?? [];
    expect(first.lines[0]).toContain(
      'FAIL  src/server/zz-fixture-fail.test.ts > fixture > compares numbers'
    );
    expect(first.lines).toContain('AssertionError: expected 2 to be 3 // Object.is equality');
    expect(first.lines.join('\n')).toContain('- 3\n+ 2');
    expect(
      first.lines.some((line) => line.includes('❯ src/server/zz-fixture-fail.test.ts:4:46'))
    ).toBe(true);
    expect(first.lines.some((line) => line.includes('⎯'))).toBe(false);
    expect(second.lines.join('\n')).toContain('-     3,\n+     2,');
    expect(third.lines).toContain('TypeError: kaput');
    expect(first.line).toBe(13);
    expect(parseVitest(lines('jest'))).toBeNull();
  });

  it('jest: the summary and each ● block', () => {
    const parsed = parseJest(lines('jest'));
    expect(parsed?.summary).toEqual([
      'Test Suites: 1 failed, 1 passed, 2 total',
      'Tests:       2 failed, 5 passed, 7 total',
      'Snapshots:   0 total',
      'Time:        0.812 s, estimated 1 s',
    ]);
    expect(parsed?.failures.map((failure) => failure.lines[0].trim())).toEqual([
      '● math › adds',
      '● math › divides',
    ]);
    expect(parsed?.failures[0].lines.join('\n')).toContain('Expected: 3');
    expect(parsed?.failures[0].lines.join('\n')).toContain(
      'at Object.toBe (src/math.test.js:5:19)'
    );
    expect(parsed?.failures[1].lines.join('\n')).not.toContain('Test Suites');
    expect(parseJest(lines('vitest'))).toBeNull();
  });

  it('bun: the error printed before each (fail) line, and the counts', () => {
    const parsed = parseBun(lines('bun'));
    expect(parsed?.summary).toEqual([
      '1 pass',
      '2 fail',
      '3 expect() calls',
      'Ran 3 tests across 1 file. [4.00ms]',
    ]);
    expect(parsed?.failures).toHaveLength(2);
    const [first, second] = parsed?.failures ?? [];
    expect(first.lines[0]).toBe('(fail) math > subtracts [0.33ms]');
    expect(first.lines.join('\n')).toContain('Expected: 3\nReceived: 2');
    expect(first.lines.join('\n')).toContain('a.test.ts:4:43');
    expect(second.lines[0]).toBe('(fail) math > objects [0.14ms]');
    expect(second.lines.join('\n')).toContain('-     3,\n+     2,');
    // The second error starts after the first (fail), not at the file's header.
    expect(second.lines.join('\n')).not.toContain('toBe(expected)');
    expect(parseBun(lines('go'))).toBeNull();
  });

  it('pytest: the FAILURES blocks, the short summary and the final line', () => {
    const parsed = parsePytest(lines('pytest'));
    expect(parsed?.summary).toEqual([
      'FAILED test_math.py::test_add - assert (1 + 1) == 3',
      "FAILED test_math.py::test_dict - AssertionError: assert {'a': 1} == {'a': 2}",
      '========================= 2 failed, 1 passed in 0.03s ==========================',
    ]);
    expect(parsed?.failures).toHaveLength(2);
    expect(parsed?.failures[0].lines[0]).toMatch(/^_+ test_add _+$/);
    expect(parsed?.failures[0].lines.join('\n')).toContain('E       assert (1 + 1) == 3');
    expect(parsed?.failures[1].lines.join('\n')).toContain('Differing items');
    expect(parsed?.failures[1].lines.join('\n')).not.toContain('short test summary');
    expect(parsePytest(lines('cargo'))).toBeNull();
  });

  it('go test: top-level --- FAIL blocks keep their subtests', () => {
    const parsed = parseGo(lines('go'));
    expect(parsed?.summary).toEqual(['FAIL', 'FAIL\tfx\t0.212s', 'FAIL']);
    expect(parsed?.failures.map((failure) => failure.lines)).toEqual([
      [
        '--- FAIL: TestSub (0.00s)',
        '    a_test.go:4: got 2, want 3',
        '    a_test.go:4: more detail',
      ],
      [
        '--- FAIL: TestThird (0.00s)',
        '    --- FAIL: TestThird/inner (0.00s)',
        '        a_test.go:5: inner broke',
      ],
    ]);
    expect(parseGo(lines('pytest'))).toBeNull();
  });

  it('cargo test: each test stdout block, compile errors, the test result', () => {
    const parsed = parseCargo(lines('cargo'));
    expect(parsed?.summary).toEqual([
      'test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
      'error: test failed, to rerun pass `--lib`',
    ]);
    expect(parsed?.failures.map((failure) => failure.lines[0])).toEqual([
      '---- tests::bad stdout ----',
      '---- tests::panics stdout ----',
    ]);
    expect(parsed?.failures[0].lines.join('\n')).toContain('  left: 4\n right: 5');
    expect(parsed?.failures[1].lines.join('\n')).toContain('boom');
    const compile = parseCargo(
      cleanLines(
        '   Compiling fx v0.1.0 (/x)\nerror[E0425]: cannot find value `y` in this scope\n --> src/lib.rs:1:30\n  |\n1 | pub fn f() -> i32 { y }\n  |                     ^ not found\n\nerror: could not compile `fx` (lib test) due to 1 previous error\n'
      )
    );
    expect(compile?.failures).toHaveLength(1);
    expect(compile?.failures[0].lines[0]).toBe('error[E0425]: cannot find value `y` in this scope');
    expect(compile?.failures[0].lines).toContain('  |                     ^ not found');
    expect(compile?.summary).toEqual([
      'error: could not compile `fx` (lib test) due to 1 previous error',
    ]);
  });

  it('tsc: plain and --pretty errors (colours removed), with their code frames', () => {
    const plain = parseTsc(lines('tsc'));
    expect(plain?.summary).toEqual(['2 TypeScript errors']);
    expect(plain?.failures.map((failure) => failure.lines)).toEqual([
      ["a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'."],
      ["a.ts(2,34): error TS2339: Property 'foo' does not exist on type 'string'."],
    ]);
    const pretty = parseTsc(lines('tsc-pretty'));
    expect(pretty?.summary).toEqual(['Found 2 errors in the same file, starting at: a.ts:1']);
    expect(pretty?.failures).toHaveLength(2);
    expect(pretty?.failures[0].lines).toEqual([
      "a.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.",
      '',
      "1 const x: number = 'a';",
      '        ~',
    ]);
    expect(parseTsc(lines('jest'))).toBeNull();
  });

  it('xcodebuild: an XCTest failure with its verdict, the last Executed line, Failing tests', () => {
    const parsed = parseXcodebuild(lines('xcodebuild-test'));
    expect(parsed?.summary).toEqual([
      '** TEST FAILED **',
      'Executed 2 tests, with 1 failure (0 unexpected) in 2.052 (2.056) seconds',
      'Failing tests:',
      '  FxTests.testBad()',
    ]);
    expect(parsed?.failures).toHaveLength(1);
    expect(parsed?.failures[0].lines).toEqual([
      '/tmp/fx/sw/Tests/FxTests/FxTests.swift:5: error: -[FxTests.FxTests testBad] : XCTAssertEqual failed: ("4") is not equal to ("5") - math is off',
      "Test Case '-[FxTests.FxTests testBad]' failed (2.051 seconds).",
    ]);
  });

  it('xcodebuild: compile errors once each with their code frame, the failed commands', () => {
    const parsed = parseXcodebuild(lines('xcodebuild-build'));
    expect(parsed?.summary).toContain('** TEST FAILED **');
    expect(parsed?.summary).toContain('The following build commands failed:');
    expect(parsed?.summary).toContain('  Testing cancelled because the build failed.');
    expect(parsed?.failures).toHaveLength(2);
    expect(parsed?.failures[0].lines[0]).toMatch(/FxTests\.swift:4:34: error: use of 'add'/);
    expect(parsed?.failures[0].lines).toContain(
      '4 |   func testOk() { XCTAssertEqual(add(1, 1), 2) }'
    );
    expect(parsed?.failures[0].lines.length).toBeLessThan(10);
    expect(parseXcodebuild(lines('cargo'))).toBeNull();
  });

  it('cleanLines drops colours and keeps the last redraw of a progress line', () => {
    expect(cleanLines('\x1b[32mok\x1b[0m\n 10%\r 50%\r100%\ndone\r\n')).toEqual([
      'ok',
      '100%',
      'done',
      '',
    ]);
  });
});

/** An output long enough to be summarised: `n` filler lines around `body`. */
const padded = (body: string, n = 200, filler = (i: number) => `  progress line ${i}`) =>
  `${Array.from({ length: n }, (_, i) => filler(i)).join('\n')}\n${body}`;

describe('summarizeOutput', () => {
  const base = { kind: 'auto' as const, label: 'pnpm run test', log: '/logs/x.log' };

  it('a short output is printed whole, passed or failed, with its exit code', () => {
    const passed = summarizeOutput({ ...base, output: 'all good\n3 passed\n', exitCode: 0 });
    expect(passed).toBe(
      'all good\n3 passed\n[untether] `pnpm run test`: passed, exit code 0 · 2 lines (whole output above; also in /logs/x.log)\n'
    );
    const failed = summarizeOutput({ ...base, output: fixture('go'), exitCode: 1 });
    expect(failed).toContain('--- FAIL: TestThird/inner');
    expect(failed).toContain('FAILED, exit code 1 · 9 lines (whole output above');
    expect(summarizeOutput({ ...base, output: '', exitCode: 0 })).toBe(
      '[untether] `pnpm run test`: passed, exit code 0 · 0 lines (whole output above; also in /logs/x.log)\n'
    );
  });

  it('passed with a long output: only the header and the summary, nothing cut short', () => {
    const output = padded(
      ' Test Files  31 passed (31)\n      Tests  402 passed (402)\n   Duration  9.1s\n',
      300,
      (i) => ` ✓ src/file-${i}.test.ts (3 tests) 12ms`
    );
    const text = summarizeOutput({ ...base, output, exitCode: 0 });
    expect(text.split('\n').filter(Boolean)).toEqual([
      '[untether] `pnpm run test`: passed, exit code 0 · 303 lines · full output: /logs/x.log',
      'Summary:',
      '  Test Files  31 passed (31)',
      '  Tests  402 passed (402)',
      '  Duration  9.1s',
    ]);
  });

  it('passed with no summary it knows: its last lines', () => {
    const text = summarizeOutput({ ...base, output: padded('Checks done.'), exitCode: 0 });
    expect(text).toContain('Last lines:\n');
    expect(text.trim().endsWith('  Checks done.')).toBe(true);
    expect(text.split('\n').length).toBeLessThan(12);
  });

  it('failed: the summary, the first failures in full and where the rest are', () => {
    const many = Array.from(
      { length: 6 },
      (_, i) =>
        ` FAIL  src/a.test.ts > case ${i}\nAssertionError: expected ${i} to be ${i + 1}\n ❯ src/a.test.ts:${i + 1}:1\n⎯⎯⎯⎯⎯⎯[${i + 1}/6]⎯`
    ).join('\n');
    const output = padded(
      `⎯⎯⎯⎯⎯⎯⎯ Failed Tests 6 ⎯⎯⎯⎯⎯⎯⎯\n${many}\n Test Files  1 failed (1)\n      Tests  6 failed | 2 passed (8)\n`,
      100,
      (i) => (i === 0 ? ' RUN  v4.1.12 /repo' : `   × case ${i}`)
    );
    const text = summarizeOutput({ ...base, kind: 'vitest', output, exitCode: 1 });
    expect(text).toContain('`pnpm run test`: FAILED, exit code 1');
    expect(text).toContain('  Tests  6 failed | 2 passed (8)');
    expect(text).toContain(
      '── Failure 1 of 6 (log line 102) ──\n FAIL  src/a.test.ts > case 0\nAssertionError: expected 0 to be 1'
    );
    expect(text).toContain('── Failure 3 of 6');
    expect(text).not.toContain('── Failure 4 of 6');
    expect(text).toMatch(/… 3 more failures \(log lines \d+, \d+, \d+\)/);
    expect(text).toContain('UT_FULL_OUTPUT=1');
    expect(text).toContain("sed -n '<from>,<to>p' /logs/x.log");
  });

  it('bounds the failures: one at most oneFailureLines, all at most failureLines', () => {
    const long = (n: number) =>
      ` FAIL  src/a.test.ts > big ${n}\n${Array.from({ length: 120 }, (_, i) => `  diff line ${i}`).join('\n')}\n⎯⎯⎯⎯⎯⎯`;
    const output = ` RUN  v4\n⎯⎯ Failed Tests 3 ⎯⎯\n${long(1)}\n${long(2)}\n${long(3)}\n Test Files  1 failed (1)\n`;
    const text = summarizeOutput({ ...base, output, exitCode: 1 });
    const failureLines = text.split('\n').filter((line) => /^( FAIL| {2}diff line)/.test(line));
    expect(failureLines.length).toBeLessThanOrEqual(SUMMARY_LIMITS.failureLines);
    expect(text).toContain(
      `… ${121 - SUMMARY_LIMITS.oneFailureLines} more lines of this failure in the log`
    );
    expect(text.split('\n').length).toBeLessThan(SUMMARY_LIMITS.failureLines + 30);
  });

  it('a failing command no parser knows: its error lines and its tail, stderr included', () => {
    const output = padded(
      'src/x.ts:3:1 lint/style: something\n\nERR_PNPM_RECURSIVE_RUN_FIRST_FAIL web@1.0.0 check: `./scripts/check-all.sh`\nExit status 1',
      200,
      (i) => (i === 7 ? 'fatal: Error: cannot find module ./gone' : `building chunk ${i}`)
    );
    const text = summarizeOutput({ ...base, output, exitCode: 1 });
    expect(text).toContain('Error lines:\n  8: fatal: Error: cannot find module ./gone');
    expect(text).toContain(`── Last ${SUMMARY_LIMITS.tailLines} lines ──`);
    expect(text).toContain('ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL');
    expect(text.trim().split('\n').at(-2)).toBe('Exit status 1');
  });

  it('a command that failed without output says so (nothing hidden)', () => {
    expect(summarizeOutput({ ...base, output: '', exitCode: 127 })).toContain(
      'FAILED, exit code 127 · 0 lines'
    );
  });

  it('cuts very long lines', () => {
    const text = summarizeOutput({ ...base, output: `${'x'.repeat(5000)}\n`, exitCode: 0 });
    expect(text).toContain(`… (${5000 - SUMMARY_LIMITS.lineChars} more chars)`);
  });
});

describe('summarizeMain', () => {
  it('prints the summary and returns 0 whatever the exit code; UT_FULL_OUTPUT=1 prints it all', () => {
    const log = path.join(dir, 'x.log');
    fs.writeFileSync(log, padded(' Test Files  1 passed (1)\n'));
    let out = '';
    const write = (text: string) => {
      out += text;
    };
    expect(summarizeMain([log, '0', 'vitest', 'vitest run'], write, {})).toBe(0);
    expect(out).toContain('Summary:\n  Test Files  1 passed (1)');
    expect(out).not.toContain('progress line 5');
    out = '';
    expect(summarizeMain([log, '3', 'auto', 'x'], write, { UT_FULL_OUTPUT: '1' })).toBe(0);
    expect(out).toContain('progress line 5\n');
    expect(out).toContain('[untether] exit code 3');
    out = '';
    expect(summarizeMain([path.join(dir, 'gone.log'), '1', 'auto', 'x'], write, {})).toBe(1);
    expect(out).toContain('could not read the output log');
  });
});

describe('recognising test and check commands', () => {
  it.each([
    ['vitest run', 'vitest'],
    ['pnpm exec vitest run src/a.test.ts', 'vitest'],
    ['npx jest --ci', 'jest'],
    ['bun test', 'bun'],
    ['pytest -x tests/', 'pytest'],
    ['python3 -m pytest', 'pytest'],
    ['go test ./...', 'go'],
    ['cargo test --lib', 'cargo'],
    ['tsc --noEmit -p .', 'tsc'],
    ['xcodebuild test -project mac/Untether.xcodeproj -scheme Untether', 'xcodebuild'],
    ['xcodebuild -project X.xcodeproj -scheme X build', 'xcodebuild'],
    ['pnpm run test', 'auto'],
    ['pnpm test', 'auto'],
    ['npm run check', 'auto'],
    ['pnpm run lint', 'auto'],
    ['pnpm run typecheck', 'auto'],
    ['pnpm --filter web run test:e2e', 'auto'],
    ['yarn test', 'auto'],
    ['bun run check', 'auto'],
    ['FOO=1 timeout 600 pnpm run test', 'auto'],
  ])('%s → %s', (command, kind) => {
    expect(summarizeKind(command)).toBe(kind);
  });

  it.each([
    'ls -la',
    'git status',
    'pnpm install',
    'pnpm run dev',
    'pnpm run build',
    'node script.js',
    'xcodebuild -list',
    'go build ./...',
    'cat test.log',
    'echo pnpm run test',
  ])('leaves %s alone', (command) => {
    expect(summarizeKind(command)).toBeNull();
  });

  it('several commands: the one recognised, or auto for a mix', () => {
    expect(summarizeKind('cd web && pnpm exec vitest run x')).toBe('vitest');
    expect(summarizeKind('cd web && pnpm run check && pnpm run test run')).toBe('auto');
    expect(summarizeKind('cd web\npnpm exec tsc --noEmit')).toBe('tsc');
  });

  it('leaves alone a pipe, a stdout redirection, a background job, a watch and the opt-out', () => {
    expect(summarizeKind('pnpm run test 2>&1 | tail -50')).toBeNull();
    expect(summarizeKind('pnpm run test > /tmp/out.txt')).toBeNull();
    expect(summarizeKind('pnpm run test &> out')).toBeNull();
    expect(summarizeKind('pnpm run test &')).toBeNull();
    expect(summarizeKind('vitest --watch')).toBeNull();
    expect(summarizeKind('tsc -w')).toBeNull();
    expect(summarizeKind('UT_FULL_OUTPUT=1 pnpm run test')).toBeNull();
    expect(summarizeKind('export UT_FULL_OUTPUT=1; cargo test')).toBeNull();
    // 2>&1 alone keeps everything in the same stream: still summarised.
    expect(summarizeKind('pnpm run test 2>&1')).toBe('auto');
  });

  it("the project's own check commands and patterns", () => {
    const checks = [
      'bash scripts/check.sh && (cd hub && bun build src/server.ts --target=bun --outdir /tmp/x)',
    ];
    expect(
      summarizeKind(
        'bash scripts/check.sh &&  (cd hub && bun build src/server.ts --target=bun --outdir /tmp/x)',
        { checks }
      )
    ).toBe('auto');
    expect(summarizeKind('bash scripts/check.sh', { checks })).toBeNull();
    expect(summarizeKind('bash scripts/check.sh', { patterns: ['scripts/check\\.sh'] })).toBe(
      'auto'
    );
    expect(summarizeKind('ls', { patterns: ['('] })).toBeNull();
  });

  it('kindOfCommand sees past wrappers', () => {
    expect(kindOfCommand(['env', 'CI=1', 'npx', '--yes', 'vitest', 'run'])).toBe('vitest');
    expect(kindOfCommand(['pnpm', 'exec', '--', 'tsc'])).toBe('tsc');
    expect(kindOfCommand(['make', 'test'])).toBe('auto');
    expect(kindOfCommand(['make', 'all'])).toBeNull();
  });
});

describe('the rewrite', () => {
  const hookSource = path.join(__dirname, 'task-guard-hook.ts');
  const loader = pathToFileURL(
    path.resolve(__dirname, '../../../node_modules/tsx/dist/loader.mjs')
  ).href;
  const runner = [process.execPath, '--import', loader, hookSource];

  /** Runs `command` rewritten in `shell`; its output, exit code and the folder it ended in. */
  function run(shell: string, command: string, kind: 'auto' | 'vitest' = 'auto') {
    const log = path.join(dir, 'logs', 'run.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const rewritten = `${summarizedCommand(command, kind, log, runner)}\n__s=$?; echo "__cwd=$PWD"; exit $__s`;
    const result = spawnSync(shell, ['-c', rewritten], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, UT_FULL_OUTPUT: '' },
    });
    return { ...result, log: fs.readFileSync(log, 'utf8') };
  }

  const shells = ['/bin/bash', '/bin/zsh'].filter((shell) => fs.existsSync(shell));

  it.each(shells)(
    '%s: keeps the exit code, the cd, and puts stdout and stderr in the log',
    (shell) => {
      fs.mkdirSync(path.join(dir, 'sub'));
      const noisy = `cd sub && for i in $(seq 1 300); do echo "line $i"; done; echo "Error: broke here" >&2; exit_with() { return $1; }; exit_with 3`;
      const result = run(shell, noisy);
      expect(result.status).toBe(3);
      // The label is the command, cut at 120 characters.
      expect(result.stdout).toMatch(
        /^\[untether\] `cd sub && for i in .{60,}`: FAILED, exit code 3 · 301 lines · full output: /
      );
      expect(result.stdout).toContain('Error: broke here');
      expect(result.stdout).not.toContain('line 5\n');
      expect(result.stdout).toContain(`__cwd=${fs.realpathSync(path.join(dir, 'sub'))}`);
      expect(result.log).toContain('line 5\n');
      expect(result.log).toContain('Error: broke here');
      expect(result.stdout.split('\n').length).toBeLessThan(SUMMARY_LIMITS.tailLines + 15);
    }
  );

  it.each(shells)('%s: a passing command ends 0 with its short output whole', (shell) => {
    const result = run(shell, 'echo " Test Files  2 passed (2)"');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(' Test Files  2 passed (2)\n[untether]');
    expect(result.stdout).toContain('passed, exit code 0 · 1 lines');
  });

  it('a summary that cannot run still shows the tail and keeps the exit code', () => {
    const log = path.join(dir, 'broken.log');
    const rewritten = summarizedCommand('echo visible; (exit 4)', 'auto', log, [
      '/nonexistent/runner',
    ]);
    const result = spawnSync('/bin/bash', ['-c', rewritten], { encoding: 'utf8' });
    expect(result.status).toBe(4);
    expect(result.stdout).toContain(`[untether] full output (4): ${log}`);
    expect(result.stdout).toContain('visible');
  });

  it('rewriteForSummary: names the log in the folder, prunes old logs, leaves others alone', () => {
    const logDir = path.join(dir, 'output');
    fs.mkdirSync(logDir);
    for (let i = 0; i < LOGS_KEPT + 5; i++)
      fs.writeFileSync(path.join(logDir, `2026010${String(i).padStart(3, '0')}.log`), '');
    const rewritten = rewriteForSummary(
      'pnpm run test',
      { logDir, runner: ['/r'] },
      new Date('2026-11-03T01:02:03Z')
    );
    expect(rewritten).toContain(`__ut_log=${logDir}/20261103-010203-`);
    expect(rewritten).toContain('/r --summarize "$__ut_log" "$__ut_rc" auto \'pnpm run test\'');
    expect(fs.readdirSync(logDir)).toHaveLength(LOGS_KEPT - 1);
    expect(rewriteForSummary('ls', { logDir, runner: ['/r'] })).toBeNull();
  });

  it('logFileName and pruneLogs', () => {
    expect(logFileName('cd web && pnpm run test', new Date('2026-11-03T01:02:03Z'), 7)).toBe(
      '20261103-010203-7-cd-web-pnpm-run-test.log'
    );
    pruneLogs(path.join(dir, 'missing'));
  });
});

describe('the guard hook and the task setup', () => {
  function policy(extra: object): string {
    const file = path.join(dir, 'policy.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ taskId: 't', root: '/wt/x', home: '/Users/n', ...extra })
    );
    return file;
  }

  const call = (file: string, command: string) => {
    let out = '';
    const code = runGuardHook(
      file,
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command, description: 'd' },
        cwd: '/wt/x',
      }),
      () => {},
      (text) => {
        out += text;
      }
    );
    return { code, out };
  };

  it('rewrites a recognised command; any other runs as written, shell-group record or not', () => {
    const logDir = path.join(dir, 'output');
    const file = policy({ recordShellGroups: true, summarize: { logDir, runner: ['/r'] } });
    const tested = call(file, 'pnpm run test');
    expect(tested.code).toBe(0);
    const input = JSON.parse(tested.out).hookSpecificOutput.updatedInput;
    expect(input.description).toBe('d');
    // The shell-group record never goes in front of it (2026-11-11: task-processes.ts).
    expect(input.command).toMatch(/^__ut_log=/);
    expect(input.command).toContain('{ pnpm run test\n} >"$__ut_log" 2>&1');
    expect(input.command.trim().endsWith('(exit $__ut_rc)')).toBe(true);
    expect(call(file, 'git status').out).toBe('');
  });

  it('only a recognised command changes', () => {
    const file = policy({ summarize: { logDir: path.join(dir, 'o'), runner: ['/r'] } });
    expect(call(file, 'git status').out).toBe('');
    expect(
      JSON.parse(call(file, 'cargo test').out).hookSpecificOutput.updatedInput.command
    ).toMatch(/^__ut_log=/);
    expect(call(file, 'UT_FULL_OUTPUT=1 cargo test').out).toBe('');
  });

  it('a blocked command is still blocked, never rewritten', () => {
    const file = policy({ summarize: { logDir: path.join(dir, 'o'), runner: ['/r'] } });
    const result = call(file, 'git push && pnpm run test');
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
  });

  it("createTaskGuard: only a Claude task of a project with summarizeOutput gets it, with the project's checks", () => {
    const make = (settings: object, command = ['claude']) => {
      const guard = createTaskGuard({
        untetherDir: dir,
        hook: ['/node', '/hook.ts'],
        settings: () => settings,
      });
      guard.prepare(
        {
          id: 'abc',
          command,
          agent: command[0],
          repoPath: '/repo',
        } as never,
        '/wt/x'
      );
      return JSON.parse(
        fs.readFileSync(path.join(dir, 'agent-hooks', 'tasks', 'abc', 'policy.json'), 'utf8')
      );
    };
    expect(make({}).summarize).toBeUndefined();
    expect(make({ summarizeOutput: false }).summarize).toBeUndefined();
    expect(
      make({
        summarizeOutput: true,
        checkCommand: 'bash scripts/check.sh',
        fastCheckCommand: 'cd web && pnpm run check',
        summarizeCommands: ['make verify'],
      }).summarize
    ).toEqual({
      logDir: path.join(dir, 'agent-hooks', 'tasks', 'abc', 'output'),
      runner: ['/node', '/hook.ts'],
      checks: ['bash scripts/check.sh', 'cd web && pnpm run check'],
      patterns: ['make verify'],
    });
    // Codex does not read a hook's updatedInput.
    expect(make({ summarizeOutput: true }, ['codex']).summarize).toBeUndefined();
  });
});
