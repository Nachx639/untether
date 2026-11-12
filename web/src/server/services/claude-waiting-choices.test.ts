import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  optionForTyped,
  parseScreenChoices,
  sameMenuKey,
  takesReply,
} from '../../shared/claude-screen.js';
import type { ClaudeStatus } from './claude-chat.js';
import { ClaudeStatusNotifier, watchedSessions } from './claude-status-notifier.js';

const fixture = (name: string) =>
  readFileSync(path.join(__dirname, '__fixtures__/claude-waiting', name), 'utf8');

/**
 * Claude Code's permission menu drawn for a 53-column PTY (QA of 2026-10-04, session ff005102):
 * it cut the path mid-word itself ("/Users/alexandr" + "apublicdemouser") and moved "handles"
 * to the next row whole, indenting both continuations.
 */
const RULE_53 = '─'.repeat(53);
const DASHES_53 = '╌'.repeat(53);
const PTY_53_DIALOG = [
  RULE_53,
  ' Bash command',
  ' Tip: auto mode handles these prompts for you —',
  ' choose "switch to auto mode" below',
  ' Create empty file hoja5.txt',
  DASHES_53,
  ' touch hoja5.txt && ls -l hoja5.txt',
  DASHES_53,
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
];
const MID_WORD_OPTION = [
  '   2. Yes, and always allow access to /Users/alexandr',
  '      apublicdemouser/.untether-qa/qa-git from this',
  '      project',
];
const SPACED_OPTION = [
  '   3. Yes, and switch to auto mode · auto mode',
  '      handles these prompts for you',
];
const PTY_53_FOOT = ['   4. No', '', ' Esc to cancel · Tab to amend'];
const MID_WORD_LABEL =
  'Yes, and always allow access to /Users/alexandrapublicdemouser/.untether-qa/qa-git from this project';
const SPACED_LABEL = 'Yes, and switch to auto mode · auto mode handles these prompts for you';

/** The screen as the server's terminal (at the PTY's width) has it: no row soft-wrapped. */
function ptyScreen(options: string[][]) {
  const lines = [...PTY_53_DIALOG, ...options.flat(), ...PTY_53_FOOT];
  return { text: lines.join('\n'), wrappedRows: lines.map(() => false) };
}

describe('a menu Claude wrapped itself, read on the server and on the phone', () => {
  it('reads the mid-word and the spaced continuation the same on both, in either order', () => {
    const orders: Array<[string[][], string[]]> = [
      [
        [MID_WORD_OPTION, SPACED_OPTION],
        ['Yes', MID_WORD_LABEL, SPACED_LABEL, 'No'],
      ],
      [
        [
          [SPACED_OPTION[0].replace('3.', '2.'), SPACED_OPTION[1]],
          [MID_WORD_OPTION[0].replace('2.', '3.'), ...MID_WORD_OPTION.slice(1)],
        ],
        ['Yes', SPACED_LABEL, MID_WORD_LABEL, 'No'],
      ],
    ];
    for (const [options, labels] of orders) {
      const { text, wrappedRows } = ptyScreen(options);
      // The server reads its own terminal, at the PTY's 53 columns.
      const server = parseScreenChoices(text, { cols: 53, wrappedRows, visibleRows: 56 });
      expect(server?.options).toEqual(labels);
      // A phone whose terminal has the PTY's width holds the same rows.
      const sameWidth = parseScreenChoices(text, {
        cols: 53,
        wrappedRows,
        visibleRows: 56,
        ptyCols: 53,
      });
      // A wider phone (the PTY sized by a narrower client) holds them too, with room to
      // spare on the right: read at the PTY's width, "/Users/alexandr" still fills its row.
      const wider = parseScreenChoices(text, {
        cols: 60,
        wrappedRows,
        visibleRows: 56,
        ptyCols: 53,
      });
      for (const phone of [sameWidth, wider]) {
        expect(phone?.options).toEqual(server?.options);
        expect(phone?.key).toBe(server?.key);
      }
    }
  });

  it('reads no menu off a copy narrower than the PTY, whose rows lost their tails', () => {
    // The phone's terminal stayed at 45 columns while another client had the PTY at 53: each
    // longer row spilled onto the next one, which Claude's next row overwrote. What ghostty
    // held on the phone, replayed from the session's cast.
    const RULE_45 = '─'.repeat(45);
    const DASHES_45 = '╌'.repeat(45);
    const rows: Array<[boolean, string]> = [
      [false, RULE_45],
      [true, ' Bash command'],
      [false, ' Tip: auto mode handles these prompts for you'],
      [true, ' choose "switch to auto mode" below'],
      [false, ' Create empty file hoja5.txt'],
      [false, DASHES_45],
      [true, ' touch hoja5.txt && ls -l hoja5.txt'],
      [false, DASHES_45],
      [true, ' Do you want to proceed?'],
      [false, ' ❯ 1. Yes'],
      [false, '   2. Yes, and always allow access to /Users/'],
      [true, '      apublicdemouser/.untether-qa/qa-git f'],
      [true, '      project'],
      [false, '   3. Yes, and switch to auto mode · auto mod'],
      [true, '      handles these prompts for you'],
      [false, '   4. No'],
      [false, ''],
      [false, ' Esc to cancel · Tab to amend'],
    ];
    const text = rows.map(([, line]) => line).join('\n');
    const wrappedRows = rows.map(([wrapped]) => wrapped);
    const layout = { cols: 45, wrappedRows, visibleRows: 56 };
    // Read as if the app drew for this width: the labels the phone showed, and a key the
    // server refused on every tap ("La pregunta en pantalla ha cambiado").
    const misread = parseScreenChoices(text, layout);
    expect(misread?.options.slice(1, 3)).toEqual([
      'Yes, and always allow access to /Users/apublicdemouser/.untether-qa/qa-git fproject',
      'Yes, and switch to auto mode · auto modhandles these prompts for you',
    ]);
    const server = parseScreenChoices(ptyScreen([MID_WORD_OPTION, SPACED_OPTION]).text, {
      cols: 53,
      visibleRows: 56,
      wrappedRows: ptyScreen([MID_WORD_OPTION, SPACED_OPTION]).wrappedRows,
    });
    expect(sameMenuKey(misread?.key, server?.key)).toBe(false);
    // Knowing the PTY's width, the phone shows no menu rather than a wrong one.
    expect(parseScreenChoices(text, { ...layout, ptyCols: 53 })).toBeNull();
  });
});

describe("Claude's waiting screens", () => {
  it('keeps the space where Claude word-wrapped an option to a full 60-column line', () => {
    const line2 = '  2. Yes, and always allow access to /private/tmp/vtqa-perm';
    const line3 = '  3. Yes, and switch to auto mode · auto mode handles these';
    const cols = Math.max(line2.length, line3.length) + 1;
    const screen = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      line2.padEnd(cols - 1),
      '     from this project',
      line3.padEnd(cols - 1),
      '     prompts for you',
      '   4. No',
    ].join('\n');
    // Claude ended these rows itself: the terminal didn't soft-wrap any of them.
    const wrappedRows = screen.split('\n').map(() => false);
    expect(parseScreenChoices(screen, { cols, wrappedRows })?.options).toEqual([
      'Yes',
      'Yes, and always allow access to /private/tmp/vtqa-perm from this project',
      'Yes, and switch to auto mode · auto mode handles these prompts for you',
      'No',
    ]);
  });

  it('joins a word Claude cut at the edge itself, being longer than its box', () => {
    // 45 columns on the SE: Claude cut the path where it filled the row and went on below;
    // the chat card, the row and the answer sheet all showed ".untethe r-qa" (2026-10-03).
    const screen = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and always allow access to',
      '      /Users/alexandrapublicdemouser/.untethe',
      '      r-qa/qa-git from this project',
      '   3. Yes, and switch to auto mode · auto',
      '      mode handles these prompts for you',
      '   4. No',
    ].join('\n');
    const wrappedRows = screen.split('\n').map(() => false);
    expect(parseScreenChoices(screen, { cols: 45, wrappedRows })?.options).toEqual([
      'Yes',
      'Yes, and always allow access to /Users/alexandrapublicdemouser/.untether-qa/qa-git from this project',
      'Yes, and switch to auto mode · auto mode handles these prompts for you',
      'No',
    ]);
  });

  it('joins a row the terminal soft-wrapped mid-word without a space', () => {
    const screen = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '  2. /tmp/alexandrapu',
      '     blicdemouser',
      '   3. No',
    ].join('\n');
    // ghostty marks the row that goes on from the one above (checked 2026-10-03).
    const wrappedRows = [false, false, false, true, false];
    expect(parseScreenChoices(screen, { cols: 20, wrappedRows })?.options[1]).toBe(
      '/tmp/alexandrapublicdemouser'
    );
  });

  it('keeps the space after a path that just fit its row, before a plain word', () => {
    // 39 characters fill the box at 45 columns: Claude moved "from" down whole.
    const screen = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and always allow access to',
      '      /Users/alexandrapublicdemouser/Projects',
      '      from this project',
      '   3. No',
    ].join('\n');
    const wrappedRows = screen.split('\n').map(() => false);
    expect(parseScreenChoices(screen, { cols: 45, wrappedRows })?.options[1]).toBe(
      'Yes, and always allow access to /Users/alexandrapublicdemouser/Projects from this project'
    );
  });

  it('measures a row with wide characters in columns when joining a cut word', () => {
    // "/a/测试测试测" fills 19 of 20 columns (each 测 or 试 takes two) and goes on below.
    const screen = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. /a/测试测试测',
      '      试/b from x',
      '   3. No',
    ].join('\n');
    const wrappedRows = screen.split('\n').map(() => false);
    expect(parseScreenChoices(screen, { cols: 20, wrappedRows })?.options[1]).toBe(
      '/a/测试测试测试/b from x'
    );
  });

  it('tells apart questions and commands that differ only in letters of other scripts', () => {
    const ask = (question: string, a: string, b: string) =>
      parseScreenChoices([` ${question}`, ` ❯ 1. ${a}`, `   2. ${b}`].join('\n'))?.key;
    expect(ask('要删除旧的构建文件吗？', '是，删除', '否，保留')).not.toBe(
      ask('要推送到远程仓库吗？', '是，推送', '否，稍后')
    );
    const bash = fixture('permission-bash.txt');
    expect(parseScreenChoices(bash.replaceAll('dist/', './测试'))?.key).not.toBe(
      parseScreenChoices(bash.replaceAll('dist/', './文档'))?.key
    );
  });

  it('reads a permission prompt with three options', () => {
    expect(parseScreenChoices(fixture('permission-bash.txt'))).toEqual({
      question: 'Do you want to proceed?',
      options: [
        'Yes',
        "Yes, and don't ask again for pnpm build commands in /Users/alice/Projects/untether/web",
        'No, and tell Claude what to do differently (esc)',
      ],
      cursor: 0,
      navigate: true,
      key: expect.any(String),
      numbered: true,
      detail: [
        'Bash command',
        'rm -rf dist/ && pnpm build',
        'Remove the stale build output and rebuild',
      ],
    });
  });

  it('reads plan approval through the dialog borders, not the plan steps', () => {
    expect(parseScreenChoices(fixture('plan-approval.txt'))).toEqual({
      question: 'Would you like to proceed?',
      options: [
        'Yes, and auto-accept edits',
        'Yes, and manually approve edits',
        'No, keep planning',
      ],
      cursor: 0,
      navigate: true,
      key: expect.any(String),
      numbered: true,
      detail: [
        'Plan: answer sheet',
        '1. Parse the waiting screen',
        '2. Put the choices in the push',
      ],
    });
  });

  it('reads a yes/no question as y and n', () => {
    expect(parseScreenChoices(fixture('yes-no.txt'))).toEqual({
      question: 'Overwrite it with the new defaults? (y/n)',
      options: ['Yes', 'No'],
      keys: ['y', 'n'],
    });
  });

  it('reads the plan approval of Claude Code 2.1, whose Enter would execute the plan', () => {
    expect(parseScreenChoices(fixture('plan-approval-live.txt'))).toMatchObject({
      question: 'Would you like to proceed?',
      options: [
        'Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session',
        'Yes, manually approve edits',
        'Tell Claude what to change',
      ],
    });
  });

  it('reads it whole in a narrow terminal, question and labels unwrapped, hints left out', () => {
    expect(parseScreenChoices(fixture('plan-approval-narrow.txt'))).toEqual({
      question: 'Would you like to proceed?',
      options: [
        'Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session',
        'Yes, manually approve edits',
        'Tell Claude what to change',
      ],
      cursor: 0,
      navigate: true,
      key: expect.any(String),
      numbered: true,
      // The plan's title tells one plan from another (not the question every plan asks).
      detail: ['Ready to code?', "Here is Claude's plan:", 'Crear diez.txt'],
    });
  });

  it("keys a plan by its text: the rule under Claude Code 2.1's preview is not the top", () => {
    // From that rule down, every plan had the same key: a late tap on plan A's "Yes, and
    // switch to BYPASS PERMISSIONS" approved plan B (fifth review of 2026-10-03).
    const planA = fixture('plan-approval-live.txt');
    const planB = planA.replace('Crear hola.txt', 'Borrar la base de datos');
    expect(parseScreenChoices(planA)?.key).not.toBe(parseScreenChoices(planB)?.key);
    expect(sameMenuKey(parseScreenChoices(planA)?.key, parseScreenChoices(planB)?.key)).toBe(false);
  });

  it("never takes Codex's header box above its menu for the menu's dialog", () => {
    // Its version, model and folder showed as what an approval approved (fifth review).
    const screen = [
      '╭──────────────────────────────────╮',
      '│ >_ OpenAI Codex (v0.155.1)       │',
      '│ model: gpt-x high                │',
      '╰──────────────────────────────────╯',
      '',
      '  Would you like to run the following command?',
      '  $ ping -c 1 example.com',
      '› 1. Yes, proceed',
      '  2. No, and tell Codex what to do differently (esc)',
      '  Press enter to confirm or esc to cancel',
    ].join('\n');
    const read = parseScreenChoices(screen);
    expect(read?.options).toHaveLength(2);
    // Only the command it asks to run (2026-11-10), never the box above.
    expect(read?.detail).toEqual(['ping -c 1 example.com']);
  });

  it("tells a typed option's number (or y/n) from a reply", () => {
    const menu = { question: 'Proceed?', options: ['Yes', 'Maybe', 'No'], numbered: true };
    expect(optionForTyped(' 2 ', menu)).toBe(2);
    // Without numbers on screen a digit is just a message.
    expect(optionForTyped('2', { ...menu, numbered: undefined })).toBeNull();
    expect(optionForTyped('4', menu)).toBeNull();
    expect(optionForTyped('no, cambia el nombre', menu)).toBeNull();
    const yesNo = { question: 'Overwrite? (y/n)', options: ['Yes', 'No'], keys: ['y', 'n'] };
    expect(optionForTyped('N', yesNo)).toBe(2);
    expect(optionForTyped('1', yesNo)).toBeNull();
  });

  it('finds nothing to answer while Claude works', () => {
    expect(parseScreenChoices(fixture('busy.txt'))).toBeNull();
  });

  it('reads the unnumbered trust-folder dialog as a menu answered by moving its cursor', () => {
    expect(parseScreenChoices(fixture('trust-folder.txt'))).toEqual({
      question: 'Quick safety check: Is this a project you created or one you trust?',
      options: ['No, exit', 'Yes, I trust this folder'],
      cursor: 0,
      navigate: true,
      key: expect.any(String),
      detail: ['Accessing workspace:', '/Users/alexandrapublicdemouser/.untether-', 'qa/qa-git'],
    });
    expect(parseScreenChoices(fixture('trust-folder-yes.txt'))?.cursor).toBe(1);
  });

  it("does not take Codex's prompt (› too) for a menu, idle or working", () => {
    expect(parseScreenChoices(fixture('codex-idle.txt'))).toBeNull();
    expect(parseScreenChoices(fixture('codex-busy.txt'))).toBeNull();
  });

  it("does not take Claude's prompt with a draft of several lines for a menu", () => {
    expect(parseScreenChoices(fixture('prompt-draft.txt'))).toBeNull();
  });

  it('needs the key hints under an unnumbered menu', () => {
    const screen = fixture('trust-folder.txt').replace('Enter to confirm · Esc to cancel', '');
    expect(parseScreenChoices(screen)).toBeNull();
  });

  it("reads Codex's update prompt, titled from the top of the screen", () => {
    expect(parseScreenChoices(fixture('codex-update.txt'))).toEqual({
      question: '✨\u200aUpdate available! 0.155.1 -> 0.160.0',
      options: [
        'Update now (runs `npm install -g @openai/codex`)',
        'Skip',
        'Skip until next version',
      ],
      cursor: 0,
      navigate: true,
      key: expect.any(String),
      numbered: true,
    });
  });

  it("titles Codex's update prompt the same below blank rows, as the phone reads it", () => {
    const screen = `${'\n'.repeat(20)}${fixture('codex-update.txt')}`;
    expect(parseScreenChoices(screen)?.question).toBe(
      '✨\u200aUpdate available! 0.155.1 -> 0.160.0'
    );
  });

  // 2026-11-09: Codex runs inline now (--no-alt-screen). Captured from codex-cli 0.164 against a
  // local mock model: the same dialogs, with blank rows below them and old frames in the history.
  describe('Codex inline', () => {
    const history = fixture('codex-inline-history.txt');
    const layout = { cols: 100, visibleRows: 30 };

    it('sees no menu at the prompt, or while it works', () => {
      expect(parseScreenChoices(fixture('codex-inline-idle.txt'))).toBeNull();
      expect(parseScreenChoices(fixture('codex-inline-busy.txt'))).toBeNull();
    });

    it('reads an approval above the blank rows Codex leaves under it', () => {
      const choices = parseScreenChoices(fixture('codex-inline-approval.txt'));
      expect(choices).toMatchObject({ cursor: 0, navigate: true, numbered: true });
      expect(choices?.options).toEqual([
        'Yes, proceed (y)',
        "Yes, and don't ask again for commands that start with `touch zz-denied` (p)",
        'No, and tell Codex what to do differently (esc)',
      ]);
    });

    it('tells what an approval approves: its command and the reason given (2026-11-10)', () => {
      expect(parseScreenChoices(fixture('codex-inline-approval.txt'))?.detail).toEqual([
        'touch zz-denied',
        'prueba del dialogo',
      ]);
      // As codex-cli 0.164 drew it in the twin: a reason, and a command with a path.
      const screen = [
        '› ASK:touch /tmp/utt-gemelo-p2/fuera.txt',
        '',
        '• Running touch /tmp/utt-gemelo-p2/fuera.txt',
        '',
        '  Would you like to run the following command?',
        '',
        '  Environment: local',
        '',
        '  Reason: Necesito escribir fuera del sandbox',
        '',
        '  $ touch /tmp/utt-gemelo-p2/fuera.txt',
        '    && echo hecho',
        '',
        '› 1. Yes, proceed (y)',
        '  2. No, and tell Codex what to do differently (esc)',
        '',
        '  Press enter to confirm or esc to cancel',
      ].join('\n');
      const read = parseScreenChoices(screen);
      expect(read?.question).toBe('Would you like to run the following command?');
      expect(read?.detail).toEqual([
        'touch /tmp/utt-gemelo-p2/fuera.txt && echo hecho',
        'Necesito escribir fuera del sandbox',
      ]);
      // Another command, the same question and options: another menu.
      const other = parseScreenChoices(screen.replaceAll('fuera.txt', 'otro.txt'));
      expect(sameMenuKey(read?.key, other?.key)).toBe(false);
    });

    it('gives the trust and update prompts no detail: they ask about no command', () => {
      expect(parseScreenChoices(fixture('codex-inline-trust.txt'))?.detail).toBeUndefined();
      expect(parseScreenChoices(fixture('codex-update.txt'))?.detail).toBeUndefined();
    });

    it('reads the trust prompt', () => {
      expect(parseScreenChoices(fixture('codex-inline-trust.txt'))?.options).toEqual([
        'Trust and continue',
        'Back to Agent Command Center',
      ]);
    });

    it('takes a trust prompt left in the history for what it is: over', () => {
      expect(history).toContain('1. Trust and continue');
      expect(parseScreenChoices(history, layout)).toBeNull();
    });
  });

  it("reads Codex's trust prompt by its question", () => {
    expect(parseScreenChoices(fixture('codex-trust.txt'))).toEqual({
      question: 'Do you trust the contents of this directory?',
      options: ['Yes, continue', 'No, quit'],
      cursor: 0,
      navigate: true,
      key: expect.any(String),
      numbered: true,
    });
  });

  it('reads a numbered menu without a question mark, cursor included', () => {
    const screen = [
      ' By proceeding, you accept all responsibility for actions taken.',
      '',
      ' ❯ 1. No, exit',
      '   2. Yes, I accept',
      '',
      ' Enter to confirm · Esc to exit',
    ].join('\n');
    expect(parseScreenChoices(screen)).toEqual({
      question: 'By proceeding, you accept all responsibility for actions taken.',
      options: ['No, exit', 'Yes, I accept'],
      cursor: 0,
      navigate: true,
      key: expect.any(String),
      numbered: true,
    });
  });

  it("takes a numbered list in Claude's answer for text, not a menu", () => {
    // Review of 2026-10-03: read as a menu, the phone typed a bare "2" there, and a reply
    // waited forever for this "dialog" to go away while Claude sat idle at its prompt.
    const answer = [
      '⏺ Two ways to do it. Which one do you prefer?',
      '  1. Rewrite it',
      '  2. Patch it',
    ];
    expect(parseScreenChoices(answer.join('\n'))).toBeNull();
    expect(
      parseScreenChoices([...answer, '', ...fixture('prompt-draft.txt').split('\n')].join('\n'))
    ).toBeNull();
  });

  it("does not take the user's past messages (❯ text in Claude Code 2.1) for a menu", () => {
    const prompt = ['─'.repeat(40), '❯\u00a0', '─'.repeat(40), '  ⏵⏵ bypass permissions on'];
    const wrapped = [
      '❯ rename the helper and update',
      '  every caller in the package',
      '',
      '⏺ Press Esc to leave insert mode, then type :wq to save.',
      '',
      ...prompt,
    ];
    expect(parseScreenChoices(wrapped.join('\n'))).toBeNull();
    const numbered = [
      '❯ 1. rename the helper',
      '  2. update its callers',
      '',
      '⏺ Done.',
      '',
      ...prompt,
    ];
    expect(parseScreenChoices(numbered.join('\n'))).toBeNull();
  });

  it('reads the plan approval by its options when its question is off screen', () => {
    // The phone's keyboard shortens the terminal: the server sees the options without the
    // question the phone read from scrollback; the options identify the menu.
    expect(parseScreenChoices(fixture('plan-approval-short.txt'))).toEqual({
      question: '',
      options: [
        'Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session',
        'Yes, manually approve edits',
        'Tell Claude what to change',
      ],
      cursor: 0,
      navigate: true,
      key: expect.any(String),
      numbered: true,
    });
  });

  it('needs the key named right before "to" in the hints of an unnumbered menu', () => {
    const screen = fixture('trust-folder.txt').replace(
      'Enter to confirm · Esc to cancel',
      'Enter a name to continue'
    );
    expect(parseScreenChoices(screen)).toBeNull();
  });

  it("says what Claude Code 2.1's permission prompt approves, past its tip", () => {
    // "Tip: auto mode handles these prompts for / you — choose …" took two of the three lines
    // and left the command out (2026-10-03).
    expect(parseScreenChoices(fixture('permission-bash-tip.txt'))?.detail).toEqual([
      'Bash command',
      'Create empty file nuevo.txt',
      'touch nuevo.txt && ls -l nuevo.txt',
    ]);
  });

  it('says which line an edit changes, not the context above it', () => {
    expect(parseScreenChoices(fixture('permission-edit.txt'))).toMatchObject({
      detail: ['Edit file', 'diez.txt', '6 +seis'],
      // The real 2.1.288 screen, with its "Nohift+tab)".
      options: [
        'Yes',
        'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session',
        'No',
      ],
    });
  });

  it('drops the tail of a "(shift+tab)" hint Claude Code 2.1 leaves glued to an option', () => {
    // At 45 columns its own redraw left "3. Nohift+tab)" on every permission prompt.
    const screen = fixture('permission-bash-tip.txt').replace('   4. No', '   4. Nohift+tab)');
    expect(parseScreenChoices(screen)?.options.at(-1)).toBe('No');
    // A real hint, after a space, stays.
    const hinted = fixture('permission-bash-tip.txt').replace(
      '   4. No',
      '   4. No, keep going (shift+tab)'
    );
    expect(parseScreenChoices(hinted)?.options.at(-1)).toBe('No, keep going (shift+tab)');
  });

  it("reads a menu's key from the visible screen only, whatever the scrollback holds", () => {
    // The phone's scrollback holds what reached it since it connected, the server's the whole
    // recording: keys read with them differed for the same menu, and a reply was refused
    // (2026-10-03, SE simulator).
    const screen = fixture('permission-bash-tip.txt');
    const rows = screen.split('\n').length;
    const phone = parseScreenChoices(`⏺ what the phone saw\n${screen}`, { visibleRows: rows });
    const server = parseScreenChoices(`⏺ the whole recording\nmore of it\n${screen}`, {
      visibleRows: rows,
    });
    expect(phone?.key).toBe(server?.key);
    expect(sameMenuKey(phone?.key, server?.key)).toBe(true);
  });

  it('tells apart two permission prompts that differ only in what they approve', () => {
    // Same question, same options: without the command a late tap approved the next one.
    const first = parseScreenChoices(fixture('permission-bash.txt'));
    const next = parseScreenChoices(
      fixture('permission-bash.txt').replaceAll('rm -rf dist/ && pnpm build', 'rm -rf ~/Projects')
    );
    expect(next?.question).toBe(first?.question);
    expect(next?.options).toEqual(first?.options);
    expect(next?.detail).not.toEqual(first?.detail);
  });

  it("reads Gemini CLI's tool confirmation, its cursor a ●", () => {
    // Read as nothing, the phone typed a message and Enter into it: "Allow once" (review).
    expect(parseScreenChoices(fixture('gemini-confirm.txt'))).toEqual({
      question: "Allow execution of: 'rm'?",
      options: ['Allow once', 'Allow for this session', 'No, suggest changes (esc)'],
      cursor: 0,
      navigate: true,
      key: expect.any(String),
      numbered: true,
      detail: ['Shell rm -rf build'],
    });
  });

  it("does not take a numbered list typed into Claude's or Codex's input for a menu", () => {
    // Read as one, "1" pressed Enter on the unfinished draft (review of 2026-10-03).
    const rule = '─'.repeat(45);
    const claude = [
      '⏺ Listo: el test pasa.',
      '',
      `${'─'.repeat(30)} mi-sesion ─`,
      '❯ 1. crea otro test para el caso vacío',
      '  2. y otro para las mayúsculas',
      rule,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ];
    expect(parseScreenChoices(claude.join('\n'))).toBeNull();
    const idle = fixture('codex-idle.txt').split('\n');
    const at = idle.findIndex((line) => line.startsWith('› Ask Codex'));
    const codex = [
      ...idle.slice(0, at),
      '› 1. revisa el test',
      '  2. luego haz commit',
      ...idle.slice(at + 1),
    ];
    expect(parseScreenChoices(codex.join('\n'))).toBeNull();
  });

  it('only refuses a written reply on a menu whose option is to exit or quit', () => {
    const permission = parseScreenChoices(
      fixture('permission-bash.txt').replace(
        '/Users/alice/Projects/untether/web',
        '/Users/me/code/exit-survey'
      )
    );
    expect(permission && takesReply(permission)).toBe(true);
    const ask = {
      question: 'How should it stop?',
      options: ['Exit with code 1 Calls process.exit(1)', 'Retry'],
    };
    expect(takesReply(ask)).toBe(true);
    const trust = parseScreenChoices(fixture('trust-folder.txt'));
    expect(trust && takesReply(trust)).toBe(false);
    const codexTrust = parseScreenChoices(fixture('codex-trust.txt'));
    expect(codexTrust && takesReply(codexTrust)).toBe(false);
  });

  it("does not take a yes/no line above Codex's composer for a question waiting", () => {
    const screen = [
      '• Done. Overwrite the old one too? (y/n)',
      '',
      '› Ask Codex to do anything',
      '',
      '  gpt-6-astra xhigh',
    ];
    expect(parseScreenChoices(screen.join('\n'))).toBeNull();
  });
});

describe('claude-waiting push', () => {
  it('watches a shielded session through the program inside tmux, where Claude runs', async () => {
    // Its own pid is tmux's client, with no Claude under it: shielded sessions (the default)
    // never pushed "finished" or "needs you" (2026-10-03, no push all day on the iPhone).
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const source = {
      listSessions: () => [
        { id: 'plain', name: 'a', pid: 10, status: 'running' },
        { id: 'shield', name: 'b', pid: 20, status: 'running', shielded: true },
      ],
      programRootPid: (s: { pid?: number; shielded?: boolean }) => (s.shielded ? 99 : s.pid),
    };
    expect(watchedSessions(source).map((s) => s.pid)).toEqual([10, 99]);
    const notifier = new ClaudeStatusNotifier(
      () => watchedSessions(source),
      notify,
      async (pids) => new Map(pids.filter((pid) => pid === 99).map((pid) => [pid, status]))
    );
    await notifier.tick();
    status = { status: 'idle' };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ type: 'claude-finished' });
  });

  it('notices a turn that started and ended between two looks', async () => {
    // A quick answer went idle → busy → idle within the 3 s between looks: no "finished"
    // (2026-10-03). Claude stamps each status change (statusUpdatedAt, here `since`).
    let status: ClaudeStatus = { status: 'idle', since: 1 };
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'claude', pid: 42, status: 'running' }],
      notify,
      async () => new Map([[42, status]])
    );
    await notifier.tick();
    await notifier.tick(); // Unchanged: nothing.
    status = { status: 'idle', since: 2 };
    await notifier.tick();
    expect(notify.mock.calls.map((c) => c[0].type)).toEqual(['claude-finished']);
    status = { status: 'busy', since: 3 };
    await notifier.tick();
    status = { status: 'busy', since: 4 }; // Busy again: says nothing about in between.
    await notifier.tick();
    status = { status: 'waiting', since: 5, waitingFor: 'permission' };
    await notifier.tick();
    status = { status: 'waiting', since: 6, waitingFor: 'permission' }; // A new question.
    await notifier.tick();
    expect(notify.mock.calls.map((c) => c[0].type)).toEqual([
      'claude-finished',
      'claude-waiting',
      'claude-waiting',
    ]);
  });

  it('carries the on-screen choices', async () => {
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'claude', pid: 42, status: 'running' }],
      notify,
      async () => new Map([[42, status]]),
      undefined,
      async (sessionId) =>
        sessionId === 's1' ? parseScreenChoices(fixture('permission-bash.txt')) : null
    );
    await notifier.tick();
    status = { status: 'waiting', waitingFor: 'permission to run Bash' };
    await notifier.tick();

    const payload = notify.mock.calls[0][0];
    expect(payload.data.choices.question).toBe('Do you want to proceed?');
    expect(payload.data.choices.options).toHaveLength(3);
    expect(payload.data.choices.options[0]).toBe('Yes');
    // Small enough for Web Push, whatever is on screen.
    expect(payload.data.choices.options.every((o: string) => o.length <= 80)).toBe(true);
    expect(JSON.stringify(payload).length).toBeLessThan(3000);
  });

  it('says on the lock screen what Claude asks to do, not just "permission prompt"', async () => {
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'claude', pid: 42, status: 'running' }],
      notify,
      async () => new Map([[42, status]]),
      undefined,
      async () => parseScreenChoices(fixture('permission-bash-tip.txt'))
    );
    await notifier.tick();
    status = { status: 'waiting', waitingFor: 'permission prompt' };
    await notifier.tick();

    const payload = notify.mock.calls[0][0];
    const asks = 'Create empty file nuevo.txt · touch nuevo.txt && ls -l nuevo.txt';
    expect(payload.body).toBe(asks);
    // The service worker rebuilds the body in the phone's language from this.
    expect(payload.data.detail).toBe(asks);
    // And the answer sheet opens with it before re-reading the screen.
    expect(payload.data.choices.detail).toEqual([
      'Bash command',
      'Create empty file nuevo.txt',
      'touch nuevo.txt && ls -l nuevo.txt',
    ]);
    expect(JSON.stringify(payload).length).toBeLessThan(3000);
  });

  it('still notifies when the screen cannot be read', async () => {
    let status: ClaudeStatus = { status: 'busy' };
    const notify = vi.fn();
    const notifier = new ClaudeStatusNotifier(
      () => [{ id: 's1', name: 'claude', pid: 42, status: 'running' }],
      notify,
      async () => new Map([[42, status]]),
      undefined,
      async () => {
        throw new Error('snapshot failed');
      }
    );
    await notifier.tick();
    status = { status: 'waiting' };
    await notifier.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].data.choices).toBeUndefined();
  });
});

describe('a dialog that counts down (2026-11-09)', () => {
  const wrap = (text: string, cols: number) =>
    text
      .split('\n')
      .flatMap((line) => {
        if (line.length <= cols || !line.includes('automatically block')) return [line];
        const rows: string[] = [];
        let row = '';
        for (const word of line.trim().split(' ')) {
          if (`${row} ${word}`.length > cols) {
            rows.push(` ${row}`);
            row = word;
          } else row = row ? `${row} ${word}` : word;
        }
        return [...rows, ` ${row}`];
      })
      .join('\n');
  const screen = fixture('permission-countdown.txt');

  it.each([120, 86, 45])('keeps its key while the clock ticks at %i columns', (cols) => {
    const at = (clock: string) => parseScreenChoices(wrap(screen.replace('1:59', clock), cols));
    expect(at('1:59')?.key).toBeTruthy();
    expect(at('0:03')?.key).toBe(at('1:59')?.key);
  });

  it('still tells another command apart, and keeps the words of the warning', () => {
    const key = parseScreenChoices(screen)?.key ?? '';
    const other = parseScreenChoices(screen.replaceAll('build.old', 'build.bak'))?.key;
    expect(sameMenuKey(key, other)).toBe(false);
    expect(key).toContain('automaticallyblockthisrequestin,toavoid');
    // A clock inside the command is not a countdown: it stays.
    const at = (time: string) =>
      parseScreenChoices(screen.replaceAll('mv build build.old', `at ${time} mv build`))?.key;
    expect(sameMenuKey(at('12:30'), at('12:31'))).toBe(false);
  });

  it('keeps a clock in a command, even one that reads like the countdown (review 2026-11-09)', () => {
    const key = (command: string) =>
      parseScreenChoices(screen.replaceAll('mv build build.old', command))?.key;
    expect(sameMenuKey(key('rm /tmp/in1:20'), key('rm /tmp/in1:21'))).toBe(false);
    expect(sameMenuKey(key('sleep in 1:20'), key('sleep in 1:21'))).toBe(false);
    const faked = (clock: string) =>
      parseScreenChoices(
        screen.replace(
          ' │ mv build build.old',
          ` │ ⚠ Claude Code will automatically block this request in ${clock}, rm x`
        )
      )?.key;
    expect(sameMenuKey(faked('1:20'), faked('1:21'))).toBe(false);
  });

  it('shows what is asked, not the countdown', () => {
    const detail = parseScreenChoices(screen)?.detail ?? [];
    expect(detail.join(' ')).toContain('mv build build.old');
    expect(detail.join(' ')).not.toContain('automatically');
  });
});
