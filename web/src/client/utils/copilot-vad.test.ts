import { describe, expect, it } from 'vitest';
import { type FrameContext, rms, type TurnEvent, TurnTaker } from './copilot-vad.js';

const RATE = 16000;
/** 1024 samples at 16 kHz: 64 ms a frame. */
const N = 1024;
const FRAME_MS = (N / RATE) * 1000;
const tone = (amp: number) => new Float32Array(N).fill(amp);
const quiet = () => tone(0.001);
const voice = () => tone(0.2);

function run(
  vad: TurnTaker,
  frames: Float32Array[],
  ctx: Partial<FrameContext> = {}
): { events: TurnEvent[]; at: Array<{ i: number; e: TurnEvent }> } {
  const events: TurnEvent[] = [];
  const at: Array<{ i: number; e: TurnEvent }> = [];
  frames.forEach((f, i) => {
    for (const e of vad.frame(f, {
      now: i * FRAME_MS,
      speakingOut: false,
      clipsOnly: false,
      handsFree: true,
      thinking: false,
      ...ctx,
    })) {
      events.push(e);
      at.push({ i, e });
    }
  });
  return { events, at };
}

const times = (n: number, f: () => Float32Array) => Array.from({ length: n }, f);
const types = (events: TurnEvent[]) => events.map((e) => e.type);

describe('copilot turn-taking (copilot-vad)', () => {
  it('measures RMS', () => {
    expect(rms(tone(0.5))).toBeCloseTo(0.5);
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it('opens on 250 ms of voice, peeks after 200 ms of silence and ends after 350 ms', () => {
    const vad = new TurnTaker(RATE);
    run(vad, times(10, quiet));
    const { at } = run(vad, [...times(8, voice), ...times(8, quiet)]);
    const start = at.find((x) => x.e.type === 'start');
    // 4 frames of 64 ms = 256 ms ≥ 250.
    expect(start?.i).toBe(3);
    const peek = at.find((x) => x.e.type === 'peek');
    const end = at.find((x) => x.e.type === 'end');
    // Silence starts at frame 8: 4 frames (256 ms) ≥ 200 → peek; 6 frames (384 ms) ≥ 350 → end.
    expect(peek?.i).toBe(11);
    expect(end?.i).toBe(13);
    const e = end?.e as Extract<TurnEvent, { type: 'end' }>;
    expect(e.peeked).toBe(true);
    // The preroll (up to 400 ms before the voice) is part of the utterance.
    expect(e.durMs).toBeGreaterThan(8 * FRAME_MS);
    expect(vad.listening).toBe(false);
  });

  it('takes back the peek when the user goes on talking, then sends the whole utterance', () => {
    const vad = new TurnTaker(RATE);
    run(vad, times(10, quiet));
    const { events } = run(vad, [
      ...times(6, voice),
      ...times(4, quiet),
      ...times(3, voice),
      ...times(10, quiet),
    ]);
    expect(types(events)).toEqual(['start', 'peek', 'resume', 'peek', 'end']);
  });

  it('waits 600 ms of silence after a long utterance', () => {
    const vad = new TurnTaker(RATE);
    run(vad, times(10, quiet));
    const { at } = run(vad, [...times(25, voice), ...times(12, quiet)]);
    const end = at.find((x) => x.e.type === 'end');
    // 25 × 64 = 1600 ms spoken ≥ 1200: 10 frames (640 ms) ≥ 600.
    expect(end?.i).toBe(25 + 9);
  });

  it('ignores the voice without hands-free; a short press sends nothing, a long one does', () => {
    const vad = new TurnTaker(RATE);
    const off = run(vad, times(20, voice), { handsFree: false });
    expect(off.events).toEqual([]);
    expect(types(vad.press())).toEqual(['start']);
    run(vad, times(2, voice), { handsFree: false });
    // The preroll is ~400 ms of what came before: a press right away is short.
    const short = new TurnTaker(RATE);
    short.press();
    run(short, times(2, voice), { handsFree: false });
    expect(types(short.release())).toEqual(['drop']);
    run(vad, times(10, voice), { handsFree: false });
    const end = vad.release();
    expect(types(end)).toEqual(['end']);
    expect((end[0] as Extract<TurnEvent, { type: 'end' }>).peeked).toBe(false);
    expect(vad.release()).toEqual([]);
  });

  it('over the copilot: its echo does not count, a real voice ducks it at 120 ms and cuts it at 300 ms', () => {
    const vad = new TurnTaker(RATE);
    run(vad, times(10, quiet));
    const echo = run(
      vad,
      times(10, () => tone(0.04)),
      { speakingOut: true }
    );
    expect(echo.events).toEqual([]);
    const { at } = run(vad, times(6, voice), { speakingOut: true });
    expect(at[0]).toEqual({ i: 1, e: { type: 'duck', on: true } });
    const barge = at.find((x) => x.e.type === 'barge');
    expect(barge?.i).toBe(4); // 5 × 64 = 320 ms ≥ 300
    expect(at[at.indexOf(barge as (typeof at)[number]) + 1].e.type).toBe('start');
  });

  it('a false start over the copilot brings its volume back', () => {
    const vad = new TurnTaker(RATE);
    run(vad, times(10, quiet));
    const { events } = run(vad, [...times(2, voice), ...times(4, quiet)], { speakingOut: true });
    expect(events).toEqual([
      { type: 'duck', on: true },
      { type: 'duck', on: false },
    ]);
  });

  it('over an interjection clip only, cuts at the duck point', () => {
    const vad = new TurnTaker(RATE);
    run(vad, times(10, quiet));
    const { at } = run(vad, times(3, voice), { speakingOut: true, clipsOnly: true });
    expect(at.find((x) => x.e.type === 'barge')?.i).toBe(1);
  });

  it('talking while the copilot thinks cuts that answer (or carries the phrase on)', () => {
    const vad = new TurnTaker(RATE);
    run(vad, times(10, quiet));
    const { events } = run(vad, times(5, voice), { thinking: true });
    expect(types(events)).toEqual(['barge', 'start']);
  });

  it('cuts an utterance at 14 s, and drops one that cannot finish', () => {
    const vad = new TurnTaker(RATE);
    run(vad, times(10, quiet));
    const { events } = run(vad, times(240, voice));
    expect(types(events).slice(0, 2)).toEqual(['start', 'end']);
    const next = new TurnTaker(RATE);
    run(next, times(10, quiet));
    run(next, times(6, voice));
    expect(next.listening).toBe(true);
    expect(next.abort()).toEqual([{ type: 'drop' }]);
    expect(next.listening).toBe(false);
    expect(next.abort()).toEqual([]);
  });
});
