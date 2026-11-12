import * as fs from 'fs';
import { Ghostty } from 'ghostty-web';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  decodeWsV3Frame,
  encodeWsV3Frame,
  encodeWsV3SubscribePayload,
  WsV3MessageType,
  WsV3SubscribeFlags,
} from '../../shared/ws-v3.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { PtyManager } from '../pty/index.js';
import type { SessionManager } from '../pty/session-manager.js';
import { CastOutputHub } from './cast-output-hub.js';
import type { GitStatusHub } from './git-status-hub.js';
import type { TerminalManager } from './terminal-manager.js';
import { resolveGhosttyWasmPath } from './terminal-manager.js';
import { type WebSocketRequestV3, WsV3Hub } from './ws-v3-hub.js';

vi.unmock('ghostty-web');
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

/**
 * Opening a session with a long history, end to end but for the network: the server reads the
 * cast and sends its replay, the phone decodes each frame and ghostty parses it. 2026-10-04: a
 * 1 MB cast of short lines (214k events) went out as one frame per event and the simulator's
 * terminal stayed blank for 2.8 s; ghostty itself parses that megabyte in about 20 ms.
 */
describe('history replay speed', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, RM_TEST_DIR);
    tmpDir = null;
  });

  async function open(bytes: number, line: (i: number) => string) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-speed-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const lines = [JSON.stringify({ version: 2, width: 45, height: 40 })];
    for (let i = 0, size = 0; size < bytes; i++) {
      const data = line(i);
      size += data.length;
      lines.push(JSON.stringify([i / 100, 'o', data]));
    }
    fs.writeFileSync(stdoutPath, `${lines.join('\n')}\n`);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({ lastClearOffset: 0 }),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const hub = new WsV3Hub({
      ptyManager: { getSession: () => null } as unknown as PtyManager,
      terminalManager: {} as unknown as TerminalManager,
      castOutputHub: new CastOutputHub(sessionManager, {
        replayMaxBytes: 2 * bytes,
        historyMaxBytes: 2 * bytes,
      }),
      gitStatusHub: {} as unknown as GitStatusHub,
      sessionMonitor: null,
      remoteRegistry: null,
      isHQMode: false,
    });

    const wasm = await fs.promises.readFile(resolveGhosttyWasmPath(__dirname));
    const instance = new WebAssembly.Instance(await WebAssembly.compile(wasm), {
      env: { log: () => {} },
    });
    const terminal = new Ghostty(
      instance as unknown as ConstructorParameters<typeof Ghostty>[0]
    ).createTerminal(45, 40, { scrollbackLimit: 10000 });

    // The phone's side: decode each frame (as terminal-socket-client and the connection
    // manager do) and write it into ghostty.
    const decoder = new TextDecoder();
    let frames = 0;
    let parseMs = 0;
    let done: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      done = resolve;
    });
    const ws = Object.assign(new (await import('events')).EventEmitter(), {
      readyState: 1,
      bufferedAmount: 0,
      send: (data: Uint8Array) => {
        const frame = decodeWsV3Frame(data);
        if (!frame) return;
        if (frame.type === WsV3MessageType.STDOUT) {
          frames++;
          const text = decoder.decode(frame.payload, { stream: true });
          const started = performance.now();
          terminal.write(text);
          parseMs += performance.now() - started;
        } else if (frame.type === WsV3MessageType.EVENT) {
          if (decoder.decode(frame.payload).includes('replay-end')) done();
        }
      },
      close: vi.fn(),
      terminate: vi.fn(),
      ping: vi.fn(),
    });
    const started = performance.now();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    ws.emit(
      'message',
      Buffer.from(
        encodeWsV3Frame({
          type: WsV3MessageType.SUBSCRIBE,
          sessionId: 's1',
          payload: encodeWsV3SubscribePayload({
            flags: WsV3SubscribeFlags.Stdout | WsV3SubscribeFlags.Events,
          }),
        })
      ),
      true
    );
    await ended;
    const totalMs = performance.now() - started;
    hub.dispose();
    terminal.free();
    console.log(
      `replay of ${(bytes / 1048576).toFixed(0)} MB, ${lines.length - 1} events: ${frames} frames, ` +
        `${totalMs.toFixed(0)} ms in all, ${parseMs.toFixed(0)} ms of it in ghostty`
    );
    return { frames, totalMs, events: lines.length - 1 };
  }

  it('sends 1 MB of short lines in a handful of frames', async () => {
    const { frames, events } = await open(1024 * 1024, (i) => `${i % 1000}\r\n`);
    expect(events).toBeGreaterThan(200_000);
    expect(frames).toBeLessThanOrEqual(8);
  }, 30_000);

  it('gets 16 MB of Claude output from the cast into ghostty within a few seconds', async () => {
    const { frames, totalMs } = await open(
      16 * 1024 * 1024,
      (i) => `\x1b[2K\x1b[38;2;200;100;50m⏺ línea ${i} el veloz murciélago\x1b[0m\r\n`
    );
    expect(frames).toBeLessThanOrEqual(80);
    // About 1.5 s on an M-series Mac, most of it reading and parsing the cast's JSON lines.
    // Bounded loosely for slower machines: one frame per event took far longer.
    expect(totalMs).toBeLessThan(8000);
  }, 60_000);
});
