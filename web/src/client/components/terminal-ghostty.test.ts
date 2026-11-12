// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Ghostty, GhosttyCell, GhosttyTerminal } from 'ghostty-web';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

// The real loader and ghostty-web on the real WASM: the test setup mocks both for components.
vi.unmock('./terminal-ghostty.js');
vi.unmock('ghostty-web');

const wasm = readFileSync(createRequire(import.meta.url).resolve('ghostty-web/ghostty-vt.wasm'));

function screenText(terminal: GhosttyTerminal): string {
  const row = (cells: GhosttyCell[] | null) =>
    (cells ?? []).map((cell) => (cell.codepoint ? String.fromCodePoint(cell.codepoint) : ' '));
  return Array.from({ length: terminal.rows }, (_, y) => row(terminal.getLine(y)).join('')).join(
    '\n'
  );
}

describe('createGhostty', () => {
  let fetchMock: Mock<(url: string) => Promise<Response>>;

  beforeEach(() => {
    // A fresh module each time: it compiles the WASM once per page.
    vi.resetModules();
    fetchMock = vi.fn(
      async () => new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } })
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function createGhostty(): Promise<Ghostty> {
    return (await import('./terminal-ghostty.js')).createGhostty();
  }

  it('a preload compiles the WASM the first terminal then uses, and a failed one is retried', async () => {
    const loader = await import('./terminal-ghostty.js');
    fetchMock.mockRejectedValueOnce(new TypeError('Load failed'));
    loader.preloadGhosttyModule();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The failure is forgotten: the next preload fetches again, the terminal reuses that.
    loader.preloadGhosttyModule();
    const ghostty = await loader.createGhostty();
    ghostty.createTerminal(20, 5).free();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a disposed terminal's text out of the next one and compiles once", async () => {
    const first = await createGhostty();
    const old = first.createTerminal(45, 30, { scrollbackLimit: 10000 });
    let output = '';
    for (let i = 1; i <= 4000; i++) {
      output += `línea ${i} · el veloz murciélago hindú comía feliz cardillo y kiwi\r\n`;
    }
    old.write(output);
    expect(screenText(old)).toContain('murciélago');
    old.free();

    // What the next session's terminal does: created, fitted, then its first output.
    const terminal = (await createGhostty()).createTerminal(80, 24, { scrollbackLimit: 10000 });
    terminal.resize(45, 30);
    terminal.write('\x1b[5;3Hhola');

    expect(screenText(terminal)).toContain('hola');
    expect(screenText(terminal)).not.toMatch(/murci|línea/);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('/ghostty-vt.wasm');
  });

  it("logs what ghostty writes out from that instance's own memory", async () => {
    const instantiate = vi.spyOn(WebAssembly, 'instantiate');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await createGhostty();
    const ghostty = await createGhostty();

    // The imports of the second instance, called the way its WASM calls them.
    const [, imports] = instantiate.mock.calls[1] as [
      WebAssembly.Module,
      { env: { log: (ptr: number, len: number) => void } },
    ];
    const { exports, memory } = ghostty as unknown as {
      exports: { ghostty_wasm_alloc_u8_array(len: number): number };
      memory: WebAssembly.Memory;
    };
    const text = new TextEncoder().encode('stream warning');
    const ptr = exports.ghostty_wasm_alloc_u8_array(text.length);
    new Uint8Array(memory.buffer).set(text, ptr);
    imports.env.log(ptr, text.length);

    expect(log).toHaveBeenCalledWith('[ghostty-vt]', 'stream warning');
  });

  it('compiles the bytes when the file comes without the WASM content type', async () => {
    fetchMock.mockImplementation(
      async () => new Response(wasm, { headers: { 'Content-Type': 'application/octet-stream' } })
    );

    const terminal = (await createGhostty()).createTerminal(80, 24);
    terminal.write('hola');

    expect(screenText(terminal).split('\n')[0].trimEnd()).toBe('hola');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says why when the file cannot be fetched', async () => {
    fetchMock.mockImplementation(
      async () => new Response('missing', { status: 404, statusText: 'Not Found' })
    );

    await expect(createGhostty()).rejects.toThrow('Failed to fetch WASM: 404 Not Found');
  });
});
