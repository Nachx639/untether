import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STREAM_COALESCE_MS,
  STREAM_MAX_PENDING_CHARS,
  STREAM_SOFT_BUFFERED_BYTES,
  StreamCoalescer,
} from './agent-stream-coalescer.js';

function make(options: { maxPendingChars?: number } = {}) {
  const sent: string[] = [];
  const resyncs: number[] = [];
  const socket = { backlog: 0, history: 0 };
  const coalescer = new StreamCoalescer({
    send: (data) => sent.push(data),
    backlog: () => socket.backlog,
    totalBacklog: () => socket.backlog + socket.history,
    resync: (skipped) => resyncs.push(skipped),
    ...options,
  });
  return { coalescer, sent, resyncs, socket };
}

describe('StreamCoalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the first chunk after a quiet spell at once (typing echoes without delay)', () => {
    const { coalescer, sent } = make();
    coalescer.push('a');
    expect(sent).toEqual(['a']);
    vi.advanceTimersByTime(STREAM_COALESCE_MS * 3);
    coalescer.push('b');
    expect(sent).toEqual(['a', 'b']);
  });

  it('groups a burst into at most one frame per window, in order', () => {
    const { coalescer, sent } = make();
    for (let i = 0; i < 1000; i++) coalescer.push(`${i};`);
    expect(sent).toEqual(['0;']);
    vi.advanceTimersByTime(STREAM_COALESCE_MS);
    expect(sent).toHaveLength(2);
    expect(sent.join('')).toBe(Array.from({ length: 1000 }, (_, i) => `${i};`).join(''));
  });

  it('a steady flood goes out about once per window', () => {
    const { coalescer, sent } = make();
    // 1 s of output, one line every millisecond.
    for (let ms = 0; ms < 1000; ms++) {
      coalescer.push('line\r\n');
      vi.advanceTimersByTime(1);
    }
    vi.advanceTimersByTime(STREAM_COALESCE_MS);
    expect(sent.length).toBeLessThanOrEqual(Math.ceil(1000 / STREAM_COALESCE_MS) + 1);
    expect(sent.join('')).toBe('line\r\n'.repeat(1000));
  });

  it('flushNow sends what waits before another frame of the session', () => {
    const { coalescer, sent } = make();
    coalescer.push('a');
    coalescer.push('b');
    coalescer.flushNow();
    expect(sent).toEqual(['a', 'b']);
    vi.advanceTimersByTime(STREAM_COALESCE_MS);
    expect(sent).toEqual(['a', 'b']);
  });

  it('holds output while the socket is behind and sends it grouped once it drains', () => {
    const { coalescer, sent, socket } = make();
    coalescer.push('a');
    socket.backlog = STREAM_SOFT_BUFFERED_BYTES + 1;
    coalescer.push('b');
    coalescer.push('c');
    vi.advanceTimersByTime(STREAM_COALESCE_MS * 10);
    expect(sent).toEqual(['a']);
    socket.backlog = 0;
    vi.advanceTimersByTime(STREAM_COALESCE_MS);
    expect(sent).toEqual(['a', 'bc']);
  });

  it('drops a flood past its limit and resyncs once the socket drained', () => {
    const { coalescer, sent, resyncs, socket } = make({ maxPendingChars: 100 });
    coalescer.push('x');
    socket.backlog = STREAM_SOFT_BUFFERED_BYTES + 1;
    for (let i = 0; i < 20; i++) coalescer.push('0123456789');
    expect(coalescer.isResyncing()).toBe(true);
    // Output meanwhile is skipped too: the replay has it.
    coalescer.push('later');
    vi.advanceTimersByTime(STREAM_COALESCE_MS * 5);
    expect(resyncs).toEqual([]);
    socket.backlog = 0;
    vi.advanceTimersByTime(STREAM_COALESCE_MS);
    expect(resyncs).toHaveLength(1);
    expect(resyncs[0]).toBeGreaterThan(100);
    expect(sent).toEqual(['x']);
    expect(coalescer.isResyncing()).toBe(false);
    // Live again after the resync.
    vi.advanceTimersByTime(STREAM_COALESCE_MS);
    coalescer.push('next');
    expect(sent).toEqual(['x', 'next']);
  });

  it('a second flood waits for the first replay to drain before replaying again', () => {
    // 2026-11-02 review: replays are history (not live backlog), so with steady output each
    // flood queued one more full replay behind the last.
    const { coalescer, resyncs, socket } = make({ maxPendingChars: 100 });
    coalescer.push('z'.repeat(101));
    expect(resyncs).toHaveLength(1);
    socket.history = STREAM_SOFT_BUFFERED_BYTES * 2; // the replay is still queued
    vi.advanceTimersByTime(STREAM_COALESCE_MS);
    coalescer.push('z'.repeat(101));
    vi.advanceTimersByTime(STREAM_COALESCE_MS * 20);
    expect(resyncs).toHaveLength(1);
    socket.history = 0;
    vi.advanceTimersByTime(STREAM_COALESCE_MS);
    expect(resyncs).toHaveLength(2);
  });

  it('one enormous chunk counts as a flood', () => {
    const { coalescer, sent, resyncs } = make();
    coalescer.push('y'.repeat(STREAM_MAX_PENDING_CHARS + 1));
    expect(sent).toEqual([]);
    expect(resyncs).toEqual([STREAM_MAX_PENDING_CHARS + 1]);
  });

  it('sends nothing after dispose', () => {
    const { coalescer, sent } = make();
    coalescer.push('a');
    coalescer.push('b');
    coalescer.dispose();
    coalescer.push('c');
    vi.advanceTimersByTime(STREAM_COALESCE_MS * 2);
    expect(sent).toEqual(['a']);
  });
});
