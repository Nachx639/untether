import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { exitAfterFlush } from './exit-after-flush.js';

describe('exitAfterFlush', () => {
  it('exits only after a slow pipe took everything written before (2026-10-23)', async () => {
    const out = new PassThrough({ highWaterMark: 16 });
    const big = 'x'.repeat(300_000);
    out.write(big);
    const exits: number[] = [];
    void exitAfterFlush(3, [out], (code) => exits.push(code));
    expect(exits).toEqual([]);
    let read = 0;
    for await (const chunk of out) {
      read += chunk.length;
      if (read >= big.length) break;
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(read).toBe(big.length);
    expect(exits).toEqual([3]);
  });
});
