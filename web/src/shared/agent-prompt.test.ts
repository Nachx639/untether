import { describe, expect, it } from 'vitest';
import {
  agentMayNotAnswer,
  approveOption,
  denyOption,
  promptDeletes,
  promptLines,
  promptWhole,
  type TaskPrompt,
  textDeletes,
  untetherWrapper,
  WRAPPED_ASKS_MAX,
} from './agent-prompt.js';

const OPTIONS = [
  'Yes',
  "Yes, and don't ask again for bash -c commands in this folder",
  'No, and tell Claude what to do differently (esc)',
];

const prompt = (over: Partial<TaskPrompt> = {}): TaskPrompt => ({
  question: 'Do you want to proceed?',
  options: OPTIONS,
  detail: ['Bash command', "bash -c 'grep -H x scripts/check.d/*.sh'"],
  asks: "Permission for Bash: bash -c 'grep -H x scripts/check.d/*.sh'",
  since: '2026-11-10T08:19:33.000Z',
  ...over,
});

describe("a prompt of the agent's own on a task's screen (2026-11-10)", () => {
  it('approve is the plain Yes, deny the No; a menu without them has neither', () => {
    expect(approveOption(OPTIONS)).toBe(1);
    expect(denyOption(OPTIONS)).toBe(3);
    // Only a widening yes: approve picks nothing rather than more than was asked.
    expect(approveOption(["Yes, and don't ask again", 'No'])).toBe(0);
    expect(approveOption(['Rojo', 'Verde'])).toBe(0);
    expect(denyOption(['Rojo', 'Verde'])).toBe(0);
  });

  it('knows a command that deletes from one that does not', () => {
    for (const command of [
      'rm -rf "$TMPDIR/rv/"*',
      'cd build && rm old.log',
      'sudo rm -r /var/x',
      'git clean -fdx',
      'git reset --hard origin/main',
      'git push --force origin ut/x',
      'git branch -D ut/x',
      'find . -name "*.log" -delete',
      'ls | xargs rm',
      'psql -c "DROP TABLE users"',
      "node -e 'fs.rmSync(dir, { recursive: true })'",
      'docker compose down -v',
      "bash -c 'rm -rf x'",
    ]) {
      expect(textDeletes(command), command).toBe(true);
    }
    for (const command of [
      'bash -c \'grep -H "solo-si-cambia=" scripts/check.d/*.sh | while read -r b r; do echo $b; done\'',
      'git status --short',
      'pnpm run check',
      'git log --format=%H -1',
      'confirm() { echo ok; }; confirm',
      'ls scripts/form.sh',
    ]) {
      expect(textDeletes(command), command).toBe(false);
    }
  });

  it('an agent may approve what deletes nothing and could be read, and nothing else', () => {
    expect(agentMayNotAnswer(prompt(), 'Yes')).toBeNull();
    // Never a deletion: seen on the screen, or only in what its own event said it asks.
    expect(agentMayNotAnswer(prompt({ detail: ['Bash command', 'rm -rf /rv/*'] }), 'Yes')).toMatch(
      /delete/
    );
    const hidden = prompt({
      detail: ['Bash command', 'bash -c … +12 lines'],
      asks: 'Permission for Bash: bash -c \'cd x\nrm -rf "$D"/*\'',
    });
    expect(promptDeletes(hidden)).toBe(true);
    expect(agentMayNotAnswer(hidden, 'Yes')).toMatch(/delete/);
    // Nor what nobody could read, nor more than this one call.
    // Nor what is not known whole: the screen alone may show the command cut, its `rm`
    // out of sight (review 2026-11-10), so without the agent's own event it is the user's.
    const cut = prompt({ detail: ['Bash command', 'bash -c … +12 lines'], asks: undefined });
    expect(agentMayNotAnswer(cut, 'Yes')).toMatch(/not known whole/);
    expect(agentMayNotAnswer(prompt({ asks: undefined }), 'Yes')).toMatch(/not known whole/);
    expect(agentMayNotAnswer(prompt({ detail: [], asks: '  ' }), 'Yes')).toMatch(/not known whole/);
    expect(agentMayNotAnswer(prompt(), OPTIONS[1])).toMatch(/more than this one call/);
    // Refusing is always its to give.
    expect(
      agentMayNotAnswer(prompt({ detail: ['Bash command', 'rm -rf /'] }), OPTIONS[2])
    ).toBeNull();
    expect(agentMayNotAnswer(cut, OPTIONS[2])).toBeNull();
  });

  it('ut task status shows what it asks, its options and how to answer', () => {
    const lines = promptLines(
      prompt({ asks: "Permission for Bash: bash -c 'grep -H x scripts/check.d/*.sh'" }),
      '3dc243e4'
    );
    expect(lines[0]).toBe("asks: Permission for Bash: bash -c 'grep -H x scripts/check.d/*.sh'");
    expect(lines).toContain('Do you want to proceed?');
    expect(lines).toContain('  1. Yes');
    expect(lines).toContain('  3. No, and tell Claude what to do differently (esc)');
    expect(lines.join('\n')).toContain(
      'ut task answer 3dc243e4 approve | deny | <number> | --text'
    );
    expect(promptLines(prompt({ deletes: true }), 'x').join('\n')).toContain(
      'only the user approves it'
    );
    expect(promptLines(prompt({ options: [], question: '' }), 'x').join('\n')).toContain(
      'could not be read from the screen'
    );
  });

  it('knows a command Untether itself rewrote from one the agent wrote (2026-11-11)', () => {
    const slot = `__ut_slot=$('/app/ut' check-slot acquire --pid $$ --label 'pnpm test')\n{ pnpm test\n}`;
    const summary = `__ut_log='/u/output/x.log'\n{ pnpm test\n} >"$__ut_log" 2>&1`;
    expect(untetherWrapper(`Permission for Bash: ${slot}`)).toBe('check slot');
    expect(untetherWrapper(`Permission for Bash: ${summary}`)).toBe('output summary');
    expect(untetherWrapper(`Permission for Bash: ${slot}\n{ ${summary}\n}`)).toBe(
      'check slot, output summary'
    );
    // The agent's own commands, whatever they say of those names.
    expect(untetherWrapper('Permission for Bash: git status')).toBeNull();
    expect(untetherWrapper('Permission for Bash: grep -rn "x__ut_log=" src')).toBeNull();
    expect(untetherWrapper('Permission for Bash: echo "$__ut_slot"')).toBeNull();
    expect(untetherWrapper(undefined)).toBeNull();
    // ut task status says so, and the command is told whole, bounded.
    const wrapped = prompt({ asks: `Permission for Bash: ${slot}`, wrapped: 'check slot' });
    expect(promptLines(wrapped, 'x').join('\n')).toContain(
      'Untether itself rewrote this command (check slot)'
    );
    expect(promptWhole(wrapped)).toBe(`Permission for Bash: ${slot}`);
    expect(promptWhole(prompt({ asks: 'x'.repeat(WRAPPED_ASKS_MAX + 50) }))).toHaveLength(
      WRAPPED_ASKS_MAX
    );
  });
});
