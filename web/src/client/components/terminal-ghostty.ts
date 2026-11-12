/**
 * A ghostty-web Ghostty, so a WASM instance and its memory, of its own for each terminal.
 *
 * All terminals shared the one Ghostty.load() made, so one linear memory, and a new terminal
 * showed another session's text (2026-10-03): ghostty gives a new terminal the pages a disposed
 * one used without zeroing them (its release build takes fresh pages to be zero), so every cell
 * it had not written yet still held the old text. On the phone, opening another session showed
 * the previous one's lines; the clear after fitting only reached the visible rows. The module now
 * compiles once per page and each terminal instantiates it: an instance starts at about 1.2 MB and
 * goes with its terminal, as ghostty-web's dispose() lets go of the Ghostty it was given.
 */
import { Ghostty } from 'ghostty-web';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('terminal-ghostty');

const GHOSTTY_WASM_URL = '/ghostty-vt.wasm';

let modulePromise: Promise<WebAssembly.Module> | null = null;

/** ghostty-vt.wasm, fetched and compiled once for the page. */
function compileGhosttyModule(): Promise<WebAssembly.Module> {
  if (!modulePromise) {
    modulePromise = (async () => {
      if (typeof WebAssembly.compileStreaming === 'function') {
        try {
          return await WebAssembly.compileStreaming(fetch(GHOSTTY_WASM_URL));
        } catch (error) {
          // Sent without the application/wasm type the streaming compile needs: use the bytes.
          logger.debug('streaming compile of the ghostty WASM failed, compiling its bytes', error);
        }
      }
      // As ghostty-web 0.4's Ghostty.load fetches it in a browser.
      const response = await fetch(GHOSTTY_WASM_URL);
      if (!response.ok) {
        throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0) {
        throw new Error(`WASM file is empty (0 bytes). Check path: ${GHOSTTY_WASM_URL}`);
      }
      return WebAssembly.compile(bytes);
    })();
  }
  return modulePromise;
}

/**
 * Fetch and compile the WASM ahead of the first terminal (user report 2026-10-14: the first
 * open after a cold start fetched and compiled it only then, behind «Cargando historial»).
 * A failure is forgotten, so the terminal that needs it tries again.
 */
export function preloadGhosttyModule(): void {
  const pending = compileGhosttyModule();
  pending.catch((error: unknown) => {
    if (modulePromise === pending) modulePromise = null;
    logger.debug('ghostty WASM preload failed', error);
  });
}

/** A Ghostty on a new instance of the compiled module, with the imports Ghostty.load gives it. */
export async function createGhostty(): Promise<Ghostty> {
  const module = await compileGhosttyModule();
  const instance: WebAssembly.Instance = await WebAssembly.instantiate(module, {
    env: {
      log: (ptr: number, len: number) => {
        const bytes = new Uint8Array(
          (instance.exports.memory as WebAssembly.Memory).buffer,
          ptr,
          len
        );
        console.log('[ghostty-vt]', new TextDecoder().decode(bytes));
      },
    },
  });
  return new Ghostty(instance);
}
