/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeWsV3Frame,
  decodeWsV3ResizePayload,
  VIEWING_REFRESH_MS,
  WsV3MessageType,
} from '../../shared/ws-v3.js';
import { authClient } from './auth-client.js';
import {
  CONNECT_TIMEOUT_MS,
  OFFLINE_INPUT_MAX_BYTES,
  PROBE_OPENING_TIMEOUT_MS,
  SEEN_READ_GAP_MS,
  TerminalSocketClient,
  VIEWING_IDLE_MS,
} from './terminal-socket-client.js';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  sent: Uint8Array[] = [];
  send(data: ArrayBuffer) {
    this.sent.push(new Uint8Array(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

let visibility: DocumentVisibilityState = 'visible';
let focused = true;

describe('TerminalSocketClient reconnect after the page was hidden', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    visibility = 'visible';
    focused = true;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ noAuth: true })))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reconnects as soon as the page is visible instead of waiting out the backoff', async () => {
    const client = new TerminalSocketClient();
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeSocket.instances).toHaveLength(1);

    // The phone sleeps: every reconnect attempt fails, backoff grows to 30 s.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    for (let i = 0; i < 6; i++) {
      FakeSocket.instances[FakeSocket.instances.length - 1].close();
      await vi.advanceTimersByTimeAsync(2 ** i * 1000);
    }
    FakeSocket.instances[FakeSocket.instances.length - 1].close();
    const attempts = FakeSocket.instances.length;

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.instances).toHaveLength(attempts + 1);
  });

  it('replaces a socket stuck connecting after a network switch (2026-10-20 review)', async () => {
    const client = new TerminalSocketClient();
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeSocket.instances).toHaveLength(1);
    // No open, no close: the handshake hangs on the old network.
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 100);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0].readyState).toBe(3);
    client.disconnect();
  });

  it('starts over at once when the page comes back with the socket still connecting', async () => {
    const client = new TerminalSocketClient();
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(PROBE_OPENING_TIMEOUT_MS);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0].readyState).toBe(3);
    client.disconnect();
  });

  it('leaves a live socket alone when the page becomes visible', async () => {
    const client = new TerminalSocketClient();
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    const socket = FakeSocket.instances[0];
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.();

    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  async function openClient() {
    const client = new TerminalSocketClient();
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    const socket = FakeSocket.instances[0];
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.();
    return { client, socket };
  }

  it('disconnect() closes the socket on logout and schedules no reconnect', async () => {
    const { client, socket } = await openClient();
    client.disconnect();
    expect(socket.readyState).toBe(3);
    expect(client.getConnectionStatus()).toBe(false);
    // No backoff reconnect and no ping keep the old token's socket alive.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(FakeSocket.instances).toHaveLength(1);
    // The re-login reconnects with the new token.
    client.forceReconnect();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('stops reconnecting and says so when the server refuses the token (close 4401)', async () => {
    const client = new TerminalSocketClient();
    const rejected = vi.fn();
    client.onTokenRejected(rejected);
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0] as unknown as {
      onclose: ((event: { code: number }) => void) | null;
    };
    socket.onclose?.({ code: 4401 });
    expect(rejected).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('replaces a socket that stays OPEN but stops answering pings', async () => {
    const { client } = await openClient();

    // Wi-Fi to cellular: the old TCP connection is gone, no close event ever comes.
    await vi.advanceTimersByTimeAsync(70_000);

    // Replaced (the fake replacement never opens, so its connect timeout may replace it too).
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2);
    expect(FakeSocket.instances[0].readyState).toBe(3);
    expect(client.getConnectionStatus()).toBe(false);
  });

  it('keeps a socket that answers its pings', async () => {
    const { socket } = await openClient();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      socket.onmessage?.({ data: new ArrayBuffer(0) });
    }
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('probes an OPEN socket when the page comes back and replaces it if silent', async () => {
    await openClient();
    await vi.advanceTimersByTimeAsync(10_000);

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('keeps the socket when the foreground probe is answered', async () => {
    const { socket } = await openClient();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(500);
    socket.onmessage?.({ data: new ArrayBuffer(0) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  function framesSent(socket: FakeSocket, type: WsV3MessageType) {
    return socket.sent
      .map((raw) => decodeWsV3Frame(raw))
      .filter((frame) => frame?.type === type)
      .map((frame) => frame?.sessionId);
  }

  it('subscribes each session once after a reconnect, with no stale subscription frames', async () => {
    const { client, socket } = await openClient();
    const stopA = client.subscribe('a', { stdout: true });
    client.subscribe('b', { stdout: true });

    // Offline: the view for "a" closes, a new one for "c" opens, "b" also wants events.
    socket.close();
    stopA();
    client.subscribe('c', { stdout: true });
    client.subscribe('b', { events: true });

    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(next).not.toBe(socket);
    next.readyState = FakeSocket.OPEN;
    next.onopen?.();

    // One SUBSCRIBE (= one history replay) per live session, nothing for "a".
    expect(framesSent(next, WsV3MessageType.SUBSCRIBE).sort()).toEqual(['b', 'c']);
    expect(framesSent(next, WsV3MessageType.UNSUBSCRIBE)).toEqual([]);
  });

  it('replaces a silent probed socket sooner when a session is opened, then subscribes it once', async () => {
    // User report 2026-10-14: a session opened right after unlocking subscribed on a dead
    // socket and showed «Cargando historial» for the whole 4 s probe.
    const { client, socket } = await openClient();
    await vi.advanceTimersByTimeAsync(10_000);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(300);
    client.subscribe('a', { stdout: true, events: true });
    // Held: its replay would go into the dead socket.
    expect(framesSent(socket, WsV3MessageType.SUBSCRIBE)).toEqual([]);

    await vi.advanceTimersByTimeAsync(PROBE_OPENING_TIMEOUT_MS - 300);
    expect(FakeSocket.instances).toHaveLength(2);
    const next = FakeSocket.instances[1];
    next.readyState = FakeSocket.OPEN;
    next.onopen?.();
    expect(framesSent(next, WsV3MessageType.SUBSCRIBE)).toEqual(['a']);
    expect(framesSent(socket, WsV3MessageType.SUBSCRIBE)).toEqual([]);
  });

  it('sends a subscription held during the probe as soon as the socket answers', async () => {
    const { client, socket } = await openClient();
    await vi.advanceTimersByTimeAsync(10_000);
    document.dispatchEvent(new Event('visibilitychange'));
    const stopA = client.subscribe('a', { stdout: true });
    client.subscribe('b', { stdout: true });
    stopA();
    expect(framesSent(socket, WsV3MessageType.SUBSCRIBE)).toEqual([]);

    await vi.advanceTimersByTimeAsync(200);
    socket.onmessage?.({ data: new ArrayBuffer(0) });
    expect(framesSent(socket, WsV3MessageType.SUBSCRIBE)).toEqual(['b']);
    expect(framesSent(socket, WsV3MessageType.UNSUBSCRIBE)).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.instances).toHaveLength(1);
    // Later subscriptions go out at once.
    client.subscribe('c', { stdout: true });
    expect(framesSent(socket, WsV3MessageType.SUBSCRIBE)).toEqual(['b', 'c']);
  });

  function sentFrames(socket: FakeSocket) {
    return socket.sent.map((raw) => {
      const frame = decodeWsV3Frame(raw);
      if (!frame) throw new Error('undecodable frame');
      return frame;
    });
  }

  async function reopen() {
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances[FakeSocket.instances.length - 1];
    next.readyState = FakeSocket.OPEN;
    next.onopen?.();
    return next;
  }

  // User report 2026-10-14: a size queued while offline and sent on reconnect resized the
  // session under whoever used it meanwhile. Only a recent claim (a tap, a key) survives.
  it('drops stale input and plain resizes queued while offline, keeps a recent claim', async () => {
    const { client, socket } = await openClient();
    socket.close();

    client.sendInputText('s1', 'rm -rf build');
    client.sendInputKey('s1', 'enter');
    client.resize('s1', 80, 24, true);
    client.resize('s2', 100, 30);
    // Away for an hour: every reconnect attempt fails.
    for (let minute = 0; minute < 60; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      FakeSocket.instances[FakeSocket.instances.length - 1].close();
    }
    client.resize('s1', 40, 20, true);
    client.resize('s3', 50, 20);
    client.sendInputText('s1', 'ls');

    const next = await reopen();
    const frames = sentFrames(next).filter(
      (f) => f.type !== WsV3MessageType.PING && f.type !== WsV3MessageType.VIEWING
    );
    const decoder = new TextDecoder();
    expect(frames.map((f) => [WsV3MessageType[f.type], f.sessionId])).toEqual([
      ['RESIZE', 's1'],
      ['INPUT_TEXT', 's1'],
    ]);
    expect(decoder.decode(frames[1].payload)).toBe('ls');
    // The claim kept is the latest one, not the hour-old 80x24, with this page's id.
    expect(decodeWsV3ResizePayload(frames[0].payload)).toEqual({
      cols: 40,
      rows: 20,
      claim: true,
      clientId: expect.any(String),
    });
  });

  it('caps input queued while offline to the most recent 64 KB', async () => {
    const { client, socket } = await openClient();
    socket.close();
    const chunk = 'x'.repeat(1024);
    for (let i = 0; i < 100; i++) client.sendInputText('s1', `${i}:${chunk}`);

    const next = await reopen();
    const inputs = sentFrames(next)
      .filter((f) => f.type === WsV3MessageType.INPUT_TEXT)
      .map((f) => Number(new TextDecoder().decode(f.payload).split(':')[0]));
    const bytes = inputs.length * (chunk.length + 3);
    expect(bytes).toBeLessThanOrEqual(OFFLINE_INPUT_MAX_BYTES);
    expect(inputs.length).toBeGreaterThan(50);
    // The newest input, contiguous and in order.
    expect(inputs).toEqual(
      Array.from({ length: inputs.length }, (_, i) => 100 - inputs.length + i)
    );
  });

  function viewingFrames(socket: FakeSocket) {
    return socket.sent
      .map((raw) => decodeWsV3Frame(raw))
      .filter((frame) => frame?.type === WsV3MessageType.VIEWING)
      .map((frame) => frame?.sessionId);
  }

  it('reports the viewed session while the page is visible, and again after a reconnect', async () => {
    const { client, socket } = await openClient();

    client.setViewingSession('s1');
    expect(viewingFrames(socket)).toEqual(['s1']);

    // Phone locked: hidden page means nobody is looking.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(viewingFrames(socket)).toEqual(['s1', '']);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1']);

    // Safari closed / tab discarded.
    window.dispatchEvent(new Event('pagehide'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1', '']);
    window.dispatchEvent(new Event('pageshow'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1', '', 's1']);

    // A new socket knows nothing: the viewed session is sent again on open.
    socket.close();
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(next).not.toBe(socket);
    next.readyState = FakeSocket.OPEN;
    next.onopen?.();
    expect(viewingFrames(next)).toEqual(['s1']);

    // Leaving the session view (an older view clearing late does not undo a newer one).
    client.clearViewingSession('other');
    client.clearViewingSession('s1');
    expect(viewingFrames(next)).toEqual(['s1', '']);
  });

  it('does not queue viewing reports while offline', async () => {
    const client = new TerminalSocketClient();
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    client.setViewingSession('s1');
    client.setViewingSession('s2');
    const socket = FakeSocket.instances[0];
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.();
    expect(viewingFrames(socket)).toEqual(['s2']);
  });

  /** Let `ms` pass on a socket that keeps answering (so the pong timeout never drops it). */
  async function liveFor(socket: FakeSocket, ms: number) {
    for (let left = ms; left > 0; left -= 5000) {
      await vi.advanceTimersByTimeAsync(Math.min(5000, left));
      socket.onmessage?.({ data: new ArrayBuffer(0) });
    }
  }

  it('repeats the viewed session every 20 s while someone keeps using the page', async () => {
    const { client, socket } = await openClient();
    client.setViewingSession('s1');
    for (let i = 0; i < 3; i++) {
      await liveFor(socket, VIEWING_REFRESH_MS / 2);
      window.dispatchEvent(new Event('pointerdown'));
      await liveFor(socket, VIEWING_REFRESH_MS / 2);
    }
    expect(viewingFrames(socket)).toEqual(['s1', 's1', 's1', 's1']);
    // Taps between refreshes add no frames of their own.
    window.dispatchEvent(new Event('keydown'));
    expect(viewingFrames(socket)).toHaveLength(4);

    // Leaving the session stops the repeats.
    client.setViewingSession(null);
    await liveFor(socket, 3 * VIEWING_REFRESH_MS);
    expect(viewingFrames(socket)).toEqual(['s1', 's1', 's1', 's1', '']);
  });

  function seenFrames(socket: FakeSocket) {
    return socket.sent
      .map((raw) => decodeWsV3Frame(raw))
      .filter((frame) => frame?.type === WsV3MessageType.SEEN)
      .map((frame) => new TextDecoder().decode(frame?.payload));
  }

  it('reports what the looked-at page shows as seen, read fresh at every send', async () => {
    const { client, socket } = await openClient();
    let shown = ['needs-you:t1', 'confirm:c1'];
    // Someone is using the page (a page nobody touched for VIEWING_IDLE_MS says nothing).
    window.dispatchEvent(new Event('pointerdown'));
    client.setSeenSource(() => shown);
    expect(seenFrames(socket)).toEqual(['confirm:c1\nneeds-you:t1']);

    // Repeated while it stays on screen; taps in between add nothing of their own.
    window.dispatchEvent(new Event('pointerdown'));
    expect(seenFrames(socket)).toHaveLength(1);
    await liveFor(socket, VIEWING_REFRESH_MS);
    expect(seenFrames(socket)).toHaveLength(2);

    // What it shows changed (a re-render): said at once.
    shown = ['confirm:c2'];
    client.seenMayHaveChanged();
    expect(seenFrames(socket).at(-1)).toBe('confirm:c2');

    // A page not looked at says nothing.
    let count = seenFrames(socket).length;
    focused = false;
    await liveFor(socket, VIEWING_REFRESH_MS);
    expect(seenFrames(socket)).toHaveLength(count);
    // One looked at that shows nothing pending still says it is looked at (empty).
    focused = true;
    shown = [];
    await liveFor(socket, VIEWING_REFRESH_MS);
    expect(seenFrames(socket).at(-1)).toBe('');
    count = seenFrames(socket).length;

    client.setSeenSource(null);
    shown = ['confirm:c3'];
    await liveFor(socket, 2 * VIEWING_REFRESH_MS);
    expect(seenFrames(socket)).toHaveLength(count);
  });

  it('reads what the page shows once per burst of scrolls or taps, the last one included (2026-11-10)', async () => {
    const { client, socket } = await openClient();
    window.dispatchEvent(new Event('pointerdown'));
    let keys = ['confirm:c1'];
    const source = vi.fn(() => keys);
    client.setSeenSource(source);
    expect(seenFrames(socket)).toHaveLength(1);
    source.mockClear();

    // Frame-rate events right after a read: nothing is read again yet.
    for (const type of ['scroll', 'wheel', 'keydown', 'pointerdown', 'scroll', 'scroll']) {
      window.dispatchEvent(new Event(type));
    }
    expect(source).not.toHaveBeenCalled();

    // What the burst scrolled into view is still reported, a moment later, once.
    keys = ['confirm:c1', 'needs-you:t1'];
    await vi.advanceTimersByTimeAsync(SEEN_READ_GAP_MS + 1);
    expect(source).toHaveBeenCalledTimes(1);
    expect(seenFrames(socket).at(-1)).toBe('confirm:c1\nneeds-you:t1');

    // A view that re-rendered says so at once, as before.
    client.seenMayHaveChanged();
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('keeps one token poll however often connect is asked for (2026-11-10)', async () => {
    const getCurrentUser = vi.spyOn(authClient, 'getCurrentUser').mockReturnValue(null);
    const client = new TerminalSocketClient();
    // The auth config is cached by the earlier tests (noAuth): ask for an authenticated server.
    vi.spyOn(client as unknown as { isNoAuthMode(): boolean }, 'isNoAuthMode').mockReturnValue(
      false
    );
    await client.initialize();
    await vi.advanceTimersByTimeAsync(100);
    getCurrentUser.mockClear();

    for (let i = 0; i < 5; i++) client.forceReconnect();
    getCurrentUser.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    // One poll every 500 ms: four in two seconds, not one per caller.
    expect(getCurrentUser.mock.calls.length).toBeLessThanOrEqual(4);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('says nothing is viewed once the page sits untouched, and again on the next tap', async () => {
    const { client, socket } = await openClient();
    client.setViewingSession('s1');
    await liveFor(socket, VIEWING_IDLE_MS + VIEWING_REFRESH_MS);
    const frames = viewingFrames(socket);
    expect(frames.at(-1)).toBe('');
    expect(frames.filter((frame) => frame === '')).toHaveLength(1);
    expect(frames.filter((frame) => frame === 's1').length).toBeLessThanOrEqual(
      VIEWING_IDLE_MS / VIEWING_REFRESH_MS
    );

    // Still untouched: '' was said once, the repeats stay quiet.
    await liveFor(socket, 5 * VIEWING_REFRESH_MS);
    expect(viewingFrames(socket)).toEqual(frames);

    window.dispatchEvent(new Event('wheel'));
    expect(viewingFrames(socket)).toEqual([...frames, 's1']);
  });

  it('says nothing is viewed when the window loses focus or the page is hidden or frozen', async () => {
    const { client, socket } = await openClient();
    client.setViewingSession('s1');

    // Another window or app in front.
    focused = false;
    window.dispatchEvent(new Event('blur'));
    expect(viewingFrames(socket)).toEqual(['s1', '']);
    await liveFor(socket, 3 * VIEWING_REFRESH_MS);
    expect(viewingFrames(socket)).toEqual(['s1', '']);
    focused = true;
    window.dispatchEvent(new Event('focus'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1']);

    // Hidden (screen locked): no repeats while hidden.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await liveFor(socket, 3 * VIEWING_REFRESH_MS);
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1', '']);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1', '', 's1']);

    document.dispatchEvent(new Event('freeze'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1', '', 's1', '']);
    document.dispatchEvent(new Event('resume'));
    expect(viewingFrames(socket)).toEqual(['s1', '', 's1', '', 's1', '', 's1']);
  });
  function presentFrames(socket: FakeSocket) {
    return socket.sent
      .map((raw) => decodeWsV3Frame(raw))
      .filter((frame) => frame?.type === WsV3MessageType.PRESENT)
      .map((frame) => frame?.sessionId);
  }

  // User report 2026-10-14: a Mac window stayed at a locked phone's width. The server gives it
  // back once the page has been gone a while, from these reports.
  it('reports the session on a visible page, focused or not, touched or not', async () => {
    const { client, socket } = await openClient();
    client.setViewingSession('s1');
    expect(presentFrames(socket)).toEqual(['s1']);
    const id = decodeWsV3Frame(socket.sent.at(-1) as Uint8Array)?.payload;
    expect(new TextDecoder().decode(id).length).toBeGreaterThan(0);

    // Read without touching, another window in front: still there, repeated every 20 s.
    focused = false;
    window.dispatchEvent(new Event('blur'));
    await liveFor(socket, VIEWING_IDLE_MS + 2 * VIEWING_REFRESH_MS);
    const frames = presentFrames(socket);
    expect(frames.every((frame) => frame === 's1')).toBe(true);
    expect(frames.length).toBeGreaterThanOrEqual(
      (VIEWING_IDLE_MS + VIEWING_REFRESH_MS) / VIEWING_REFRESH_MS
    );
    expect(viewingFrames(socket).at(-1)).toBe('');

    // Locked: said at once, then nothing while hidden.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(presentFrames(socket).at(-1)).toBe('');
    const hiddenCount = presentFrames(socket).length;
    await liveFor(socket, 3 * VIEWING_REFRESH_MS);
    expect(presentFrames(socket)).toHaveLength(hiddenCount);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(presentFrames(socket).at(-1)).toBe('s1');

    // A new socket is told again on open; nothing is queued while offline.
    socket.close();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1000);
    const next = FakeSocket.instances[FakeSocket.instances.length - 1];
    expect(next).not.toBe(socket);
    next.readyState = FakeSocket.OPEN;
    next.onopen?.();
    expect(presentFrames(next)).toEqual(['s1']);

    // Leaving the session view.
    client.setViewingSession(null);
    expect(presentFrames(next)).toEqual(['s1', '']);
  });
});
