// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_COPY_INPUT_WINDOW_MS,
  type AppCopyResult,
  type CopyRow,
  type CopyWasm,
  cleanCopiedLines,
  copyPreview,
  copyText,
  DesktopCopy,
  decodeOsc52,
  OSC52_MAX_CHARS,
  Osc52Scanner,
  readCopyRow,
} from './terminal-clipboard.js';

const row = (text: string, continues = false): CopyRow => ({ cells: Array.from(text), continues });
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe('copyText', () => {
  it('joins soft-wrapped rows into the printed line and drops trailing padding', () => {
    const rows = [row('Un texto largo par'), row('a el arranque     ', true), row('otra   ')];
    expect(copyText(rows, { col: 0, row: 0 }, { col: 17, row: 2 })).toBe(
      'Un texto largo para el arranque\notra'
    );
  });

  it('starts and ends where the selection does', () => {
    const rows = [row('hello world'), row('second line - dash')];
    expect(copyText(rows, { col: 6, row: 4 }, { col: 5, row: 5 })).toBe('world\nsecond');
  });

  it('takes the same columns of every row for a block selection, without joining', () => {
    const rows = [row('ab 123 cd'), row('ef 456 gh', true), row('ij 789')];
    expect(copyText(rows, { col: 3, row: 0 }, { col: 5, row: 2 }, true)).toBe('123\n456\n789');
    // Dragged from the right: the same block.
    expect(copyText(rows, { col: 5, row: 0 }, { col: 3, row: 2 }, true)).toBe('123\n456\n789');
  });

  it('keeps wide characters and graphemes as they were printed', () => {
    // "日本" takes four cells; the tail of each is ''.
    const wide: CopyRow = { cells: ['日', '', '本', '', '👍🏽', '', ' ', 'é'], continues: false };
    expect(copyText([wide], { col: 0, row: 0 }, { col: 7, row: 0 })).toBe('日本👍🏽 é');
  });
});

describe('cleanCopiedLines', () => {
  it("leaves out Claude Code's prompt box around the text", () => {
    expect(
      cleanCopiedLines([
        '╭──────────────╮',
        '│ > hola mundo │',
        '│   segunda    │',
        '╰──────────────╯',
      ])
    ).toEqual(['hola mundo', '  segunda']);
  });

  it("leaves out the rules around Claude Code's prompt and its marker", () => {
    expect(
      cleanCopiedLines(['Respuesta - final', '─'.repeat(30), '❯ mi pregunta', '─'.repeat(30)])
    ).toEqual(['Respuesta - final', 'mi pregunta']);
  });

  it('keeps a rule that is all that was selected, and tree drawings', () => {
    expect(cleanCopiedLines(['────────'])).toEqual(['────────']);
    expect(cleanCopiedLines(['src', '├── a.ts', '└── b.ts'])).toEqual([
      'src',
      '├── a.ts',
      '└── b.ts',
    ]);
  });

  it('keeps tables, square boxes and markdown as printed', () => {
    const table = [
      '┌─────┬─────┐',
      '│ a   │ b   │',
      '├─────┼─────┤',
      '│ 1   │ 2   │',
      '└─────┴─────┘',
    ];
    expect(cleanCopiedLines(table)).toEqual(table);
    const nu = ['╭───┬───╮', '│ # │ x │', '╰───┴───╯'];
    expect(cleanCopiedLines(nu)).toEqual(nu);
    const md = ['texto', '---', '> cita'];
    expect(cleanCopiedLines(md)).toEqual(md);
  });

  it('keeps a quote marker that does not follow a rule', () => {
    expect(cleanCopiedLines(['> citado', 'texto'])).toEqual(['> citado', 'texto']);
  });
});

describe('readCopyRow', () => {
  const cell = (ch: string, width = 1) => ({
    codepoint: ch ? (ch.codePointAt(0) as number) : 0,
    width,
    grapheme_len: 0,
  });
  const wasm = (history: string[][], screen: ReturnType<typeof cell>[][], wrapped: boolean[]) =>
    ({
      getScrollbackLength: () => history.length,
      getScrollbackLine: (r: number) => history[r]?.map((ch) => cell(ch)) ?? null,
      getLine: (r: number) => screen[r] ?? null,
      isRowWrapped: (r: number) => wrapped[r] ?? false,
      getGraphemeString: () => '',
      getScrollbackGraphemeString: () => '',
      isAlternateScreen: () => false,
    }) as CopyWasm;

  it("leaves a wide character's tail empty instead of a space", () => {
    const w = wasm([], [[cell('日', 2), cell('', 0), cell('x'), cell('')]], [false]);
    expect(readCopyRow(w, 0).cells).toEqual(['日', '', 'x', ' ']);
  });

  it('reads the wrap flag on screen and guesses it for history rows from a full row', () => {
    const history = [
      Array.from('abcd'),
      Array.from('ef  '),
      Array.from('────'),
      Array.from('gh  '),
    ];
    const w = wasm(history, [[cell('i')]], [true]);
    expect(readCopyRow(w, 1).continues).toBe(true);
    expect(readCopyRow(w, 2).continues).toBe(false);
    // A full-width rule is not a wrap.
    expect(readCopyRow(w, 3).continues).toBe(false);
    expect(readCopyRow(w, 4).continues).toBe(true);
  });
});

describe('Osc52Scanner', () => {
  it('finds a write ended by BEL or ST and decodes UTF-8', () => {
    const scanner = new Osc52Scanner();
    expect(scanner.push(`a\x1b]52;c;${b64('hola – ñ 日本')}\x07b`)).toEqual([
      { text: 'hola – ñ 日本' },
    ]);
    expect(scanner.push(`\x1b]52;;${b64('dos')}\x1b\\`)).toEqual([{ text: 'dos' }]);
  });

  it('finds one split across chunks, also inside its prefix and its ST', () => {
    const scanner = new Osc52Scanner();
    const sequence = `\x1b]52;c;${b64('partido')}\x1b\\`;
    const found = [];
    for (const piece of [
      sequence.slice(0, 2),
      sequence.slice(2, 9),
      sequence.slice(9, -1),
      sequence.slice(-1),
    ]) {
      found.push(...scanner.push(piece));
    }
    expect(found).toEqual([{ text: 'partido' }]);
  });

  it('never answers a query nor clears the clipboard', () => {
    const scanner = new Osc52Scanner();
    expect(scanner.push('\x1b]52;c;?\x07\x1b]52;c;\x07')).toEqual([]);
    expect(decodeOsc52('c;?')).toBeNull();
    expect(decodeOsc52('c;not base64!')).toBeNull();
  });

  it('an unended write does not swallow the next one; CAN cancels one', () => {
    const scanner = new Osc52Scanner();
    expect(scanner.push(`\x1b]52;c;${b64('sin fin')} y texto`)).toEqual([]);
    expect(scanner.push(`\x1b]52;c;${b64('siguiente')}\x07`)).toEqual([{ text: 'siguiente' }]);
    expect(scanner.push(`\x1b]52;c;${b64('cancelado')}\x18\x07`)).toEqual([]);
    expect(scanner.push(`\x1b]52;c;${b64('luego')}\x07`)).toEqual([{ text: 'luego' }]);
  });

  it('drops a write cut off by another sequence', () => {
    const scanner = new Osc52Scanner();
    expect(scanner.push(`\x1b]52;c;${b64('x')}\x1b[2J\x1b]52;c;${b64('y')}\x07`)).toEqual([
      { text: 'y' },
    ]);
  });

  it('reports a payload over the limit without keeping it', () => {
    const scanner = new Osc52Scanner();
    const big = 'A'.repeat(Math.ceil((OSC52_MAX_CHARS * 16) / 3) + 100);
    const found = [
      ...scanner.push(`\x1b]52;c;${big.slice(0, 1000)}`),
      ...scanner.push(big),
      ...scanner.push('\x07ok'),
    ];
    expect(found).toEqual([{ tooLong: true }]);
    expect(scanner.push(`\x1b]52;c;${b64('after')}\x07`)).toEqual([{ text: 'after' }]);
  });
});

describe('DesktopCopy.copyFromApp', () => {
  const copies: DesktopCopy[] = [];
  const setup = (onScreen: boolean) => {
    const results: AppCopyResult[] = [];
    const copy = new DesktopCopy({
      terminal: () => null,
      canvas: () => null,
      mouseReport: () => '',
      sendToApp: () => {},
      isEmulatedMouse: () => false,
      onScreen: () => onScreen,
      notify: (result) => results.push(result),
    });
    // Listens for the user's keys and clicks from here on.
    copy.attach({} as never, document.createElement('div'));
    copies.push(copy);
    return { copy, results };
  };
  const key = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }));
  const writes: string[] = [];
  let reject = false;
  beforeEach(() => {
    for (const copy of copies.splice(0)) copy.detach();
    writes.length = 0;
    reject = false;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (reject) throw new DOMException('no gesture', 'NotAllowedError');
          writes.push(text);
        },
      },
    });
  });

  it('writes the text right after a key or click, and says what it copied', async () => {
    const { copy, results } = setup(true);
    key();
    copy.copyFromApp({ text: 'hola' });
    await vi.waitFor(() => expect(results).toEqual([{ kind: 'copied', text: 'hola' }]));
    expect(writes).toEqual(['hola']);
  });

  it('only offers a copy nobody asked for (no key or click just before)', async () => {
    const { copy, results } = setup(true);
    copy.copyFromApp({ text: 'rm -rf ~' });
    expect(results[0]).toMatchObject({ kind: 'blocked', unasked: true, text: 'rm -rf ~' });
    expect(writes).toEqual([]);
    const now = performance.now();
    key();
    vi.spyOn(performance, 'now').mockReturnValue(now + APP_COPY_INPUT_WINDOW_MS + 1);
    copy.copyFromApp({ text: 'tarde' });
    vi.restoreAllMocks();
    expect(results[1]).toMatchObject({ kind: 'blocked', unasked: true });
    // The toast's button: the user's click copies it.
    expect(await (results[0] as Extract<AppCopyResult, { kind: 'blocked' }>).retry()).toBe(true);
    expect(writes).toEqual(['rm -rf ~']);
  });

  it('never writes from a terminal that is not on screen', async () => {
    const { copy, results } = setup(false);
    key();
    copy.copyFromApp({ text: 'oculto' });
    copy.copyFromApp({ tooLong: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writes).toEqual([]);
    expect(results).toEqual([]);
  });

  it('offers a retry when the browser blocks the write, and says when it is too long', async () => {
    const { copy, results } = setup(true);
    reject = true;
    key();
    copy.copyFromApp({ text: 'bloqueado' });
    await vi.waitFor(() => expect(results[0]?.kind).toBe('blocked'));
    expect(results[0]).toMatchObject({ unasked: false });
    reject = false;
    const blocked = results[0] as Extract<AppCopyResult, { kind: 'blocked' }>;
    expect(await blocked.retry()).toBe(true);
    expect(writes).toEqual(['bloqueado']);
    copy.copyFromApp({ tooLong: true });
    expect(results[1]).toEqual({ kind: 'tooLong' });
  });
});

describe('copyPreview', () => {
  it('shows the start of the text on one line', () => {
    expect(copyPreview('uno\n  dos\ttres')).toBe('uno ⏎ dos tres');
    expect(copyPreview('x'.repeat(60), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
