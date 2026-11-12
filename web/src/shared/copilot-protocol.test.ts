import { describe, expect, it } from 'vitest';
import { CLIP_TURN, decodeAudioFrame, encodeAudioFrame } from './copilot-protocol';

describe('copilot audio frames', () => {
  it('round-trips turn, index and payload', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = encodeAudioFrame(42, 3, payload);
    expect(frame.length).toBe(13);
    expect(decodeAudioFrame(frame)).toEqual({ turn: 42, index: 3, payload });
    expect(decodeAudioFrame(frame.buffer as ArrayBuffer)?.turn).toBe(42);
  });

  it('carries clip frames and little-endian numbers', () => {
    const frame = encodeAudioFrame(CLIP_TURN, 7, new Uint8Array());
    expect(Array.from(frame.slice(0, 8))).toEqual([255, 255, 255, 255, 7, 0, 0, 0]);
    expect(decodeAudioFrame(frame)?.turn).toBe(CLIP_TURN);
  });

  it('refuses frames too short for a header', () => {
    expect(decodeAudioFrame(new Uint8Array(4))).toBeNull();
  });
});
