/**
 * Heavy check runs of a task's agent take a check slot (2026-11-10: bakery's tasks ran
 * scripts/check.sh at once, load 250 on 12 cores): what counts as heavy, and the rewrite the
 * hook hands Claude, run in a real shell against a stand-in for the Untether CLI.
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import {
  CHECK_SLOT_ENV,
  heavyCheck,
  onlyCheck,
  SLOT_REUSED_EXIT,
  slotCommand,
  weightOfCommand,
} from './check-slot-wrap.js';
import type { GuardPolicy } from './task-guard.js';
import { rewrittenBashInput, runGuardHook } from './task-guard-hook.js';

describe('heavyCheck', () => {
  const project = {
    checks: ['bash scripts/verificar.sh'],
    related: 'pnpm exec vitest related {files} --run',
  };

  it.each([
    'pnpm run test',
    'pnpm test',
    'npm test',
    'cd web && pnpm run test',
    'pnpm --filter web run test',
    'pnpm run check',
    'vitest run',
    'npx vitest run',
    'pnpm exec vitest run --reporter=dot',
    'pnpm vitest run',
    'scripts/check.sh',
    './scripts/check.sh --all',
    'bash scripts/check.sh',
    'cd /repo && bash scripts/check.sh 2>&1 | tail -40',
    'pnpm test 2>&1 | tail -20',
    'pnpm run test > /tmp/out.log 2>&1',
    'timeout 600 pnpm test',
    'CI=1 pnpm test',
    'pytest',
    'go test ./...',
    'cargo test',
    'make test',
    'xcodebuild -scheme App test',
    // More than a few files is the whole suite's weight.
    'vitest run a.test.ts b.test.ts c.test.ts d.test.ts',
    // The word check-slot somewhere is not a run through one.
    'echo check-slot; pnpm test',
    'pnpm test # check-slot',
    // The project's own commands.
    'bash scripts/verificar.sh',
    'cd repo && bash   scripts/verificar.sh --fast',
    'pnpm exec vitest related a.ts b.ts c.ts d.ts e.ts --run',
  ])('heavy: %s', (command) => {
    expect(heavyCheck(command, project)).toBe(true);
  });

  it.each([
    // Focused on a few files: it does not wait.
    'pnpm exec vitest run src/server/a.test.ts',
    'vitest run src/a.test.ts src/b.test.ts',
    'pnpm test -- src/a.test.ts',
    'pnpm run test src/a.test.ts',
    'pnpm vitest run src/a.test.ts -t "one case"',
    'pytest tests/test_a.py',
    'go test ./pkg/one',
    'cargo test parser',
    'pnpm exec vitest related src/a.ts src/b.ts --run',
    // Not a test run at all.
    'pnpm run lint',
    'pnpm run typecheck',
    'tsc --noEmit',
    'git status',
    'ls scripts/check.sh',
    'cat scripts/check.sh',
    // Never ends, or ends before its run does.
    'vitest --watch',
    'pnpm run dev',
    'pnpm test > out.log 2>&1 &',
    // Goes through a slot already.
    'ut check-slot run -- pnpm test',
    '/app/untether check-slot run -- bash scripts/check.sh',
    'ut check-slot run -- bash scripts/verificar.sh',
    "cd web && ut check-slot run -- 'pnpm test'",
    '',
  ])('not heavy: %s', (command) => {
    expect(heavyCheck(command, project)).toBe(false);
  });

  it('a focused run is not heavy just because the checkCommand is its prefix', () => {
    expect(heavyCheck('pnpm test src/a.test.ts', { checks: ['pnpm test'] })).toBe(false);
    expect(heavyCheck('pnpm test', { checks: ['pnpm test'] })).toBe(true);
  });

  it('weighs one simple command', () => {
    expect(weightOfCommand(['pnpm', 'run', 'test'])).toBe('heavy');
    expect(weightOfCommand(['vitest', 'run', 'a.test.ts'])).toBe('focused');
    expect(weightOfCommand(['echo', 'test'])).toBeNull();
  });
});

describe('onlyCheck: a kept pass may stand for the run', () => {
  it.each([
    'pnpm run test',
    'cd web && pnpm run test',
    '(cd web && pnpm run check) && (cd web && pnpm run test)',
    'pnpm test 2>&1',
    'pnpm test >/dev/null 2>&1',
    'CI=1 pnpm exec vitest run',
    'scripts/check.sh',
    '  pnpm run test\n',
  ])('yes: %s', (command) => {
    expect(onlyCheck(command)).toBe(true);
  });

  it.each([
    // Its exit code would be the filter's: a failed run would be kept as a pass.
    'pnpm run test | tail -20',
    'pnpm run test 2>&1 | grep FAIL',
    // A failure could end in 0.
    'pnpm run test; echo done',
    'pnpm run test || true',
    'pnpm run lint\npnpm run test',
    // Skipping it would lose what else it does.
    'pnpm run test && git commit -m "tests pass"',
    'pnpm run build && pnpm run test',
    'pnpm run test > out.log 2>&1',
    'pnpm run test $(cat files.txt)',
    'pnpm run test &',
    'git status',
    '',
  ])('no: %s', (command) => {
    expect(onlyCheck(command)).toBe(false);
  });

  it("the project's own check, written exactly, is one whatever it runs", () => {
    const settings = { checks: ['make lint && ./tools/all.sh'] };
    expect(onlyCheck('make lint && ./tools/all.sh', settings)).toBe(true);
    expect(onlyCheck('make lint  &&  ./tools/all.sh', settings)).toBe(true);
    expect(onlyCheck('make lint && ./tools/all.sh && git push', settings)).toBe(false);
    expect(onlyCheck('make lint && ./tools/all.sh')).toBe(false);
  });
});

describe('the rewrite, in a real shell', () => {
  let dir: string;
  let cli: string;
  let calls: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-slot-wrap-'));
    calls = path.join(dir, 'calls.log');
    cli = path.join(dir, 'fake ut');
    // A stand-in for the CLI: `acquire` prints a ticket (or nothing with NO_SLOT), each call
    // is recorded with the pid it was given.
    fs.writeFileSync(
      cli,
      `#!/bin/sh\necho "$@" >> '${calls}'\nif [ "$2" = acquire ]; then echo "waiting for a check slot: 1 ahead" >&2; [ -n "$NO_SLOT" ] || echo T1; fi\n`,
      { mode: 0o755 }
    );
  });

  afterEach(() => fs.rmSync(dir, RM_TEST_DIR));

  const run = (script: string, env: NodeJS.ProcessEnv = {}) =>
    spawnSync('/bin/zsh', ['-c', script], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, ...env, [CHECK_SLOT_ENV]: '' },
    });

  it('takes the slot, runs the command as written with the ticket in its environment, gives it back and keeps the exit code', () => {
    const script = slotCommand(
      `cd '${dir}' && echo "ran with $${CHECK_SLOT_ENV}" && (exit 3)`,
      'pnpm test',
      [cli]
    );
    const result = run(`${script}\necho "after: $? in $PWD, slot var: [$${CHECK_SLOT_ENV}]"`);
    expect(result.stdout).toContain('ran with T1');
    // Its own exit code, the `cd` still holds, and the variable does not outlive the run.
    expect(result.stdout).toMatch(/after: 3 in .*ut-slot-wrap-.*, slot var: \[\]/);
    // The wait is told on stderr, outside what the command prints.
    expect(result.stderr).toContain('waiting for a check slot: 1 ahead');
    const log = fs.readFileSync(calls, 'utf8').trim().split('\n');
    expect(log[0]).toMatch(/^check-slot acquire --pid \d+ --label pnpm test$/);
    expect(log[1]).toBe('check-slot release T1');
  });

  it('without a slot (no server) the command still runs, and nothing is released', () => {
    const script = slotCommand('echo ran; false', 'pnpm test', [cli]);
    const result = run(`${script}\necho "after: $?"`, { NO_SLOT: '1' });
    expect(result.stdout).toContain('ran');
    expect(result.stdout).toContain('after: 1');
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  describe('a check and nothing else (reusable)', () => {
    // `acquire` ends with SLOT_REUSED_EXIT when REUSED is set (the same files passed before).
    beforeEach(() => {
      fs.writeFileSync(
        cli,
        `#!/bin/sh\necho "$@" >> '${calls}'\nif [ "$2" = acquire ]; then if [ -n "$REUSED" ]; then echo "[untether] check: reused, same tree as before" >&2; exit ${SLOT_REUSED_EXIT}; fi; [ -n "$NO_SLOT" ] || echo T1; fi\n`,
        { mode: 0o755 }
      );
    });

    it.each(['/bin/zsh', '/bin/bash', '/bin/sh'])(
      '%s: says what it runs, and reports how it ended with the release',
      (shell) => {
        const script = slotCommand('echo ran; (exit 3)', 'cd web && pnpm test', [cli], true);
        const result = spawnSync(shell, ['-c', `${script}\necho "after: $?"`], {
          encoding: 'utf8',
          cwd: dir,
          env: { ...process.env, [CHECK_SLOT_ENV]: '' },
        });
        expect(result.stdout).toContain('ran');
        expect(result.stdout).toContain('after: 3');
        const log = fs.readFileSync(calls, 'utf8').trim().split('\n');
        expect(log[0]).toMatch(
          /^check-slot acquire --pid \d+ --label cd web && pnpm test --command cd web && pnpm test$/
        );
        expect(log[1]).toBe('check-slot release T1 --exit 3');
      }
    );

    it.each(['/bin/zsh', '/bin/bash', '/bin/sh'])(
      '%s: reused, the command is not run at all and the call ends well',
      (shell) => {
        const marker = path.join(dir, 'ran');
        const script = slotCommand(`touch '${marker}'; (exit 3)`, 'pnpm test', [cli], true);
        const result = spawnSync(shell, ['-c', `${script}\necho "after: $?"`], {
          encoding: 'utf8',
          cwd: dir,
          env: { ...process.env, [CHECK_SLOT_ENV]: '', REUSED: '1' },
        });
        expect(fs.existsSync(marker)).toBe(false);
        expect(result.stdout).toContain('after: 0');
        expect(result.stderr).toContain('check: reused, same tree as before');
        // Nothing was taken: nothing is released.
        expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
      }
    );

    it('without a slot (no server) it still runs, and nothing is reported', () => {
      const script = slotCommand('echo ran; false', 'pnpm test', [cli], true);
      const result = run(`${script}\necho "after: $?"`, { NO_SLOT: '1' });
      expect(result.stdout).toContain('ran');
      expect(result.stdout).toContain('after: 1');
      expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    });
  });

  it('is valid for bash too', () => {
    const script = slotCommand('echo ok', 'pnpm test', [cli]);
    expect(execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8', cwd: dir })).toContain(
      'ok'
    );
  });
});

describe('the hook', () => {
  const slot: GuardPolicy['checkSlot'] = { cli: ['/app/untether'], mode: 'wrap' };
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
  const rewritten = (input: string | null) =>
    input ? (JSON.parse(input).hookSpecificOutput.updatedInput.command as string) : null;

  it('wraps a heavy run of a Claude agent and leaves a focused one as it is', () => {
    const heavy = rewritten(rewrittenBashInput(bash('cd web && pnpm test'), undefined, slot));
    expect(heavy).toContain('/app/untether check-slot acquire --pid $$');
    expect(heavy).toContain('{ cd web && pnpm test\n}');
    expect(heavy).toContain('/app/untether check-slot release "$__ut_slot"');
    expect(
      rewrittenBashInput(bash('pnpm exec vitest run src/a.test.ts'), undefined, slot)
    ).toBeNull();
    expect(rewrittenBashInput(bash('git status'), undefined, slot)).toBeNull();
  });

  it('only a run that is a check and nothing else says its command (a kept pass may stand for it)', () => {
    const only = rewritten(rewrittenBashInput(bash('cd web && pnpm test'), undefined, slot));
    expect(only).toContain("--command 'cd web && pnpm test'");
    expect(only).toContain('check-slot release "$__ut_slot" --exit "$__ut_slot_rc"');
    const more = rewritten(rewrittenBashInput(bash('pnpm test 2>&1 | tail -20'), undefined, slot));
    expect(more).toContain('check-slot acquire --pid $$');
    expect(more).not.toContain('--command');
    expect(more).not.toContain('--exit');
  });

  it("recognises the project's checkCommand and relatedTestCommand", () => {
    const project: GuardPolicy['checkSlot'] = {
      ...slot,
      checks: ['bash tools/all.sh'],
      related: 'pnpm exec vitest related {files} --run',
    };
    expect(rewrittenBashInput(bash('bash tools/all.sh'), undefined, project)).not.toBeNull();
    expect(
      rewrittenBashInput(
        bash('pnpm exec vitest related a.ts b.ts c.ts d.ts --run'),
        undefined,
        project
      )
    ).not.toBeNull();
    expect(
      rewrittenBashInput(bash('pnpm exec vitest related a.ts --run'), undefined, project)
    ).toBeNull();
  });

  it('the slot goes around the summarised form', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-slot-sum-'));
    try {
      const command = rewritten(
        rewrittenBashInput(
          bash('pnpm test'),
          { logDir: path.join(dir, 'out'), runner: ['/app/untether', 'guard-hook'] },
          slot
        )
      );
      const acquire = command?.indexOf('check-slot acquire') ?? -1;
      const summary = command?.indexOf('--summarize') ?? -1;
      const release = command?.indexOf('check-slot release') ?? -1;
      expect(acquire).toBeGreaterThanOrEqual(0);
      expect(summary).toBeGreaterThan(acquire);
      expect(release).toBeGreaterThan(summary);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });

  it('Codex (no rewritten input): a heavy run is refused with the command to use, nothing in the guard log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-slot-ask-'));
    try {
      const policy: GuardPolicy = {
        taskId: 't1',
        root: dir,
        home: dir,
        blockedLog: path.join(dir, 'blocked.jsonl'),
        checkSlot: { cli: ['/app/untether'], mode: 'ask' },
      };
      const file = path.join(dir, 'policy.json');
      fs.writeFileSync(file, JSON.stringify(policy));
      const said: string[] = [];
      const call = (command: string) =>
        runGuardHook(
          file,
          JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir }),
          (text) => said.push(text),
          () => {}
        );
      expect(call('pnpm test')).toBe(2);
      expect(said.join('')).toContain("/app/untether check-slot run -- 'pnpm test'");
      expect(fs.existsSync(policy.blockedLog as string)).toBe(false);
      // What it is told to run goes through, and so does a focused run.
      expect(call("/app/untether check-slot run -- 'pnpm test'")).toBe(0);
      expect(call('pnpm exec vitest run src/a.test.ts')).toBe(0);
    } finally {
      fs.rmSync(dir, RM_TEST_DIR);
    }
  });
});
