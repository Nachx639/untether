import { readFileSync } from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseScreenChoices } from '../../shared/claude-screen.js';
import {
  claudeInputHolds,
  codexDialogOnScreen,
  codexInputHolds,
  codexReadyOnScreen,
  type InitialInputDeps,
  sanitizeTypedText,
  TYPED_GAP_MS,
  trustFolderOption,
  typeWhenClaudeReady,
  typeWhenCodexReady,
} from './claude-initial-input';

describe('typeWhenClaudeReady', () => {
  let status: string | undefined;
  let dialog: boolean;
  let running: boolean;
  let sent: Array<{ text: string } | { key: 'enter' }>;
  let deps: InitialInputDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    status = undefined;
    dialog = false;
    running = true;
    sent = [];
    deps = {
      claudeStatus: async () => status,
      dialogOnScreen: async () => dialog,
      isRunning: () => running,
      send: (input) => sent.push(input),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for Claude to be idle before typing the text and Enter', async () => {
    const done = typeWhenClaudeReady('hola', deps);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);

    status = 'idle';
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hola' }, { key: 'enter' }]);
  });

  it('with whileBusy, types into a working Claude at once; its menus still wait (2026-10-23)', async () => {
    // Working: a follow-up goes in now, Claude reads it within its turn.
    status = 'busy';
    const busy = typeWhenClaudeReady('el arreglo está en X', deps, { whileBusy: true });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(busy).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'el arreglo está en X' }, { key: 'enter' }]);

    // A question or permission of its own ('waiting'), or a dialog drawn on screen: waits.
    for (const [shownStatus, shownDialog] of [
      ['waiting', false],
      ['busy', true],
    ] as const) {
      sent = [];
      status = shownStatus;
      dialog = shownDialog;
      const held = typeWhenClaudeReady('A', deps, { whileBusy: true });
      await vi.advanceTimersByTimeAsync(5000);
      expect(sent).toEqual([]);
      status = 'idle';
      dialog = false;
      await vi.advanceTimersByTimeAsync(2000);
      await expect(held).resolves.toBe(true);
      expect(sent).toEqual([{ text: 'A' }, { key: 'enter' }]);
    }

    // Without it, a working Claude is still waited for (a brief, the first prompt).
    sent = [];
    status = 'busy';
    const plain = typeWhenClaudeReady('hola', deps, { timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(plain).resolves.toBe(false);
    expect(sent).toEqual([]);
  });

  it('presses Enter once more only when Claude kept the text in its input and shows no menu (2026-10-20)', async () => {
    status = 'idle';
    let screen = '────\n❯ hola, revisa el login\n────';
    const withScreen = { ...deps, screenText: async () => screen };
    const done = typeWhenClaudeReady('hola, revisa el login', withScreen);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hola, revisa el login' }, { key: 'enter' }, { key: 'enter' }]);

    // Taken (the input is empty), or a menu of its own came up: never a second Enter.
    for (const [shown, menu] of [
      ['────\n❯ \n────', false],
      ['────\n❯ hola, revisa el login\n────', true],
    ] as const) {
      sent = [];
      screen = shown;
      // The menu comes up once the text was typed (a permission right away).
      const again = typeWhenClaudeReady('hola, revisa el login', {
        ...withScreen,
        dialogOnScreen: async () => menu && sent.length > 0,
      });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(again).resolves.toBe(true);
      expect(sent.filter((input) => 'key' in input)).toHaveLength(1);
    }
  });

  it('claudeInputHolds reads its input box, a long paste included', () => {
    expect(claudeInputHolds('❯ arregla X', 'arregla X')).toBe(true);
    expect(claudeInputHolds('❯ ', 'arregla X')).toBe(false);
    expect(claudeInputHolds('❯ [Pasted text #1 +7 lines]', 'línea 1\nlínea 2')).toBe(true);
    expect(claudeInputHolds('no prompt here', 'arregla X')).toBe(false);
  });

  it('waits while a startup dialog is on screen', async () => {
    status = 'idle';
    dialog = true;
    const done = typeWhenClaudeReady('hola', deps);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toEqual([]);

    dialog = false;
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hola' }, { key: 'enter' }]);
  });

  it('lets the caller answer a dialog it may answer (a task worktree trust prompt)', async () => {
    status = 'idle';
    dialog = true;
    const answerDialog = vi.fn(async () => {
      dialog = false;
      return true;
    });
    const done = typeWhenClaudeReady('hola', { ...deps, answerDialog });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBe(true);
    expect(answerDialog).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ text: 'hola' }, { key: 'enter' }]);
  });

  it('answers a dialog once while the screen still shows it right after the answer', async () => {
    status = 'idle';
    dialog = true;
    const answerDialog = vi.fn(async () => {
      // The screen lags: the dialog stays drawn for another 1.5 s.
      setTimeout(() => {
        dialog = false;
      }, 1500);
      return true;
    });
    const done = typeWhenClaudeReady('hola', { ...deps, answerDialog });
    await vi.advanceTimersByTimeAsync(4000);
    await expect(done).resolves.toBe(true);
    expect(answerDialog).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ text: 'hola' }, { key: 'enter' }]);
  });

  it('never types blind when Claude never becomes ready (a late dialog would take the Enter)', async () => {
    const onGiveUp = vi.fn();
    const done = typeWhenClaudeReady('hola', { ...deps, onGiveUp }, { timeoutMs: 30000 });
    await vi.advanceTimersByTimeAsync(31000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
    expect(onGiveUp).toHaveBeenCalledWith('Claude never became ready');
  });

  describe("never typed onto the user's own input (2026-11-10)", () => {
    it('waits while the user writes or has unsent text, with no time limit for a queue that keeps waiting', async () => {
      status = 'idle';
      let hold: string | null = 'the user has unsent text in its input';
      const onHold = vi.fn();
      const done = typeWhenClaudeReady(
        '[untether] Message mbcd234 from …',
        { ...deps, userHold: async () => hold, onHold, lockKey: 'hold-1' },
        { keepWaiting: () => true }
      );
      // An idle prompt, but the user's draft sits in it: 20 minutes, nothing typed.
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(sent).toEqual([]);
      expect(onHold).toHaveBeenCalledTimes(1);
      expect(onHold).toHaveBeenCalledWith('the user has unsent text in its input');

      hold = null;
      await vi.advanceTimersByTimeAsync(2000);
      await expect(done).resolves.toBe(true);
      expect(sent).toEqual([{ text: '[untether] Message mbcd234 from …' }, { key: 'enter' }]);
    });

    it('looks again right before the keys go in: the user started to write while it settled', async () => {
      status = 'idle';
      const answers: Array<string | null> = [null, 'the user is typing or has just sent a message'];
      const userHold = vi.fn(async () =>
        answers.length ? (answers.shift() as string | null) : null
      );
      const done = typeWhenClaudeReady('nota', { ...deps, userHold, lockKey: 'hold-2' });
      // Ready and clear on the first look; the second look (after the settle) says the user types.
      await vi.advanceTimersByTimeAsync(450);
      expect(userHold.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(done).resolves.toBe(true);
      expect(sent).toEqual([{ text: 'nota' }, { key: 'enter' }]);
    });

    it('a guard that cannot tell holds the typing, and a give-up says why', async () => {
      status = 'idle';
      const onGiveUp = vi.fn();
      const done = typeWhenClaudeReady(
        'nota',
        {
          ...deps,
          onGiveUp,
          lockKey: 'hold-3',
          userHold: async () => {
            throw new Error('no screen');
          },
        },
        { timeoutMs: 5000, maxWaitMs: 8000 }
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(done).resolves.toBe(false);
      expect(sent).toEqual([]);
      expect(onGiveUp).toHaveBeenCalledWith('its input could not be checked (never typed over it)');
    });

    it("two texts waiting for the same idle prompt go in one at a time, never as one turn (the user's reply and an agent's message)", async () => {
      // The second one sees "idle" until the first is picked up, as a real status file does.
      const typed: string[] = [];
      const session = {
        ...deps,
        lockKey: 'same-session',
        send: (input: { text: string } | { key: 'enter' }) => {
          sent.push(input);
          if ('key' in input) status = 'busy';
          else typed.push(input.text);
        },
      };
      const reply = typeWhenClaudeReady('respuesta de Alex', session);
      const message = typeWhenClaudeReady('[untether] Message mbcd234 from …', session, {
        keepWaiting: () => true,
      });
      status = 'idle';
      await vi.advanceTimersByTimeAsync(3000);
      await expect(reply).resolves.toBe(true);
      // The first text and its Enter went in whole before anything of the second.
      expect(sent).toEqual([{ text: typed[0] }, { key: 'enter' }]);
      // Claude works on it; the other waits for the next idle prompt.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(typed).toHaveLength(1);
      status = 'idle';
      await vi.advanceTimersByTimeAsync(5000);
      await expect(message).resolves.toBe(true);
      expect(sent).toEqual([
        { text: typed[0] },
        { key: 'enter' },
        { text: typed[1] },
        { key: 'enter' },
      ]);
      expect([...typed].sort()).toEqual(['[untether] Message mbcd234 from …', 'respuesta de Alex']);
    });

    it('with the prompt still idle after a typing, the next text waits a moment instead of joining it', async () => {
      status = 'idle';
      const session = { ...deps, lockKey: 'slow-status' };
      const first = typeWhenClaudeReady('uno', session);
      const second = typeWhenClaudeReady('dos', session);
      await vi.advanceTimersByTimeAsync(1500);
      await expect(first).resolves.toBe(true);
      // Its status has not said "busy" yet: the second is not typed right behind the first.
      expect(sent).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(TYPED_GAP_MS + 2000);
      await expect(second).resolves.toBe(true);
      expect(sent).toHaveLength(4);
    });
  });

  it('keeps waiting while a dialog shows, then types once the user answers it', async () => {
    dialog = true;
    const done = typeWhenClaudeReady('hola', deps, { timeoutMs: 30000 });
    await vi.advanceTimersByTimeAsync(120_000); // the user takes two minutes
    expect(sent).toEqual([]);
    dialog = false;
    status = 'idle';
    await vi.advanceTimersByTimeAsync(2000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hola' }, { key: 'enter' }]);
  });

  it('treats an unreadable screen as a dialog', async () => {
    status = 'idle';
    const done = typeWhenClaudeReady(
      'hola',
      { ...deps, dialogOnScreen: async () => Promise.reject(new Error('no screen')) },
      { timeoutMs: 3000 }
    );
    await vi.advanceTimersByTimeAsync(4000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
  });

  it('does not press Enter into a dialog that is still open at the longest wait', async () => {
    dialog = true;
    const onGiveUp = vi.fn();
    const done = typeWhenClaudeReady(
      'hola',
      { ...deps, onGiveUp },
      { timeoutMs: 30000, maxWaitMs: 120_000 }
    );
    await vi.advanceTimersByTimeAsync(121_000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
    expect(onGiveUp).toHaveBeenCalled();
  });

  it('gives up when the session exits', async () => {
    const done = typeWhenClaudeReady('hola', deps, { timeoutMs: 30000 });
    running = false;
    await vi.advanceTimersByTimeAsync(31000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
  });

  it('sends multi-line text as a bracketed paste', async () => {
    status = 'idle';
    const done = typeWhenClaudeReady('one\ntwo', deps);
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(sent).toEqual([{ text: '\x1b[200~one\ntwo\x1b[201~' }, { key: 'enter' }]);
  });

  // 2026-10-20 (security audit): a prompt could end the paste early, submit half-way or
  // switch Claude's permission mode with the keys it held.
  it('types no control characters or escape sequences from the prompt', async () => {
    status = 'idle';
    const done = typeWhenClaudeReady('one\x1b[201~\rrm -rf ~\x1b[Z\ntwo\u0003', deps);
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(sent).toEqual([{ text: '\x1b[200~one\nrm -rf ~\ntwo\x1b[201~' }, { key: 'enter' }]);
  });
});

describe('sanitizeTypedText', () => {
  it('keeps text, tabs and newlines; drops CSI, OSC, other escapes and controls', () => {
    expect(sanitizeTypedText('héllo\tworld\r\nnext')).toBe('héllo\tworld\nnext');
    expect(sanitizeTypedText('a\x1b]0;title\x07b\x1b]52;c;Zm9v\x1b\\c')).toBe('abc');
    expect(sanitizeTypedText('a\x1b[1;5Ab\x1bOPc\x1bxd')).toBe('abcd');
    expect(sanitizeTypedText('a\x00\x08\x7f\x9b31mb\x1b')).toBe('ab');
    expect(sanitizeTypedText('plain question?')).toBe('plain question?');
  });
});

// Codex 0.155 screens (plain text, as cellsToText renders them).
const CODEX_BANNER = [
  '╭──────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.155.1)                    │',
  '│                                               │',
  '│ model:     gpt-5.5 high   /model to change    │',
  '│ directory: ~/Projects/app                     │',
  '╰──────────────────────────────────────────────╯',
  '',
];
const CODEX_PROMPT = [
  ...CODEX_BANNER,
  '  Tip: Use /review to get a code review of your changes.',
  '',
  '',
  '› Ask Codex to do anything',
  '',
  '  gpt-5.5 high · 100% context left · ~/Projects/app',
  '',
].join('\n');
const CODEX_UPDATE = [
  '  ✨ Update available! 0.155.1 -> 0.156.0',
  '',
  '  Release notes: https://github.com/openai/codex/releases/latest',
  '',
  '› 1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  '  Press enter to continue',
].join('\n');
const CODEX_TRUST = [
  ...CODEX_BANNER,
  '> You are running Codex in /Users/me/Projects/app',
  '',
  '  Since this folder is version controlled, you may wish to allow Codex to work in this',
  '  folder without asking for approval.',
  '',
  '› 1. Yes, allow Codex to work in this folder without asking for approval',
  '  2. No, ask me to approve edits and commands',
  '',
].join('\n');

describe('Codex screen readiness', () => {
  it('is ready at the prompt with its footer', () => {
    expect(codexReadyOnScreen(CODEX_PROMPT)).toBe(true);
    expect(codexDialogOnScreen(CODEX_PROMPT)).toBe(false);
  });

  it('is not ready on the update prompt or the trust dialog', () => {
    expect(codexDialogOnScreen(CODEX_UPDATE)).toBe(true);
    expect(codexReadyOnScreen(CODEX_UPDATE)).toBe(false);
    expect(codexDialogOnScreen(CODEX_TRUST)).toBe(true);
    expect(codexReadyOnScreen(CODEX_TRUST)).toBe(false);
  });

  it('is not ready while the shell or the banner is all there is', () => {
    expect(codexReadyOnScreen('me@mac app % codex\n')).toBe(false);
    expect(codexReadyOnScreen(CODEX_BANNER.join('\n'))).toBe(false);
    expect(codexReadyOnScreen('')).toBe(false);
  });

  it('reads Codex inline (--no-alt-screen), blank rows under its prompt included', () => {
    const inline = (name: string) =>
      readFileSync(
        path.join(__dirname, '__fixtures__/claude-waiting', `codex-inline-${name}.txt`),
        'utf8'
      );
    expect(codexReadyOnScreen(inline('idle'))).toBe(true);
    expect(codexDialogOnScreen(inline('idle'))).toBe(false);
    expect(codexInputHolds(inline('busy'), 'Ask Codex to do anything')).toBe(true);
    for (const dialog of ['trust', 'approval']) {
      expect(codexDialogOnScreen(inline(dialog))).toBe(true);
      expect(codexReadyOnScreen(inline(dialog))).toBe(false);
    }
  });

  it('does not take a numbered list in the conversation above the prompt for a dialog', () => {
    const screen = ['• Plan:', '  1. Read the code', '  then run the tests', '', ''].join('\n');
    expect(codexDialogOnScreen(screen)).toBe(false);
  });
});

describe('typeWhenCodexReady', () => {
  let screen: string;
  let running: boolean;
  let sent: Array<{ text: string } | { key: 'enter' }>;
  const deps = () => ({
    screenText: async () => screen,
    isRunning: () => running,
    send: (input: { text: string } | { key: 'enter' }) => sent.push(input),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    screen = '';
    running = true;
    sent = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('types the text once the prompt has shown for two polls', async () => {
    const done = typeWhenCodexReady('hola', deps());
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toEqual([]);
    screen = CODEX_PROMPT;
    await vi.advanceTimersByTimeAsync(2500);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hola' }, { key: 'enter' }]);
  });

  it('presses Enter once more when Codex kept the text in its input', async () => {
    // Codex took an Enter 80 ms after the text as part of the burst: the question stayed in
    // its input, unsent (2026-10-03, SE).
    screen = CODEX_PROMPT;
    const typed = CODEX_PROMPT.replace('› Ask Codex to do anything', '› hola');
    const done = typeWhenCodexReady('hola', {
      ...deps(),
      send: (input) => {
        sent.push(input);
        // The text shows in the input; only the second Enter sends it.
        if ('text' in input) screen = typed;
        else if (sent.filter((s) => 'key' in s).length === 2) screen = CODEX_PROMPT;
      },
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hola' }, { key: 'enter' }, { key: 'enter' }]);
  });

  it('presses Enter only once when Codex takes it', async () => {
    screen = CODEX_PROMPT;
    const done = typeWhenCodexReady('hola', deps());
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBe(true);
    expect(sent).toEqual([{ text: 'hola' }, { key: 'enter' }]);
  });

  it('waits while the user answers the update prompt, then types', async () => {
    screen = CODEX_UPDATE;
    const done = typeWhenCodexReady('hola', deps());
    await vi.advanceTimersByTimeAsync(10000);
    expect(sent).toEqual([]);
    screen = CODEX_PROMPT;
    await vi.advanceTimersByTimeAsync(2500);
    await expect(done).resolves.toBe(true);
  });

  it('reads the screen once per poll while a dialog is up', async () => {
    screen = CODEX_UPDATE;
    const screenText = vi.fn(async () => screen);
    const done = typeWhenCodexReady(
      'hola',
      { ...deps(), screenText },
      { pollMs: 500, timeoutMs: 60_000 }
    );
    await vi.advanceTimersByTimeAsync(4_900); // polls at 0, 500, ..., 4500: ten of them
    expect(screenText).toHaveBeenCalledTimes(10);
    running = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(done).resolves.toBe(false);
  });

  it('never answers a dialog still open at the longest wait', async () => {
    screen = CODEX_TRUST;
    const onGiveUp = vi.fn();
    const done = typeWhenCodexReady(
      'hola',
      { ...deps(), onGiveUp },
      { timeoutMs: 30000, maxWaitMs: 120_000 }
    );
    await vi.advanceTimersByTimeAsync(121_000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
    expect(onGiveUp).toHaveBeenCalledWith('Codex never became ready');
  });

  it('does not type into a screen it cannot read', async () => {
    const done = typeWhenCodexReady(
      'hola',
      { ...deps(), screenText: async () => Promise.reject(new Error('no screen')) },
      { timeoutMs: 3000 }
    );
    await vi.advanceTimersByTimeAsync(4000);
    await expect(done).resolves.toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('trustFolderOption', () => {
  it("finds Claude Code's trust answer, and nothing in other menus", () => {
    expect(
      trustFolderOption({
        question: 'Quick safety check: Is this a project you created or one you trust?',
        options: ['No, exit', 'Yes, I trust this folder'],
      })
    ).toBe(2);
    expect(
      trustFolderOption({
        question: 'Do you trust the files in this folder?',
        options: ['Yes, proceed', 'No, exit'],
      })
    ).toBe(1);
    expect(
      trustFolderOption({ question: 'Do you want to run rm -rf build?', options: ['Yes', 'No'] })
    ).toBe(0);
    expect(trustFolderOption(null)).toBe(0);
    // Codex 0.163: no "Yes" (2026-10-23).
    expect(
      trustFolderOption({
        question: 'Trust this folder?',
        options: ['Trust and continue', 'Back to Agent Command Center'],
      })
    ).toBe(1);
  });
});

describe("Codex 0.163's trust dialog (2026-10-23)", () => {
  // The screen of task session 84136a32 for 30 min, as Untether read it with no client.
  const screen = [
    '',
    '  Folder access',
    '  /Users/me/Projects/.untether-worktrees/untether/security-upgrade-axios',
    '',
    '  Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:',
    '  /Users/me/Projects/untether',
    '',
    '  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings',
    '  can run code automatically, even without a model request. Continue only if you trust these files. Your trust',
    '  decision will be saved.',
    '',
    '› 1. Trust and continue',
    '  2. Back to Agent Command Center',
    '',
    '  enter continue · esc back',
  ].join('\n');

  it('is read as a menu whose first option trusts the folder, not as a draft in the composer', () => {
    const choices = parseScreenChoices(screen);
    expect(choices).toMatchObject({
      question: 'Trust this folder?',
      options: ['Trust and continue', 'Back to Agent Command Center'],
      cursor: 0,
    });
    expect(trustFolderOption(choices)).toBe(1);
    expect(codexDialogOnScreen(screen)).toBe(true);
    expect(codexReadyOnScreen(screen)).toBe(false);
  });

  it('a draft in the composer with a hint that is no key hint is still no menu', () => {
    const draft = ['› 1. arregla esto', '  2. y esto', '', '  100% context left · ? for shortcuts'];
    expect(parseScreenChoices(draft.join('\n'))).toBeNull();
  });
});

describe('a dialog nobody answers (2026-10-23)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const updateMenu = [
    '  ✨ Update available · 0.163.0 → 0.164.0',
    '',
    '› 1. Update now (runs `npm install -g @openai/codex`)',
    '  2. Skip',
    '  3. Skip until next version',
    '',
    '  Press enter to continue',
  ].join('\n');

  it('is told once after a while, and the text is never typed into it', async () => {
    const sent: unknown[] = [];
    const onDialogWaiting = vi.fn();
    const done = typeWhenCodexReady(
      'Fix the CVE',
      { screenText: async () => updateMenu, isRunning: () => true, send: (i) => sent.push(i) },
      { timeoutMs: 1000, maxWaitMs: 60_000, dialogNoticeMs: 20_000, onDialogWaiting }
    );
    await vi.advanceTimersByTimeAsync(19_000);
    expect(onDialogWaiting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onDialogWaiting).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(done).resolves.toBe(false);
    expect(onDialogWaiting).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it('is not told when the caller answers it (the trust dialog of a task worktree)', async () => {
    let screen = updateMenu;
    const onDialogWaiting = vi.fn();
    const done = typeWhenCodexReady(
      'Fix the CVE',
      {
        screenText: async () => screen,
        isRunning: () => true,
        send: () => {},
        answerDialog: async () => {
          screen = '› Ask Codex to do anything\n\n  ? for shortcuts';
          return true;
        },
      },
      { dialogNoticeMs: 1000, onDialogWaiting }
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(done).resolves.toBe(true);
    expect(onDialogWaiting).not.toHaveBeenCalled();
  });
});
