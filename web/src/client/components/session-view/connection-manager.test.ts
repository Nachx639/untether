/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../shared/types.js';
import type { Terminal } from '../terminal.js';

type SubscribeOpts = {
  onStdout?: (data: Uint8Array) => void;
  onEvent?: (data: unknown) => void;
  onError?: (message: string) => void;
};

const subscriptions: SubscribeOpts[] = [];

vi.mock('../../services/terminal-socket-client.js', () => ({
  terminalSocketClient: {
    subscribe: vi.fn((_sessionId: string, opts: SubscribeOpts) => {
      subscriptions.push(opts);
      return () => {};
    }),
  },
}));

const { ConnectionManager } = await import('./connection-manager.js');

const encoder = new TextEncoder();

describe('ConnectionManager replay after reconnect', () => {
  let written: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    subscriptions.length = 0;
    written = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function connect() {
    const manager = new ConnectionManager(vi.fn(), vi.fn());
    manager.setTerminal({
      write: (data: string) => written.push(data),
      holdPaint: vi.fn(),
      releasePaint: vi.fn(),
      isPaintHeld: () => false,
    } as unknown as Terminal);
    manager.setSession({ id: 's1' } as Session);
    manager.setConnected(true);
    manager.connectToStream();
    return subscriptions[0];
  }

  it('starts the terminal over when the server replays history on a new socket', async () => {
    const sub = connect();

    // First connection: header + history.
    sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 } });
    sub.onStdout?.(encoder.encode('$ ls\r\nfile\r\n'));
    await vi.advanceTimersByTimeAsync(20);

    // Phone slept, socket came back, the client re-subscribed: same history again.
    sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 } });
    sub.onStdout?.(encoder.encode('$ ls\r\nfile\r\n'));
    await vi.advanceTimersByTimeAsync(20);

    expect(written.join('')).toBe('$ ls\r\nfile\r\n\x1bc$ ls\r\nfile\r\n');
  });

  it('does not reset a terminal that has shown nothing yet', async () => {
    const sub = connect();
    sub.onEvent?.({ kind: 'header', header: { width: 80, height: 24 } });
    sub.onStdout?.(encoder.encode('hi'));
    await vi.advanceTimersByTimeAsync(20);
    expect(written.join('')).toBe('hi');
  });
});

describe("ConnectionManager and the PTY's size", () => {
  it('remembers the size the stream reports, from its header and each resize', () => {
    subscriptions.length = 0;
    const manager = new ConnectionManager(vi.fn(), vi.fn());
    const sizes = vi.fn();
    manager.setOnPtySize(sizes);
    manager.setTerminal({
      write: vi.fn(),
      holdPaint: vi.fn(),
      releasePaint: vi.fn(),
      isPaintHeld: () => false,
    } as unknown as Terminal);
    manager.setSession({ id: 's1' } as Session);
    manager.setConnected(true);
    manager.connectToStream();
    const sub = subscriptions[0];
    expect(manager.getPtySize()).toBeNull();

    sub.onEvent?.({ kind: 'header', header: { width: 120, height: 30 } });
    expect(manager.getPtySize()).toEqual({ cols: 120, rows: 30 });
    // Another client resized the PTY (2026-10-04: to 53 columns under the phone's 45).
    sub.onEvent?.({ kind: 'resize', dimensions: '53x56' });
    expect(manager.getPtySize()).toEqual({ cols: 53, rows: 56 });
    sub.onEvent?.({ kind: 'resize', dimensions: 'garbage' });
    expect(manager.getPtySize()).toEqual({ cols: 53, rows: 56 });
    expect(sizes.mock.calls).toEqual([[{ cols: 120, rows: 30 }], [{ cols: 53, rows: 56 }]]);
  });
});

describe('ConnectionManager stream errors', () => {
  it('says in the terminal, once, that the stream failed instead of staying blank', () => {
    subscriptions.length = 0;
    const written: string[] = [];
    const releasePaint = vi.fn();
    const manager = new ConnectionManager(vi.fn(), vi.fn());
    manager.setTerminal({
      write: (data: string) => written.push(data),
      holdPaint: vi.fn(),
      releasePaint,
      isPaintHeld: () => true,
    } as unknown as Terminal);
    manager.setSession({ id: 's1' } as Session);
    manager.setConnected(true);
    manager.connectToStream();
    const sub = subscriptions[0];
    sub.onError?.('Session not found');
    sub.onError?.('Session not found');
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('Session not found');
    expect(releasePaint).toHaveBeenCalled();
  });
});
