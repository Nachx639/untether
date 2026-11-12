/**
 * Copying from the web terminal in real browsers (Chromium and WebKit, as Chrome and Safari on
 * the Mac). Run with: pnpm exec tsx src/test/terminal-copy.browser.ts
 *
 * 2026-10-31, user report: select in the terminal, Cmd+C, and the paste was a lone "-". The
 * drag's selection ended after one or two cells: ghostty-web auto-scrolled it to the first or
 * last row near the canvas's edges (Claude Code's prompt rows), and the IME input over the
 * cursor's row took the mouse events (terminal-clipboard.ts). Each case below failed before.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserType, chromium, type Page, webkit } from '@playwright/test';
import { RM_TEST_DIR } from './helpers/rm-test-dir.js';
import { type SystemSoundGuard, watchSystemSounds } from './helpers/system-sound-guard.js';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

async function bundle(): Promise<string> {
  const esbuild = require(path.join(webRoot, 'node_modules/esbuild'));
  const { commonOptions } = require(path.join(webRoot, 'scripts/esbuild-config.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-copy-'));
  const entry = path.join(dir, 'entry.ts');
  const src = (file: string) => JSON.stringify(path.join(webRoot, 'src/client/components', file));
  fs.writeFileSync(
    entry,
    `import ${src('terminal.ts')};\nimport { DesktopIMEInput } from ${src('ime-input.ts')};\n` +
      'Object.assign(window, { DesktopIMEInput });\n'
  );
  try {
    const result = await esbuild.build({
      ...commonOptions,
      entryPoints: [entry],
      write: false,
      outfile: path.join(dir, 'bundle.js'),
      sourcemap: false,
      nodePaths: [path.join(webRoot, 'node_modules')],
      logLevel: 'error',
    });
    const js = result.outputFiles.find((file: { path: string }) => file.path.endsWith('.js'));
    return js.text;
  } finally {
    fs.rmSync(dir, RM_TEST_DIR);
  }
}

const PAGE = `<!doctype html><html><body style="margin:0;background:#111">
<div style="width:800px;height:408px"><ut-terminal id="t" session-id="copy-test"></ut-terminal></div>
<input id="field" value="field text" style="position:absolute;top:440px">
<script>
  window.__copies = [];
  window.__input = [];
  // After the page's own copy handlers: what this copy puts on the clipboard.
  window.addEventListener('copy', (e) => {
    window.__copies.push({ prevented: e.defaultPrevented, text: e.clipboardData.getData('text/plain') });
    // Nothing selected anywhere: the browser's own copy has nothing to act on and WebKit plays
    // the system alert sound (2026-11-03). What the page did is recorded above.
    const field = document.activeElement;
    const fieldSelection = field && 'selectionStart' in field && field.selectionStart !== field.selectionEnd;
    if (!e.defaultPrevented && !document.getSelection()?.toString() && !fieldSelection) e.preventDefault();
  });
  document.addEventListener('terminal-input', (e) => window.__input.push(e.detail.text));
</script>
<script type="module" src="/bundle.js"></script></body></html>`;

type Cell = { row: number; col: number };

class TerminalPage {
  constructor(
    readonly page: Page,
    readonly name: string
  ) {}

  async write(text: string) {
    await this.page.evaluate((data) => {
      (document.getElementById('t') as unknown as { write(d: string): void }).write(data);
    }, text);
    await this.page.waitForTimeout(150);
  }

  async size(): Promise<{ cols: number; rows: number }> {
    return this.page.evaluate(() => {
      const term = (
        document.getElementById('t') as unknown as { terminal: { cols: number; rows: number } }
      ).terminal;
      return { cols: term.cols, rows: term.rows };
    });
  }

  async point(cell: Cell): Promise<[number, number]> {
    const box = await this.page.locator('#t canvas').first().boundingBox();
    assert(box);
    const { cols, rows } = await this.size();
    return [
      box.x + (box.width / cols) * (cell.col + 0.5),
      box.y + (box.height / rows) * (cell.row + 0.5),
    ];
  }

  async drag(from: Cell, to: Cell, modifier?: 'Shift' | 'Alt') {
    if (modifier) await this.page.keyboard.down(modifier);
    const [x0, y0] = await this.point(from);
    const [x1, y1] = await this.point(to);
    await this.page.mouse.move(x0, y0);
    await this.page.mouse.down();
    await this.page.mouse.move(x1, y1, { steps: 12 });
    // Holding still a moment, as a hand does (ghostty's auto-scroll ran every 50 ms).
    await this.page.waitForTimeout(250);
    await this.page.mouse.up();
    if (modifier) await this.page.keyboard.up(modifier);
    await this.page.waitForTimeout(100);
  }

  /** Cmd+C: what the copy event put on the clipboard (null: the page did not handle it). */
  async copy(): Promise<{ prevented: boolean; text: string }> {
    await this.page.evaluate(() => {
      (window as unknown as { __copies: unknown[] }).__copies = [];
    });
    await this.page.keyboard.press('Meta+c');
    await this.page.waitForTimeout(100);
    const copies = await this.page.evaluate(
      () =>
        (window as unknown as { __copies: Array<{ prevented: boolean; text: string }> }).__copies
    );
    assert.equal(copies.length, 1, `${this.name}: one copy event`);
    return copies[0];
  }

  async reset() {
    await this.write('\x1b[?1002l\x1b[?1006l\x1b[?1049l\x1bc');
    await this.page.evaluate(() => {
      const t = document.getElementById('t') as unknown as { terminal: { clearSelection(): void } };
      t.terminal.clearSelection();
      (window as unknown as { __input: unknown[] }).__input = [];
    });
  }

  async selected(): Promise<string> {
    return this.page.evaluate(() =>
      (document.getElementById('t') as unknown as { getSelectedText(): string }).getSelectedText()
    );
  }
}

async function run(type: BrowserType, name: string, url: string, sounds: SystemSoundGuard) {
  sounds.mark(`${name}: launch`);
  const browser: Browser = await type.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1000, height: 600 },
      ...(name === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}),
    });
    // tsx keeps function names with a __name() helper the page does not have.
    await context.addInitScript('window.__name = (fn) => fn;');
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error(name, 'page error', error.message));
    await page.goto(url);
    await page.waitForFunction(
      () => (document.getElementById('t') as unknown as { terminal?: unknown })?.terminal
    );
    await page.waitForTimeout(300);
    const t = new TerminalPage(page, name);
    const { cols, rows } = await t.size();
    const last = rows - 1;

    sounds.mark(`${name}: step 1`);
    // 1. The report: Claude Code's full screen (no history), its prompt between rules on the
    //    last rows. A drag over them selected one or two cells ("-").
    await t.reset();
    const rule = '─'.repeat(cols);
    await t.write(
      `\x1b[?1049h\x1b[2J\x1b[1;1HRespuesta de Claude - con guion\x1b[${rows - 2};1H${rule}` +
        `\x1b[${rows - 1};1H❯ comando - con guion\x1b[${rows};1H${rule}\x1b[${rows - 1};22H`
    );
    // The IME input sits over the cursor's row, as in the session view.
    await page.evaluate(() => {
      const root = document.querySelector('#t .terminal-root') as HTMLElement;
      const Ime = (window as unknown as { DesktopIMEInput: new (o: unknown) => { focus(): void } })
        .DesktopIMEInput;
      const t = document.getElementById('t') as unknown as {
        getCursorInfo?: unknown;
        terminal: { rows: number };
      };
      const canvas = document.querySelector('#t canvas') as HTMLCanvasElement;
      const ime = new Ime({
        container: root,
        onTextInput: () => {},
        getCursorInfo: () => {
          const box = canvas.getBoundingClientRect();
          return { x: 0, y: (box.height / t.terminal.rows) * (t.terminal.rows - 2) + 4 };
        },
      });
      ime.focus();
    });
    // The first rows, where ghostty auto-scrolled the end up to the first cell.
    await t.drag({ row: 0, col: 0 }, { row: 1, col: 30 });
    assert.equal(await t.selected(), 'Respuesta de Claude - con guion', `${name}: top rows`);
    // The prompt row, right to left (ghostty auto-scrolled the end down to the last cell, and
    // the IME input over this row took the mouse in WebKit).
    await t.drag({ row: last - 1, col: 20 }, { row: last - 1, col: 2 });
    assert.equal(await t.selected(), 'comando - con guion', `${name}: prompt row selected`);
    let copied = await t.copy();
    assert.deepEqual(copied, { prevented: true, text: 'comando - con guion' }, `${name}: Cmd+C`);
    if (name === 'chromium') {
      assert.equal(
        await page.evaluate(() => navigator.clipboard.readText()),
        'comando - con guion'
      );
    }
    // The prompt with its rules: the text alone.
    await t.drag({ row: last - 2, col: 0 }, { row: last, col: cols - 1 });
    assert.equal(await t.selected(), 'comando - con guion', `${name}: prompt rows, no rules`);

    sounds.mark(`${name}: step 2`);
    // 2. Printed lines: soft wraps joined, padding dropped, wide characters and graphemes whole.
    await t.reset();
    const long = `inicio ${'x'.repeat(cols)} fin`;
    await t.write(`${long}\r\n日本語 🎉 café ok    \r\nfinal`);
    await t.drag({ row: 0, col: 0 }, { row: 3, col: 4 });
    assert.equal(await t.selected(), `${long}\n日本語 🎉 café ok\nfinal`, `${name}: printed lines`);
    copied = await t.copy();
    assert.equal(copied.text, `${long}\n日本語 🎉 café ok\nfinal`, `${name}: Cmd+C printed lines`);

    sounds.mark(`${name}: step 3`);
    // 3. Option+drag: a block of columns.
    await t.reset();
    await t.write('a 111 b\r\nc 222 d\r\ne 333 f');
    await t.drag({ row: 0, col: 2 }, { row: 2, col: 4 }, 'Alt');
    assert.equal(await t.selected(), '111\n222\n333', `${name}: block selection`);

    sounds.mark(`${name}: step 4`);
    // 4. An app that tracks the mouse gets plain drags; Shift+drag selects locally.
    await t.reset();
    await t.write('\x1b[?1049h\x1b[?1002h\x1b[?1006hlinea de la app');
    await t.drag({ row: 0, col: 0 }, { row: 0, col: 8 });
    const reports = await page.evaluate(() =>
      (window as unknown as { __input: string[] }).__input.join('')
    );
    const sgr = reports.replaceAll('\x1b', 'ESC');
    assert.match(sgr, /^ESC\[<0;1;1M/, `${name}: press reported`);
    assert.match(sgr, /ESC\[<32;\d+;1M/, `${name}: drag reported`);
    assert.match(sgr, /ESC\[<0;9;1m$/, `${name}: release reported`);
    assert.equal(await t.selected(), '', `${name}: no local selection for the app's drag`);
    await t.drag({ row: 0, col: 0 }, { row: 0, col: 4 }, 'Shift');
    assert.equal(await t.selected(), 'linea', `${name}: Shift+drag selects locally`);

    sounds.mark(`${name}: step 5`);
    // 5. Nothing selected: Cmd+C is the browser's; a field's own selection wins.
    await t.reset();
    copied = await t.copy();
    assert.equal(copied.prevented, false, `${name}: no selection, copy untouched`);
    await t.write('hola');
    await t.drag({ row: 0, col: 0 }, { row: 0, col: 3 });
    await page.evaluate(() => {
      const field = document.getElementById('field') as HTMLInputElement;
      field.focus();
      field.select();
    });
    copied = await t.copy();
    assert.equal(copied.prevented, false, `${name}: a field's selection is copied by the browser`);

    sounds.mark(`${name}: step 6`);
    // 6. An app's copy (OSC 52): written right after a key or click while shown; offered with
    //    a button when nobody asked for it; never from a hidden terminal.
    if (name === 'chromium') {
      const appCopy = (text: string) =>
        page.evaluate((value) => {
          (
            document.getElementById('t') as unknown as { copyFromApp(r: unknown): void }
          ).copyFromApp({
            text: value,
          });
        }, text);
      const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
      await page.evaluate(() => navigator.clipboard.writeText('antes'));
      await page.keyboard.press('Shift');
      await appCopy('copiado por la app – ñ');
      await page.waitForTimeout(200);
      assert.equal(await clipboard(), 'copiado por la app – ñ', `${name}: app copy after a key`);
      await page.evaluate(() => {
        const t = document.getElementById('t') as unknown as HTMLElement & {
          copyFromApp(r: unknown): void;
        };
        t.style.display = 'none';
        t.copyFromApp({ text: 'oculto' });
        t.style.display = '';
      });
      await page.waitForTimeout(200);
      assert.equal(await clipboard(), 'copiado por la app – ñ', `${name}: hidden terminal`);
      // Output nobody asked for: the toast shows it and its button copies it.
      await page.waitForTimeout(3200);
      await appCopy('sin pedir');
      await page.waitForTimeout(200);
      assert.equal(await clipboard(), 'copiado por la app – ñ', `${name}: unasked copy waits`);
      const toastBox = page.locator('.ut-toast', { hasText: 'sin pedir' });
      await toastBox.locator('button', { hasText: 'Copy' }).click();
      await page.waitForTimeout(200);
      assert.equal(await clipboard(), 'sin pedir', `${name}: the toast's button copies`);
    }
    console.log(`${name}: terminal copy ok (${cols}x${rows})`);
  } finally {
    await browser.close();
  }
}

async function main() {
  const script = await bundle();
  const wasm = fs.readFileSync(path.join(webRoot, 'node_modules/ghostty-web/ghostty-vt.wasm'));
  const server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(script);
    } else if (req.url === '/ghostty-vt.wasm') {
      res.setHeader('Content-Type', 'application/wasm');
      res.end(wasm);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(PAGE);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  // A test that makes a browser beep fails (see system-sound-guard.ts).
  const sounds = await watchSystemSounds();
  try {
    await run(chromium, 'chromium', url, sounds);
    await run(webkit, 'webkit', url, sounds);
    const beeps = await sounds.stop();
    assert.equal(beeps.length, 0, `the browsers beeped:\n${sounds.describe(beeps)}`);
    if (!sounds.watching) console.log('system alert sounds not watched (no macOS log)');
  } finally {
    await sounds.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
