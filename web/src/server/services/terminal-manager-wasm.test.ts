import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import { resolveGhosttyWasmPath, TerminalManager } from './terminal-manager.js';
import { draftOnScreen } from './user-input-guard.js';

// The real ghostty-web and its WASM: the test setup mocks the module for unit tests.
vi.unmock('ghostty-web');

describe('resolveGhosttyWasmPath', () => {
  let testRoot: string | undefined;

  afterEach(async () => {
    if (testRoot) {
      await rm(testRoot, RM_TEST_DIR);
      testRoot = undefined;
    }
  });

  it('finds the wasm asset next to a bundled npm package lib directory', async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), 'untether-wasm-'));
    const moduleDir = path.join(testRoot, 'lib');
    const wasmPath = path.join(testRoot, 'public', 'ghostty-vt.wasm');
    await mkdir(moduleDir, { recursive: true });
    await mkdir(path.dirname(wasmPath), { recursive: true });
    await writeFile(wasmPath, 'wasm');

    expect(resolveGhosttyWasmPath(moduleDir)).toBe(wasmPath);
  });

  it('finds the installed ghostty-web wasm before assets are copied', () => {
    expect(resolveGhosttyWasmPath(path.join(tmpdir(), 'missing-module'))).toContain(
      'ghostty-web/ghostty-vt.wasm'
    );
  });
});

describe('TerminalManager terminals on the real WASM', () => {
  let controlDir: string | undefined;
  let manager: TerminalManager | undefined;

  afterEach(async () => {
    manager?.destroy();
    manager = undefined;
    if (controlDir) {
      await rm(controlDir, RM_TEST_DIR);
      controlDir = undefined;
    }
  });

  /** A session whose cast file has a 45x30 header and `output` as its only event. */
  async function writeSession(dir: string, sessionId: string, output: string) {
    const header = JSON.stringify({ version: 2, width: 45, height: 30 });
    await mkdir(path.join(dir, sessionId), { recursive: true });
    await writeFile(
      path.join(dir, sessionId, 'stdout'),
      `${header}\n${JSON.stringify([0.1, 'o', output])}\n`
    );
  }

  it("never shows a closed session's text in a new session's screen", async () => {
    controlDir = await mkdtemp(path.join(tmpdir(), 'untether-ghostty-'));
    let oldOutput = '';
    for (let i = 1; i <= 4000; i++) {
      oldOutput += `línea ${i} · el veloz murciélago hindú comía feliz cardillo y kiwi\r\n`;
    }
    await writeSession(controlDir, 'old', oldOutput);
    // Only one word, on row 5: every other cell of the new screen was never written.
    await writeSession(controlDir, 'new', '\x1b[5;3Hhola');
    manager = new TerminalManager(controlDir);

    expect((await manager.getRecentText('old')).text).toContain('murciélago');
    manager.closeTerminal('old');

    const recent = (await manager.getRecentText('new')).text;
    const screen = (await manager.getBufferSnapshot('new')).cells
      .map((row) => row.map((cell) => cell.char).join(''))
      .join('\n');
    expect(recent).toContain('hola');
    expect(screen).toContain('hola');
    expect(recent).not.toMatch(/murci|línea/);
    expect(screen).not.toMatch(/murci|línea/);
  });

  // 2026-11-10 (task 5690cffb, Codex 0.164): its empty prompt as it was recorded. The guard of
  // the user's own input read the greyed placeholder as a draft (it took the italic bit for
  // "dim"), so the task's brief was never typed: 50 min "working" on an empty prompt.
  it("Codex's greyed placeholder is no draft of the user's; typed text is", async () => {
    controlDir = await mkdtemp(path.join(tmpdir(), 'untether-ghostty-'));
    const empty =
      '\x1b[6;1H\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[7;1H\x1b[22m \x1b[8;1H  ' +
      '\x1b[38;5;223;49mGPT-6-Astra medium\x1b[39;49m · \x1b[38;5;151;49m~/Projects/x\x1b[39;49m  ⚠ ' +
      '\x1b[38;5;179;49m2 warnings\x1b[39;49m · \x1b[1mf2\x1b[22m to view\x1b[39m\x1b[49m\x1b[0m\x1b[6;3H';
    await writeSession(controlDir, 'codex-empty', empty);
    await writeSession(
      controlDir,
      'codex-draft',
      `${empty}\x1b[6;1H\x1b[K\x1b[1m›\x1b[22m arregla el test`
    );
    manager = new TerminalManager(controlDir);
    const cells = async (id: string) => (await manager.getBufferSnapshot(id)).cells;
    const text = (await cells('codex-empty')).map((row) => row.map((c) => c.char).join(''));
    expect(text.join('\n')).toContain('› Ask Codex to do anything');
    expect(draftOnScreen(await cells('codex-empty'))).toBe(false);
    expect(draftOnScreen(await cells('codex-draft'))).toBe(true);
  });

  it('gives two reads of a new session at once the same terminal', async () => {
    controlDir = await mkdtemp(path.join(tmpdir(), 'untether-ghostty-'));
    await writeSession(controlDir, 'new', 'hola');
    manager = new TerminalManager(controlDir);

    const [first, second] = await Promise.all([
      manager.getTerminal('new'),
      manager.getTerminal('new'),
    ]);
    // Not toBe: a failure would print both terminals, WASM memory and all.
    expect(first === second).toBe(true);
  });

  // 2026-10-23: a 120x30 task session, read with no client connected: its agent's prompt and
  // menus must be on the screen as the agent drew them, at the PTY's width.
  it("reads a session's screen at its PTY's size with no client connected", async () => {
    controlDir = await mkdtemp(path.join(tmpdir(), 'untether-ghostty-'));
    await mkdir(path.join(controlDir, 'task'), { recursive: true });
    await writeFile(
      path.join(controlDir, 'task', 'session.json'),
      JSON.stringify({ initialCols: 120, initialRows: 30 })
    );
    manager = new TerminalManager(controlDir);
    // Before the session wrote its cast: the PTY's size already, not 80x24.
    const early = await manager.getTerminal('task');
    expect([early.cols, early.rows]).toEqual([120, 30]);
    manager.closeTerminal('task');

    const wide = `› ${'x'.repeat(100)} end`;
    await writeFile(
      path.join(controlDir, 'task', 'stdout'),
      `${JSON.stringify({ version: 2, width: 120, height: 30 })}\n${JSON.stringify([0.1, 'o', `\x1b[28;1H${wide}`])}\n`
    );
    const terminal = await manager.getTerminal('task');
    expect([terminal.cols, terminal.rows]).toEqual([120, 30]);
    const snapshot = await manager.getBufferSnapshot('task');
    expect(snapshot.cols).toBe(120);
    const rows = snapshot.cells.map((row) =>
      row
        .map((cell) => cell.char)
        .join('')
        .trimEnd()
    );
    expect(rows).toContain(wide);
  });
});
