import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerEvent } from '../../shared/types.js';
import { ServerEventType } from '../../shared/types.js';
import {
  decodeWsV3Frame,
  encodeWsV3Frame,
  encodeWsV3ResizePayload,
  encodeWsV3SubscribePayload,
  VIEWING_REFRESH_MS,
  VIEWING_STALE_MS,
  WsV3MessageType,
  WsV3SubscribeFlags,
} from '../../shared/ws-v3.js';
import { RM_TEST_DIR } from '../../test/helpers/rm-test-dir.js';
import type { PtyManager } from '../pty/index.js';
import type { SessionManager } from '../pty/session-manager.js';
import { STREAM_COALESCE_MS, STREAM_SOFT_BUFFERED_BYTES } from './agent-stream-coalescer.js';
import {
  CastOutputHub,
  type CastOutputHubListener,
  type CastSubscription,
} from './cast-output-hub.js';
import type { GitStatusHub, GitStatusHubEvent, GitStatusHubListener } from './git-status-hub.js';
import type { SessionMonitor } from './session-monitor.js';
import type { TerminalManager } from './terminal-manager.js';
import {
  CLIENT_HEARTBEAT_INTERVAL_MS,
  MAX_CLIENT_BUFFERED_BYTES,
  type WebSocketRequestV3,
  WsV3Hub,
} from './ws-v3-hub.js';

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

class FakeWebSocket extends EventEmitter {
  readyState: WebSocket['readyState'] = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  send = vi.fn((data: Uint8Array) => {
    this.sent.push(new Uint8Array(data));
  });
  close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  });
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  });
  ping = vi.fn();
}

function decodeLastFrame(ws: FakeWebSocket) {
  const raw = ws.sent.at(-1);
  if (!raw) throw new Error('no ws sends');
  const frame = decodeWsV3Frame(raw);
  if (!frame) throw new Error('failed to decode ws v3 frame');
  return frame;
}

function sendBinaryFrame(ws: FakeWebSocket, frame: Uint8Array) {
  ws.emit('message', Buffer.from(frame), true);
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe('WsV3Hub', () => {
  type BufferChangeListener = Parameters<TerminalManager['subscribeToBufferChanges']>[1];

  let ptyManager: PtyManager;
  let terminalManager: TerminalManager;
  let castOutputHub: CastOutputHub;
  let gitStatusHub: GitStatusHub;
  let sessionMonitor: EventEmitter;
  let hub: WsV3Hub;

  type PtySessionStub = { gitRepoPath?: string; workingDir?: string } | null;
  let getSession: Mock<(sessionId: string) => PtySessionStub>;
  let castListener: CastOutputHubListener | undefined;
  let castUnsubscribe: Mock<() => void> | undefined;
  let castResync: Mock<() => void> | undefined;
  let snapshotListener: BufferChangeListener | undefined;
  let gitListener: GitStatusHubListener | undefined;

  beforeEach(() => {
    castListener = undefined;
    snapshotListener = undefined;
    gitListener = undefined;

    getSession = vi.fn<(sessionId: string) => PtySessionStub>(() => null);

    ptyManager = {
      getSession,
      sendInput: vi.fn<PtyManager['sendInput']>(),
      resizeSession: vi.fn<PtyManager['resizeSession']>(() => ({ applied: true })),
      killSession: vi.fn<PtyManager['killSession']>(async () => {}),
      resetSessionSize: vi.fn<PtyManager['resetSessionSize']>(),
    } as unknown as PtyManager;

    type SubscribeToBufferChangesFn = (
      sessionId: string,
      listener: BufferChangeListener
    ) => Promise<() => void>;

    terminalManager = {
      subscribeToBufferChanges: vi.fn<SubscribeToBufferChangesFn>(async (_sessionId, cb) => {
        snapshotListener = cb;
        return vi.fn<() => void>();
      }),
      encodeSnapshot: vi.fn(() => Buffer.from([9, 9, 9])),
    } as unknown as TerminalManager;

    type CastSubscribeFn = (sessionId: string, listener: CastOutputHubListener) => CastSubscription;
    castOutputHub = {
      subscribe: vi.fn<CastSubscribeFn>((_sessionId, listener) => {
        castListener = listener;
        castUnsubscribe = vi.fn<() => void>();
        castResync = vi.fn<() => void>();
        return Object.assign(castUnsubscribe, { resync: castResync });
      }),
    } as unknown as CastOutputHub;

    type GitStartWatchingFn = GitStatusHub['startWatching'];
    type GitAddClientFn = GitStatusHub['addClient'];
    type GitRemoveClientFn = GitStatusHub['removeClient'];
    gitStatusHub = {
      startWatching: vi.fn<GitStartWatchingFn>(),
      addClient: vi.fn<GitAddClientFn>((_sessionId, listener) => {
        gitListener = listener;
      }),
      removeClient: vi.fn<GitRemoveClientFn>(),
    } as unknown as GitStatusHub;

    sessionMonitor = new EventEmitter();

    hub = new WsV3Hub({
      ptyManager,
      terminalManager,
      castOutputHub,
      gitStatusHub,
      sessionMonitor: sessionMonitor as unknown as SessionMonitor,
      remoteRegistry: null,
      isHQMode: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends WELCOME on connect', () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(
      ws as unknown as WebSocket,
      { userId: 'u', authMethod: 'token' } as unknown as WebSocketRequestV3
    );
    const first = ws.sent[0];
    if (!first) throw new Error('expected welcome frame');
    const frame = decodeWsV3Frame(first);
    expect(frame?.type).toBe(WsV3MessageType.WELCOME);
  });

  it('acks global events subscription + broadcasts sessionMonitor events', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: '',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Events }),
      })
    );
    await flush();

    const ack = decodeLastFrame(ws);
    expect(ack.type).toBe(WsV3MessageType.EVENT);
    expect(ack.sessionId).toBe('');
    expect(JSON.parse(new TextDecoder().decode(ack.payload))).toMatchObject({ type: 'connected' });

    const evt: ServerEvent = {
      type: ServerEventType.SessionExit,
      sessionId: 's1',
      exitCode: 0,
      timestamp: new Date().toISOString(),
    };
    sessionMonitor.emit('notification', evt);
    await flush();

    const forwarded = decodeLastFrame(ws);
    expect(forwarded.type).toBe(WsV3MessageType.EVENT);
    expect(forwarded.sessionId).toBe('s1');
    expect(JSON.parse(new TextDecoder().decode(forwarded.payload))).toMatchObject({
      type: ServerEventType.SessionExit,
      exitCode: 0,
      sessionId: 's1',
    });
  });

  it('forwards stdout events when subscribed', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Stdout }),
      })
    );
    await flush();

    expect(castOutputHub.subscribe).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(castListener).toBeTypeOf('function');

    if (!castListener) throw new Error('expected cast listener');
    castListener({ kind: 'output', data: 'hello', historical: false });
    await flush();
    const stdout = decodeLastFrame(ws);
    expect(stdout.type).toBe(WsV3MessageType.STDOUT);
    expect(stdout.sessionId).toBe('s1');
    expect(new TextDecoder().decode(stdout.payload)).toBe('hello');

    castListener({ kind: 'exit', exitCode: 0 });
    await flush();
    const exitEvt = decodeLastFrame(ws);
    expect(exitEvt.type).toBe(WsV3MessageType.EVENT);
    expect(exitEvt.sessionId).toBe('s1');
    expect(JSON.parse(new TextDecoder().decode(exitEvt.payload))).toEqual({
      kind: 'exit',
      exitCode: 0,
    });

    castListener({ kind: 'error', message: 'boom' });
    await flush();
    const err = decodeLastFrame(ws);
    expect(err.type).toBe(WsV3MessageType.ERROR);
    expect(err.sessionId).toBe('s1');
    expect(JSON.parse(new TextDecoder().decode(err.payload))).toEqual({ message: 'boom' });
  });

  /** Subscribes `ws` to s1's stdout, then switches to fake timers when asked. */
  async function subscribeStdout(ws: FakeWebSocket, fakeTimers = false) {
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Stdout }),
      })
    );
    await flush();
    if (!castListener) throw new Error('expected cast listener');
    if (fakeTimers) vi.useFakeTimers();
    return castListener;
  }

  const decodeAll = (ws: FakeWebSocket) =>
    ws.sent.map((raw) => decodeWsV3Frame(raw)).filter((frame) => frame !== null);

  it('still drops a client that fell more than the hard limit behind', async () => {
    const ws = new FakeWebSocket();
    const listener = await subscribeStdout(ws);
    ws.bufferedAmount = MAX_CLIENT_BUFFERED_BYTES + 1;
    const sentBefore = ws.sent.length;
    listener({ kind: 'exit', exitCode: 0 });
    await flush();
    expect(ws.terminate).toHaveBeenCalled();
    expect(ws.sent.length).toBe(sentBefore);
    expect(castUnsubscribe).toHaveBeenCalled();
  });

  it('groups a burst of live output into one frame per window', async () => {
    try {
      const ws = new FakeWebSocket();
      const listener = await subscribeStdout(ws, true);
      const before = ws.sent.length;
      for (let i = 0; i < 500; i++) {
        listener({ kind: 'output', data: `${i}\n`, historical: false });
      }
      await vi.advanceTimersByTimeAsync(STREAM_COALESCE_MS);
      const frames = decodeAll(ws).slice(before);
      expect(frames.length).toBe(2);
      expect(frames.map((f) => new TextDecoder().decode(f.payload)).join('')).toBe(
        Array.from({ length: 500 }, (_, i) => `${i}\n`).join('')
      );
      // An exit right after output goes out after it, not before.
      listener({ kind: 'output', data: 'last', historical: false });
      listener({ kind: 'exit', exitCode: 0 });
      const tail = decodeAll(ws).slice(-2);
      expect(tail.map((f) => f.type)).toEqual([WsV3MessageType.STDOUT, WsV3MessageType.EVENT]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds live output for a client that stopped reading and resyncs it once it drained', async () => {
    // 2026-10-02: a stalled phone kept every frame queued (~10 MB/s of server memory) until it
    // was dropped at 16 MB. Now its output waits, bounded, and it gets a fresh replay instead.
    try {
      const ws = new FakeWebSocket();
      const listener = await subscribeStdout(ws, true);
      ws.bufferedAmount = STREAM_SOFT_BUFFERED_BYTES + 1;
      listener({ kind: 'output', data: 'first', historical: false }); // leading edge
      const sentBefore = ws.sent.length;
      const chunk = 'y\n'.repeat(64 * 1024);
      for (let i = 0; i < 40; i++) listener({ kind: 'output', data: chunk, historical: false });
      await vi.advanceTimersByTimeAsync(STREAM_COALESCE_MS * 20);
      expect(ws.sent.length).toBe(sentBefore);
      expect(ws.terminate).not.toHaveBeenCalled();
      expect(castResync).not.toHaveBeenCalled();

      ws.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(STREAM_COALESCE_MS);
      expect(castResync).toHaveBeenCalledOnce();
      const notice = decodeAll(ws).at(-1);
      expect(notice?.type).toBe(WsV3MessageType.EVENT);
      const said = JSON.parse(new TextDecoder().decode(notice?.payload));
      expect(said.kind).toBe('output-skipped');
      expect(said.chars).toBeGreaterThan(1024 * 1024);
      expect(ws.terminate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a history replay larger than the buffer limit without dropping the viewer', async () => {
    // 2026-10-04: the replay goes out in one synchronous loop, so nothing drains meanwhile.
    // A session with more than 16 MB since the last clear tripped the limit on every
    // (re)connect: the client was terminated, reconnected, got the same replay, forever.
    try {
      const ws = new FakeWebSocket();
      ws.send = vi.fn((data: Uint8Array) => {
        ws.sent.push(data);
        ws.bufferedAmount += data.length;
      });
      const listener = await subscribeStdout(ws, true);

      const chunk = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 24; i++) listener({ kind: 'output', data: chunk, historical: true });
      // Live output right after the replay, while the history is still queued.
      listener({ kind: 'output', data: 'live', historical: false });

      expect(ws.terminate).not.toHaveBeenCalled();
      expect(ws.sent.length).toBe(26); // WELCOME + 24 history frames + the live one

      // Live output does not pile up behind the history: it waits until the socket drains.
      for (let i = 0; i < 4; i++) listener({ kind: 'output', data: chunk, historical: false });
      await vi.advanceTimersByTimeAsync(STREAM_COALESCE_MS * 4);
      const queuedLive = ws.bufferedAmount - 24 * (chunk.length + 8);
      expect(queuedLive).toBeLessThanOrEqual(STREAM_SOFT_BUFFERED_BYTES + chunk.length + 64);
      expect(ws.terminate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribes a client that vanished without closing, but keeps one that answers', async () => {
    vi.useFakeTimers();
    try {
      const gone = new FakeWebSocket();
      const answersPings = new FakeWebSocket();
      answersPings.ping = vi.fn(() => answersPings.emit('pong'));
      const pingsItself = new FakeWebSocket();
      for (const ws of [gone, answersPings, pingsItself]) {
        hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
      }
      sendBinaryFrame(
        gone,
        encodeWsV3Frame({
          type: WsV3MessageType.SUBSCRIBE,
          sessionId: 's1',
          payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Stdout }),
        })
      );
      await vi.advanceTimersByTimeAsync(0);
      const goneUnsubscribe = castUnsubscribe;

      // The phone leaves Wi-Fi: no FIN, no frames, no pongs. The client's own 20 s PING
      // frames keep the other socket alive even without protocol pongs.
      for (let t = 0; t < 60_000; t += 20_000) {
        await vi.advanceTimersByTimeAsync(20_000);
        sendBinaryFrame(
          pingsItself,
          encodeWsV3Frame({ type: WsV3MessageType.PING, payload: new Uint8Array() })
        );
      }

      expect(gone.terminate).toHaveBeenCalled();
      expect(goneUnsubscribe).toHaveBeenCalled();
      expect(answersPings.terminate).not.toHaveBeenCalled();
      expect(pingsItself.terminate).not.toHaveBeenCalled();
      expect(2 * CLIENT_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(60_000);
    } finally {
      hub.dispose();
      vi.useRealTimers();
    }
  });

  // 2026-10-20: subscribeToBufferChanges is awaited; a socket closed (or a second subscribe)
  // during that await left the buffer listener registered forever.
  it('drops a snapshot listener whose subscription ended while it was being attached', async () => {
    const pending: Array<{ resolve: (u: () => void) => void; unsub: Mock<() => void> }> = [];
    vi.mocked(terminalManager.subscribeToBufferChanges).mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          pending.push({ resolve, unsub: vi.fn<() => void>() });
        })
    );
    const subscribeSnapshots = (ws: FakeWebSocket) =>
      sendBinaryFrame(
        ws,
        encodeWsV3Frame({
          type: WsV3MessageType.SUBSCRIBE,
          sessionId: 's1',
          payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Snapshots }),
        })
      );

    // Closed during the await.
    const closed = new FakeWebSocket();
    hub.handleClientConnection(closed as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    subscribeSnapshots(closed);
    await flush();
    closed.close();
    const first = pending[0];
    if (!first) throw new Error('expected a pending attach');
    first.resolve(first.unsub);
    await flush();
    expect(first.unsub).toHaveBeenCalledOnce();

    // Subscribed twice: the first attach is superseded, only the second stays.
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    subscribeSnapshots(ws);
    await flush();
    subscribeSnapshots(ws);
    await flush();
    const [, a, b] = pending;
    if (!a || !b) throw new Error('expected two pending attaches');
    a.resolve(a.unsub);
    b.resolve(b.unsub);
    await flush();
    expect(a.unsub).toHaveBeenCalledOnce();
    expect(b.unsub).not.toHaveBeenCalled();
    ws.close();
    await flush();
    expect(b.unsub).toHaveBeenCalledOnce();
  });

  it('forwards VT snapshots when subscribed', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Snapshots }),
      })
    );
    await flush();

    expect(terminalManager.subscribeToBufferChanges).toHaveBeenCalledWith(
      's1',
      expect.any(Function)
    );
    expect(snapshotListener).toBeTypeOf('function');

    if (!snapshotListener) throw new Error('expected snapshot listener');
    snapshotListener('s1', {
      cols: 80,
      rows: 24,
      viewportY: 0,
      cursorX: 0,
      cursorY: 0,
      cells: [],
    });
    await flush();

    const snap = decodeLastFrame(ws);
    expect(snap.type).toBe(WsV3MessageType.SNAPSHOT_VT);
    expect(snap.sessionId).toBe('s1');
    expect(Array.from(snap.payload)).toEqual([9, 9, 9]);
  });

  it('routes input/resize/kill to PtyManager for local sessions', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.INPUT_TEXT,
        sessionId: 's1',
        payload: new TextEncoder().encode('ls'),
      })
    );
    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.RESIZE,
        sessionId: 's1',
        payload: encodeWsV3ResizePayload(80, 24, { claim: true, clientId: 'page-1' }),
      })
    );
    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.KILL,
        sessionId: 's1',
        payload: new TextEncoder().encode('SIGKILL'),
      })
    );
    await flush();

    expect(ptyManager.sendInput).toHaveBeenCalledWith('s1', { text: 'ls' });
    expect(ptyManager.resizeSession).toHaveBeenCalledWith('s1', 80, 24, {
      claim: true,
      clientId: 'page-1',
    });
    expect(ptyManager.killSession).toHaveBeenCalledWith('s1', 'SIGKILL');
  });

  it('sends ERROR for invalid SUBSCRIBE payload', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: new Uint8Array([1, 2, 3]),
      })
    );
    await flush();

    const err = decodeLastFrame(ws);
    expect(err.type).toBe(WsV3MessageType.ERROR);
    expect(err.sessionId).toBe('s1');
    expect(JSON.parse(new TextDecoder().decode(err.payload)).message).toContain(
      'Invalid SUBSCRIBE payload'
    );
  });

  it('unsubscribes old listeners on re-subscribe', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Stdout }),
      })
    );
    await flush();

    const unsubscribeStdout = vi.mocked(castOutputHub.subscribe).mock.results[0]?.value;
    expect(typeof unsubscribeStdout).toBe('function');

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Snapshots }),
      })
    );
    await flush();

    expect(unsubscribeStdout).toHaveBeenCalled();
  });

  it('keeps the stdout stream, without a second replay, when only the other flags change', async () => {
    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    const subscribe = (flags: number) =>
      sendBinaryFrame(
        ws,
        encodeWsV3Frame({
          type: WsV3MessageType.SUBSCRIBE,
          sessionId: 's1',
          payload: encodeWsV3SubscribePayload({ flags }),
        })
      );

    subscribe(WsV3SubscribeFlags.Stdout | WsV3SubscribeFlags.Events);
    await flush();
    // Another view of the session (a preview's snapshots) joins: 2026-10-04 this replayed
    // the whole history (16 MB) again to the terminal that already showed it.
    subscribe(WsV3SubscribeFlags.Stdout | WsV3SubscribeFlags.Events | WsV3SubscribeFlags.Snapshots);
    await flush();

    expect(castOutputHub.subscribe).toHaveBeenCalledOnce();
    expect(castUnsubscribe).not.toHaveBeenCalled();
    expect(terminalManager.subscribeToBufferChanges).toHaveBeenCalledOnce();

    // The stream still follows the flags: the end of the replay is an event.
    castListener?.({ kind: 'replay-end' });
    const frame = decodeLastFrame(ws);
    expect(frame.type).toBe(WsV3MessageType.EVENT);
    expect(JSON.parse(new TextDecoder().decode(frame.payload))).toEqual({ kind: 'replay-end' });

    // Without stdout it is a new subscription again.
    subscribe(WsV3SubscribeFlags.Snapshots);
    await flush();
    expect(castUnsubscribe).toHaveBeenCalledOnce();
  });

  it('streams git-status updates as EVENT frames when enabled', async () => {
    getSession.mockReturnValue({
      gitRepoPath: '/repo',
      workingDir: '/repo',
    });

    const ws = new FakeWebSocket();
    hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);

    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Events }),
      })
    );
    await flush();

    expect(gitStatusHub.startWatching).toHaveBeenCalledWith('s1', '/repo', '/repo');
    expect(gitListener).toBeTypeOf('function');

    if (!gitListener) throw new Error('expected git listener');
    const update: GitStatusHubEvent = {
      type: 'git-status-update',
      sessionId: 's1',
      gitModifiedCount: 2,
      gitAddedCount: 1,
      gitDeletedCount: 0,
      gitAheadCount: 1,
      gitBehindCount: 0,
      gitInsertionCount: 10,
      gitDeletionCount: 3,
    };
    gitListener(update);
    await flush();
    const evt = decodeLastFrame(ws);
    expect(evt.type).toBe(WsV3MessageType.EVENT);
    expect(evt.sessionId).toBe('s1');
    expect(JSON.parse(new TextDecoder().decode(evt.payload))).toEqual(update);
  });

  it('stops counting a viewer that does not repeat VIEWING within the stale window', async () => {
    vi.useFakeTimers();
    try {
      // A page left open on a locked Mac: connected, answering pings, never saying more.
      const mac = new FakeWebSocket();
      const phone = new FakeWebSocket();
      for (const ws of [mac, phone]) {
        hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
        ws.ping = vi.fn(() => ws.emit('pong'));
      }
      const viewing = (ws: FakeWebSocket, sessionId: string) =>
        sendBinaryFrame(ws, encodeWsV3Frame({ type: WsV3MessageType.VIEWING, sessionId }));

      viewing(mac, 's1');
      viewing(phone, 's2');
      await vi.advanceTimersByTimeAsync(0);
      expect(hub.isSessionBeingViewed('s1')).toBe(true);

      // The phone keeps looking and repeats it; the Mac page says nothing more.
      for (let t = 0; t < VIEWING_STALE_MS; t += VIEWING_REFRESH_MS) {
        await vi.advanceTimersByTimeAsync(VIEWING_REFRESH_MS);
        viewing(phone, 's2');
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(mac.terminate).not.toHaveBeenCalled();
      expect(hub.isSessionBeingViewed('s1')).toBe(false);
      expect(hub.isSessionBeingViewed('s2')).toBe(true);

      // Looking again (a new VIEWING) counts again at once.
      viewing(mac, 's1');
      await vi.advanceTimersByTimeAsync(0);
      expect(hub.isSessionBeingViewed('s1')).toBe(true);
    } finally {
      hub.dispose();
      vi.useRealTimers();
    }
  });

  it('remembers what a looked-at page reported as seen, and whether anyone is about', async () => {
    vi.useFakeTimers();
    try {
      const phone = new FakeWebSocket();
      hub.handleClientConnection(
        phone as unknown as WebSocket,
        {} as unknown as WebSocketRequestV3
      );
      phone.ping = vi.fn(() => phone.emit('pong'));
      expect(hub.isAnyClientActive()).toBe(false);

      const before = Date.now();
      await vi.advanceTimersByTimeAsync(10);
      sendBinaryFrame(
        phone,
        encodeWsV3Frame({
          type: WsV3MessageType.SEEN,
          payload: new TextEncoder().encode('confirm:c1\nneeds-you:t1'),
        })
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(hub.isAnyClientActive()).toBe(true);
      expect(hub.wasSeenSince('confirm:c1', before)).toBe(true);
      expect(hub.wasSeenSince('needs-you:t1', before)).toBe(true);
      expect(hub.wasSeenSince('confirm:c2', before)).toBe(false);
      // Seen before a push was held does not count for it.
      expect(hub.wasSeenSince('confirm:c1', Date.now() + 1)).toBe(false);

      // A page that stops saying anything stops counting as someone about.
      await vi.advanceTimersByTimeAsync(VIEWING_STALE_MS + 1);
      expect(hub.isAnyClientActive()).toBe(false);
      sendBinaryFrame(phone, encodeWsV3Frame({ type: WsV3MessageType.VIEWING, sessionId: 's1' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(hub.isAnyClientActive()).toBe(true);
      // The list on screen with nothing pending: an empty SEEN still says someone is about.
      await vi.advanceTimersByTimeAsync(VIEWING_STALE_MS + 1);
      sendBinaryFrame(phone, encodeWsV3Frame({ type: WsV3MessageType.VIEWING, sessionId: '' }));
      expect(hub.isAnyClientActive()).toBe(false);
      sendBinaryFrame(phone, encodeWsV3Frame({ type: WsV3MessageType.SEEN }));
      await vi.advanceTimersByTimeAsync(0);
      expect(hub.isAnyClientActive()).toBe(true);
      phone.close();
      expect(hub.isAnyClientActive()).toBe(false);
    } finally {
      hub.dispose();
      vi.useRealTimers();
    }
  });

  // User report 2026-10-14: the owner of a session's size is a page (pty/size-owner.ts).
  it('knows which page views a session, and passes its resizes and give-backs with its id', async () => {
    const phone = new FakeWebSocket();
    const desktop = new FakeWebSocket();
    for (const ws of [phone, desktop]) {
      hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    }
    const viewing = (ws: FakeWebSocket, sessionId: string, clientId: string) =>
      sendBinaryFrame(
        ws,
        encodeWsV3Frame({
          type: WsV3MessageType.VIEWING,
          sessionId,
          payload: new TextEncoder().encode(clientId),
        })
      );
    viewing(phone, 'fwd_1', 'phone-page');
    viewing(desktop, 's2', 'desk-page');
    await flush();
    expect(hub.isClientViewing('phone-page', 'fwd_1')).toBe(true);
    expect(hub.isClientViewing('desk-page', 'fwd_1')).toBe(false);
    expect(hub.isSessionBeingViewed('fwd_1')).toBe(true);
    // Nobody but the phone itself shows it.
    expect(hub.isSessionBeingViewed('fwd_1', 'phone-page')).toBe(false);

    sendBinaryFrame(
      phone,
      encodeWsV3Frame({
        type: WsV3MessageType.RESIZE,
        sessionId: 'fwd_1',
        payload: encodeWsV3ResizePayload(57, 72),
      })
    );
    sendBinaryFrame(
      phone,
      encodeWsV3Frame({
        type: WsV3MessageType.RESET_SIZE,
        sessionId: 'fwd_1',
        payload: new TextEncoder().encode('phone-page'),
      })
    );
    await flush();
    expect(ptyManager.resizeSession).toHaveBeenCalledWith('fwd_1', 57, 72, {
      claim: false,
      clientId: null,
    });
    expect(ptyManager.resetSessionSize).toHaveBeenCalledWith('fwd_1', {
      clientId: 'phone-page',
      viewedElsewhere: false,
    });
    hub.dispose();
  });

  // User report 2026-10-14: a Mac window stayed at a locked phone's width. The server tells
  // how long the owning page has been away, from PRESENT frames and its sockets closing.
  it('knows how long a page has been away from a session, across its sockets', async () => {
    vi.useFakeTimers();
    try {
      const connect = () => {
        const ws = new FakeWebSocket();
        hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
        ws.ping = vi.fn(() => ws.emit('pong'));
        return ws;
      };
      const present = (ws: FakeWebSocket, sessionId: string, clientId = 'phone-page') =>
        sendBinaryFrame(
          ws,
          encodeWsV3Frame({
            type: WsV3MessageType.PRESENT,
            sessionId,
            payload: new TextEncoder().encode(clientId),
          })
        );
      expect(hub.clientAwayMs('phone-page', 'fwd_1')).toBeNull();

      const phone = connect();
      present(phone, 'fwd_1');
      await vi.advanceTimersByTimeAsync(0);
      expect(hub.clientAwayMs('phone-page', 'fwd_1')).toBe(0);
      // Present on one session is away from another.
      expect(hub.clientAwayMs('phone-page', 'fwd_2')).toBe(0);

      // Visible but untouched for minutes (reading): still there while it repeats PRESENT.
      for (let t = 0; t < 180_000; t += VIEWING_REFRESH_MS) {
        await vi.advanceTimersByTimeAsync(VIEWING_REFRESH_MS);
        present(phone, 'fwd_1');
      }
      expect(hub.clientAwayMs('phone-page', 'fwd_1')).toBe(0);

      // Locked: hidden, then the socket closes.
      present(phone, '');
      await vi.advanceTimersByTimeAsync(10_000);
      phone.close();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(hub.clientAwayMs('phone-page', 'fwd_1')).toBe(30_000);

      // Back (a new socket): there again at once.
      const again = connect();
      present(again, 'fwd_1');
      expect(hub.clientAwayMs('phone-page', 'fwd_1')).toBe(0);

      // Its old socket closing late, while the new one is there, changes nothing.
      const late = connect();
      present(late, 'fwd_1');
      late.close();
      expect(hub.clientAwayMs('phone-page', 'fwd_1')).toBe(0);

      // Frozen without a word (no hidden frame, socket left open): away from when its next
      // PRESENT was due.
      await vi.advanceTimersByTimeAsync(VIEWING_STALE_MS + 1);
      expect(hub.clientAwayMs('phone-page', 'fwd_1')).toBe(
        VIEWING_STALE_MS + 1 - VIEWING_REFRESH_MS
      );

      // Moved to another session: away from the first since then.
      present(again, 'fwd_2');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(hub.clientAwayMs('phone-page', 'fwd_1')).toBe(5_000);
      expect(hub.clientAwayMs('phone-page', 'fwd_2')).toBe(0);
    } finally {
      hub.dispose();
      vi.useRealTimers();
    }
  });

  it('tracks which session each client is viewing and forgets it when the socket goes', async () => {
    vi.useFakeTimers();
    try {
      const phone = new FakeWebSocket();
      const laptop = new FakeWebSocket();
      const silent = new FakeWebSocket();
      for (const ws of [phone, laptop, silent]) {
        hub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
      }
      const viewing = (ws: FakeWebSocket, sessionId: string) =>
        sendBinaryFrame(ws, encodeWsV3Frame({ type: WsV3MessageType.VIEWING, sessionId }));

      expect(hub.isSessionBeingViewed('s1')).toBe(false);
      viewing(phone, 's1');
      viewing(laptop, 's1');
      viewing(silent, 's2');
      await vi.advanceTimersByTimeAsync(0);
      expect(hub.isSessionBeingViewed('s1')).toBe(true);
      expect(hub.isSessionBeingViewed('s2')).toBe(true);
      expect(hub.isSessionBeingViewed('s3')).toBe(false);
      expect(hub.isSessionBeingViewed('')).toBe(false);

      // Phone locked (page hidden): it reports nothing; the laptop still shows s1.
      viewing(phone, '');
      await vi.advanceTimersByTimeAsync(0);
      expect(hub.isSessionBeingViewed('s1')).toBe(true);

      // Laptop closes its socket: nobody is looking at s1 any more.
      laptop.close();
      expect(hub.isSessionBeingViewed('s1')).toBe(false);

      // A half-open client stops counting once the heartbeat drops it.
      laptop.removeAllListeners();
      for (let t = 0; t < 60_000; t += 20_000) {
        await vi.advanceTimersByTimeAsync(20_000);
        sendBinaryFrame(phone, encodeWsV3Frame({ type: WsV3MessageType.PING }));
      }
      expect(silent.terminate).toHaveBeenCalled();
      expect(hub.isSessionBeingViewed('s2')).toBe(false);
    } finally {
      hub.dispose();
      vi.useRealTimers();
    }
  });
});

describe('WsV3Hub history replay through a real CastOutputHub', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, RM_TEST_DIR);
    tmpDir = null;
  });

  it('opens a session whose cast holds more than the buffer limit since the last clear', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-v3-replay-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const line = JSON.stringify([0.1, 'o', `${'y'.repeat(64 * 1024 - 1)}\n`]);
    const lines = [JSON.stringify({ version: 2, width: 80, height: 24 })];
    const count = Math.ceil((MAX_CLIENT_BUFFERED_BYTES * 1.25) / line.length);
    for (let i = 0; i < count; i++) lines.push(line);
    fs.writeFileSync(stdoutPath, `${lines.join('\n')}\n`);

    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({}),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const realHub = new WsV3Hub({
      ptyManager: { getSession: () => null } as unknown as PtyManager,
      terminalManager: {} as unknown as TerminalManager,
      // Replays are capped (CAST_REPLAY_MAX_BYTES); this one may send all of its history.
      castOutputHub: new CastOutputHub(sessionManager, {
        replayMaxBytes: 2 * count * line.length,
        historyMaxBytes: 2 * count * line.length,
      }),
      gitStatusHub: {} as unknown as GitStatusHub,
      sessionMonitor: null,
      remoteRegistry: null,
      isHQMode: false,
    });

    // A link slower than the replay loop: nothing drains while the history is sent.
    const ws = new FakeWebSocket();
    let stdoutBytes = 0;
    ws.send = vi.fn((data: Uint8Array) => {
      ws.bufferedAmount += data.length;
      const frame = decodeWsV3Frame(data);
      if (frame?.type === WsV3MessageType.STDOUT) stdoutBytes += frame.payload.length;
    });
    realHub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({ flags: WsV3SubscribeFlags.Stdout }),
      })
    );

    await vi.waitFor(
      () => {
        if (!ws.terminate.mock.calls.length) expect(stdoutBytes).toBe(count * 64 * 1024);
      },
      { timeout: 10_000 }
    );
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(stdoutBytes).toBeGreaterThan(MAX_CLIENT_BUFFERED_BYTES);
    realHub.dispose();
  });

  it('marks where the history replay ends, before live output', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-v3-replay-end-'));
    const stdoutPath = path.join(tmpDir, 'stdout');
    const lines = [
      JSON.stringify({ version: 2, width: 80, height: 24 }),
      JSON.stringify([0.1, 'o', 'one\r\n']),
      JSON.stringify([0.2, 'o', 'two\r\n']),
    ];
    fs.writeFileSync(stdoutPath, `${lines.join('\n')}\n`);
    const sessionManager = {
      getSessionPaths: () => ({ stdoutPath }),
      loadSessionInfo: () => ({}),
      saveSessionInfo: vi.fn(),
    } as unknown as SessionManager;
    const realHub = new WsV3Hub({
      ptyManager: { getSession: () => null } as unknown as PtyManager,
      terminalManager: {} as unknown as TerminalManager,
      castOutputHub: new CastOutputHub(sessionManager),
      gitStatusHub: {} as unknown as GitStatusHub,
      sessionMonitor: null,
      remoteRegistry: null,
      isHQMode: false,
    });
    const ws = new FakeWebSocket();
    realHub.handleClientConnection(ws as unknown as WebSocket, {} as unknown as WebSocketRequestV3);
    sendBinaryFrame(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.SUBSCRIBE,
        sessionId: 's1',
        payload: encodeWsV3SubscribePayload({
          flags: WsV3SubscribeFlags.Stdout | WsV3SubscribeFlags.Events,
        }),
      })
    );

    const decoder = new TextDecoder();
    const stream = () =>
      ws.sent
        .map((raw) => decodeWsV3Frame(raw))
        .filter((frame) => frame && frame.type !== WsV3MessageType.WELCOME)
        .map((frame) => {
          const text = decoder.decode(frame?.payload);
          return frame?.type === WsV3MessageType.EVENT ? JSON.parse(text).kind : text;
        });
    await vi.waitFor(() => expect(stream()).toContain('replay-end'), { timeout: 5_000 });
    expect(stream()).toEqual(['header', 'one\r\ntwo\r\n', 'replay-end']);
    realHub.dispose();
  });
});
